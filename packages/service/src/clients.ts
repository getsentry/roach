/**
 * The address of the client of a proxy connection, for the limit of runs
 * for each client (`service.ts`).
 *
 * Behind a load balancer, a connection can start with a PROXY protocol v1
 * header (`proxyProtocol`). It gives the address of the client
 * (`clientAddress()`). An IPv6 client is grouped by its /64
 * (`clientGroup()`).
 */
import type http from "node:http";
import { isIP, type Socket } from "node:net";

/**
 * A PROXY protocol v1 header, such as
 * `PROXY TCP4 203.0.113.7 10.0.0.2 51234 443`. It is at most 107 bytes.
 * The first bytes of a connection must come in `PROXY_HEADER_MS`.
 */
const PROXY_PREFIX = Buffer.from("PROXY ");

const PROXY_HEADER =
  /^PROXY (?:TCP[46] ([0-9A-Fa-f:.]+) [0-9A-Fa-f:.]+ \d{1,5} \d{1,5}|UNKNOWN[^\r\n]*)\r\n/;

const MAX_PROXY_HEADER_BYTES = 107;

const PROXY_HEADER_MS = 10_000;

/** The address of the client of each connection with a PROXY header. */
const proxiedClients = new WeakMap<Socket, string>();

/**
 * The address of the client of a request. With `proxyProtocol`, it comes
 * from the PROXY header of the connection, when the connection has one.
 * Else it is the address of the socket.
 */
export function clientAddress(incoming: http.IncomingMessage): string {
  return (
    proxiedClients.get(incoming.socket) ?? incoming.socket.remoteAddress ?? ""
  );
}

/**
 * The group of a client address for the limit of runs for each client. An
 * IPv6 client often has a whole /64, so the group of an IPv6 address is
 * its /64, such as `2001:db8:0:1::/64`. An IPv4 address is its own group,
 * also in each IPv6 form, such as `::ffff:192.0.2.1`, `::ffff:c000:201`,
 * and `0:0:0:0:0:ffff:192.0.2.1`.
 */
export function clientGroup(address: string): string {
  if (isIP(address) !== 6) return address;
  const groups = ipv6Groups(address);
  if (
    groups.slice(0, 5).every((group) => group === 0) &&
    groups[5] === 0xffff
  ) {
    const [high = 0, low = 0] = groups.slice(6);
    return [high >> 8, high & 0xff, low >> 8, low & 0xff].join(".");
  }
  return `${groups
    .slice(0, 4)
    .map((group) => group.toString(16))
    .join(":")}::/64`;
}

/** The eight 16-bit groups of an IPv6 address. */
function ipv6Groups(address: string): number[] {
  // The URL parser writes each IPv6 form with hex groups only, such as
  // `::ffff:c000:201`. A zone, such as `%eth0`, is not part of it.
  const [head = "", tail] = new URL(
    `http://[${address.split("%")[0]}]`,
  ).hostname
    .slice(1, -1)
    .split("::");
  const front = head ? head.split(":") : [];
  const back = tail ? tail.split(":") : [];
  const zeros = Array<string>(8 - front.length - back.length).fill("0");
  return [...front, ...zeros, ...back].map((group) =>
    Number.parseInt(group, 16),
  );
}

/**
 * Read the PROXY protocol v1 header of a new connection, when it has one,
 * and keep the address of its client. Then give the connection to
 * `server`. A connection without the header keeps the address of its
 * socket. A header that is not valid closes the connection.
 *
 * The load balancer writes its header first, so a client cannot put a
 * header before it. Without a load balancer, a client can send its own
 * header. That changes only the address for the limit of runs for each
 * client.
 */
export function acceptProxied(socket: Socket, server: http.Server): void {
  let read = Buffer.alloc(0);
  const timer = setTimeout(() => socket.destroy(), PROXY_HEADER_MS);
  const accept = (rest: Buffer) => {
    socket.off("data", onData);
    clearTimeout(timer);
    socket.pause();
    if (rest.length > 0) socket.unshift(rest);
    server.emit("connection", socket);
    socket.resume();
  };
  const onData = (chunk: Buffer) => {
    read = Buffer.concat([read, chunk]);
    const prefix = Math.min(read.length, PROXY_PREFIX.length);
    if (!read.subarray(0, prefix).equals(PROXY_PREFIX.subarray(0, prefix))) {
      accept(read);
      return;
    }
    const end = read.indexOf("\r\n");
    if (end < 0 || end + 2 > MAX_PROXY_HEADER_BYTES) {
      if (end >= 0 || read.length >= MAX_PROXY_HEADER_BYTES) socket.destroy();
      return;
    }
    const match = PROXY_HEADER.exec(read.subarray(0, end + 2).toString());
    if (!match) {
      socket.destroy();
      return;
    }
    // `UNKNOWN`, such as from a health check, gives no address.
    if (match[1] && isIP(match[1])) proxiedClients.set(socket, match[1]);
    accept(read.subarray(end + 2));
  };
  socket.on("error", () => socket.destroy());
  socket.on("close", () => clearTimeout(timer));
  socket.on("data", onData);
}

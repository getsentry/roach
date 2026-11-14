/**
 * The PROXY protocol v1 header of a proxy connection.
 *
 * Behind a load balancer, a connection can start with a PROXY protocol v1
 * header (`proxyProtocol`). The service reads it and drops it, so the
 * HTTP server sees only the bytes of the client.
 */
import type http from "node:http";
import type { Socket } from "node:net";

/**
 * A PROXY protocol v1 header, such as
 * `PROXY TCP4 203.0.113.7 10.0.0.2 51234 443`. It is at most 107 bytes.
 * The first bytes of a connection must come in `PROXY_HEADER_MS`.
 */
const PROXY_PREFIX = Buffer.from("PROXY ");

const PROXY_HEADER =
  /^PROXY (?:TCP[46] [0-9A-Fa-f:.]+ [0-9A-Fa-f:.]+ \d{1,5} \d{1,5}|UNKNOWN[^\r\n]*)\r\n/;

const MAX_PROXY_HEADER_BYTES = 107;

const PROXY_HEADER_MS = 10_000;

/**
 * Read and drop the PROXY protocol v1 header of a new connection, when it
 * has one. Then give the connection to `server`. A header that is not
 * valid closes the connection.
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
    accept(read.subarray(end + 2));
  };
  socket.on("error", () => socket.destroy());
  socket.on("close", () => clearTimeout(timer));
  socket.on("data", onData);
}

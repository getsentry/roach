/**
 * The proxy sockets of the service (`service.ts`).
 *
 * The proxy is a forward proxy. It intercepts HTTPS with its own
 * certificate authority (`certificates.ts`). It gives each request that a
 * rule matches to the recorder (`recorder.ts`). Other requests go live
 * without a change, and their responses stream.
 *
 * It sends requests only to the `allow` origins of the run. It refuses
 * other origins with HTTP 403 and sends nothing. The upstream host always
 * comes from `allow`, never from the request. Only the path comes from the
 * request. It also refuses an origin whose address is not public
 * (`addresses.ts`), unless the service config has `privateNetworks`. The
 * stats of the run count each refused request (`refused`).
 *
 * An error with a `status`, such as HTTP 413, is the fault of the client,
 * and the client gets its message. Any other error, such as a failure of
 * the upstream or of GCS, can hold a response body in its message. So only
 * Sentry gets the error. The client gets a generic message with the id of
 * the Sentry event, and the log gets the class of the error.
 *
 * Each response has an `x-roach` header: `replayed`, `live`,
 * `missed` (`replay` mode had no recording), or `passthrough` (no rule
 * matched).
 *
 * Behind a load balancer, a connection can start with a PROXY protocol v1
 * header (`proxyProtocol`). It gives the address of the client
 * (`clientAddress()`).
 */
import { timingSafeEqual } from "node:crypto";
import http from "node:http";
import https from "node:https";
import net, { isIP, type Socket } from "node:net";
import tls from "node:tls";
import {
  isPublicAddress,
  NOT_PUBLIC_CODE,
  notPublicError,
  publicLookup,
} from "./addresses.ts";
import type { CertificateAuthority } from "./certificates.ts";
import { reportInternal } from "./errors.ts";
import type { ProxyRequest, Recorder, Telemetry } from "./recorder.ts";
import type { OpenedSession } from "@sentry/roach/types";

/** Headers for one connection, which the proxy must not forward. */
const HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);
const AUTHORITY = /^(\[[0-9a-f:.]+\]|[a-z0-9.-]+):(\d{1,5})$/i;
/**
 * A proxied request body over this size gets HTTP 413, unless the target
 * has a smaller `maxBodyBytes`.
 */
const MAX_BODY_BYTES = 64 * 1024 * 1024;
/**
 * A control API body over this size gets HTTP 413. Anyone can call
 * `POST /runs`, so the service reads no more before it checks the token.
 */
const MAX_CONTROL_BODY_BYTES = 1024 * 1024;
/** A tunnel that sends no byte this long after its `200` closes. */
const TUNNEL_FIRST_BYTE_MS = 10_000;
/**
 * A tunnel that sends and gets no byte this long closes. A live model
 * call can take minutes before its first byte, so this is long.
 */
const TUNNEL_IDLE_MS = 10 * 60 * 1000;
/**
 * The HTTP servers of the proxy. Headers that do not come in 10 s get
 * HTTP 408 from Node. A whole request, with its body, has Node's default
 * of 300 s. Node checks these times each second.
 */
const HTTP_OPTIONS: http.ServerOptions = {
  headersTimeout: 10_000,
  connectionsCheckingInterval: 1000,
};
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

/** An error that answers a request with its own status. */
const httpError = (status: number, message: string) =>
  Object.assign(new Error(message), { status });

/** Parse the allowed origins, by origin. A value that is not one throws. */
export function parseOrigins(values: string[]): Map<string, URL> {
  return new Map(
    values.map((value) => {
      const origin = new URL(value);
      if (
        (origin.protocol !== "http:" && origin.protocol !== "https:") ||
        origin.origin !== value.replace(/\/$/, "")
      ) {
        throw new Error(`Roach origin must be an origin: ${value}`);
      }
      return [origin.origin, origin];
    }),
  );
}

/** The `host:port` of an origin, with the default port of its scheme. */
function authorityOf(origin: URL): string {
  const port = origin.port || (origin.protocol === "https:" ? "443" : "80");
  return `${origin.hostname}:${port}`;
}

/**
 * The bytes of request bodies that the requests of many targets can hold
 * at one time (`ProxyTarget.bodyBudget`). `used` counts the bodies of the
 * requests that did not finish, and `clients` counts them for each client
 * (`ProxyTarget.client`). One client can hold at most `perClient` bytes,
 * so it cannot take all of `max`. A body that takes longer than `readMs`
 * to come fails with HTTP 408 and gives its bytes back.
 */
export interface BodyBudget {
  max: number;
  perClient: number;
  readMs: number;
  used: number;
  clients: Map<string, number>;
}

/** The bytes that one request holds of its `BodyBudget`. */
interface Held {
  budget: BodyBudget | undefined;
  client: string;
  bytes: number;
}

/** Hold `bytes` more of the budget. Returns `false` when they do not fit. */
function hold(held: Held, bytes: number): boolean {
  const { budget, client } = held;
  if (!budget) return true;
  const ofClient = budget.clients.get(client) ?? 0;
  if (budget.used + bytes > budget.max || ofClient + bytes > budget.perClient) {
    return false;
  }
  budget.used += bytes;
  budget.clients.set(client, ofClient + bytes);
  held.bytes += bytes;
  return true;
}

/** Give back all bytes that a request holds. */
function release(held: Held): void {
  const { budget, client, bytes } = held;
  held.bytes = 0;
  if (!budget || bytes === 0) return;
  budget.used -= bytes;
  const left = (budget.clients.get(client) ?? 0) - bytes;
  if (left > 0) budget.clients.set(client, left);
  else budget.clients.delete(client);
}

const busyError = () =>
  httpError(
    503,
    "the service has too many large requests at this time. Send the request again later.",
  );

/**
 * Read a whole body. A body over `maxBytes` fails with HTTP 413. A body
 * that does not fit in the budget of `held` fails with HTTP 503, and one
 * that does not come in the `readMs` of the budget fails with HTTP 408.
 * Only request bodies have a limit: the client sends them, and a large
 * upstream response is not the fault of the client.
 */
function readBody(
  stream: http.IncomingMessage,
  maxBytes = Infinity,
  held: Held = { budget: undefined, client: "", bytes: 0 },
): Promise<Buffer> {
  const declared = Number(stream.headers["content-length"]);
  if (declared > maxBytes) {
    // Drop the body without a look at it, so it costs no memory.
    stream.resume();
    return Promise.reject(httpError(413, `body is over ${maxBytes} bytes`));
  }
  // Hold the bytes when they come, not the declared length. So a client
  // that declares a large body and then sends nothing holds nothing.
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let failed = false;
    const fail = (error: Error) => {
      // Read the rest without keeping it, so the client gets the error.
      failed = true;
      chunks.length = 0;
      clearTimeout(deadline);
      reject(error);
    };
    // Node gives a whole request 300 s (`HTTP_OPTIONS`). That is too long
    // to hold a part of the budget, so these bodies have a shorter limit.
    const readMs = held.budget?.readMs;
    const deadline =
      readMs === undefined
        ? undefined
        : setTimeout(
            () =>
              fail(
                httpError(408, `the body did not come in ${readMs / 1000} s`),
              ),
            readMs,
          );
    stream.on("data", (chunk: Buffer) => {
      if (failed) return;
      size += chunk.length;
      if (size > maxBytes) {
        fail(httpError(413, `body is over ${maxBytes} bytes`));
      } else if (!hold(held, chunk.length)) {
        fail(busyError());
      } else {
        chunks.push(chunk);
      }
    });
    stream.on("end", () => {
      clearTimeout(deadline);
      resolve(Buffer.concat(chunks));
    });
    stream.on("error", (error: Error & { code?: string }) => {
      clearTimeout(deadline);
      // A client that closes its connection before its body came is not a
      // failure of the proxy, so it does not go to Sentry. `method` is set
      // only on a request, not on an upstream response.
      const aborted = stream.method !== null && error.code === "ECONNRESET";
      reject(aborted ? abortedError() : error);
    });
  });
}

/** The error of a request whose client closed it before its body came. */
const abortedError = () =>
  Object.assign(
    httpError(400, "the client closed the request before its body came"),
    { aborted: true },
  );

/**
 * Read a JSON object body of a control API call. A body over
 * `MAX_CONTROL_BODY_BYTES` fails with HTTP 413 before it is parsed. Any
 * other body that is not a JSON object fails with HTTP 400.
 */
export async function readJson<T>(incoming: http.IncomingMessage): Promise<T> {
  const text = (await readBody(incoming, MAX_CONTROL_BODY_BYTES)).toString(
    "utf8",
  );
  let value: unknown;
  try {
    value = JSON.parse(text || "{}");
  } catch {
    throw httpError(400, "body is not JSON");
  }
  // Callers read fields, so `null`, a list, or a single value is a bad body.
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw httpError(400, "body is not a JSON object");
  }
  return value as T;
}

/** Compare tokens in constant time. */
export function sameToken(
  actual: string | undefined,
  expected: string,
): boolean {
  if (actual === undefined) return false;
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Send a request to an allowed origin. The host, port, and scheme come from
 * the configuration. Only the path comes from the client. Without
 * `privateNetworks`, only public addresses get the request.
 */
function sendUpstream(
  origin: URL,
  request: ProxyRequest,
  privateNetworks: boolean,
  extraHeaders: http.OutgoingHttpHeaders = {},
): Promise<http.IncomingMessage> {
  const headers: http.OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(request.headers)) {
    if (value !== undefined && !HOP_HEADERS.has(name)) headers[name] = value;
  }
  headers.host = origin.host;
  if (request.body.length > 0) {
    headers["content-length"] = String(request.body.length);
  } else {
    delete headers["content-length"];
  }
  Object.assign(headers, extraHeaders);
  const client = origin.protocol === "https:" ? https : http;
  // A URL keeps the brackets of an IPv6 host. A request option has none.
  const hostname = origin.hostname.replace(/^\[|\]$/g, "");
  // Node does not call `lookup` for an IP address, so check it here.
  if (!privateNetworks && isIP(hostname) && !isPublicAddress(hostname)) {
    return Promise.reject(notPublicError(hostname, hostname));
  }
  return new Promise((resolve, reject) => {
    const upstream = client.request(
      {
        protocol: origin.protocol,
        hostname,
        port: origin.port || undefined,
        // The check is on the address of the connection. A kept-alive
        // connection had the check when it opened.
        lookup: privateNetworks ? undefined : publicLookup,
        servername: isIP(hostname) ? undefined : hostname,
        path: `${request.url.pathname}${request.url.search}`,
        method: request.method,
        headers,
      },
      resolve,
    );
    upstream.on("error", reject);
    upstream.end(request.body);
  });
}

/** Proxy one request to an allowed origin, through the recorder. */
async function proxyRequest(
  {
    recorder,
    origins,
    replayOnly,
    privateNetworks = false,
    maxBodyBytes = MAX_BODY_BYTES,
  }: ProxyTarget,
  session: string | undefined,
  incoming: http.IncomingMessage,
  outgoing: http.ServerResponse,
  tunnelOrigin: string | undefined,
  held: Held,
): Promise<void> {
  const url = new URL(
    tunnelOrigin ? `${tunnelOrigin}${incoming.url}` : (incoming.url ?? ""),
  );
  const origin = origins.get(url.origin);
  if (!origin) {
    process.stderr.write(`[roach] Refused ${url.origin}\n`);
    recorder.countRefused("notAllowed", url.origin);
    outgoing.writeHead(403, { "content-type": "text/plain" });
    outgoing.end(`Roach: ${url.origin} is not an allowed origin\n`);
    return;
  }
  const request: ProxyRequest = {
    method: incoming.method ?? "GET",
    url,
    headers: incoming.headers,
    body: await readBody(incoming, maxBodyBytes, held),
  };
  const rule = recorder.ruleFor(request);

  if (!rule && replayOnly) {
    // Without this, anyone could send live traffic through a public run.
    recorder.countRefused("replayOnly", origin.origin);
    outgoing.writeHead(403, { "content-type": "text/plain" });
    outgoing.end(
      "Roach: this run can only replay, and no rule records this request\n",
    );
    return;
  }
  if (!rule) {
    // Learn its credentials before it goes out, so that a later recording
    // that shows them has them redacted.
    recorder.learn(request.headers);
    const upstream = await sendUpstream(origin, request, privateNetworks);
    // Count it only when it went out. A refused address counts as refused.
    recorder.countPassthrough(origin.origin, session);
    outgoing.writeHead(upstream.statusCode ?? 502, upstream.statusMessage, {
      ...upstream.headers,
      "x-roach": "passthrough",
    });
    outgoing.on("close", () => upstream.destroy());
    upstream.pipe(outgoing);
    return;
  }

  const response = await recorder.respond(
    rule,
    request,
    async () => {
      // Ask for a plain body, so the recording is readable.
      const upstream = await sendUpstream(origin, request, privateNetworks, {
        "accept-encoding": "identity",
      });
      return {
        status: upstream.statusCode ?? 502,
        headers: upstream.headers,
        body: await readBody(upstream),
      };
    },
    session,
  );
  outgoing.writeHead(response.status, {
    ...response.headers,
    "content-length": String(response.body.length),
    "x-roach": response.source,
  });
  outgoing.end(response.body);
}

/** Write a JSON response. */
export function sendJson(
  outgoing: http.ServerResponse,
  status: number,
  body: unknown,
): void {
  outgoing.writeHead(status, { "content-type": "application/json" });
  outgoing.end(JSON.stringify(body));
}

/**
 * Answer a session or stats call of one recorder. `route` is the method
 * and the path after the prefix of the run, such as `POST /session`.
 * `sessionUrl` gives the proxy URL of a session id. Returns `false` when
 * the route is not one of them.
 */
export async function controlRecorder(
  recorder: Recorder,
  route: string,
  incoming: http.IncomingMessage,
  outgoing: http.ServerResponse,
  sessionUrl: (id: string) => string,
): Promise<boolean> {
  switch (route) {
    case "GET /stats":
      sendJson(outgoing, 200, recorder.stats());
      return true;
    // The recorder throws an error with a status for a fault of the client.
    // `listenProxy()` answers each error.
    case "POST /session": {
      const { name } = await readJson<{ name?: unknown }>(incoming);
      if (typeof name !== "string" || name === "") {
        sendJson(outgoing, 400, { error: "name must be a string" });
        return true;
      }
      const id = await recorder.startSession(name);
      sendJson(outgoing, 200, { url: sessionUrl(id) } satisfies OpenedSession);
      return true;
    }
    case "POST /session/end": {
      const { name, passed } = await readJson<{
        name?: unknown;
        passed?: unknown;
      }>(incoming);
      const missed = await recorder.endSession(String(name), passed === true);
      sendJson(outgoing, 200, { missed });
      return true;
    }
    default:
      return false;
  }
}

/** Where a proxied request goes: the allowed origins and the recorder. */
export interface ProxyTarget {
  origins: Map<string, URL>;
  recorder: Recorder;
  /**
   * Refuse requests that no rule matches, so nothing goes live. The
   * service sets this for a run without the write token.
   */
  replayOnly?: boolean;
  /**
   * Send requests to addresses that are not public too, such as
   * `127.0.0.1`. Only for tests and local development.
   */
  privateNetworks?: boolean;
  /** Set when the target stops. Its tunnels then refuse new requests. */
  closed?: boolean;
  /** A request body over this size gets HTTP 413. Default: 64 MiB. */
  maxBodyBytes?: number;
  /**
   * The budget that the request bodies of this target take from, until
   * each request finishes. A body that does not fit gets HTTP 503, and the
   * run goes on. Targets can share one budget.
   */
  bodyBudget?: BodyBudget;
  /**
   * The client whose part of `bodyBudget` the requests take. The service
   * sets it for a run without the token: the address group
   * (`clientGroup()`) of the client that started the run.
   */
  client?: string;
  /** The time of the last proxied request, from `Date.now()`. */
  lastUsed?: number;
  /** Gets a span for each proxied request. */
  telemetry: Telemetry;
}

/**
 * The target of a request and the session id of its proxy URL, or the HTTP
 * status that refuses the request.
 */
export type TargetResult =
  | { target: ProxyTarget; session: string | undefined }
  | { status: 403 | 407 };

/** The options of `listenProxy()`. */
export interface ListenOptions {
  host: string;
  port: number;
  authority: CertificateAuthority;
  /**
   * The target of a proxied request. It reads `Proxy-Authorization` of a
   * `CONNECT` or an absolute-form request.
   */
  targetFor(incoming: http.IncomingMessage): TargetResult;
  /** Answer a request to the proxy itself, such as the control API. */
  control(
    incoming: http.IncomingMessage,
    outgoing: http.ServerResponse,
  ): Promise<void>;
  /**
   * Send an unexpected error of `control` to Sentry. Returns the id of its
   * event, or `undefined` when nothing goes to Sentry.
   */
  capture(error: unknown): string | undefined;
  /**
   * Read a PROXY protocol v1 header at the start of a connection, when it
   * has one. A header that is not valid closes the connection.
   */
  proxyProtocol?: boolean;
}

/** A listening proxy socket. */
export interface ListeningProxy {
  port: number;
  close(): Promise<void>;
}

/** Refuse a proxied request that has no target. */
function refuse(status: 403 | 407, outgoing: http.ServerResponse): void {
  outgoing.writeHead(
    status,
    status === 407
      ? {
          "proxy-authenticate": 'Basic realm="roach"',
          "content-type": "text/plain",
        }
      : { "content-type": "text/plain" },
  );
  outgoing.end(
    `Roach: ${status === 407 ? "proxy credentials required" : "forbidden"}\n`,
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
function acceptProxied(socket: Socket, server: http.Server): void {
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

/** Proxy one request through its target, and answer errors with 502. */
function serveProxied(
  { target, session }: { target: ProxyTarget; session: string | undefined },
  incoming: http.IncomingMessage,
  outgoing: http.ServerResponse,
  tunnelOrigin: string | undefined,
): void {
  if (target.closed) {
    outgoing.writeHead(410, { "content-type": "text/plain" });
    outgoing.end("Roach: this run has ended\n");
    return;
  }
  target.lastUsed = Date.now();
  // Only the origin: the path and query can hold a credential.
  const origin = String(tunnelOrigin ?? URL.parse(incoming.url ?? "")?.origin);
  const method = incoming.method ?? "GET";
  const { telemetry } = target;
  telemetry
    .span(
      {
        op: "roach.request",
        name: `${method} ${origin}`,
        attributes: { "roach.origin": origin, "http.request.method": method },
      },
      async () => {
        const held: Held = {
          budget: target.bodyBudget,
          client: target.client ?? "",
          bytes: 0,
        };
        try {
          await proxyRequest(
            target,
            session,
            incoming,
            outgoing,
            tunnelOrigin,
            held,
          );
        } catch (error) {
          // In the span, so that the Sentry event is in the trace.
          answerError(target, origin, error, outgoing);
        } finally {
          release(held);
        }
        telemetry.annotate({
          "http.response.status_code": outgoing.statusCode,
        });
      },
    )
    .catch(() => outgoing.destroy());
}

/** Answer a proxied request that failed. See the start of this file. */
function answerError(
  target: ProxyTarget,
  origin: string,
  error: unknown,
  outgoing: http.ServerResponse,
): void {
  if ((error as { code?: string }).code === NOT_PUBLIC_CODE) {
    target.recorder.countRefused("notPublic", origin);
  }
  const status = (error as { status?: number }).status;
  const text =
    status === undefined
      ? reportInternal("Request", error, target.telemetry.capture(error))
      : (error as Error).message;
  // A body that did not fit in the budget, that did not come in time, or
  // whose client closed the request is not a miss and not an error. Count
  // it, so that Sentry shows it.
  const result = (error as { aborted?: boolean }).aborted
    ? "aborted"
    : status === 503
      ? "busy"
      : status === 408
        ? "timeout"
        : undefined;
  if (result) {
    target.telemetry.annotate({ "roach.result": result });
    target.telemetry.count("roach.request", 1, {
      "roach.origin": origin,
      "roach.result": result,
    });
  }
  if (!outgoing.headersSent) {
    outgoing.writeHead(status ?? 502, {
      "content-type": "text/plain",
      // Clients of model APIs send a 503 again, after this time in s.
      ...(status === 503 ? { "retry-after": "1" } : {}),
      // The rest of a slow body does not come in time, so close the
      // connection and do not wait for it.
      ...(status === 408 ? { connection: "close" } : {}),
    });
  }
  outgoing.end(`Roach error: ${text}\n`);
}

/**
 * Listen for proxied requests and control requests on one port. The
 * caller decides the target of each proxied request, so one port serves
 * many runs.
 */
export async function listenProxy(
  options: ListenOptions,
): Promise<ListeningProxy> {
  const { authority } = options;
  // The origin, target, and session of each tunnel. Absolute-form requests
  // have none.
  const tunnels = new WeakMap<
    Socket,
    { origin: string; target: ProxyTarget; session: string | undefined }
  >();
  const sockets = new Set<Socket>();

  // Requests inside a CONNECT tunnel. The tunnel gives the origin.
  const tunnelServer = http.createServer(HTTP_OPTIONS, (incoming, outgoing) => {
    const tunnel = tunnels.get(incoming.socket);
    if (!tunnel) {
      outgoing.writeHead(400).end();
      return;
    }
    serveProxied(tunnel, incoming, outgoing, tunnel.origin);
  });
  const server = http.createServer(HTTP_OPTIONS, (incoming, outgoing) => {
    // A request to the proxy itself has a path. A proxied plain HTTP
    // request has an absolute URL.
    if (!incoming.url?.startsWith("/")) {
      const target = options.targetFor(incoming);
      if ("status" in target) refuse(target.status, outgoing);
      else serveProxied(target, incoming, outgoing, undefined);
      return;
    }
    options.control(incoming, outgoing).catch((error: unknown) => {
      // An error with a status, such as 413 from readBody, is the fault of
      // the client. Any other error is a bug of the proxy or a failure of
      // the store.
      const status = (error as { status?: number }).status;
      const message =
        status === undefined
          ? reportInternal("Control", error, options.capture(error))
          : (error as Error).message;
      if (outgoing.headersSent) {
        outgoing.end();
        return;
      }
      sendJson(outgoing, status ?? 500, { error: message });
    });
  });
  // With `proxyProtocol`, a plain TCP server reads the PROXY header of a
  // connection, when it has one, and then gives it to `server`.
  const listener = options.proxyProtocol
    ? net.createServer((socket) => acceptProxied(socket, server))
    : server;
  listener.on("connection", (socket: Socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  server.on(
    "connect",
    (request: http.IncomingMessage, socket: Socket, head: Buffer) => {
      socket.on("error", () => socket.destroy());
      const target = options.targetFor(request);
      if ("status" in target) {
        socket.end(
          target.status === 407
            ? 'HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="roach"\r\n\r\n'
            : "HTTP/1.1 403 Forbidden\r\n\r\n",
        );
        return;
      }
      const match = AUTHORITY.exec(request.url ?? "");
      if (!match) {
        socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
        return;
      }
      const [, host, port] = match as unknown as [string, string, string];
      const allowed = [...target.target.origins.values()].some(
        (origin) => authorityOf(origin) === `${host.toLowerCase()}:${port}`,
      );
      if (!allowed) {
        process.stderr.write(`[roach] Refused ${host}:${port}\n`);
        // The scheme is not known before the tunnel opens. Most tunnels
        // are HTTPS on 443, so name them as their origin.
        const origin = port === "443" ? `https://${host}` : `${host}:${port}`;
        target.target.telemetry.span(
          {
            op: "roach.request",
            name: `CONNECT ${origin}`,
            attributes: {
              "roach.origin": origin,
              "http.request.method": "CONNECT",
            },
          },
          () => target.target.recorder.countRefused("notAllowed", origin),
        );
        socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
        return;
      }
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      // A tunnel that a client leaves open must not stay open forever.
      socket.setTimeout(TUNNEL_IDLE_MS, () => socket.destroy());
      const open = async (first: Buffer) => {
        socket.unshift(first);
        // A TLS handshake starts with byte 0x16. Anything else is plain HTTP.
        if (first[0] !== 0x16) {
          tunnels.set(socket, {
            ...target,
            origin: `http://${host}${port === "80" ? "" : `:${port}`}`,
          });
          tunnelServer.emit("connection", socket);
          socket.resume();
          return;
        }
        const secure = new tls.TLSSocket(socket, {
          isServer: true,
          secureContext: await authority.contextFor(host),
          ALPNProtocols: ["http/1.1"],
        });
        secure.on("error", () => secure.destroy());
        tunnels.set(secure, {
          ...target,
          origin: `https://${host}${port === "443" ? "" : `:${port}`}`,
        });
        tunnelServer.emit("connection", secure);
      };
      const onFirst = (first: Buffer) => {
        clearTimeout(firstByte);
        socket.pause();
        open(first).catch(() => socket.destroy());
      };
      const firstByte = setTimeout(() => {
        socket.off("data", onFirst);
        socket.destroy();
      }, TUNNEL_FIRST_BYTE_MS);
      if (head.length > 0) onFirst(head);
      else socket.once("data", onFirst);
    },
  );

  // Node checks `headersTimeout` and `requestTimeout` only after the
  // `listening` event of a server. The tunnel server, and `server` with
  // `proxyProtocol`, get their connections from another server and never
  // listen. So send the event to them. This relies on Node internals
  // (`setupConnectionsTracking` in `lib/_http_server.js`), and the test
  // "times out slow headers" fails when Node changes them.
  tunnelServer.emit("listening");
  if (listener !== server) server.emit("listening");
  await new Promise<void>((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(options.port, options.host, () => resolve());
  });
  const address = listener.address();
  if (!address || typeof address === "string") {
    throw new Error("Roach did not bind to a TCP port");
  }
  return {
    port: address.port,
    async close() {
      await new Promise<void>((resolve) => {
        listener.close(() => resolve());
        for (const socket of sockets) socket.destroy();
      });
      if (listener !== server) server.close();
      tunnelServer.close();
    },
  };
}

/**
 * The proxy sockets of the service (`service.ts`).
 *
 * The proxy is a forward proxy. It intercepts HTTPS with its own
 * certificate authority (`certificates.ts`). It gives each request that a
 * rule matches to the recorder (`recorder.ts`). Other requests go live
 * without a change, and their responses stream.
 *
 * It sends requests only to the `allow` origins. It refuses other origins
 * with HTTP 403 and sends nothing. The upstream host always comes from
 * `allow`, never from the client. Only the path comes from the client.
 *
 * Each response has an `x-roach` header: `replayed`, `live`,
 * `missed` (`replay` mode had no recording), or `passthrough` (no rule
 * matched).
 */
import { timingSafeEqual } from "node:crypto";
import http from "node:http";
import https from "node:https";
import { isIP, type Socket } from "node:net";
import tls from "node:tls";
import type { CertificateAuthority } from "./certificates.ts";
import type { ProxyRequest, Recorder } from "./recorder.ts";

/** The path prefix of the control API. */
export const CONTROL_PATH = "/__roach";

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
/** A request body over this size gets HTTP 413. */
const MAX_BODY_BYTES = 64 * 1024 * 1024;

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
 * Read a whole body. A body over `maxBytes` fails with HTTP 413. Only
 * request bodies have a limit: the client sends them, and a large upstream
 * response is not the fault of the client.
 */
function readBody(
  stream: http.IncomingMessage,
  maxBytes = Infinity,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    stream.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        // Read the rest without keeping it, so the client gets the 413.
        chunks.length = 0;
        reject(httpError(413, `body is over ${maxBytes} bytes`));
        return;
      }
      chunks.push(chunk);
    });
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
}

/** Read a JSON object request body. Any other body fails with HTTP 400. */
export async function readJson<T>(incoming: http.IncomingMessage): Promise<T> {
  const text = (await readBody(incoming, MAX_BODY_BYTES)).toString("utf8");
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
 * the configuration. Only the path comes from the client.
 */
function sendUpstream(
  origin: URL,
  request: ProxyRequest,
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
  return new Promise((resolve, reject) => {
    const upstream = client.request(
      {
        protocol: origin.protocol,
        hostname,
        port: origin.port || undefined,
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
  { recorder, origins, replayOnly }: ProxyTarget,
  incoming: http.IncomingMessage,
  outgoing: http.ServerResponse,
  tunnelOrigin: string | undefined,
): Promise<void> {
  const url = new URL(
    tunnelOrigin ? `${tunnelOrigin}${incoming.url}` : (incoming.url ?? ""),
  );
  const origin = origins.get(url.origin);
  if (!origin) {
    process.stderr.write(`[roach] Refused ${url.origin}\n`);
    outgoing.writeHead(403, { "content-type": "text/plain" });
    outgoing.end(`Roach: ${url.origin} is not an allowed origin\n`);
    return;
  }
  const request: ProxyRequest = {
    method: incoming.method ?? "GET",
    url,
    headers: incoming.headers,
    body: await readBody(incoming, MAX_BODY_BYTES),
  };
  const rule = recorder.ruleFor(request);

  if (!rule && replayOnly) {
    // Without this, anyone could send live traffic through a public run.
    outgoing.writeHead(403, { "content-type": "text/plain" });
    outgoing.end(
      "Roach: this run can only replay, and no rule records this request\n",
    );
    return;
  }
  if (!rule) {
    recorder.countPassthrough(origin.origin, request.headers);
    const upstream = await sendUpstream(origin, request);
    outgoing.writeHead(upstream.statusCode ?? 502, upstream.statusMessage, {
      ...upstream.headers,
      "x-roach": "passthrough",
    });
    outgoing.on("close", () => upstream.destroy());
    upstream.pipe(outgoing);
    return;
  }

  const response = await recorder.respond(rule, request, async () => {
    // Ask for a plain body, so the recording is readable.
    const upstream = await sendUpstream(origin, request, {
      "accept-encoding": "identity",
    });
    return {
      status: upstream.statusCode ?? 502,
      headers: upstream.headers,
      body: await readBody(upstream),
    };
  });
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
 * Returns `false` when the route is not one of them.
 */
export async function controlRecorder(
  recorder: Recorder,
  route: string,
  incoming: http.IncomingMessage,
  outgoing: http.ServerResponse,
): Promise<boolean> {
  switch (route) {
    case "GET /stats":
      sendJson(outgoing, 200, recorder.stats());
      return true;
    case "POST /session": {
      const { name } = await readJson<{ name?: unknown }>(incoming);
      if (typeof name !== "string" || name === "") {
        sendJson(outgoing, 400, { error: "name must be a string" });
        return true;
      }
      await recorder.startSession(name);
      outgoing.writeHead(204).end();
      return true;
    }
    case "POST /session/end": {
      const { name, passed } = await readJson<{
        name?: unknown;
        passed?: unknown;
      }>(incoming);
      try {
        const missed = await recorder.endSession(String(name), passed === true);
        sendJson(outgoing, 200, { missed });
      } catch (error) {
        sendJson(outgoing, 409, { error: (error as Error).message });
      }
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
  /** Set when the target stops. Its tunnels then refuse new requests. */
  closed?: boolean;
}

/** A target, or the HTTP status that refuses the request. */
export type TargetResult = ProxyTarget | { status: 403 | 407 };

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

/** Proxy one request through its target, and answer errors with 502. */
function serveProxied(
  target: ProxyTarget,
  incoming: http.IncomingMessage,
  outgoing: http.ServerResponse,
  tunnelOrigin: string | undefined,
): void {
  if (target.closed) {
    outgoing.writeHead(410, { "content-type": "text/plain" });
    outgoing.end("Roach: this run has ended\n");
    return;
  }
  proxyRequest(target, incoming, outgoing, tunnelOrigin).catch(
    (error: unknown) => {
      if (!outgoing.headersSent) {
        const status = (error as { status?: number }).status ?? 502;
        outgoing.writeHead(status, { "content-type": "text/plain" });
      }
      outgoing.end(
        `Roach error: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    },
  );
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
  // The origin and target of each tunnel. Absolute-form requests have none.
  const tunnels = new WeakMap<
    Socket,
    { origin: string; target: ProxyTarget }
  >();
  const sockets = new Set<Socket>();

  // Requests inside a CONNECT tunnel. The tunnel gives the origin.
  const tunnelServer = http.createServer((incoming, outgoing) => {
    const tunnel = tunnels.get(incoming.socket);
    if (!tunnel) {
      outgoing.writeHead(400).end();
      return;
    }
    serveProxied(tunnel.target, incoming, outgoing, tunnel.origin);
  });
  const server = http.createServer((incoming, outgoing) => {
    // A request to the proxy itself has a path. A proxied plain HTTP
    // request has an absolute URL.
    if (!incoming.url?.startsWith("/")) {
      const target = options.targetFor(incoming);
      if ("status" in target) refuse(target.status, outgoing);
      else serveProxied(target, incoming, outgoing, undefined);
      return;
    }
    options.control(incoming, outgoing).catch((error: unknown) => {
      process.stderr.write(`[roach] Control failed: ${String(error)}\n`);
      // An error with a status, such as 413 from readBody, is the fault of
      // the client. Any other error is a bug of the proxy.
      const status = (error as { status?: number }).status ?? 500;
      if (outgoing.headersSent) {
        outgoing.end();
        return;
      }
      sendJson(outgoing, status, {
        error: status === 500 ? "internal error" : (error as Error).message,
      });
    });
  });
  server.on("connection", (socket: Socket) => {
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
      const allowed = [...target.origins.values()].some(
        (origin) => authorityOf(origin) === `${host.toLowerCase()}:${port}`,
      );
      if (!allowed) {
        process.stderr.write(`[roach] Refused ${host}:${port}\n`);
        socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
        return;
      }
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      const open = async (first: Buffer) => {
        socket.unshift(first);
        // A TLS handshake starts with byte 0x16. Anything else is plain HTTP.
        if (first[0] !== 0x16) {
          tunnels.set(socket, {
            origin: `http://${host}${port === "80" ? "" : `:${port}`}`,
            target,
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
          origin: `https://${host}${port === "443" ? "" : `:${port}`}`,
          target,
        });
        tunnelServer.emit("connection", secure);
      };
      const onFirst = (first: Buffer) => {
        socket.pause();
        open(first).catch(() => socket.destroy());
      };
      if (head.length > 0) onFirst(head);
      else socket.once("data", onFirst);
    },
  );

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Roach did not bind to a TCP port");
  }
  return {
    port: address.port,
    async close() {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        for (const socket of sockets) socket.destroy();
      });
      tunnelServer.close();
    },
  };
}

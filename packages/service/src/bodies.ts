/**
 * Request bodies of the proxy and the control API: their size limits, the
 * budget of bytes that the bodies of many runs share (`BodyBudget`), and
 * the time that a body has to come.
 */
import type http from "node:http";
import { httpError } from "./errors.ts";

/**
 * A control API body over this size gets HTTP 413. Anyone can call
 * `POST /runs`, so the service reads no more before it checks the token.
 */
const MAX_CONTROL_BODY_BYTES = 1024 * 1024;

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
export interface Held {
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
export function release(held: Held): void {
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
export function readBody(
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

/**
 * Request bodies of the proxy and the control API, and their size limits.
 */
import type http from "node:http";
import { httpError } from "./errors.ts";

/** A control API body over this size gets HTTP 413. */
const MAX_CONTROL_BODY_BYTES = 1024 * 1024;

/**
 * Read a whole body. A body over `maxBytes` fails with HTTP 413. Only
 * request bodies have a limit: the client sends them, and a large upstream
 * response is not the fault of the client.
 */
export function readBody(
  stream: http.IncomingMessage,
  maxBytes = Infinity,
): Promise<Buffer> {
  const declared = Number(stream.headers["content-length"]);
  if (declared > maxBytes) {
    // Drop the body without a look at it, so it costs no memory.
    stream.resume();
    return Promise.reject(httpError(413, `body is over ${maxBytes} bytes`));
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let failed = false;
    const fail = (error: Error) => {
      // Read the rest without keeping it, so the client gets the error.
      failed = true;
      chunks.length = 0;
      reject(error);
    };
    stream.on("data", (chunk: Buffer) => {
      if (failed) return;
      size += chunk.length;
      if (size > maxBytes) {
        fail(httpError(413, `body is over ${maxBytes} bytes`));
      } else {
        chunks.push(chunk);
      }
    });
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", (error: Error & { code?: string }) => {
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

/**
 * The conversion between a live response and the recording file that the
 * recorder writes (`recorder.ts`).
 *
 * `toRecording()` makes a recording from a live response: a text body
 * when the response is text, and else base64. `fromRecording()` makes the
 * response that a replay sends. `decodeBody()` reads a compressed body,
 * with a limit on its decoded size.
 */
import { promisify } from "node:util";
import { brotliDecompress, gunzip, inflate, zstdDecompress } from "node:zlib";
import type { ProxyRequest, ProxyResponse } from "./recorder.ts";
import type { KeyedRequest } from "./request-key.ts";
import { redactRequestUrl } from "./secrets.ts";
import type { Recording } from "./store.ts";
import {
  isEventStream,
  mapStreamEvents,
  mergeStreamDeltas,
} from "./streams.ts";
import type { RecordingRule } from "@sentry/roach/types";
import {
  fillValues,
  templateValues,
  type RequestValues,
} from "@sentry/roach/values";

/** Content types that a recording keeps as text. Other bodies are base64. */
const TEXT_CONTENT_TYPE = /^text\/|json|xml|x-www-form-urlencoded/i;

/** Response headers that a recording keeps. Other headers change each run. */
export const RECORDED_HEADERS = ["content-type", "location"];

const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);

/**
 * The largest body that the recorder decodes from a content encoding. It
 * is the largest request body that the proxy reads (`server.ts`), so a
 * small compressed body cannot fill the memory of the service.
 */
const MAX_DECODED_BYTES = 64 * 1024 * 1024;

/**
 * Decoders of the content encodings that the recorder can read. They run
 * on the thread pool of zlib, so they do not block other requests.
 */
const DECODERS: Record<
  string,
  (body: Buffer, options: { maxOutputLength: number }) => Promise<Buffer>
> = {
  gzip: promisify(gunzip),
  "x-gzip": promisify(gunzip),
  deflate: promisify(inflate),
  br: promisify(brotliDecompress),
  zstd: promisify(zstdDecompress),
};

/**
 * The body of a response without its content encoding. The proxy asks for
 * `identity`, but an upstream can encode the body all the same, and the
 * recorder must decode it to find credentials in it. An empty body, such
 * as of a 304, stays empty. Rejects when it does not know an encoding,
 * when the body is not valid, or when the decoded body is larger than
 * `MAX_DECODED_BYTES`.
 */
export async function decodeBody({
  headers,
  body,
}: ProxyResponse): Promise<Buffer> {
  if (body.length === 0) return body;
  const encodings = (headers["content-encoding"] ?? "")
    .split(",")
    .map((encoding) => encoding.trim().toLowerCase())
    .filter((encoding) => encoding !== "" && encoding !== "identity");
  let result = body;
  for (const encoding of encodings.toReversed()) {
    const decoder = DECODERS[encoding];
    if (!decoder) throw new Error(`unknown content encoding ${encoding}`);
    result = await decoder(result, { maxOutputLength: MAX_DECODED_BYTES });
  }
  return result;
}

/** The text of `body` when it is valid UTF-8, or `undefined`. */
export function utf8Text(body: Buffer): string | undefined {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      body,
    );
  } catch {
    return undefined;
  }
}

/**
 * The response as a recording keeps it. A stream gets one delta per content
 * block, and each value of the request becomes a placeholder. A body that
 * is not text gets `redactBytes` before it is encoded, because a redaction
 * of the encoded text cannot find a credential in it. The URL has the
 * value of each credential query parameter redacted, and of each
 * parameter that holds the value of a credential field of the body
 * (`redactRequestUrl`).
 */
export function toRecording(
  request: ProxyRequest,
  rule: RecordingRule,
  keyed: KeyedRequest,
  session: string | undefined,
  response: ProxyResponse,
  redactBytes: (body: Buffer) => Buffer,
): Recording {
  const contentType = response.headers["content-type"];
  const headers: Record<string, string> = {};
  for (const name of RECORDED_HEADERS) {
    const value = response.headers[name];
    if (typeof value === "string") headers[name] = value;
  }
  let body = "";
  let bodyEncoding: Recording["response"]["bodyEncoding"] = "base64";
  if (!TEXT_CONTENT_TYPE.test(contentType ?? "")) {
    body = redactBytes(response.body).toString("base64");
  } else {
    const text = response.body.toString("utf8");
    const template = (part: string) => templateValues(part, keyed.values);
    body = isEventStream(contentType)
      ? mapStreamEvents(mergeStreamDeltas(text), template)
      : template(text);
    bodyEncoding = "utf8";
  }
  return {
    session,
    request: {
      method: request.method,
      url: redactRequestUrl(request, rule),
    },
    response: { status: response.status, headers, body, bodyEncoding },
  };
}

/** The response of a recording, with the values of the current request. */
export function fromRecording(
  { response }: Recording,
  values: RequestValues,
): ProxyResponse {
  const body = NULL_BODY_STATUSES.has(response.status)
    ? Buffer.alloc(0)
    : response.bodyEncoding === "utf8"
      ? Buffer.from(fillValues(response.body, values))
      : Buffer.from(response.body, "base64");
  return { status: response.status, headers: response.headers, body };
}

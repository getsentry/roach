/**
 * The key of a recorded request.
 *
 * The key is the hash of the rule, the method, the URL, the key headers,
 * and the body. A JSON body has sorted object keys, so key order does not
 * matter. Each changing value of the rule is `<<name>>` in the key
 * (`values.ts`).
 *
 * The patterns of `values` come from the client, and all runs share one
 * process. A slow pattern would block every run, so a key has a time limit
 * (`KEY_TIME_LIMIT`).
 */
import { createHash } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import { THINKING_BLOCK_TYPES } from "./streams.ts";
import type { RecordingRule } from "./types.ts";
import {
  extractValues,
  type KnownValues,
  type RequestValues,
  type ValuePatterns,
  withTimeLimit,
} from "./values.ts";

/** Change this to make every recording a miss. */
const KEY_VERSION = "http-v1";

/**
 * The time that the key of one request can take: 1 s, and 0.5 s for each
 * MiB of the body. The built-in patterns take less than 0.1 s for each
 * MiB. A key that takes longer fails its request, and other runs go on.
 */
const KEY_TIME_LIMIT = { baseMs: 1000, msPerMiB: 500 };

/** The parts of a request that make its key. */
interface RequestToKey {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: string;
}

/** A request as the key sees it. */
export interface KeyedRequest {
  /** The name of the recording file, without `.json`. */
  key: string;
  /**
   * The changing values of the request outside thinking blocks, in their
   * order. They fill the placeholders of a replayed response.
   */
  values: RequestValues;
}

/** JSON with sorted object keys, so equal bodies give equal keys. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries
    .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
    .join(",")}}`;
}

function parseJson(body: string): unknown {
  try {
    return body ? JSON.parse(body) : undefined;
  } catch {
    return undefined;
  }
}

/** Marks the place of a thinking block in the text of a body. */
const THINKING_MARK = /"\uE000(\d+)"/g;

/**
 * The text of a JSON value with `<<name>>` for each changing value, and the
 * values outside thinking blocks.
 *
 * A replay keeps the recorded text of a thinking block (`streams.ts`), and
 * a later request sends it back. So its values come from the recording
 * run. They are in the key, but they do not fill placeholders, and known
 * values of this run are not looked for in them.
 */
function normalizeJson(
  json: unknown,
  patterns: ValuePatterns | undefined,
  known: KnownValues | undefined,
): { text: string; values: RequestValues } {
  const thinking: string[] = [];
  const mark = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(mark);
    if (value === null || typeof value !== "object") return value;
    const record = value as Record<string, unknown>;
    if (THINKING_BLOCK_TYPES.has(String(record.type))) {
      thinking.push(extractValues(stableStringify(record), patterns).text);
      return `\uE000${thinking.length - 1}`;
    }
    return Object.fromEntries(
      Object.entries(record).map(([name, item]) => [name, mark(item)]),
    );
  };
  const { text, values } = extractValues(
    stableStringify(mark(json)),
    patterns,
    known,
  );
  return {
    text: text.replace(THINKING_MARK, (_, index) => thinking[Number(index)]!),
    values,
  };
}

const sha256 = (text: string) =>
  createHash("sha256").update(text).digest("hex");
/**
 * The key and the changing values of a request. `known` holds
 * the values of earlier requests in the same session (`values.ts`). It
 * throws an error with HTTP status 400 when it takes too long.
 */
export function keyRequest(
  rule: RecordingRule,
  request: RequestToKey,
  known?: KnownValues,
): KeyedRequest {
  const mib = Buffer.byteLength(request.body) / (1024 * 1024);
  return withTimeLimit(
    Math.ceil(KEY_TIME_LIMIT.baseMs + KEY_TIME_LIMIT.msPerMiB * mib),
    () => keyRequestNow(rule, request, known),
  );
}

function keyRequestNow(
  rule: RecordingRule,
  request: RequestToKey,
  known?: KnownValues,
): KeyedRequest {
  const headers = Object.fromEntries(
    (rule.keyHeaders ?? []).map((name) => [
      name,
      String(request.headers[name] ?? ""),
    ]),
  );
  const json = parseJson(request.body);
  const { text, values } =
    json === undefined
      ? extractValues(request.body, rule.values, known)
      : normalizeJson(json, rule.values, known);
  const key = sha256(
    [
      KEY_VERSION,
      rule.name,
      request.method,
      request.url,
      ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
      text,
    ].join("\n"),
  );
  return { key, values };
}

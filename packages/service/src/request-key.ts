/**
 * The key of a recorded request.
 *
 * The key is the hash of the rule name, the method, the URL, the key
 * headers, and the body. It does not use `match` of the rule, so a change
 * to its URL prefixes keeps the keys. A JSON body has sorted object keys,
 * so key order does not matter. Each changing value of the rule is
 * `<<name>>` in the key (`@sentry/roach/values`).
 *
 * The patterns of `values` come from the client, and all runs share one
 * process. A slow pattern would block every run. So a key has a time
 * limit (`keyTimeLimit()`), and the service makes the keys of runs without
 * the token in a worker process (`key-worker.ts`).
 */
import { createHash } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import { parseJson } from "./json-strings.ts";
import { THINKING_BLOCK_TYPES } from "./streams.ts";
import type { RecordingRule } from "@sentry/roach/types";
import {
  extractValues,
  type KnownValues,
  type RequestValues,
  type ValuePatterns,
  withTimeLimit,
} from "@sentry/roach/values";

/** Change this to make every recording a miss. */
const KEY_VERSION = "http-v1";

/**
 * The time that the key of one request can take: 1 s, and 0.5 s for each
 * MiB of the body. The built-in patterns take about 60 to 110 ms for each
 * MiB. A key that takes longer fails its request, and other runs go on.
 */
const KEY_TIME_LIMIT = { baseMs: 1000, msPerMiB: 500 };

/** The time limit of the key of a body of `bytes` bytes, in ms. */
export function keyTimeLimit(bytes: number): number {
  const mib = bytes / (1024 * 1024);
  return Math.ceil(KEY_TIME_LIMIT.baseMs + KEY_TIME_LIMIT.msPerMiB * mib);
}

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
   * The text that the key hashes: the rule, the method, the URL, the key
   * headers, and the normalized body. A miss compares it with the text of
   * a recorded request (`misses.ts`).
   */
  text: string;
  /**
   * The changing values of the request outside thinking blocks, in their
   * order. They fill the placeholders of a replayed response.
   */
  values: RequestValues;
}

/**
 * JSON with sorted object keys, so equal bodies give equal keys. A value
 * in `replace` is written as its string instead.
 */
function stableStringify(
  value: unknown,
  replace?: ReadonlyMap<object, string>,
): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  const replaced = replace?.get(value);
  if (replaced !== undefined) return JSON.stringify(replaced);
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item, replace)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries
    .map(
      ([key, item]) =>
        `${JSON.stringify(key)}:${stableStringify(item, replace)}`,
    )
    .join(",")}}`;
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
  maxValues: number,
): { text: string; values: RequestValues } {
  const thinking: string[] = [];
  // The mark of each thinking block, numbered in the order of the body.
  // The text gets the mark in place of the block, without a copy of the
  // body, because a copy of a large body needs hundreds of MiB.
  const marks = new Map<object, string>();
  // The values of thinking blocks count toward `maxValues` too.
  let left = maxValues;
  const mark = (value: unknown): void => {
    if (value === null || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) mark(item);
      return;
    }
    const record = value as Record<string, unknown>;
    if (THINKING_BLOCK_TYPES.has(String(record.type))) {
      const block = extractValues(
        stableStringify(record),
        patterns,
        undefined,
        left,
      );
      for (const list of block.values.values()) left -= list.length;
      thinking.push(block.text);
      marks.set(record, `\uE000${thinking.length - 1}`);
      return;
    }
    for (const item of Object.values(record)) mark(item);
  };
  mark(json);
  const { text, values } = extractValues(
    stableStringify(json, marks),
    patterns,
    known,
    left,
  );
  return {
    text: text.replace(THINKING_MARK, (_, index) => thinking[Number(index)]!),
    values,
  };
}

const sha256 = (text: string) =>
  createHash("sha256").update(text).digest("hex");
/**
 * The key and the changing values of a request. `known` holds the values
 * of earlier requests in the same session (`@sentry/roach/values`). It
 * throws an error with HTTP status 400 when it takes longer than
 * `timeLimitMs`, by default `keyTimeLimit()` of the body, when the
 * request has more than `maxValues` changing values, or when its JSON body
 * is nested too deep for the key. The limits never change a key: a request
 * gets its key, or it fails.
 */
export function keyRequest(
  rule: RecordingRule,
  request: RequestToKey,
  known?: KnownValues,
  timeLimitMs = keyTimeLimit(Buffer.byteLength(request.body)),
  maxValues = Infinity,
): KeyedRequest {
  try {
    return withTimeLimit(timeLimitMs, () =>
      keyRequestNow(rule, request, known, maxValues),
    );
  } catch (error) {
    // The key walks a JSON body with recursion, so a body that is nested
    // very deep, such as 5,000 levels of `[`, fills the call stack. Such a
    // body never got a key. It is the fault of the client, so it gets HTTP
    // 400 and does not go to Sentry.
    const overflow =
      error instanceof RangeError &&
      error.message === "Maximum call stack size exceeded";
    if (!overflow) throw error;
    throw Object.assign(
      new Error("the JSON body is nested too deep to make its key"),
      { status: 400 },
    );
  }
}

function keyRequestNow(
  rule: RecordingRule,
  request: RequestToKey,
  known: KnownValues | undefined,
  maxValues: number,
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
      ? extractValues(request.body, rule.values, known, maxValues)
      : normalizeJson(json, rule.values, known, maxValues);
  const keyText = [
    KEY_VERSION,
    rule.name,
    request.method,
    request.url,
    ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
    text,
  ].join("\n");
  return { key: sha256(keyText), text: keyText, values };
}

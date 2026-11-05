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
 * process. A slow pattern would block every run. So the patterns see only
 * the start of a large body (`MAX_VALUE_TEXT`), and they have a time limit
 * (`KEY_TIME_LIMIT_MS`).
 */
import { createHash } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
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
 * The characters of a body that the value patterns see: 4 Mi. The key
 * keeps the text after them as it is, so a changing value there changes
 * the key. The thinking blocks of a JSON body come after its other text.
 */
const MAX_VALUE_TEXT = 4 * 1024 * 1024;
/**
 * The time that the value patterns of one request can take. The built-in
 * patterns take about 60 ms for each Mi characters. A request whose
 * patterns take longer fails with HTTP 400, and other runs go on.
 */
const KEY_TIME_LIMIT_MS = 500;

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
 * `extractValues()` on the first `budget.left` characters of `text`. The
 * rest of the text stays as it is.
 */
function extractCapped(
  text: string,
  patterns: ValuePatterns | undefined,
  budget: { left: number },
  known?: KnownValues,
): { text: string; values: RequestValues } {
  const size = Math.min(text.length, budget.left);
  budget.left -= size;
  if (size === text.length) return extractValues(text, patterns, known);
  const head = extractValues(text.slice(0, size), patterns, known);
  return { text: head.text + text.slice(size), values: head.values };
}

/**
 * The text of a JSON value, with a mark in place of each thinking block,
 * and the text of each thinking block.
 */
function markThinking(json: unknown): { text: string; thinking: string[] } {
  const thinking: string[] = [];
  const mark = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(mark);
    if (value === null || typeof value !== "object") return value;
    const record = value as Record<string, unknown>;
    if (THINKING_BLOCK_TYPES.has(String(record.type))) {
      thinking.push(stableStringify(record));
      return `\uE000${thinking.length - 1}`;
    }
    return Object.fromEntries(
      Object.entries(record).map(([name, item]) => [name, mark(item)]),
    );
  };
  return { text: stableStringify(mark(json)), thinking };
}

/**
 * The text of a body with `<<name>>` for each changing value, and the
 * values outside thinking blocks. It throws an error with HTTP status 400
 * when the patterns take too long.
 *
 * A replay keeps the recorded text of a thinking block (`streams.ts`), and
 * a later request sends it back. So its values come from the recording
 * run. They are in the key, but they do not fill placeholders, and known
 * values of this run are not looked for in them.
 */
function normalizeBody(
  body: string,
  patterns: ValuePatterns | undefined,
  known: KnownValues | undefined,
): { text: string; values: RequestValues } {
  const json = parseJson(body);
  // Only the patterns have a time limit. The other work is linear in the
  // size of the body, which has a limit (`server.ts`).
  const marked =
    json === undefined ? { text: body, thinking: [] } : markThinking(json);
  return withTimeLimit(KEY_TIME_LIMIT_MS, () => {
    const budget = { left: MAX_VALUE_TEXT };
    const main = extractCapped(marked.text, patterns, budget, known);
    if (json === undefined) return main;
    const thinking = marked.thinking.map(
      (block) => extractCapped(block, patterns, budget).text,
    );
    return {
      text: main.text.replace(
        THINKING_MARK,
        (_, index) => thinking[Number(index)]!,
      ),
      values: main.values,
    };
  });
}

const sha256 = (text: string) =>
  createHash("sha256").update(text).digest("hex");
/**
 * The key and the changing values of a request. `known` holds the values
 * of earlier requests in the same session (`@sentry/roach/values`). It
 * throws an error with HTTP status 400 when its value patterns take too
 * long.
 */
export function keyRequest(
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
  const { text, values } = normalizeBody(request.body, rule.values, known);
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

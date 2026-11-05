/**
 * The JSON reads of the service.
 *
 * `parseJson()` parses a whole body, for the key (`request-key.ts`) and
 * the token usage (`usage.ts`). `parseJsonSkipBom()` also skips a byte
 * order mark at the start, for the redaction of credentials
 * (`secrets.ts`). The key does not skip it, so that no key changes.
 * `scanStrings()` reads JSON text in one pass and gives each
 * string with its depth, whether it is a field name, and its escapes.
 * `decodeString()` decodes one string.
 */

/** The parsed value of a JSON text, or `undefined` when it is not JSON. */
export const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

/**
 * The parsed value of a JSON text, or `undefined` when it is not JSON. A
 * byte order mark at the start does not count.
 */
export const parseJsonSkipBom = (text: string): unknown =>
  parseJson(text.startsWith("\uFEFF") ? text.slice(1) : text);

/** Tells whether a parsed JSON value is an object that is not an array. */
export const isObject = (json: unknown): json is Record<string, unknown> =>
  json !== null && typeof json === "object" && !Array.isArray(json);

const QUOTE = 0x22;

const BACKSLASH = 0x5c;

const LINE_BREAK = 0x0a;

const COLON = 0x3a;

/** `{` or `[`. A compare is faster than a set for each character. */
export const isOpen = (code: number) => code === 0x7b || code === 0x5b;

/** `}` or `]`. */
const isClose = (code: number) => code === 0x7d || code === 0x5d;

/** Space, tab, line feed, or carriage return. */
export const isJsonSpace = (code: number) =>
  code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d;

/**
 * The escapes of a JSON string: it has none, all are valid, or one is not
 * valid (or it has a control character), so `JSON.parse` would throw.
 */
export type Escapes = "none" | "valid" | "bad";

/**
 * The escapes that are not `u` escapes, by the character after the
 * backslash, and the character that each one gives.
 */
const SIMPLE_ESCAPES = new Map([
  [0x22, '"'],
  [0x5c, "\\"],
  [0x2f, "/"],
  [0x62, "\b"],
  [0x66, "\f"],
  [0x6e, "\n"],
  [0x72, "\r"],
  [0x74, "\t"],
]);

const U = 0x75;

/** Tells whether the character at `at` of `text` is a hex digit. */
function isHex(text: string, at: number): boolean {
  const code = text.charCodeAt(at);
  return (
    (code >= 0x30 && code <= 0x39) ||
    (code >= 0x41 && code <= 0x46) ||
    (code >= 0x61 && code <= 0x66)
  );
}

/** Tells whether `text` has a valid `u` escape at `at` (its backslash). */
const uEscape = (text: string, at: number) =>
  text.charCodeAt(at + 1) === U &&
  isHex(text, at + 2) &&
  isHex(text, at + 3) &&
  isHex(text, at + 4) &&
  isHex(text, at + 5);

/**
 * Call `visit` for each JSON string of `text`, in one pass: its start, its
 * end after the closing quote, the depth of objects and arrays around it,
 * whether it is a field name (a `:` follows it), its escapes (`Escapes`),
 * and the length of its value. The length is right only when the escapes
 * are valid. A string ends at a line break, because JSON does not allow
 * one in a string. So a line that is not JSON, such as a header line in
 * the text of a key, cannot make it read the next lines wrong.
 */
export function scanStrings(
  text: string,
  visit: (
    start: number,
    end: number,
    depth: number,
    name: boolean,
    escapes: Escapes,
    length: number,
  ) => void,
): void {
  let depth = 0;
  let at = 0;
  while (at < text.length) {
    const code = text.charCodeAt(at);
    if (isOpen(code)) depth += 1;
    else if (isClose(code)) depth -= 1;
    if (code !== QUOTE) {
      at += 1;
      continue;
    }
    let end = at + 1;
    let escapes: Escapes = "none";
    let length = 0;
    while (end < text.length) {
      const next = text.charCodeAt(end);
      if (next === QUOTE) break;
      if (next === LINE_BREAK) break;
      length += 1;
      if (next === BACKSLASH && text.charCodeAt(end + 1) !== LINE_BREAK) {
        if (escapes === "none") escapes = "valid";
        // The hex digits of a `u` escape cannot be a quote or a line break.
        if (uEscape(text, end)) end += 6;
        else {
          if (!SIMPLE_ESCAPES.has(text.charCodeAt(end + 1))) escapes = "bad";
          end += 2;
        }
      } else {
        // JSON does not allow a control character, such as a tab, in a
        // string. A header line can have one.
        if (next < 0x20) escapes = "bad";
        end += 1;
      }
    }
    if (text.charCodeAt(end) !== QUOTE) {
      // Not a string. Each quote before `end` has a backslash before it, so
      // no string can start there either. Go on at `end`, so each character
      // is read once.
      at = end;
      continue;
    }
    end += 1;
    let after = end;
    while (isJsonSpace(text.charCodeAt(after))) after += 1;
    visit(at, end, depth, text.charCodeAt(after) === COLON, escapes, length);
    at = end;
  }
}

/**
 * The value of the JSON string from `start` to `end` of `text`, or
 * `undefined` when its escapes are not valid (`scanStrings`). It decodes
 * the escapes itself, so it does not throw and it costs little for each
 * string. A `u` escape gives one UTF-16 code unit, as in `JSON.parse`, so a
 * lone surrogate stays.
 */
export function decodeString(
  text: string,
  start: number,
  end: number,
  escapes: Escapes,
): string | undefined {
  if (escapes === "none") return text.slice(start + 1, end - 1);
  if (escapes === "bad") return undefined;
  let value = "";
  let from = start + 1;
  let at = from;
  while (at < end - 1) {
    if (text.charCodeAt(at) !== BACKSLASH) {
      at += 1;
      continue;
    }
    value += text.slice(from, at);
    const next = text.charCodeAt(at + 1);
    if (next === U) {
      value += String.fromCharCode(
        Number.parseInt(text.slice(at + 2, at + 6), 16),
      );
      at += 6;
    } else {
      value += SIMPLE_ESCAPES.get(next)!;
      at += 2;
    }
    from = at;
  }
  return value + text.slice(from, end - 1);
}

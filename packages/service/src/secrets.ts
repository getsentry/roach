/**
 * Credentials that the proxy must never write to disk.
 *
 * The proxy learns the values of credential headers and query parameters
 * from each request that it sees, and the config can add more values. It
 * replaces each known value with `<<redacted>>` before it writes a
 * recording, in text and in bytes. It also replaces the value of each
 * credential field, such as an `access_token` that a server mints in a
 * JSON body, and the value of each credential parameter of a URL that a
 * recording keeps.
 *
 * It parses a JSON body and walks it to find the fields. Then it replaces
 * them in one pass over the JSON strings of the text (`scanStrings`). It
 * does not run a regular expression on JSON text, because a long string
 * value can overflow the stack of the expression, and it does not run a
 * pass for each value, because a client can send many. So it finds a
 * field whose name or value has a unicode escape. It does not find a field
 * whose value is not a string, such as an array, or a field in JSON text
 * that is itself a string, such as the escaped arguments of a tool call.
 */
import type { IncomingHttpHeaders } from "node:http";

/**
 * Request headers and query parameters that can carry credentials. The
 * match is broad on purpose: redacting a value that is not a credential
 * costs little.
 */
const CREDENTIAL_HEADER =
  /auth|token|secret|key|cookie|session|password|credential|signature/i;
/**
 * Headers that match `CREDENTIAL_HEADER` but carry no credential. A response
 * can show their values, and the client must get them back without a change.
 * AI Gateway clients put a conversation id in `x-session-affinity`, and a
 * model can repeat that id in its response. Node gives header names in
 * lower case.
 */
const NOT_CREDENTIAL_HEADERS = new Set(["x-session-affinity"]);
/** Shorter parts, such as `Bearer`, are not credentials. */
const MIN_LENGTH = 12;
const REDACTED = "<<redacted>>";
const REDACTED_BYTES = Buffer.from(REDACTED);

/** The name of a field, as the field lists compare it. */
function fieldName(name: string): string {
  return name.replaceAll(/[_-]/g, "").toLowerCase();
}

/**
 * Fields of a response body whose value is a credential that a server
 * mints, such as the token of an OAuth server. The recorder replaces their
 * values only in what it writes, so a replay gives `<<redacted>>` there.
 * The list is short, and only the top of a JSON body counts, on purpose. A
 * model can repeat a part of its response in a later request, such as the
 * input of a tool call, and a redacted value there would change the key of
 * that request. The names compare without case, `_`, and `-`, so
 * `accessToken` is `access_token`.
 */
const MINTED_FIELDS = new Set(
  [
    "access_token",
    "refresh_token",
    "id_token",
    "session_token",
    "auth_token",
    "client_secret",
  ].map(fieldName),
);
/**
 * Fields whose value is a credential, for the text of a request: a request
 * sample and the text of a miss. No key uses this text, so the list can be
 * longer than `MINTED_FIELDS`.
 */
const CREDENTIAL_FIELDS = new Set(
  [
    ...MINTED_FIELDS,
    "bearer_token",
    "client_assertion",
    "password",
    "api_key",
    "secret_key",
    "private_key",
    "secret_access_key",
  ].map(fieldName),
);
/**
 * A value of a bare `token` field that is a credential: a GitHub token, a
 * JWT, or a Slack token. Model APIs also use `token` for text, such as in
 * log probabilities, so only these prefixes count, and never the length.
 */
const TOKEN_VALUE =
  /^(?:gh[pousr]_|github_pat_|xox[abprs]-|eyJ[^.\s"]*\.[^.\s"]*\.)/;

/**
 * Tells whether a field or a parameter holds a credential, from its
 * decoded name and value.
 */
type CredentialTest = (name: string, value: string) => boolean;

/**
 * The test for the fields of `fields`, and for a bare `token` field with a
 * credential prefix.
 */
const fieldTest =
  (fields: Set<string>): CredentialTest =>
  (name, value) => {
    if (value === "" || value === REDACTED) return false;
    const key = fieldName(name);
    return fields.has(key) || (key === "token" && TOKEN_VALUE.test(value));
  };
const isMinted = fieldTest(MINTED_FIELDS);
/** Tells whether a field of `name` can hold a minted credential. */
const mintedName = (name: string) =>
  MINTED_FIELDS.has(fieldName(name)) || fieldName(name) === "token";
const isCredentialField = fieldTest(CREDENTIAL_FIELDS);
/** A query parameter whose name can mean a credential, at any value. */
const isCredentialParam: CredentialTest = (name) =>
  CREDENTIAL_HEADER.test(name);

/**
 * The parsed value of a JSON text, or `undefined` when it is not JSON. A
 * byte order mark at the start does not count.
 */
const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text.startsWith("\uFEFF") ? text.slice(1) : text);
  } catch {
    return undefined;
  }
};

/**
 * The string values of the credential fields of a JSON value. With `deep`,
 * it looks in each object at each depth, and else only in the object at the
 * top. It walks with a list, not with recursion, so a deep value cannot
 * overflow the stack. It does not look in the value of a credential field
 * that is not a string, such as an array.
 */
function credentialValues(
  json: unknown,
  test: CredentialTest,
  deep: boolean,
): string[] {
  const found: string[] = [];
  const pending = [json];
  while (pending.length > 0) {
    const value = pending.pop();
    if (value === null || typeof value !== "object") continue;
    if (Array.isArray(value)) {
      // An item of a list has no field name. Look only in its objects.
      if (!deep) continue;
      for (const item of value) {
        if (item !== null && typeof item === "object") pending.push(item);
      }
      continue;
    }
    // `for...in`, not `Object.entries`, so an object with many fields does
    // not make a list of pairs. A parsed value has only its own fields.
    for (const name in value) {
      const item = (value as Record<string, unknown>)[name];
      if (typeof item === "string" && test(name, item)) found.push(item);
      else if (deep && item !== null && typeof item === "object") {
        pending.push(item);
      }
    }
  }
  return found;
}

const REDACTED_JSON = `"${REDACTED}"`;
const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const LINE_BREAK = 0x0a;
const COLON = 0x3a;
/** `{` or `[`. A compare is faster than a set for each character. */
const isOpen = (code: number) => code === 0x7b || code === 0x5b;
/** `}` or `]`. */
const isClose = (code: number) => code === 0x7d || code === 0x5d;
/** Space, tab, line feed, or carriage return. */
const isJsonSpace = (code: number) =>
  code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d;

/**
 * The escapes of a JSON string: it has none, all are valid, or one is not
 * valid (or it has a control character), so `JSON.parse` would throw.
 */
type Escapes = "none" | "valid" | "bad";
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
function scanStrings(
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
 * The longest name of a field, as it is sent, that `replaceStrings`
 * decodes to find a credential field. A longer name, such as one with
 * many `_`, is not decoded. Then only its value can match, and the check
 * of `redactRequestWith` finds a value that stays.
 */
const MAX_NAME_LENGTH = 64;

/**
 * The kind of a field of `name`: a credential field at any value, a bare
 * `token` that is a credential only with a credential prefix, or neither.
 */
function fieldKind(name: string): "credential" | "token" | undefined {
  const key = fieldName(name);
  if (CREDENTIAL_FIELDS.has(key)) return "credential";
  return key === "token" ? "token" : undefined;
}

/** Tells whether a field of `name` can hold a credential (`fieldKind`). */
const credentialName = (name: string) => fieldKind(name) !== undefined;

/**
 * `text` with each JSON string replaced by `"<<redacted>>"` when it is one
 * of `values`, or when it is the value of a credential field
 * (`CREDENTIAL_FIELDS`, and a bare `token` with a credential prefix), in
 * one pass. It compares the value of each string, so a value written with
 * `\/` or a unicode escape matches too. Only a whole string matches, so a
 * short value cannot change other text. It decodes only a string whose
 * value has the length of one of `values`, the name of a field, and the
 * value of a bare `token`. A credential field matches by its place, so a
 * value pattern that changed a part of its value does not show the rest.
 */
function replaceStrings(text: string, values: Set<string>): string {
  const lengths = new Set([...values].map((value) => value.length));
  const parts: string[] = [];
  let from = 0;
  // The start of the value of the last credential field name, and the
  // kind of that field.
  let valueAt = -1;
  let field: "credential" | "token" | undefined;
  scanStrings(text, (start, end, _depth, name, escapes, length) => {
    const of = valueAt === start ? field : undefined;
    valueAt = -1;
    field = undefined;
    if (name && length <= MAX_NAME_LENGTH) {
      const decoded = decodeString(text, start, end, escapes);
      field = decoded === undefined ? undefined : fieldKind(decoded);
      if (field !== undefined) {
        // A `:` follows the name after spaces (`scanStrings`), and the
        // value starts after the spaces after it.
        let at = end;
        while (isJsonSpace(text.charCodeAt(at))) at += 1;
        at += 1;
        while (isJsonSpace(text.charCodeAt(at))) at += 1;
        valueAt = at;
      }
    }
    // An empty value shows nothing.
    let replace = of === "credential" && end - start > 2;
    if (!replace && (of === "token" || lengths.has(length))) {
      const value = decodeString(text, start, end, escapes);
      replace =
        value !== undefined &&
        (values.has(value) || (of === "token" && TOKEN_VALUE.test(value)));
    }
    if (!replace) return;
    parts.push(text.slice(from, start), REDACTED_JSON);
    from = end;
  });
  parts.push(text.slice(from));
  return parts.join("");
}

/**
 * Tells whether a parsed JSON body, after `replaceStrings`, shows no
 * credential field value: no string, as a key or a value, is one of
 * `values`, and no credential field holds a value other than
 * `<<redacted>>` or an empty string. It walks with a list, so a deep value
 * cannot overflow the stack.
 */
function showsNoField(json: unknown, values: Set<string>): boolean {
  // A compare of lengths first, so most strings need no hash.
  const lengths = new Set([...values].map((value) => value.length));
  const isValue = (text: string) =>
    lengths.has(text.length) && values.has(text);
  if (typeof json === "string") return !isValue(json);
  const pending = [json];
  while (pending.length > 0) {
    const value = pending.pop();
    if (value === null || typeof value !== "object") continue;
    if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === "string") {
          if (isValue(item)) return false;
        } else if (item !== null && typeof item === "object") {
          pending.push(item);
        }
      }
      continue;
    }
    for (const name in value) {
      if (isValue(name)) return false;
      const item = (value as Record<string, unknown>)[name];
      if (typeof item === "string") {
        if (isValue(item) || isCredentialField(name, item)) return false;
      } else if (item !== null && typeof item === "object") {
        pending.push(item);
      }
    }
  }
  return true;
}

/**
 * Tells whether `redacted` holds `<<redacted>>` at the place of each
 * credential field of `json`, the parsed body of the request. The text of
 * a key keeps the places of the body, but a value pattern can take a
 * field away, such as with its name and a part of its value. A count of
 * fields would not see that when the body also has a field that holds
 * `<<redacted>>`. It walks the two values together, with a list.
 */
function keepsFields(json: unknown, redacted: unknown): boolean {
  const pending: [unknown, unknown][] = [[json, redacted]];
  while (pending.length > 0) {
    const [value, other] = pending.pop()!;
    if (value === null || typeof value !== "object") continue;
    if (other === null || typeof other !== "object") return false;
    if (Array.isArray(value)) {
      if (!Array.isArray(other)) return false;
      for (let index = 0; index < value.length; index += 1) {
        const item: unknown = value[index];
        if (item !== null && typeof item === "object") {
          pending.push([item, other[index]]);
        }
      }
      continue;
    }
    const fields = other as Record<string, unknown>;
    for (const name in value) {
      const item = (value as Record<string, unknown>)[name];
      if (typeof item === "string") {
        if (isCredentialField(name, item) && fields[name] !== REDACTED) {
          return false;
        }
      } else if (item !== null && typeof item === "object") {
        pending.push([item, fields[name]]);
      }
    }
  }
  return true;
}

/**
 * The number of credential fields of the lines of a form body, with each
 * field that holds `<<redacted>>`, and the decoded values of the others
 * (`CREDENTIAL_FIELDS`).
 */
function formFields(lines: string[]): { count: number; values: string[] } {
  const values: string[] = [];
  let count = 0;
  for (const line of lines) {
    for (const part of paramParts(line)) {
      const name = decode(part.name);
      const value = decode(part.value);
      if (part.value && isCredentialField(name, value)) values.push(value);
      else if (value === REDACTED && credentialName(name)) count += 1;
    }
  }
  return { count: count + values.length, values };
}

/**
 * Tells whether the lines of a form body, after `redactForm`, show no
 * credential field value, as `showsNoField` does for JSON, and still have
 * `expected` credential fields that hold `<<redacted>>`. The count
 * includes the fields that held `<<redacted>>` before (`formFields`), so
 * such a field cannot take the place of a field that a value pattern took
 * away.
 */
function formShowsNoField(
  lines: string[],
  values: Set<string>,
  expected: number,
): boolean {
  let count = 0;
  for (const line of lines) {
    for (const part of paramParts(line)) {
      const name = decode(part.name);
      const value = decode(part.value);
      if (values.has(name) || values.has(value)) return false;
      if (isCredentialField(name, value)) return false;
      if (value === REDACTED && credentialName(name)) count += 1;
    }
  }
  return count >= expected;
}

/** Tells whether a parsed JSON value is an object that is not an array. */
const isObject = (json: unknown): json is Record<string, unknown> =>
  json !== null && typeof json === "object" && !Array.isArray(json);

/** Tells whether the field `name` of `json` holds a minted value. */
const mintedValue = (json: Record<string, unknown>, name: string) => {
  const value = json[name];
  return typeof value === "string" && isMinted(name, value);
};

/**
 * The value of the JSON string from `start` to `end` of `text`, or
 * `undefined` when its escapes are not valid (`scanStrings`). It decodes
 * the escapes itself, so it does not throw and it costs little for each
 * string. A `u` escape gives one UTF-16 code unit, as in `JSON.parse`, so a
 * lone surrogate stays.
 */
function decodeString(
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

/**
 * The JSON text of a response body with the value of each minted field of
 * the object at the top replaced (`isMinted`), and those values. It
 * replaces only the value after the name of its field, so the same text
 * at other places, and all other bytes, do not change. Text that is not a
 * JSON object does not change. It throws when a minted value stays in the
 * result, so the caller does not record the body.
 */
function replaceMinted(text: string): { text: string; minted: string[] } {
  const json = parseJson(text);
  const none = { text, minted: [] };
  if (!isObject(json)) return none;
  // The fields of the top object that can hold a minted value.
  const names: string[] = [];
  for (const name in json) if (mintedName(name)) names.push(name);
  if (!names.some((name) => mintedValue(json, name))) return none;
  const minted: string[] = [];
  const parts: string[] = [];
  let from = 0;
  // The place of the last name. It decodes the name only when a string
  // value comes after it, so many fields with other values cost little.
  let field: { start: number; end: number; escapes: Escapes } | undefined;
  scanStrings(text, (start, end, depth, name, escapes) => {
    if (depth !== 1) return;
    if (name) {
      field = { start, end, escapes };
      return;
    }
    if (field === undefined) return;
    const of = decodeString(text, field.start, field.end, field.escapes);
    field = undefined;
    // Decode only the values of fields that can be minted.
    if (of === undefined || !mintedName(of)) return;
    const value = decodeString(text, start, end, escapes);
    if (value === undefined || !isMinted(of, value)) return;
    minted.push(value);
    parts.push(text.slice(from, start), REDACTED_JSON);
    from = end;
  });
  parts.push(text.slice(from));
  const result = parts.join("");
  // Parse the result again, and fail when a minted value stays. The pass
  // replaces only whole strings with strings, so the names of the fields
  // do not change. Thus only the names from the first parse can hold one.
  const again = parseJson(result);
  if (!isObject(again) || names.some((name) => mintedValue(again, name))) {
    throw new Error("a minted credential stayed in the body");
  }
  return { text: result, minted };
}

/** Decode a part of a query, or keep it when it is not valid. */
const decode = (part: string) => {
  try {
    return decodeURIComponent(part.replaceAll("+", " "));
  } catch {
    return part;
  }
};

/**
 * The parts of a query, a fragment, or a form without its `?` or `#`, as
 * they are sent: each part, its name, and its value.
 */
const paramParts = (params: string) =>
  params.split("&").map((part) => {
    const at = part.indexOf("=");
    const name = at < 0 ? part : part.slice(0, at);
    const value = at < 0 ? "" : part.slice(at + 1);
    return { part, name, value };
  });

/**
 * `params` with the value of each parameter that `test` finds replaced.
 * `test` gets the decoded name and value.
 */
const redactParams = (params: string, test: CredentialTest) =>
  paramParts(params)
    .map(({ part, name, value }) =>
      value && test(decode(name), decode(value)) ? `${name}=${REDACTED}` : part,
    )
    .join("&");

/**
 * The text of an `application/x-www-form-urlencoded` body, line by line,
 * with the value of each field that `test` finds replaced.
 */
const redactForm = (text: string, test: CredentialTest) =>
  text
    .split("\n")
    .map((line) => redactParams(line, test))
    .join("\n");

/** Tells whether a content type is `application/x-www-form-urlencoded`. */
const isForm = (contentType: string | string[] | undefined) =>
  /^application\/x-www-form-urlencoded\b/i.test(String(contentType ?? ""));

/**
 * A URL as a recording and a request sample keep it, such as the URL of a
 * request: the value of each parameter of its query and its fragment that
 * `test` finds is replaced at any length. By default, that is each
 * parameter whose name can mean a credential. The other parts do not
 * change, and a relative URL stays relative.
 */
export function redactUrl(
  href: string,
  test: CredentialTest = isCredentialParam,
): string {
  const hash = href.indexOf("#");
  const beforeHash = hash < 0 ? href : href.slice(0, hash);
  const question = beforeHash.indexOf("?");
  let result = beforeHash;
  if (question >= 0) {
    const query = redactParams(beforeHash.slice(question + 1), test);
    result = `${beforeHash.slice(0, question)}?${query}`;
  }
  if (hash >= 0) result += `#${redactParams(href.slice(hash + 1), test)}`;
  return result;
}

/**
 * Add `value` and its parts to `into`, such as the token of
 * `Bearer <token>` or each value of a cookie header. Add each part with
 * `\/` for `/` to `derived`: a server can write a copy of it so, such as
 * PHP `json_encode`. These forms come from a value that the limit counts,
 * so the limit does not count them again. The whole value does not get
 * them when it has parts, because its parts cover a copy of it. So a
 * header such as a SigV4 `Authorization`, with a new value with `/` on
 * each request, does not make the list longer.
 */
function add(value: string, into: Set<string>, derived = into): void {
  const parts = value.split(/[\s;,=]+/);
  for (const part of [value, ...parts]) {
    if (part.length < MIN_LENGTH) continue;
    into.add(part);
    // The recorder redacts JSON text, which escapes `"`, `\`, and control
    // characters.
    into.add(JSON.stringify(part).slice(1, -1));
  }
  for (const part of parts) {
    if (part.length < MIN_LENGTH || !part.includes("/")) continue;
    // A recording keeps such a body as it is, and its JSON text escapes
    // the `\` again.
    const slashed = JSON.stringify(part).slice(1, -1).replaceAll("/", "\\/");
    derived.add(slashed);
    derived.add(JSON.stringify(slashed).slice(1, -1));
  }
}

/**
 * The most values that one run learns from its requests and its own
 * `secrets`, and their total length in characters. The values of
 * `initial` do not count.
 */
export interface LearnLimit {
  values: number;
  length: number;
}

/** `text` with each of `values` replaced. Give longer values first. */
function redactWith(values: string[], text: string): string {
  let result = text;
  for (const value of values) result = result.replaceAll(value, REDACTED);
  return result;
}

/** A request as its redacted text needs it (`redactRequestWith`). */
export interface RequestToRedact {
  href: string;
  body: string;
  contentType: string | string[] | undefined;
}

/**
 * The text of `request`, such as the text that its key hashes, with each
 * of `values` replaced. Give longer values first. It also replaces the
 * value of each credential field (`CREDENTIAL_FIELDS`) at any depth of a
 * JSON body, or of an `application/x-www-form-urlencoded` body. These
 * values do not join the known credentials. In the first copy of the URL,
 * the value of each credential query parameter is replaced at any length,
 * and each parameter whose value is the value of a credential field.
 *
 * Then it checks the result, and returns `undefined` when the text can
 * still show the value of a credential field. A value pattern can take a
 * quote, a name, or a part of a value away. For a JSON body, it parses the
 * body of the text again: the body must be JSON, `showsNoField` must find
 * no value, and `keepsFields` must find each field in its place. For a
 * form body, `formShowsNoField` must find no value.
 * Each step reads the text once, so a long text or many values cost
 * little.
 */
export function redactRequestWith(
  values: string[],
  text: string,
  request: RequestToRedact,
): string | undefined {
  const form = isForm(request.contentType)
    ? formFields(request.body.split("\n"))
    : undefined;
  const json = form ? undefined : parseJson(request.body);
  const fields = form
    ? form.values
    : credentialValues(json, isCredentialField, true);
  const known = new Set(fields);
  const href = redactUrl(
    request.href,
    (name, value) => isCredentialParam(name, value) || known.has(value),
  );
  const result = text.replace(request.href, () => href);
  if (form) {
    const redacted = redactWith(values, redactForm(result, isCredentialField));
    if (form.count === 0) return redacted;
    // The body comes after the URL. A credential parameter of the URL is
    // `<<redacted>>` too, and it must not count. A replacement does not
    // add or take away a line.
    const url = result.split("\n").indexOf(href);
    const body = redacted.split("\n").slice(url + 1);
    return formShowsNoField(body, known, form.count) ? redacted : undefined;
  }
  if (fields.length === 0) return redactWith(values, result);
  const redacted = redactWith(values, replaceStrings(result, known));
  // The body of a JSON request is the last line of the text of its key,
  // because JSON text has no line break.
  const body = parseJson(redacted.slice(redacted.lastIndexOf("\n") + 1));
  return body !== undefined &&
    showsNoField(body, known) &&
    keepsFields(json, body)
    ? redacted
    : undefined;
}

/**
 * Create the secret list of one proxy run, with the values of `initial`.
 * A request that would make the run learn more than `limit` fails with
 * HTTP 431 and learns nothing. So the proxy never forgets a credential
 * that it saw, and it never sends or records such a request.
 */
export function createSecrets(initial: string[], limit: LearnLimit) {
  const values = new Set<string>();
  let learned = { values: 0, length: 0 };
  initial.forEach((value) => add(value, values));
  // Redact longer values first, so no part of one stays visible.
  const longestFirst = () =>
    [...values].toSorted((a, b) => b.length - a.length);

  /** `text` with each known credential replaced. */
  const redact = (text: string): string => redactWith(longestFirst(), text);

  /**
   * Add the values in `seen` that are new. When they make the run go past
   * `limit`, it throws an error with `status` and adds nothing.
   */
  const admit = (
    seen: Set<string>,
    derived: Set<string>,
    status: number,
  ): void => {
    const next = { ...learned };
    for (const part of seen) {
      if (values.has(part)) continue;
      next.values += 1;
      next.length += part.length;
    }
    if (next.values > limit.values || next.length > limit.length) {
      throw Object.assign(
        new Error(
          `this run cannot learn more credentials (${limit.values} values or ${limit.length} characters, with the parts of each value). Start a new run.`,
        ),
        { status },
      );
    }
    learned = next;
    for (const part of seen) values.add(part);
    for (const part of derived) values.add(part);
  };

  /**
   * `body` with each known credential replaced, as bytes. Only the bytes of
   * a known value change, so a binary body stays binary.
   */
  const redactBytes = (body: Buffer): Buffer => {
    let result = body;
    for (const value of longestFirst()) {
      const needle = Buffer.from(value);
      let at = result.indexOf(needle);
      if (at < 0) continue;
      const parts: Buffer[] = [];
      let from = 0;
      while (at >= 0) {
        parts.push(result.subarray(from, at), REDACTED_BYTES);
        from = at + needle.length;
        at = result.indexOf(needle, from);
      }
      parts.push(result.subarray(from));
      result = Buffer.concat(parts);
    }
    return result;
  };

  return {
    /**
     * Learn the credentials in the headers of a request, and in the query
     * of its `url`. A query value is learned as it is sent and decoded.
     * Past the limit, it throws an error with HTTP status 431.
     */
    learn(headers: IncomingHttpHeaders, url?: URL): void {
      const seen = new Set<string>();
      const derived = new Set<string>();
      for (const [name, value] of Object.entries(headers)) {
        if (!CREDENTIAL_HEADER.test(name) || value === undefined) continue;
        if (NOT_CREDENTIAL_HEADERS.has(name)) continue;
        for (const item of Array.isArray(value) ? value : [value]) {
          add(item, seen, derived);
        }
      }
      for (const { name, value } of url
        ? paramParts(url.search.slice(1))
        : []) {
        if (!CREDENTIAL_HEADER.test(decode(name))) continue;
        add(value, seen, derived);
        add(decode(value), seen, derived);
      }
      admit(seen, derived, 431);
    },

    /**
     * Add the `secrets` of a run. Each value and each of its parts count
     * toward the limit. Past it, it throws an error with HTTP status 400.
     */
    addRunSecrets(secrets: string[]): void {
      const seen = new Set<string>();
      const derived = new Set<string>();
      for (const value of secrets) add(value, seen, derived);
      admit(seen, derived, 400);
    },

    redact,

    redactBytes,

    /** The known credentials, longer values first (`redactRequestWith`). */
    list: longestFirst,

    /**
     * The text of a response body with the value of each minted credential
     * replaced: each field of `MINTED_FIELDS`, and a bare `token` with a
     * credential prefix. In JSON, only the fields of the object at the top
     * count, because a server puts a minted credential there. A field at a
     * lower depth, such as in the input of a tool call, does not change,
     * because a later request can repeat it, and its key must not change.
     * In an `application/x-www-form-urlencoded` body, the form fields
     * count. Other text does not change. The values join the known
     * credentials, so later recordings of the run do not show them either.
     * They do not count toward the limit, because only a run that records
     * gets them, from an upstream that `allow` names.
     */
    redactFields(text: string, contentType?: string): string {
      if (isForm(contentType)) {
        return redactForm(text, (name, value) => {
          if (!isMinted(name, value)) return false;
          add(value, values);
          return true;
        });
      }
      const result = replaceMinted(text);
      for (const value of result.minted) add(value, values);
      return result.text;
    },

    /**
     * A `location` header as a recording keeps it: the value of each
     * minted credential parameter of its query and its fragment is
     * replaced (`MINTED_FIELDS`, and a bare `token` with a credential
     * prefix), such as `#access_token=`. Other parameters do not change,
     * so a replay can follow the redirect. The values join the known
     * credentials, as in `redactFields`.
     */
    redactLocation(href: string): string {
      return redactUrl(href, (name, value) => {
        if (!isMinted(name, value)) return false;
        add(value, values);
        return true;
      });
    },

    /**
     * The text of `request`, such as the text that its key hashes, with
     * each known credential and each credential field replaced
     * (`redactRequestWith`).
     */
    redactRequest(
      text: string,
      request: { url: URL; headers: IncomingHttpHeaders; body: Buffer },
    ): string | undefined {
      return redactRequestWith(longestFirst(), text, {
        href: request.url.href,
        body: request.body.toString("utf8"),
        contentType: request.headers["content-type"],
      });
    },
  };
}

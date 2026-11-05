/**
 * Credentials that the proxy must never write to disk.
 *
 * The proxy learns the values of credential headers and query parameters
 * from each request that it sees, and the config can add more values. It
 * replaces each known value with `<<redacted>>` before it writes a
 * recording, in text and in bytes. It also replaces the value of each
 * credential field (`CREDENTIAL_FIELDS`), such as an `access_token` that a
 * server mints in a JSON body, and the value of each credential query parameter of the URL
 * that a recording keeps.
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

/**
 * Fields whose value is a credential, such as a token that a server mints
 * or a secret that a client sends in a body. The names compare without
 * case, `_`, and `-`, so `access_token`, `accessToken`, and `access-token`
 * are the same. The list is narrow on purpose: a replay gives
 * `<<redacted>>` in place of each such value, and a broad match would
 * change responses that have no credential. A bare `token` is not in it,
 * because model APIs use it for text, such as in log probabilities.
 */
const CREDENTIAL_FIELDS = new Set(
  [
    "access_token",
    "refresh_token",
    "id_token",
    "auth_token",
    "bearer_token",
    "session_token",
    "client_secret",
    "client_assertion",
    "password",
    "api_key",
    "secret_key",
    "private_key",
    "secret_access_key",
  ].map(fieldName),
);
/** A JSON field with a string value: its name, the separator, its value. */
const JSON_FIELD = /"([\w-]{1,64})"(\s*:\s*)"((?:[^"\\]|\\.)*)"/g;
/**
 * A form or query field, at the start of a line or after `?` or `&`: the
 * part before it, its name, and its value.
 */
const FORM_FIELD = /(^|[?&])([\w-]{1,64})=([^&\s"#\\]*)/gm;

/** The name of a field, as `CREDENTIAL_FIELDS` compares it. */
function fieldName(name: string): string {
  return name.replaceAll(/[_-]/g, "").toLowerCase();
}

/** Whether a field holds a credential that is not redacted yet. */
const isCredentialField = (name: string, value: string) =>
  value !== "" && value !== REDACTED && CREDENTIAL_FIELDS.has(fieldName(name));

/** `text` with the value of each credential field replaced. */
const replaceFields = (
  text: string,
  found: (value: string, form: boolean) => void = () => {},
) =>
  text
    .replace(JSON_FIELD, (all, name: string, colon: string, value: string) => {
      if (!isCredentialField(name, value)) return all;
      found(value, false);
      return `"${name}"${colon}"${REDACTED}"`;
    })
    .replace(FORM_FIELD, (all, before: string, name: string, value: string) => {
      if (!isCredentialField(name, value)) return all;
      found(value, true);
      return `${before}${name}=${REDACTED}`;
    });

/** Decode a part of a query, or keep it when it is not valid. */
const decode = (part: string) => {
  try {
    return decodeURIComponent(part.replaceAll("+", " "));
  } catch {
    return part;
  }
};

/**
 * The parts of the query of `url`, as they are sent: each part, its value,
 * and whether its name can mean a credential.
 */
const queryParts = (url: URL) =>
  url.search
    .slice(1)
    .split("&")
    .map((part) => {
      const at = part.indexOf("=");
      const name = at < 0 ? part : part.slice(0, at);
      const value = at < 0 ? "" : part.slice(at + 1);
      return {
        part,
        name,
        value,
        credential: CREDENTIAL_HEADER.test(decode(name)),
      };
    });

/**
 * The URL of `url`, as a recording and a request sample keep it: the value
 * of each credential query parameter is replaced at any length. The other
 * parts do not change.
 */
export function redactUrl(url: URL): string {
  if (!url.search) return url.href;
  const search = queryParts(url)
    .map(({ part, name, value, credential }) =>
      credential && value ? `${name}=${REDACTED}` : part,
    )
    .join("&");
  return url.href.replace(url.search, () => `?${search}`);
}

/** Create the secret list of one proxy run, with the values of `initial`. */
export function createSecrets(initial: string[] = []) {
  const values = new Set<string>();
  // Keep the whole value and its parts, such as the token of
  // `Bearer <token>` or each value of a cookie header.
  const add = (value: string) => {
    for (const part of [value, ...value.split(/[\s;,=]+/)]) {
      if (part.length < MIN_LENGTH) continue;
      values.add(part);
      // The recorder redacts JSON text, which escapes `"`, `\`, and
      // control characters.
      values.add(JSON.stringify(part).slice(1, -1));
    }
  };
  initial.forEach(add);
  // Redact longer values first, so no part of one stays visible.
  const longestFirst = () =>
    [...values].toSorted((a, b) => b.length - a.length);

  /** `text` with each known credential replaced. */
  const redact = (text: string): string => {
    let result = text;
    for (const value of longestFirst()) {
      result = result.replaceAll(value, REDACTED);
    }
    return result;
  };

  return {
    /**
     * Learn the credentials in the headers of a request, and in the query
     * of its `url`. A query value is learned as it is sent and decoded.
     */
    learn(headers: IncomingHttpHeaders, url?: URL): void {
      for (const [name, value] of Object.entries(headers)) {
        if (!CREDENTIAL_HEADER.test(name) || value === undefined) continue;
        if (NOT_CREDENTIAL_HEADERS.has(name)) continue;
        for (const item of Array.isArray(value) ? value : [value]) add(item);
      }
      for (const { value, credential } of url ? queryParts(url) : []) {
        if (!credential) continue;
        add(value);
        add(decode(value));
      }
    },

    redact,

    /**
     * `body` with each known credential replaced, as bytes. Only the bytes
     * of a known value change, so a binary body stays binary.
     */
    redactBytes(body: Buffer): Buffer {
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
    },

    /**
     * The text of a response body with the value of each credential field
     * replaced (`CREDENTIAL_FIELDS`), in JSON and in form fields. The
     * values join the known credentials, so later recordings of the run do
     * not show them either.
     */
    redactFields(text: string): string {
      return replaceFields(text, (value, form) => {
        if (form) return add(decode(value));
        try {
          add(JSON.parse(`"${value}"`) as string);
        } catch {
          add(value);
        }
      });
    },

    /**
     * The text of a request to `url`, such as the text that its key hashes,
     * with each known credential and the value of each credential field
     * replaced. In the first copy of the URL, the value of each
     * credential query parameter is replaced at any length.
     */
    redactRequest(text: string, url: URL): string {
      const href = redactUrl(url);
      return redact(replaceFields(text.replace(url.href, () => href)));
    },
  };
}

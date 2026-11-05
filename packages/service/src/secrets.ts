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
 * The list is short on purpose. A model can repeat a field of its response
 * in a later request, such as the input of a tool call, and a redacted
 * value there would change the key of that request. The names compare
 * without case, `_`, and `-`, so `accessToken` is `access_token`.
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
 * A JSON field with a string value: its name, the separator, its value.
 * It does not match a name with a unicode escape, a field whose value is
 * an array, or a field in a JSON text that is itself a string, such as the
 * escaped arguments of a tool call.
 */
const JSON_FIELD = /"([\w-]{1,64})"(\s*:\s*)"((?:[^"\\]|\\.)*)"/g;
/**
 * A form, query, or fragment field, at the start of a line or after `?`,
 * `&`, or `#`: the part before it, its name, and its value.
 */
const FORM_FIELD = /(^|[?&#])([\w-]{1,64})=([^&\s"#\\]*)/gm;

/**
 * `text` with the value of each credential field of `fields` replaced, and
 * of each bare `token` field with a credential prefix. `found` gets each
 * value, and `form` tells whether it is URL encoded.
 */
const replaceFields = (
  text: string,
  fields: Set<string>,
  found: (value: string, form: boolean) => void = () => {},
) => {
  const isCredential = (name: string, value: string) => {
    if (value === "" || value === REDACTED) return false;
    const key = fieldName(name);
    return fields.has(key) || (key === "token" && TOKEN_VALUE.test(value));
  };
  return text
    .replace(JSON_FIELD, (all, name: string, colon: string, value: string) => {
      if (!isCredential(name, value)) return all;
      found(value, false);
      return `"${name}"${colon}"${REDACTED}"`;
    })
    .replace(FORM_FIELD, (all, before: string, name: string, value: string) => {
      if (!isCredential(name, value)) return all;
      found(value, true);
      return `${before}${name}=${REDACTED}`;
    });
};

/** Decode a part of a query, or keep it when it is not valid. */
const decode = (part: string) => {
  try {
    return decodeURIComponent(part.replaceAll("+", " "));
  } catch {
    return part;
  }
};

/**
 * The parts of a query or a fragment without its `?` or `#`, as they are
 * sent: each part, its value, and whether its name can mean a credential.
 */
const paramParts = (params: string) =>
  params.split("&").map((part) => {
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

/** `params` with the value of each credential parameter replaced. */
const redactParams = (params: string) =>
  paramParts(params)
    .map(({ part, name, value, credential }) =>
      credential && value ? `${name}=${REDACTED}` : part,
    )
    .join("&");

/**
 * A URL as a recording and a request sample keep it, such as the URL of a
 * request or a `location` header: the value of each credential parameter
 * of its query and its fragment is replaced at any length. The other parts
 * do not change, and a relative URL stays relative.
 */
export function redactUrl(href: string): string {
  const hash = href.indexOf("#");
  const beforeHash = hash < 0 ? href : href.slice(0, hash);
  const question = beforeHash.indexOf("?");
  let result = beforeHash;
  if (question >= 0) {
    const query = redactParams(beforeHash.slice(question + 1));
    result = `${beforeHash.slice(0, question)}?${query}`;
  }
  if (hash >= 0) result += `#${redactParams(href.slice(hash + 1))}`;
  return result;
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
     */
    learn(headers: IncomingHttpHeaders, url?: URL): void {
      for (const [name, value] of Object.entries(headers)) {
        if (!CREDENTIAL_HEADER.test(name) || value === undefined) continue;
        if (NOT_CREDENTIAL_HEADERS.has(name)) continue;
        for (const item of Array.isArray(value) ? value : [value]) add(item);
      }
      for (const { value, credential } of url
        ? paramParts(url.search.slice(1))
        : []) {
        if (!credential) continue;
        add(value);
        add(decode(value));
      }
    },

    redact,

    redactBytes,

    /**
     * The text of a response body with the value of each minted credential
     * field replaced (`MINTED_FIELDS`, and a bare `token` with a credential
     * prefix), in JSON and in form fields. The values join the known
     * credentials, so later recordings of the run do not show them either.
     */
    redactFields(text: string): string {
      return replaceFields(text, MINTED_FIELDS, (value, form) => {
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
     * (`CREDENTIAL_FIELDS`) replaced. In the first copy of the URL, the
     * value of each credential query parameter is replaced at any length.
     */
    redactRequest(text: string, url: URL): string {
      const href = redactUrl(url.href);
      return redact(
        replaceFields(
          text.replace(url.href, () => href),
          CREDENTIAL_FIELDS,
        ),
      );
    },
  };
}

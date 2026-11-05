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
 * It parses a JSON body and walks it to find the fields. It does not run a
 * regular expression on JSON text, because a long string value can
 * overflow the stack of the expression. So it finds a field whose name
 * has a unicode escape. It does not find a field whose value is not a
 * string, such as an array, or a field in JSON text that is itself a
 * string, such as the escaped arguments of a tool call.
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
const isCredentialField = fieldTest(CREDENTIAL_FIELDS);
/** A query parameter whose name can mean a credential, at any value. */
const isCredentialParam: CredentialTest = (name) =>
  CREDENTIAL_HEADER.test(name);

/** The parsed value of a JSON text, or `undefined` when it is not JSON. */
const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
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
    for (const [name, item] of Object.entries(value)) {
      if (typeof item === "string" && test(name, item)) found.push(item);
      else if (deep) pending.push(item);
    }
  }
  return found;
}

/**
 * `text` with each JSON string of `values` replaced by `"<<redacted>>"`.
 * Only a whole string value matches, so a short value cannot change other
 * text. A value matches as `JSON.stringify` writes it, and with `\/` for
 * each `/`, as some servers write it.
 */
function replaceStrings(text: string, values: string[]): string {
  const quoted = values.flatMap((value) => {
    const json = JSON.stringify(value);
    return [json, json.replaceAll("/", "\\/")];
  });
  let result = text;
  for (const json of new Set(quoted.toSorted((a, b) => b.length - a.length))) {
    result = result.replaceAll(json, `"${REDACTED}"`);
  }
  return result;
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
      for (const { name, value } of url
        ? paramParts(url.search.slice(1))
        : []) {
        if (!CREDENTIAL_HEADER.test(decode(name))) continue;
        add(value);
        add(decode(value));
      }
    },

    redact,

    redactBytes,

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
     */
    redactFields(text: string, contentType?: string): string {
      if (isForm(contentType)) {
        return redactForm(text, (name, value) => {
          if (!isMinted(name, value)) return false;
          add(value);
          return true;
        });
      }
      const minted = credentialValues(parseJson(text), isMinted, false);
      minted.forEach(add);
      return replaceStrings(text, minted);
    },

    /**
     * A `location` header as a recording keeps it: the value of each
     * minted credential parameter of its query and its fragment is
     * replaced (`MINTED_FIELDS`, and a bare `token` with a credential
     * prefix), such as `#access_token=`. Other parameters do not change,
     * so a replay can follow the redirect. The values join the known
     * credentials.
     */
    redactLocation(href: string): string {
      return redactUrl(href, (name, value) => {
        if (!isMinted(name, value)) return false;
        add(value);
        return true;
      });
    },

    /**
     * The text of `request`, such as the text that its key hashes, with
     * each known credential and the value of each credential field
     * (`CREDENTIAL_FIELDS`) at any depth of a JSON body replaced, or of an
     * `application/x-www-form-urlencoded` body. In the first copy of the
     * URL, the value of each credential query parameter is replaced at any
     * length. These values do not join the known credentials.
     */
    redactRequest(
      text: string,
      request: { url: URL; headers: IncomingHttpHeaders; body: Buffer },
    ): string {
      const href = redactUrl(request.url.href);
      const result = text.replace(request.url.href, () => href);
      if (isForm(request.headers["content-type"])) {
        return redact(redactForm(result, isCredentialField));
      }
      const json = parseJson(request.body.toString("utf8"));
      return redact(
        replaceStrings(result, credentialValues(json, isCredentialField, true)),
      );
    },
  };
}

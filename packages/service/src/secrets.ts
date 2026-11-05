/**
 * Credentials that the proxy must never write to disk.
 *
 * The proxy learns the values of credential headers and query parameters
 * from each request that it sees, and the config can add more values. It
 * replaces each known value with `<<redacted>>` before it writes a
 * recording.
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
 * The URL of `url`, with the value of each credential query parameter
 * replaced at any length. The other parts do not change.
 */
const redactQuery = (url: URL) => {
  if (!url.search) return url.href;
  const search = queryParts(url)
    .map(({ part, name, value, credential }) =>
      credential && value ? `${name}=${REDACTED}` : part,
    )
    .join("&");
  return url.href.replace(url.search, () => `?${search}`);
};

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
     * The text of a request to `url`, such as the text that its key hashes,
     * with each known credential replaced. In the first copy of the URL, the
     * value of each credential query parameter is replaced at any length.
     */
    redactRequest(text: string, url: URL): string {
      const href = redactQuery(url);
      return redact(text.replace(url.href, () => href));
    },
  };
}

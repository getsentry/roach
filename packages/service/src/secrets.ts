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

/**
 * Add `value` and its parts to `into`, such as the token of
 * `Bearer <token>` or each value of a cookie header.
 */
function add(value: string, into: Set<string>): void {
  for (const part of [value, ...value.split(/[\s;,=]+/)]) {
    if (part.length < MIN_LENGTH) continue;
    into.add(part);
    // The recorder redacts JSON text, which escapes `"`, `\`, and control
    // characters.
    into.add(JSON.stringify(part).slice(1, -1));
  }
}

/**
 * The most values that one run learns from its requests, and their total
 * length in characters. The values of `initial` do not count.
 */
export interface LearnLimit {
  values: number;
  length: number;
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
     * Past the limit, it throws an error with HTTP status 431.
     */
    learn(headers: IncomingHttpHeaders, url?: URL): void {
      const seen = new Set<string>();
      for (const [name, value] of Object.entries(headers)) {
        if (!CREDENTIAL_HEADER.test(name) || value === undefined) continue;
        if (NOT_CREDENTIAL_HEADERS.has(name)) continue;
        for (const item of Array.isArray(value) ? value : [value]) {
          add(item, seen);
        }
      }
      for (const { value, credential } of url ? queryParts(url) : []) {
        if (!credential) continue;
        add(value, seen);
        add(decode(value), seen);
      }
      const next = { ...learned };
      for (const part of seen) {
        if (values.has(part)) continue;
        next.values += 1;
        next.length += part.length;
      }
      if (next.values > limit.values || next.length > limit.length) {
        throw Object.assign(
          new Error(
            `this run cannot learn more credentials (${limit.values} values or ${limit.length} characters), so it refuses a request with a new one. Start a new run.`,
          ),
          { status: 431 },
        );
      }
      learned = next;
      for (const part of seen) values.add(part);
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

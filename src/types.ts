/**
 * The public contract of Roach: rules, modes, runs, sessions, and the
 * results of a run. The client, the service, and the vitest integration
 * share it. See `README.md`.
 */
import type { ValuePatterns } from "./values.ts";

/** The path prefix of the control API. */
export const CONTROL_PATH = "/__roach";

/**
 * - `auto`: replay a request that has a recording. Send other requests live
 *   and record them.
 * - `replay`: replay a request that has a recording. Fail other requests
 *   with HTTP 412. Nothing goes live, and nothing is recorded.
 * - `record`: send every request live and record it again.
 * - `off`: record and replay nothing.
 */
export type RecordingMode = "auto" | "off" | "record" | "replay";

/** One kind of traffic that the proxy records. */
export interface RecordingRule {
  /**
   * The name of the rule, such as `model`. Its keys start with
   * `<name>/`. Use letters, digits, `_`, `.`, and `-`.
   */
  name: string;
  /** The requests of the rule. Each field that is set must match. */
  match: {
    /** The method, such as `POST`. */
    method?: string;
    /**
     * The start of the URL, such as `https://ai-gateway.vercel.sh/`. A list
     * matches a URL that starts with one of its prefixes, so one rule can
     * record the same API on many hosts. The key does not use `match`, so a
     * string and a list with that string give the same keys.
     */
    url?: string | string[];
    /** Header values. Names are lowercase. */
    headers?: Record<string, string>;
  };
  /**
   * Request headers that are in the key, with the method, the URL, and the
   * body. Names are lowercase.
   */
  keyHeaders?: string[];
  /**
   * Values in the request body that change from run to run, such as ids and
   * times. See `values.ts`.
   */
  values?: ValuePatterns;
}

/**
 * Where a request without a recording first differs from the request of
 * the closest recording, in the texts that the keys hash. It has no text:
 * the texts go only to the `roach.request` span in Sentry, as
 * `miss.recorded` and `miss.request`.
 */
export interface RecordingChange {
  /** The key of the recording that the request is compared with. */
  file: string;
  /** The offset of the first different character. */
  at: number;
}

/** A request that a rule matched, but that had no recording. */
export interface RecordingMiss {
  rule: string;
  /** The session of the request. */
  session?: string | undefined;
  /** The key of the recording that the request needed. */
  file: string;
  /**
   * The first change from the request of the closest recording. Only the
   * first miss of each session in a run with the write token has it, and
   * only when the proxy has the text of that request.
   */
  change?: RecordingChange;
}

/** The totals of a run. */
export interface RecordingStats {
  /**
   * Requests by rule name. `missed` counts the requests that `replay` mode
   * failed, because they had no recording.
   */
  counts: Record<string, { live: number; missed: number; replayed: number }>;
  /** The requests without a recording, in order. The first 500 are kept. */
  misses: RecordingMiss[];
  /** Recordings that the proxy wrote and that were new or changed. */
  written: number;
  /** New recordings that the proxy dropped, because their session failed. */
  discarded: number;
  /**
   * Requests that matched no rule, by origin. They went live and were not
   * recorded. Use this to find traffic that a rule misses.
   */
  passthrough: Record<string, number>;
}

/** The configuration of one run. The client sends it. */
export interface RunConfig {
  /**
   * The tenant of the run, as `owner/repo`, such as
   * `process.env.GITHUB_REPOSITORY`.
   */
  tenant: string;
  mode: RecordingMode;
  rules: RecordingRule[];
  /**
   * The only origins that the run can reach, such as
   * `https://ai-gateway.vercel.sh`. The service sends requests only to
   * their public addresses.
   */
  allow: string[];
  /**
   * The name of the run in Sentry, such as
   * `${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}`. Default: the run id.
   */
  name?: string;
  /**
   * Credentials that this run must never write, such as the API keys of
   * its CI job. The service redacts them with the `secrets` of the service
   * config, keeps them only in memory, and forgets them when the run ends.
   */
  secrets?: string[];
}

/** A run that the service created. */
export interface RemoteRun {
  /** The id of the run. */
  id: string;
  /**
   * The proxy URL, with the run id and token as its user and password. A
   * request through it belongs to the open session when only one is open.
   */
  url: string;
  /** The run token. Session and stats calls use it. */
  token: string;
  /** The base URL of the control API of the run. */
  controlUrl: string;
  /** The PEM certificate of the authority that signs intercepted hosts. */
  caCert: string;
}

/** A session that the service opened. */
export interface OpenedSession {
  /**
   * The proxy URL of the session. Each request through it belongs to the
   * session, also when other sessions are open.
   */
  url: string;
}

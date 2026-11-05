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
    /** The start of the URL, such as `https://ai-gateway.vercel.sh/`. */
    url?: string;
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

/** A request that a rule matched, but that had no recording. */
export interface RecordingMiss {
  rule: string;
  /** The session of the request. */
  session?: string | undefined;
  /** The key of the recording that the request needed. */
  file: string;
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
  /**
   * Requests that the proxy refused with HTTP 403 and sent nowhere, by
   * reason and origin. An older service does not send it.
   */
  refused?: Partial<Record<RefusalReason, Record<string, number>>>;
}

/**
 * Why the proxy refused a request:
 * - `notAllowed`: its origin is not in `allow`.
 * - `notPublic`: its origin is in `allow`, but its address is not public.
 * - `replayOnly`: the run can only replay, and no rule records the request.
 */
export type RefusalReason = "notAllowed" | "notPublic" | "replayOnly";

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

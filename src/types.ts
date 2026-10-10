/**
 * The public types of Roach: rules, modes, and the results of a run. See
 * `README.md`.
 */
import type { ValuePatterns } from "./values.ts";

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
}

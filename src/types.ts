/**
 * The public types of Roach: its configuration and its
 * results. See `README.md`.
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

/** A Roach Worker (`worker/`) that keeps the recordings. */
export interface RemoteStoreConfig {
  /** The URL of the Worker, such as `https://roach.example.workers.dev`. */
  url: string;
  /**
   * The token of the tenant. The proxy sends it only to `url`, and never
   * writes it to a recording.
   */
  token: string;
  /**
   * The run of this proxy, such as the GitHub Actions run id. The Worker
   * counts the runs that use each recording, so a recording that only one
   * run uses shows up in Sentry.
   */
  run?: string;
}

/** The configuration of one proxy. Set `directory` or `store`. */
export interface RoachConfig {
  /** The directory of the recordings. Each rule has a subdirectory. */
  directory?: string;
  /** The Worker that keeps the recordings, in place of `directory`. */
  store?: RemoteStoreConfig;
  mode: RecordingMode;
  /**
   * The only origins that the proxy sends requests to, such as
   * `https://ai-gateway.vercel.sh`. The proxy refuses all other origins.
   */
  allow: string[];
  rules: RecordingRule[];
  /**
   * When the proxy stops, it lists here the recordings that sessions used.
   * A failed session uses all recordings that it recorded before. Give these
   * files to the `prune` command. Only for `directory`: R2 deletes the recordings
   * of the Worker 30 days after they were written.
   */
  usedFile?: string;
  /**
   * For each miss, the proxy writes the request as the key sees it to
   * `<missDirectory>/<rule>/<key>.json`. These files contain request
   * bodies, such as prompts, so do not commit them. It must not be inside
   * `directory`.
   */
  missDirectory?: string;
  /**
   * Credentials that the proxy must never write, such as API keys. The
   * proxy also learns the values of headers that can carry credentials,
   * such as `authorization`, from each request. It redacts them in
   * recordings and miss files.
   */
  secrets?: string[];
}

/** A request that a rule matched, but that had no recording. */
export interface RecordingMiss {
  rule: string;
  /** The session of the request. */
  session?: string | undefined;
  /** The key of the recording that the request needed. */
  file: string;
  /** The key of the recording with the most equal parts. */
  closest?: string | undefined;
  /** The parts that differ from `closest`, such as `messages[3]`. */
  differs: string[];
}

/** The totals of a proxy run. */
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

/** The address of a running proxy. Give it to the processes that use it. */
export interface RoachAddress {
  /** The proxy URL, such as `http://127.0.0.1:1234`. */
  url: string;
  /** The bearer token of the control API. */
  token: string;
  /** The PEM certificate of the authority that signs intercepted hosts. */
  caCert: string;
}

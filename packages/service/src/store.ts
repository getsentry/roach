/**
 * Recordings, and the contract of a store that keeps them.
 *
 * A recording keeps the response of one request, and the session (test)
 * that recorded it. It does not keep the request body, so a replay reads
 * only the response.
 *
 * A request sample keeps the redacted text that the key of a recorded
 * request hashes, by its place in its session (`misses.ts`). A miss
 * compares its own text with it.
 *
 * A store keeps recordings by key, `<rule>/<hash>.json`, and samples as
 * `_requests/<rule>/<hash>.json`. The GCS store (`gcs.ts`) keeps them in a
 * bucket. The file store (`recordings.ts`) keeps them in a directory, for
 * tests and development.
 */
/** One recorded response. */
export interface Recording {
  /** The session (test) that recorded the response. */
  session?: string | undefined;
  request: { method: string; url: string };
  response: {
    status: number;
    headers: Record<string, string>;
    /**
     * A text body keeps each changing value of its request as a
     * placeholder (`@sentry/roach/values`).
     */
    body: string;
    /** `base64` for a body that is not text, such as an image. */
    bodyEncoding: "base64" | "utf8";
  };
}

/** The key text of the last recorded request at one place of a session. */
export interface RequestSample {
  /** The key of the recording of the request. */
  file: string;
  /** The redacted text that the key hashed, cut at a size limit. */
  text: string;
  /** Set when `text` was cut. */
  truncated?: boolean;
  /**
   * Set when the proxy could not redact the text, so `text` is empty. The
   * sample still takes the place of an older sample of the same place.
   */
  withheld?: boolean;
}

/** A file in a store. */
export type StoredFile = Recording | RequestSample;

/** Where the recordings of a tenant are. */
export interface RecordingStore {
  /** The file of `key`, or `undefined` when there is none. */
  read(key: string): Promise<StoredFile | undefined>;
  /** Write files by key. Returns how many were new or changed. */
  write(files: Array<[string, StoredFile]>): Promise<number>;
}

/** A rule name that a store accepts. It is a directory name. */
export const RULE_NAME = /^[A-Za-z0-9][\w.-]{0,63}$/;

/** The key of a request of `rule` with the hash `hash`. */
export const recordingKey = (rule: string, hash: string) =>
  `${rule}/${hash}.json`;

/** The text of a file, as the stores keep it. */
export const formatRecording = (file: StoredFile) =>
  `${JSON.stringify(file, null, 2)}\n`;

/**
 * Recordings, and the contract of a store that keeps them.
 *
 * A recording keeps the response of one request, and the session (test)
 * that recorded it. It does not keep the request body, so prompts and other
 * inputs are not stored.
 *
 * A store keeps recordings by key, `<rule>/<hash>.json`. The GCS store
 * (`gcs.ts`) keeps them in a bucket. The file store (`recordings.ts`) keeps
 * them in a directory, for tests and development.
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
     * placeholder (`values.ts`).
     */
    body: string;
    /** `base64` for a body that is not text, such as an image. */
    bodyEncoding: "base64" | "utf8";
  };
}

/** Where the recordings of a tenant are. */
export interface RecordingStore {
  /** The recording of `key`, or `undefined` when there is none. */
  read(key: string): Promise<Recording | undefined>;
  /** Write recordings by key. Returns how many were new or changed. */
  write(recordings: Array<[string, Recording]>): Promise<number>;
}

/** A rule name that a store accepts. It is a directory name. */
export const RULE_NAME = /^[A-Za-z0-9][\w.-]{0,63}$/;

/** The key of a request of `rule` with the hash `hash`. */
export const recordingKey = (rule: string, hash: string) =>
  `${rule}/${hash}.json`;

/** The text of a recording, as the stores keep it. */
export const formatRecording = (recording: Recording) =>
  `${JSON.stringify(recording, null, 2)}\n`;

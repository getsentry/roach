/**
 * Recordings, and the contract of a store that keeps them.
 *
 * A recording keeps the response of one request, the session (test) that
 * recorded it, and the parts of the request (`parts.ts`). It does not keep
 * the request body, so prompts and other inputs are not stored.
 *
 * A store keeps recordings by key, `<rule>/<hash>.json`. The file store
 * (`recordings.ts`) keeps them in a directory that can be committed. The
 * remote store (`remote-store.ts`) keeps them in the Worker (`worker/`).
 *
 * This file uses no Node built-ins, because the Worker uses it too.
 */
import type { RequestParts } from "./parts.ts";

/** One recorded response. */
export interface Recording {
  /** The session (test) that recorded the response. */
  session?: string | undefined;
  request: { method: string; url: string; parts: RequestParts };
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

/** The recording with the most equal parts, and the parts that differ. */
interface ClosestRecording {
  key: string;
  differs: string[];
}

/** Where the recordings of a proxy are. */
export interface RecordingStore {
  /** The recording of `key`, or `undefined` when there is none. */
  read(key: string): Promise<Recording | undefined>;
  /** Write recordings by key. Returns how many were new or changed. */
  write(recordings: Array<[string, Recording]>): Promise<number>;
  /**
   * The recording of `rule` with the most equal parts. Recordings of the
   * same session come first, because a test usually sends the same
   * requests as the last time it ran. Only the file store has this: it is a
   * hint for debugging a miss, and the Worker keeps no index for it.
   */
  closest?(
    rule: string,
    parts: RequestParts,
    session: string | undefined,
  ): Promise<ClosestRecording | undefined>;
  /**
   * The keys that `session` recorded. Only the file store has this,
   * because only it supports `usedFile` and prune.
   */
  keysOf?(session: string): Promise<string[]>;
}

/** A rule name that a store accepts. It is a directory name. */
export const RULE_NAME = /^[A-Za-z0-9][\w.-]{0,63}$/;

/** A key that a store accepts: `<rule>/<sha-256 hex>.json`. */
export const RECORDING_KEY = /^([A-Za-z0-9][\w.-]{0,63})\/[0-9a-f]{64}\.json$/;

/** The key of a request of `rule` with the hash `hash`. */
export const recordingKey = (rule: string, hash: string) =>
  `${rule}/${hash}.json`;

/** The text of a recording, as the stores keep it. */
export const formatRecording = (recording: Recording) =>
  `${JSON.stringify(recording, null, 2)}\n`;

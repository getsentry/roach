/**
 * The explanation of a miss: where a request without a recording first
 * differs from the request of the closest recording.
 *
 * A recording does not keep its request. So when the proxy records a
 * request, it also writes a request sample (`store.ts`): the redacted text
 * that the key hashed. The key of the sample is the place of the request:
 * its rule, its session (test), and how many requests of that rule the
 * session sent before it. A later run that sends another request at the
 * same place reads that sample and compares the two texts. A replay writes
 * no sample, so the sample of a place is the request of its last recording.
 */
import { createHash } from "node:crypto";
import type { RequestSample } from "./store.ts";
import type { RecordingChange } from "./types.ts";

/** The longest text that a sample keeps, in UTF-16 characters. */
const MAX_SAMPLE_LENGTH = 1024 * 1024;
/** Characters shown before the first different character. */
const BEFORE = 40;
/** Characters shown after the different part. */
const AFTER = 20;
/** The most characters shown from the first different character on. */
const MAX_SHOWN = 120;

/**
 * The key of the sample of the request of `rule` at `index` in the session
 * `session`. `_` is not a valid first character of a rule name, so it is
 * never the key of a recording.
 */
export function sampleKey(
  rule: string,
  session: string | undefined,
  index: number,
): string {
  const place = createHash("sha256")
    .update(JSON.stringify([session ?? null, index]))
    .digest("hex");
  return `_requests/${rule}/${place}.json`;
}

/** The sample of a recorded request. `text` must be redacted. */
export function toSample(file: string, text: string): RequestSample {
  return text.length > MAX_SAMPLE_LENGTH
    ? { file, text: text.slice(0, MAX_SAMPLE_LENGTH), truncated: true }
    : { file, text };
}

/**
 * The first change from the text of `sample` to `text`. `undefined` when
 * the texts are the same, or when they differ only after the part that
 * the sample kept.
 */
export function firstChange(
  sample: RequestSample,
  text: string,
): RecordingChange | undefined {
  const recorded = sample.text;
  const shorter = Math.min(recorded.length, text.length);
  let at = 0;
  while (at < shorter && recorded[at] === text[at]) at += 1;
  if (at === recorded.length && (sample.truncated || at === text.length)) {
    return undefined;
  }
  // The end that both texts share. A cut sample does not have its end.
  let same = 0;
  if (!sample.truncated) {
    while (
      same < shorter - at &&
      recorded[recorded.length - 1 - same] === text[text.length - 1 - same]
    ) {
      same += 1;
    }
  }
  const around = (part: string) => {
    const from = Math.max(0, at - BEFORE);
    const to = Math.min(
      part.length,
      part.length - same + AFTER,
      at + MAX_SHOWN,
    );
    return `${from > 0 ? "…" : ""}${part.slice(from, to)}${to < part.length ? "…" : ""}`;
  };
  return {
    file: sample.file,
    at,
    recorded: around(recorded),
    request: around(text),
  };
}

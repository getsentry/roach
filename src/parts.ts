/**
 * The parts of a request, which miss diagnosis compares.
 *
 * The parts are the method, the URL, each key header, each top-level field
 * of a JSON body, and each item of a top-level array, such as
 * `messages[3]`. A recording keeps a short hash of each part
 * (`request-key.ts`). When a request has no recording, the store finds the
 * recording with the most equal parts and reports the parts that differ.
 *
 * This file uses no Node built-ins, because the Worker (`worker/`) uses it
 * too.
 */

/** A short hash of each part of a request, by part name. */
export type RequestParts = Record<string, string>;

const partOrder = new Intl.Collator("en", { numeric: true }).compare;

/** How many parts of `parts` are equal in `other`. */
const countEqualParts = (parts: RequestParts, other: RequestParts) =>
  Object.keys(parts).filter((name) => other[name] === parts[name]).length;

/** The parts that are in only one of `a` and `b`, or differ, in order. */
export function differingParts(a: RequestParts, b: RequestParts): string[] {
  const names = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...names].filter((name) => a[name] !== b[name]).toSorted(partOrder);
}

/**
 * The candidate with the most equal parts, and the parts that differ from
 * it, in a readable order. Returns `undefined` when there is no candidate.
 */
export function closestRequest<T extends { parts: RequestParts }>(
  parts: RequestParts,
  candidates: Iterable<T>,
): { candidate: T; differs: string[] } | undefined {
  let best: T | undefined;
  let bestEqual = -1;
  for (const candidate of candidates) {
    const equal = countEqualParts(parts, candidate.parts);
    if (equal > bestEqual) {
      bestEqual = equal;
      best = candidate;
    }
  }
  return (
    best && { candidate: best, differs: differingParts(parts, best.parts) }
  );
}

/** Name some parts, such as `messages[3], tools`. */
export function describeParts(parts: string[]): string {
  if (parts.length === 0) return "no part";
  const shown = parts.slice(0, 6).join(", ");
  return parts.length > 6 ? `${shown} and ${parts.length - 6} more` : shown;
}

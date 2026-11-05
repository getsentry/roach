/**
 * Text reports of a Roach run, for logs and CI summaries.
 */
import { appendFile } from "node:fs/promises";
import type {
  RecordingChange,
  RecordingMiss,
  RecordingStats,
} from "./types.ts";

/** Describe the totals of a run in one line. */
export function describeRecordingStats(stats: RecordingStats): string {
  const rules = Object.entries(stats.counts)
    .map(
      ([rule, { live, missed, replayed }]) =>
        `${rule} ${replayed} replayed, ${live} live${missed ? `, ${missed} missed` : ""}`,
    )
    .join("; ");
  const passthrough =
    Object.entries(stats.passthrough)
      .map(([origin, count]) => `${origin} ${count}`)
      .join(", ") || "none";
  return `${rules}. ${stats.written} recordings new or changed, ${stats.discarded} dropped from failed sessions. Not recorded: ${passthrough}.`;
}

/** Describe the first change of a miss, in indented lines. */
const describeChange = ({ file, at, recorded, request }: RecordingChange) =>
  [
    `\n  Changed at character ${at} of the request of ${file}:`,
    `\n  - recorded: ${JSON.stringify(recorded)}`,
    `\n  - request:  ${JSON.stringify(request)}`,
  ].join("");

/**
 * Describe the first request without a recording of each test. The first
 * miss of a test is the one to fix. Each later miss of the test usually
 * follows from it, because the live response differs from the recording.
 * When the proxy has the text of the closest recorded request, the
 * description also shows the first change from it, in indented lines.
 */
export function describeRecordingMisses(misses: RecordingMiss[]): string[] {
  const seen = new Set<string | undefined>();
  return misses
    .filter((miss) => {
      const first = !seen.has(miss.session);
      seen.add(miss.session);
      return first;
    })
    .map(
      (miss) =>
        `${miss.session ?? "outside a test"}: ${miss.file}${miss.change ? describeChange(miss.change) : ""}`,
    );
}

/**
 * Write the report of a run to stdout, and in GitHub Actions also to the
 * job summary. `title` names the run, such as `Roach (auto)`.
 */
export async function writeRunReport(
  title: string,
  stats: RecordingStats,
): Promise<void> {
  const report = [
    `${title}: ${describeRecordingStats(stats)}`,
    ...describeRecordingMisses(stats.misses).map((miss) => `- ${miss}`),
  ].join("\n");
  process.stdout.write(`${report}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    await appendFile(process.env.GITHUB_STEP_SUMMARY, `${report}\n`);
  }
}

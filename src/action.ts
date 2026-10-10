/**
 * The GitHub Action of Roach (`action.yml`). See "Use the GitHub Action" in
 * `README.md`.
 *
 * It starts a run, runs the command of the step with the proxy variables of
 * the run, and ends the run. The rules of the run come from `roach.json`.
 * The runner gives each input as `INPUT_<NAME>`.
 */
import { spawn } from "node:child_process";
import { appendFile, readFile } from "node:fs/promises";
import { startRemoteRun } from "./client.ts";
import { describeRecordingMisses, describeRecordingStats } from "./report.ts";
import type { RunConfig } from "./service.ts";

/** Variables that the command must not get: the inputs, with the token. */
const HIDDEN_VARIABLE = /^(INPUT_.*|https?_proxy|no_proxy|all_proxy)$/i;

/** Run the command in bash, and return its exit code. */
function runCommand(command: string, env: NodeJS.ProcessEnv): Promise<number> {
  const child = spawn("bash", ["-e", "-o", "pipefail", "-c", command], {
    env,
    stdio: "inherit",
  });
  // A canceled job sends a signal. Stop the command, then end the run.
  process.on("SIGINT", () => child.kill("SIGINT"));
  process.on("SIGTERM", () => child.kill("SIGTERM"));
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });
}

const command = process.env.INPUT_RUN;
if (!command) throw new Error("The run input is required");
// The runner gives an empty string for an input that the step does not set.
const token =
  process.env.INPUT_TOKEN === "" ? undefined : process.env.INPUT_TOKEN;
// Without the token, the service only allows `replay`, as for forks.
const mode = token ? "auto" : "replay";
const config = JSON.parse(await readFile("roach.json", "utf8")) as Pick<
  RunConfig,
  "allow" | "rules"
>;
const run = await startRemoteRun(
  { url: process.env.INPUT_URL!, token },
  {
    ...config,
    tenant: process.env.GITHUB_REPOSITORY!,
    mode,
    name: `${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}`,
  },
);
// The proxy URL has the run token. Keep it out of the log.
process.stdout.write(`::add-mask::${run.token}\n`);

let exitCode = 1;
try {
  const session = await run.startSession(process.env.GITHUB_JOB ?? "command");
  exitCode = await runCommand(command, {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        ([name]) => !HIDDEN_VARIABLE.test(name),
      ),
    ),
    ...run.env,
  });
  const { missed } = await session.end(exitCode === 0);
  if (missed > 0 && exitCode === 0) exitCode = 1;
} finally {
  const stats = await run.close();
  const report = [
    `Roach (${mode}): ${describeRecordingStats(stats)}`,
    ...describeRecordingMisses(stats.misses).map((miss) => `- ${miss}`),
  ].join("\n");
  process.stdout.write(`${report}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    await appendFile(process.env.GITHUB_STEP_SUMMARY, `${report}\n`);
  }
}
process.exitCode = exitCode;

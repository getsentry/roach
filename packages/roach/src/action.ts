/**
 * The GitHub Action of Roach (`action.yml`). See "Use the GitHub Action" in
 * `README.md`.
 *
 * It starts a run, runs the command of the step with the proxy variables of
 * the run, and ends the run. The run config comes from `roach.json`
 * (`config.ts`).
 * The runner gives each input as `INPUT_<NAME>`.
 */
import { spawn } from "node:child_process";
import { startRemoteRun } from "./client.ts";
import { readEnv, readRoachFile, runConfigOf } from "./config.ts";
import { writeRunReport } from "./report.ts";

/**
 * Variables that the command does not get: the inputs, which have the token,
 * the tokens of the runner (`ACTIONS_*`, such as `ACTIONS_RUNTIME_TOKEN` and
 * `ACTIONS_ID_TOKEN_REQUEST_TOKEN`), and the proxy variables of the job.
 */
const HIDDEN_VARIABLE =
  /^(INPUT_.*|ACTIONS_.*|https?_proxy|no_proxy|all_proxy)$/i;

/** Run the command in bash, and return its exit code. */
function runCommand(command: string, env: NodeJS.ProcessEnv): Promise<number> {
  // `detached` puts bash and its children in a new process group.
  const child = spawn("bash", ["-e", "-o", "pipefail", "-c", command], {
    detached: true,
    env,
    stdio: "inherit",
  });
  // A canceled job sends a signal. Bash does not pass it to its children, so
  // send it to the whole process group. Then end the run.
  const stop = (signal: NodeJS.Signals) => {
    try {
      process.kill(-child.pid!, signal);
    } catch {
      // The process group has already stopped.
    }
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => {
      // Stop what the command left in the background, such as `cmd &`. Bash
      // makes it ignore `SIGINT`, and the run ends next.
      stop("SIGTERM");
      resolve(code ?? 1);
    });
  });
}

const command = process.env.INPUT_RUN;
if (!command) throw new Error("Roach: the run input is required");
// The runner gives an empty string for an input that the step does not set.
const token = readEnv("INPUT_TOKEN");
const file = await readRoachFile();
const config = runConfigOf(file, { canWrite: token !== undefined });
const run = await startRemoteRun(
  { url: process.env.INPUT_URL!, token },
  config,
  file.noProxy ? { noProxy: file.noProxy } : {},
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
  await writeRunReport(`Roach (${config.mode})`, await run.close());
}
process.exitCode = exitCode;

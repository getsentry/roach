/**
 * The vitest global setup of Roach (`@sentry/roach/vitest`). See "Use with
 * vitest" in `README.md`.
 *
 * It starts one run with the config of `roach.json` (`config.ts`), and
 * gives the proxy variables of the run to the test workers, which start
 * after it. `vitest-setup.ts` opens one session for each test, so the
 * tests of many workers record at the same time. At the end it closes the
 * run and reports it.
 *
 * - `ROACH_TOKEN` is the write token. Only this file reads it, and the
 *   workers do not get it. Without it, the run can only replay.
 * - `ROACH_URL` is the service. Default: the Roach service of Sentry.
 * - `ROACH_MODE` sets the mode. See `runConfigOf()`. With `off`, it starts
 *   no run and does not use the service, so requests go direct.
 */
import http from "node:http";
import tls from "node:tls";
import type { TestProject } from "vitest/node";
import { startRemoteRun } from "./client.ts";
import {
  DEFAULT_SERVICE_URL,
  readEnv,
  readRoachFile,
  runConfigOf,
} from "./config.ts";
import { writeRunReport } from "./report.ts";
import type { RemoteRun } from "./types.ts";

declare module "vitest" {
  export interface ProvidedContext {
    /** The run of `@sentry/roach/vitest`, for the test workers. */
    roach:
      | (Pick<RemoteRun, "controlUrl" | "token"> & { noProxy: string })
      | null;
  }
}

/**
 * Start a Roach run for this vitest invocation. Returns the teardown,
 * which ends the run and reports it. Call it from a global setup of your
 * own when you have one, or use this module as a global setup.
 */
export async function startRoach(
  project: Pick<TestProject, "provide">,
): Promise<() => Promise<void>> {
  if (typeof http.setGlobalProxyFromEnv !== "function") {
    throw new Error("Roach needs Node 24.14 or later for vitest");
  }
  const token = readEnv("ROACH_TOKEN");
  delete process.env.ROACH_TOKEN;
  const file = await readRoachFile();
  const config = runConfigOf(file, { canWrite: token !== undefined });
  if (config.mode === "off") {
    project.provide("roach", null);
    return async () => {};
  }
  const noProxy = file.noProxy ?? "localhost,127.0.0.1,::1";
  const run = await startRemoteRun(
    { url: readEnv("ROACH_URL") ?? DEFAULT_SERVICE_URL, token },
    config,
    { noProxy },
  );
  // The proxy URL has the run token. Keep it out of the CI log.
  if (process.env.GITHUB_ACTIONS) {
    process.stdout.write(`::add-mask::${run.token}\n`);
  }
  const previousEnv = Object.keys(run.env).map(
    (name) => [name, process.env[name]] as const,
  );
  // Test workers and their child processes start later and inherit these.
  Object.assign(process.env, run.env);
  // This process started before them, so it reads neither the proxy nor
  // the CA file. Set both here.
  const previousCa = tls.getCACertificates("default");
  tls.setDefaultCACertificates([...previousCa, run.caCert]);
  const restoreProxy = http.setGlobalProxyFromEnv(run.env);
  project.provide("roach", {
    controlUrl: run.controlUrl,
    token: run.token,
    noProxy,
  });

  return async () => {
    try {
      const stats = await run.close();
      await writeRunReport(`Roach (${config.mode})`, stats);
      // A miss in a test fails that test. A miss outside a test, such as in
      // a global setup, must fail the invocation too.
      const missed = Object.values(stats.counts).some(
        (count) => count.missed > 0,
      );
      if (missed) process.exitCode = 1;
    } finally {
      restoreProxy();
      tls.setDefaultCACertificates(previousCa);
      for (const [name, value] of previousEnv) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  };
}

/** The vitest global setup. */
export default function setup(project: TestProject) {
  return startRoach(project);
}

/**
 * The vitest setup file of Roach (`@sentry/roach/vitest/setup`). See "Use
 * with vitest" in `README.md`.
 *
 * It opens one session for each test of the run that `vitest.ts` started.
 * Requests of the test go through the proxy URL of its session, so tests
 * in other workers record at the same time. Its child processes get that
 * URL too. A passed test writes its new recordings, and a failed test
 * drops them. A test with a request that `replay` mode failed fails.
 *
 * The tests of one file share one process, so they must run one at a
 * time. Do not use `test.concurrent` with Roach.
 */
import http from "node:http";
import {
  beforeEach,
  inject,
  onTestFinished,
  type ProvidedContext,
} from "vitest";
import { connectRoach } from "./client.ts";

const provided = inject("roach");
if (provided === undefined) {
  throw new Error(
    "Roach: add @sentry/roach/vitest to globalSetup to use the setup file",
  );
}
// `null` is `off` mode: no run, so requests go direct.
if (provided) useRun(provided);

/** Open a session for each test of the run. */
function useRun(run: NonNullable<ProvidedContext["roach"]>): void {
  const control = connectRoach(run);
  beforeEach(async ({ task }) => {
    // The full name starts with the file, so tests of two files never share
    // a session.
    const session = await control.startSession(task.fullName);
    const previous = {
      HTTP_PROXY: process.env.HTTP_PROXY,
      HTTPS_PROXY: process.env.HTTPS_PROXY,
    };
    process.env.HTTP_PROXY = session.url;
    process.env.HTTPS_PROXY = session.url;
    const restoreProxy = http.setGlobalProxyFromEnv({
      HTTP_PROXY: session.url,
      HTTPS_PROXY: session.url,
      NO_PROXY: run.noProxy,
    });
    onTestFinished(async ({ task: finished }) => {
      restoreProxy();
      for (const [name, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      const { missed } = await session.end(finished.result?.state === "pass");
      // `replay` mode failed these requests, so nothing went live. The test
      // must fail, also when it recovered from the error.
      if (missed > 0) {
        throw new Error(
          `Roach: ${missed} request(s) had no recording in replay mode. Run with ROACH_TOKEN to record them.`,
        );
      }
    });
  });
}

/**
 * The worker process that makes keys and redacts the text of misses.
 *
 * The value patterns of a run come from its client, and redaction takes
 * time for each credential that a run knows. Both run in this worker, so a
 * slow request does not stop the event loop that answers all runs. The
 * service has one worker. It does one job at a time, and each job has a
 * time limit (the `timeout` of `vm`). The jobs of runs with the write token
 * go before the jobs of runs without it. A job of an ended run does not
 * start.
 *
 * The worker is a child process with a heap limit (`MAX_HEAP_MB`), so one
 * request cannot fill the memory of the service. It is not a worker
 * thread: a thread that goes past its heap limit in one large allocation,
 * such as in `JSON.parse()`, stops the whole process. A child process
 * stops alone. Code that the `vm` timeout cannot stop, such as a long
 * `JSON.parse()`, gets a second limit: past the time limit and
 * `WATCHDOG_MARGIN_MS`, the service stops the worker. A job whose worker
 * stops counts as a job past its time limit. The next job starts a new
 * worker.
 */
import { type ChildProcess, fork } from "node:child_process";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import type { IncomingHttpHeaders } from "node:http";
import { keyRequest, type KeyedRequest } from "./request-key.ts";
import { redactRequestWith } from "./secrets.ts";
import type { RecordingRule } from "@sentry/roach/types";
import { type KnownValues, withTimeLimit } from "@sentry/roach/values";

type Job =
  | {
      kind: "key";
      rule: RecordingRule;
      request: {
        method: string;
        url: string;
        headers: IncomingHttpHeaders;
        body: string;
      };
      known: KnownValues | undefined;
      timeLimitMs: number;
      maxValues: number;
    }
  | {
      kind: "redact";
      values: string[];
      text: string;
      href: string;
      timeLimitMs: number;
    };

/** The answer of the worker to one job. `ms` is the time of the job. */
type Reply =
  | { ms: number; value: unknown }
  | {
      ms: number;
      error: {
        message: string;
        status: number | undefined;
        timedOut: boolean;
      };
    };

/** How a job runs. */
export interface JobOptions {
  /** The time limit of the job, in ms. */
  timeLimitMs: number;
  /** The most changing values that a key can have. */
  maxValues: number;
  /** Run the job before the jobs that do not have this. */
  first: boolean;
  /** Called before the job starts. When it returns `true`, it does not. */
  skip(): boolean;
}

/** A job that failed. `ms` is its time, and 0 when it did not start. */
export interface JobError extends Error {
  status?: number | undefined;
  ms: number;
  /** Set when the job went past its time limit, or its worker stopped. */
  timedOut?: boolean;
}

/** The value of a job that finished, and its time in ms. */
interface JobResult<T> {
  value: T;
  ms: number;
}

const MARK = "roach-key-worker";
/**
 * The old-generation heap of the worker, in MiB. The key of a 64 MiB body,
 * the largest body of a run with the token, needs about 320 MiB. At 256 MiB,
 * a 64 MiB body with a screenshot fails.
 */
const MAX_HEAP_MB = 384;
/** The time after the time limit of a job before the worker stops. */
const WATCHDOG_MARGIN_MS = 1000;

function runJob(job: Job): unknown {
  if (job.kind === "key") {
    return keyRequest(
      job.rule,
      job.request,
      job.known,
      job.timeLimitMs,
      job.maxValues,
    );
  }
  return withTimeLimit(job.timeLimitMs, () =>
    redactRequestWith(job.values, job.text, job.href),
  );
}

interface Pending extends JobOptions {
  job: Job;
  resolve(result: JobResult<unknown>): void;
  reject(error: JobError): void;
}

/** The job in the worker, when it started, and its watchdog. */
interface Running {
  pending: Pending;
  worker: ChildProcess;
  started: number;
  watchdog: NodeJS.Timeout;
}

const queue: Pending[] = [];
let running: Running | undefined;
let worker: ChildProcess | undefined;

const jobError = (message: string, fields: Partial<JobError>): JobError =>
  Object.assign(new Error(message), { ms: 0, ...fields });

/** Take the job of `from` out of `running`. */
function take(from: ChildProcess): Running | undefined {
  if (running?.worker !== from) return undefined;
  const done = running;
  running = undefined;
  clearTimeout(done.watchdog);
  return done;
}

/**
 * Stop `stopped`, and fail its job as a job past its time limit, with the
 * time that it ran. The next job starts a new worker.
 */
function failWorker(stopped: ChildProcess, why: string): void {
  if (worker === stopped) worker = undefined;
  const done = take(stopped);
  done?.pending.reject(
    jobError(why, {
      status: 400,
      ms: performance.now() - done.started,
      timedOut: true,
    }),
  );
  stopped.kill("SIGKILL");
  setImmediate(next);
}

function startWorker(): ChildProcess {
  const started = fork(fileURLToPath(import.meta.url), [MARK], {
    execArgv: [...process.execArgv, `--max-old-space-size=${MAX_HEAP_MB}`],
    // `Map` values, such as `known`, need the advanced serialization.
    serialization: "advanced",
    stdio: ["ignore", "inherit", "inherit", "ipc"],
  });
  started.on("message", (reply: Reply) => {
    const done = take(started)?.pending;
    if (!done) return;
    if ("error" in reply) {
      done.reject(
        jobError(reply.error.message, { ...reply.error, ms: reply.ms }),
      );
    } else {
      done.resolve({ value: reply.value, ms: reply.ms });
    }
    // The caller can end its run on this answer. Let it run first, so the
    // next job of an ended run does not start.
    setImmediate(next);
  });
  // A failed spawn emits `error`, and maybe no `exit`.
  started.on("error", () => failWorker(started, "the key worker failed"));
  started.on("exit", (code, signal) => {
    // `SIGABRT` when the job went past `MAX_HEAP_MB`.
    failWorker(started, `the key worker stopped (${signal ?? code})`);
  });
  return started;
}

/** Let an idle worker not keep the process alive. */
function hold(child: ChildProcess | undefined, busy: boolean): void {
  if (busy) {
    child?.ref();
    child?.channel?.ref();
  } else {
    child?.unref();
    child?.channel?.unref();
  }
}

/** Start the next job, when the worker has none. */
function next(): void {
  while (!running && queue.length > 0) {
    const index = Math.max(
      0,
      queue.findIndex((pending) => pending.first),
    );
    const [pending] = queue.splice(index, 1) as [Pending];
    if (pending.skip()) {
      pending.reject(jobError("this run has ended", { status: 410 }));
      continue;
    }
    const current = (worker ??= startWorker());
    try {
      current.send(pending.job, (error) => {
        if (error) failWorker(current, "the key worker did not get the job");
      });
    } catch (error) {
      pending.reject(jobError((error as Error).message, { status: 500 }));
      continue;
    }
    running = {
      pending,
      worker: current,
      started: performance.now(),
      watchdog: setTimeout(
        () =>
          failWorker(
            current,
            `the request took over ${pending.timeLimitMs} ms. Make the value patterns simpler.`,
          ),
        pending.timeLimitMs + WATCHDOG_MARGIN_MS,
      ),
    };
  }
  hold(worker, running !== undefined);
}

function runInWorker<T>(job: Job, options: JobOptions): Promise<JobResult<T>> {
  return new Promise((resolve, reject) => {
    queue.push({
      ...options,
      job,
      resolve: resolve as Pending["resolve"],
      reject,
    });
    next();
  });
}

/**
 * `keyRequest()` in the worker, with the time limit of `options`. Past it,
 * the job fails with HTTP status 400 and `timedOut`.
 */
export function keyInWorker(
  rule: RecordingRule,
  request: Extract<Job, { kind: "key" }>["request"],
  known: KnownValues | undefined,
  options: JobOptions,
): Promise<JobResult<KeyedRequest>> {
  return runInWorker(
    {
      kind: "key",
      rule,
      request,
      known,
      timeLimitMs: options.timeLimitMs,
      maxValues: options.maxValues,
    },
    options,
  );
}

/**
 * `redactRequestWith()` in the worker, with the time limit of `options`.
 * Past it, the job fails with `timedOut`.
 */
export function redactInWorker(
  values: string[],
  text: string,
  href: string,
  options: JobOptions,
): Promise<JobResult<string>> {
  return runInWorker(
    { kind: "redact", values, text, href, timeLimitMs: options.timeLimitMs },
    options,
  );
}

// The worker side. The parent starts this file with the mark as its
// argument.
if (process.argv[2] === MARK && process.send) {
  const send = process.send.bind(process);
  process.on("message", (job: Job) => {
    const started = performance.now();
    let reply: Reply;
    try {
      const value = runJob(job);
      reply = { ms: performance.now() - started, value };
    } catch (error) {
      reply = {
        ms: performance.now() - started,
        error: {
          message: (error as Error).message,
          status: (error as { status?: number }).status,
          // The time limit of `vm` (`withTimeLimit()`).
          timedOut: (error as { timedOut?: boolean }).timedOut === true,
        },
      };
    }
    send(reply);
  });
  // The worker ends with the service.
  process.on("disconnect", () => process.exit(0));
}

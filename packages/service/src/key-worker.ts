/**
 * The worker process that makes the keys of runs with the read token, and
 * redacts the text of their misses.
 *
 * More jobs have the read token than the write token, and the value
 * patterns and bodies of a run come from its client. Redaction takes time
 * for each credential that a run knows. Both run in this worker, so a slow
 * request does not stop the event loop that answers all runs. The service
 * has one worker. It does one job at a time, in order, and each job has a
 * time limit (the `timeout` of `vm`). A job of an ended run does not start.
 * A run with the write token does this work on the main thread
 * (`recorder.ts`), because the key of a 64 MiB body can need more memory
 * than the worker has.
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
import { redactRequestWith, type RequestToRedact } from "./secrets.ts";
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
      request: RequestToRedact;
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
 * The heap of the worker, in MiB: the old generation and each semi-space
 * of the young generation. The worker makes the keys of runs without the
 * token, with bodies of at most 16 MiB. The key of a 16 MiB body of small
 * text blocks peaks at about 330 MiB of RSS. The worst body, such as 16 MiB
 * of `{}`, stops the worker at about 500 MiB of RSS.
 */
const MAX_HEAP_MB = { old: 256, semi: 4 };
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
    redactRequestWith(job.values, job.text, job.request),
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
    execArgv: [
      ...process.execArgv,
      `--max-old-space-size=${MAX_HEAP_MB.old}`,
      `--max-semi-space-size=${MAX_HEAP_MB.semi}`,
    ],
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
    const pending = queue.shift()!;
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
 * Past it, the job fails with `timedOut`. The value is `undefined` when a
 * credential field cannot be redacted.
 */
export function redactInWorker(
  values: string[],
  text: string,
  request: RequestToRedact,
  options: JobOptions,
): Promise<JobResult<string | undefined>> {
  return runInWorker(
    { kind: "redact", values, text, request, timeLimitMs: options.timeLimitMs },
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

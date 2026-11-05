/**
 * The worker thread that makes keys and redacts the text of misses.
 *
 * The value patterns of a run come from its client, and redaction takes
 * time for each credential that a run knows. Both run in this worker, so a
 * slow request does not stop the event loop that answers all runs. The
 * service has one worker. It does one job at a time, and each job has a
 * time limit (the `timeout` of `vm`). The jobs of runs with the write token
 * go before the jobs of runs without it. A job of an ended run does not
 * start.
 */
import { performance } from "node:perf_hooks";
import { parentPort, Worker, workerData } from "node:worker_threads";
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
  | { ms: number; error: { message: string; status: number | undefined } };

/** How a job runs. */
export interface JobOptions {
  /** The time limit of the job, in ms. */
  timeLimitMs: number;
  /** Run the job before the jobs that do not have this. */
  first: boolean;
  /** Called before the job starts. When it returns `true`, it does not. */
  skip(): boolean;
}

/** A job that failed. `ms` is its time, and 0 when it did not start. */
export interface JobError extends Error {
  status?: number | undefined;
  ms: number;
  /** Set when the job went past its time limit. */
  timedOut?: boolean;
}

/** The value of a job that finished, and its time in ms. */
interface JobResult<T> {
  value: T;
  ms: number;
}

const MARK = "roach-key-worker";

function runJob(job: Job): unknown {
  if (job.kind === "key") {
    return keyRequest(job.rule, job.request, job.known, job.timeLimitMs);
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

const queue: Pending[] = [];
let running: Pending | undefined;
let worker: Worker | undefined;

const jobError = (message: string, fields: Partial<JobError>): JobError =>
  Object.assign(new Error(message), { ms: 0, ...fields });

function startWorker(): Worker {
  const started = new Worker(new URL(import.meta.url), { workerData: MARK });
  let failure: Error | undefined;
  started.on("message", (reply: Reply) => {
    const done = running!;
    running = undefined;
    if ("error" in reply) {
      // The time limit of `vm` throws an error with HTTP status 400.
      done.reject(
        jobError(reply.error.message, {
          status: reply.error.status,
          ms: reply.ms,
          timedOut: reply.error.status === 400,
        }),
      );
    } else {
      done.resolve({ value: reply.value, ms: reply.ms });
    }
    // The caller can end its run on this answer. Let it run first, so the
    // next job of an ended run does not start.
    setImmediate(next);
  });
  started.on("error", (error) => {
    failure = error;
  });
  started.on("exit", () => {
    worker = undefined;
    running?.reject(jobError(`the key worker stopped: ${String(failure)}`, {}));
    running = undefined;
    next();
  });
  return started;
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
    running = pending;
    worker ??= startWorker();
    // oxlint-disable-next-line unicorn/require-post-message-target-origin -- a worker has no origin
    worker.postMessage(pending.job);
  }
  // An idle worker must not keep the process alive.
  if (running) worker?.ref();
  else worker?.unref();
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
    { kind: "key", rule, request, known, timeLimitMs: options.timeLimitMs },
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
  request: RequestToRedact,
  options: JobOptions,
): Promise<JobResult<string>> {
  return runInWorker(
    { kind: "redact", values, text, request, timeLimitMs: options.timeLimitMs },
    options,
  );
}

// The worker side. Other worker threads, such as those of a test runner,
// can load this file too, so the worker has its own mark.
if (workerData === MARK) {
  parentPort!.on("message", (job: Job) => {
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
        },
      };
    }
    // oxlint-disable-next-line unicorn/require-post-message-target-origin -- a worker has no origin
    parentPort!.postMessage(reply);
  });
}

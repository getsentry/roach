/**
 * The recording logic of the proxy: modes, sessions, replay, and misses.
 *
 * `server.ts` owns the sockets. It gives the recorder each request that a
 * rule matches, with a function that sends the request live. The recorder
 * decides whether to replay, send live, or fail the request, and it owns
 * every read and write of the recordings. A store keeps them: the file
 * store (`recordings.ts`) or a GCS bucket (`gcs.ts`).
 *
 * A session groups the requests of one test. Many sessions can be open at
 * once, such as one for each test worker. A request names its session in
 * its proxy URL (`service.ts`). A request that names no session
 * belongs to the open session when only one is open. The recorder keeps
 * the new recordings of a session in memory until the session ends. A passed
 * session writes them, and a failed session drops them, so a bad sample is
 * never replayed. A request that ends after its session ended follows the
 * result of that session. A request outside a session is written at once.
 *
 * With each new recording, the recorder writes the redacted text of its
 * request as a sample. The first miss of a session reads the sample of its
 * place and finds the first change (`misses.ts`). The span of the request
 * always gets the change and its text. Only a run with the write token gets
 * the change in its stats, and never its text.
 *
 * The recorder never writes a known credential (`secrets.ts`). It decodes
 * a compressed body first, and it redacts a body that is not text as
 * bytes, before it encodes it. It also redacts the credentials that the
 * upstream mints, such as `access_token` in a response body. The live
 * client gets these, so the run can use them. A replay gives
 * `<<redacted>>` in their place. The recorder reports spans
 * and metrics through the `Telemetry` hooks of `service.ts`.
 */
import { randomBytes } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import { httpError, reportInternal } from "./errors.ts";
import { firstChange, sampleKey, toSample, withheldSample } from "./misses.ts";
import {
  keyInWorker,
  redactInWorker,
  type JobError,
  type JobOptions,
} from "./key-worker.ts";
import { keyRequest, keyTimeLimit } from "./request-key.ts";
import {
  decodeBody,
  fromRecording,
  RECORDED_HEADERS,
  toRecording,
  utf8Text,
} from "./recording-file.ts";
import { createSecrets, toRedact, type LearnLimit } from "./secrets.ts";
import {
  recordingKey,
  RULE_NAME,
  type Recording,
  type RecordingStore,
  type RequestSample,
} from "./store.ts";
import { usageAttributes } from "./usage.ts";
import type {
  RecordingMiss,
  RecordingMode,
  RecordingRule,
  RecordingStats,
  RefusalReason,
} from "@sentry/roach/types";
import {
  canBeKnown,
  withTimeLimit,
  type RequestValues,
} from "@sentry/roach/values";

/** A request with its whole body. */
export interface ProxyRequest {
  method: string;
  url: URL;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

/** A response with its whole body. */
export interface ProxyResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

/** Where the response to a recorded request came from. */
export type ResponseSource = "live" | "missed" | "replayed";

/** The attributes of a span or a metric. */
export type Attributes = Record<string, string | number | boolean>;

/**
 * Hooks that report spans and metrics. `service.ts` gives hooks
 * that send them to Sentry, so this file and `server.ts` do not load the
 * SDK. An attribute must never hold a credential, a body, or the path or
 * query of a URL.
 */
export interface Telemetry {
  /** Run `fn` in a span. The span ends when `fn` returns or settles. */
  span<T>(
    options: { op: string; name?: string; attributes?: Attributes },
    fn: () => T,
  ): T;
  /** Add attributes to the active span. */
  annotate(attributes: Attributes): void;
  /** Add `value` to the counter `name`. */
  count(name: string, value: number, attributes: Attributes): void;
  /** Add a time in milliseconds to the distribution `name`. */
  time(name: string, ms: number, attributes: Attributes): void;
  /**
   * Send an unexpected error to Sentry. Returns the id of its event, or
   * `undefined` when nothing goes to Sentry.
   */
  capture(error: unknown): string | undefined;
}

/** Requests by their place, for the samples of `misses.ts`. */
interface Places {
  /** Requests so far, by rule name. */
  sent: Map<string, number>;
  /** Set after the first miss, which is the one to explain. */
  explained: boolean;
}

/**
 * A new recording, and the samples of its requests. A session can send the
 * same request at more than one place, so one recording can have more than
 * one sample.
 */
interface NewRecording {
  recording: Recording;
  samples: Array<[string, RequestSample]>;
}

interface Session extends Places {
  /** The id in the proxy URL of the session. */
  id: string;
  name: string;
  /** New recordings, by key. */
  recorded: Map<string, NewRecording>;
  /** Requests that `replay` mode failed. */
  missed: number;
  /**
   * Changing values of the requests so far, with their names. A later
   * request can repeat one where no pattern finds it
   * (`@sentry/roach/values`).
   */
  known: Map<string, string>;
  /** Set when the session ends. */
  passed?: boolean;
}

const MAX_MISSES = 500;
/**
 * Origins of each refusal reason that the stats name. The client picks
 * the origin of a refused request, so later ones count as `OTHER_ORIGINS`.
 */
const MAX_REFUSED_ORIGINS = 32;
const OTHER_ORIGINS = "other origins";
/** The `roach.origin` of a metric for an origin that is not in `allow`. */
const METRIC_OTHER_ORIGIN = "other";
/**
 * Ended sessions that a run keeps, so that late requests follow their
 * result. The oldest ones go first, so memory stays bounded.
 */
const MAX_ENDED_SESSIONS = 1000;
/** Open sessions of a run, such as one for each test worker. */
const MAX_OPEN_SESSIONS = 64;
/** Statuses that are never recorded, because they are temporary. */
const isTemporaryStatus = (status: number) => status === 429 || status >= 500;

function matches(
  { match }: RecordingRule,
  { method, url, headers }: ProxyRequest,
): boolean {
  if (match.method && match.method !== method) return false;
  const prefixes = typeof match.url === "string" ? [match.url] : match.url;
  if (prefixes && !prefixes.some((prefix) => url.href.startsWith(prefix))) {
    return false;
  }
  return Object.entries(match.headers ?? {}).every(
    ([name, value]) => headers[name] === value,
  );
}

/** The config of a recorder. */
export interface RecorderConfig {
  mode: RecordingMode;
  rules: RecordingRule[];
  /** Credentials to redact, in addition to the ones that it learns. */
  secrets?: string[];
  /**
   * The `secrets` of the run config. They count toward `learnLimit`, so
   * too many of them throw an error with HTTP status 400.
   */
  runSecrets?: string[];
  /** The credentials that the recorder can learn from requests. */
  learnLimit: LearnLimit;
  /** The time that the run can use in the key worker (`key-worker.ts`). */
  workLimit: WorkLimit;
  /**
   * End the run, because it went past `workLimit`. The recorder then
   * starts no more jobs of the run.
   */
  endRun(reason: string): void;
  /**
   * Add the first change from a request sample to the first miss of each
   * session in the stats (`misses.ts`). Only a run with the write token may
   * set it: a change shows a part of a recorded request, so a run with the
   * read token could read the requests of a tenant back. The span gets the
   * change without it.
   */
  explainMisses?: boolean;
  telemetry: Telemetry;
}

/** The time that a run can use in the key worker (`key-worker.ts`). */
export interface WorkLimit {
  /**
   * The most time of one job, in ms. A key also has the time limit of its
   * body (`keyTimeLimit()`).
   */
  maxJobMs: number;
  /**
   * The most changing values in one request. A request with more fails
   * with HTTP 400. Its key does not change.
   */
  maxValues: number;
  /**
   * The most values in `known` of all sessions of the run, and their
   * characters. A request that would add more fails with HTTP 400, and
   * the run ends. The values stay, so no key changes.
   */
  maxKnown: { values: number; chars: number };
  /** The time of all jobs of the run, in ms. Past it, the run ends. */
  totalMs: number;
  /**
   * Set for a run with the read token. Its keys and the redaction of its
   * misses run in the key worker, and a key that goes past its time limit
   * ends the run. A run with the write token does them on the main thread,
   * as before the worker, so the memory limit of the worker fails none of
   * its requests.
   */
  untrusted: boolean;
}

/** Create the recorder of one run, with the store of its recordings. */
export function createRecorder(config: RecorderConfig, store: RecordingStore) {
  for (const rule of config.rules) {
    if (!RULE_NAME.test(rule.name)) {
      throw new Error(`Roach rule name is not valid: ${rule.name}`);
    }
  }
  /** Sessions by id. An ended session stays, so its late requests follow it. */
  const sessions = new Map<string, Session>();
  const open = () =>
    [...sessions.values()].filter((s) => s.passed === undefined);
  const { telemetry } = config;
  const secrets = createSecrets(config.secrets ?? [], config.learnLimit);
  secrets.addRunSecrets(config.runSecrets ?? []);
  const { workLimit } = config;
  let closed = false;
  let workMs = 0;
  /** The values in `known` of all sessions, and their characters. */
  const knownTotal = { values: 0, chars: 0 };
  /** Clear `known` of a session. */
  const forget = (session: Session) => {
    knownTotal.values -= session.known.size;
    for (const value of session.known.keys()) {
      knownTotal.chars -= value.length;
    }
    session.known.clear();
  };
  /**
   * Add the values of a request to `known` of its session. A value that
   * `canBeKnown()` refuses stays out: before, it failed each later request
   * of the session, so no key changes. Past `workLimit.maxKnown`, it adds
   * nothing, ends the run, and throws an error with HTTP status 400.
   */
  const remember = (session: Session, values: RequestValues) => {
    const added = new Map<string, string>();
    let chars = 0;
    for (const [name, list] of values) {
      for (const value of list) {
        if (session.known.has(value) || added.has(value)) continue;
        if (!canBeKnown(value)) continue;
        added.set(value, name);
        chars += value.length;
      }
    }
    const { maxKnown } = workLimit;
    if (
      knownTotal.values + added.size > maxKnown.values ||
      knownTotal.chars + chars > maxKnown.chars
    ) {
      if (!closed) config.endRun("its sessions have too many changing values");
      throw httpError(
        400,
        `the sessions of this run have over ${maxKnown.values} changing values or ${maxKnown.chars} characters of them. This run has ended.`,
      );
    }
    for (const [value, name] of added) session.known.set(value, name);
    knownTotal.values += added.size;
    knownTotal.chars += chars;
  };
  /** The options of a job of `bytes` bytes in the key worker. */
  const jobOptions = (bytes: number): JobOptions => ({
    timeLimitMs: Math.min(workLimit.maxJobMs, keyTimeLimit(bytes)),
    maxValues: workLimit.maxValues,
    skip: () => closed,
  });
  /** Count the time of a job. Past `workLimit.totalMs`, end the run. */
  const countWork = (ms: number) => {
    workMs += ms;
    if (workMs > workLimit.totalMs && !closed) {
      config.endRun(`it used over ${workLimit.totalMs} ms in the key worker`);
    }
  };
  /**
   * A recording as the store keeps it. Only the stored recording loses the
   * credentials that the upstream minted (`secrets.redactFields`), because
   * the client needs them for its next live requests. A body that is not
   * text gets this too when it is UTF-8 JSON, whatever its content type
   * says. The `location` header loses the values of its minted credential
   * parameters (`secrets.redactLocation`). The minted values are known
   * from then on, so the recording is redacted again.
   */
  const toStored = (recording: Recording): Recording => {
    const { response } = recording;
    const headers = { ...response.headers };
    if (headers.location) {
      headers.location = secrets.redactLocation(headers.location);
    }
    let { body } = response;
    if (response.bodyEncoding === "utf8") {
      body = secrets.redactFields(body, headers["content-type"]);
    } else {
      const text = utf8Text(Buffer.from(body, "base64"));
      const redacted = text && secrets.redactFields(text);
      if (redacted && redacted !== text) {
        body = secrets.redactBytes(Buffer.from(redacted)).toString("base64");
      }
    }
    return JSON.parse(
      secrets.redact(
        JSON.stringify({
          ...recording,
          response: { ...response, headers, body },
        }),
      ),
    ) as Recording;
  };
  const refused: NonNullable<RecordingStats["refused"]> = {};
  const stats: RecordingStats = {
    counts: Object.fromEntries(
      config.rules.map((rule) => [
        rule.name,
        { live: 0, missed: 0, replayed: 0 },
      ]),
    ),
    misses: [],
    written: 0,
    discarded: 0,
    passthrough: {},
    refused,
  };
  /** Count recordings by rule in `roach.recording.write`. */
  const countRecordings = (keys: string[], result: "dropped" | "written") => {
    const byRule = new Map<string, number>();
    for (const key of keys) {
      const rule = key.slice(0, key.indexOf("/"));
      byRule.set(rule, (byRule.get(rule) ?? 0) + 1);
    }
    for (const [rule, value] of byRule) {
      telemetry.count("roach.recording.write", value, {
        "roach.rule": rule,
        "roach.result": result,
      });
    }
  };
  const write = async (recordings: Array<[string, NewRecording]>) => {
    stats.written += await store.write(
      recordings.map(([key, { recording }]) => [key, recording]),
    );
    // A sample only explains a later miss, so a failed write does not fail
    // the request or the session.
    await store
      .write(recordings.flatMap(([, { samples }]) => samples))
      .catch((error: unknown) => {
        reportInternal("Sample write", error, telemetry.capture(error));
      });
    countRecordings(
      recordings.map(([key]) => key),
      "written",
    );
  };
  const drop = (keys: string[]) => {
    stats.discarded += keys.length;
    countRecordings(keys, "dropped");
  };

  const record = async (
    owner: Session | undefined,
    key: string,
    recording: NewRecording,
  ) => {
    if (owner && owner.passed === undefined) {
      // The last response wins, but each place keeps its sample.
      const earlier = owner.recorded.get(key)?.samples ?? [];
      owner.recorded.set(key, {
        ...recording,
        samples: [...earlier, ...recording.samples],
      });
    } else if (owner?.passed === false) {
      drop([key]);
    } else {
      await write([[key, recording]]);
    }
  };

  /** Requests outside a session. */
  const outside: Places = { sent: new Map(), explained: false };

  /** The sample key of the next request of `rule` in `owner`. */
  const nextSample = (rule: string, owner: Session | undefined) => {
    const places = owner ?? outside;
    const index = places.sent.get(rule) ?? 0;
    places.sent.set(rule, index + 1);
    return sampleKey(rule, owner?.name, index);
  };

  /**
   * Report a miss. The first miss of a session reads the sample of its
   * place (`sample`), and finds the first change from it to the text of the
   * request (`text`). The span of the request gets the change and its
   * text. The stats get only its key and offset, and only with
   * `explainMisses`. A failed read only leaves the change out.
   */
  const reportMiss = async (
    rule: RecordingRule,
    key: string,
    owner: Session | undefined,
    sample: string,
    text: () => Promise<string | undefined>,
  ) => {
    const where = owner ? ` in "${owner.name}"` : "";
    process.stderr.write(`[roach] No ${rule.name} recording${where}: ${key}\n`);
    const miss: RecordingMiss | undefined =
      stats.misses.length < MAX_MISSES
        ? { rule: rule.name, session: owner?.name, file: key }
        : undefined;
    if (miss) stats.misses.push(miss);
    const places = owner ?? outside;
    if (places.explained) return;
    places.explained = true;
    const read = (await store.read(sample).catch(() => undefined)) as
      | RequestSample
      | undefined;
    const recorded = read?.withheld ? undefined : read;
    // The redacted text has a time limit. Past it, the change is left out.
    const redacted = recorded && (await text());
    const change = redacted && firstChange(recorded, redacted);
    telemetry.annotate({
      "miss.sample": read ? (recorded ? "found" : "withheld") : "none",
    });
    if (!change) return;
    telemetry.annotate({
      "miss.changed_at": change.at,
      "miss.compared": change.file,
      "miss.recorded": change.recorded,
      "miss.request": change.request,
    });
    if (config.explainMisses && miss) {
      miss.change = { file: change.file, at: change.at };
    }
  };

  /** End a session. Returns its requests that `replay` mode failed. */
  const finish = async (ended: Session, passed: boolean): Promise<number> => {
    ended.passed = passed;
    const recorded = [...ended.recorded];
    ended.recorded.clear();
    forget(ended);
    if (passed) await write(recorded);
    else drop(recorded.map(([key]) => key));
    return ended.missed;
  };

  /**
   * The session of a request. `id` comes from its proxy URL. Without it,
   * the request belongs to the open session when only one is open.
   */
  const sessionOf = (id: string | undefined): Session | undefined => {
    if (id !== undefined) return sessions.get(id);
    const current = open();
    return current.length === 1 ? current[0] : undefined;
  };

  return {
    /** The rule that records a request, or `undefined` when none does. */
    ruleFor(request: ProxyRequest): RecordingRule | undefined {
      if (config.mode === "off") return undefined;
      return config.rules.find((rule) => matches(rule, request));
    },

    /**
     * Learn the credentials of a request that no rule records, before it
     * goes out. It throws when the run cannot learn more.
     */
    learn(headers: IncomingHttpHeaders): void {
      secrets.learn(headers);
    },

    /** Count a request that no rule records. */
    countPassthrough(origin: string, sessionId?: string): void {
      stats.passthrough[origin] = (stats.passthrough[origin] ?? 0) + 1;
      const owner = sessionOf(sessionId);
      telemetry.annotate({
        "roach.result": "passthrough",
        ...(owner ? { "roach.session": owner.name } : {}),
      });
      telemetry.count("roach.request", 1, {
        "roach.origin": origin,
        "roach.result": "passthrough",
      });
    },

    /** Count a request that the proxy refused and sent nowhere. */
    countRefused(reason: RefusalReason, origin: string): void {
      const origins = (refused[reason] ??= {});
      const name =
        origin in origins || Object.keys(origins).length < MAX_REFUSED_ORIGINS
          ? origin
          : OTHER_ORIGINS;
      origins[name] = (origins[name] ?? 0) + 1;
      const attributes = { "roach.result": "refused", "roach.reason": reason };
      telemetry.annotate(attributes);
      // The client picks an origin that is not in `allow`, so the metric
      // names it only as `other`. The span has the origin.
      telemetry.count("roach.request", 1, {
        ...attributes,
        "roach.origin": reason === "notAllowed" ? METRIC_OTHER_ORIGIN : origin,
      });
    },

    /**
     * Answer a request that `rule` records. `sendLive` sends it upstream.
     * A live response goes through the same template as a recording, so
     * the client gets the same body from a live run and from a replay.
     */
    async respond(
      rule: RecordingRule,
      request: ProxyRequest,
      sendLive: () => Promise<ProxyResponse>,
      sessionId?: string,
    ): Promise<ProxyResponse & { source: ResponseSource }> {
      const started = performance.now();
      const origin = request.url.origin;
      // A request belongs to the session that was open when it started.
      const owner = sessionOf(sessionId);
      const sample = nextSample(rule.name, owner);
      const counts = stats.counts[rule.name]!;
      secrets.learn(request.headers, request.url);
      telemetry.annotate({
        "roach.rule": rule.name,
        ...(owner ? { "roach.session": owner.name } : {}),
      });
      const { keyed, key } = await telemetry.span(
        { op: "roach.key", attributes: { "roach.rule": rule.name } },
        async () => {
          const toKey = {
            method: request.method,
            url: request.url.href,
            headers: request.headers,
            body: request.body.toString("utf8"),
          };
          const options = jobOptions(request.body.length);
          const value = workLimit.untrusted
            ? await keyInWorker(rule, toKey, owner?.known, options).then(
                (result) => {
                  countWork(result.ms);
                  return result.value;
                },
                (error: JobError) => {
                  countWork(error.ms);
                  if (error.timedOut && !closed) {
                    config.endRun("a key went past its time limit");
                    error.message += " This run has ended.";
                  }
                  throw error;
                },
              )
            : keyRequest(
                rule,
                toKey,
                owner?.known,
                options.timeLimitMs,
                options.maxValues,
              );
          const name = recordingKey(rule.name, value.key);
          telemetry.annotate({ "roach.key": name });
          return { keyed: value, key: name };
        },
      );
      /** The redacted text of the key, or `undefined` past the time limit. */
      const redactedText = async (): Promise<string | undefined> => {
        if (!workLimit.untrusted) {
          try {
            return withTimeLimit(keyTimeLimit(keyed.text.length), () =>
              secrets.redactRequest(keyed.text, request, rule),
            );
          } catch {
            return undefined;
          }
        }
        return redactInWorker(
          secrets.list(),
          keyed.text,
          toRedact(request, rule),
          jobOptions(keyed.text.length),
        ).then(
          (result) => {
            countWork(result.ms);
            return result.value;
          },
          (error: JobError) => {
            countWork(error.ms);
            return undefined;
          },
        );
      };
      // A session remembers every value of its requests. A value that it
      // dropped would change the keys of later requests that repeat it.
      if (owner) remember(owner, keyed.values);
      const report = (result: ResponseSource, response?: ProxyResponse) => {
        const attributes = {
          "roach.rule": rule.name,
          "roach.origin": origin,
          "roach.result": result,
        };
        telemetry.annotate({ "roach.result": result });
        const usage =
          response &&
          usageAttributes(
            request.body.toString("utf8"),
            response.headers["content-type"],
            response.body.toString("utf8"),
          );
        if (usage) telemetry.annotate(usage);
        telemetry.count("roach.request", 1, attributes);
        telemetry.time(
          "roach.request.duration",
          performance.now() - started,
          attributes,
        );
      };

      if (config.mode !== "record") {
        const recording = (await store.read(key)) as Recording | undefined;
        if (recording) {
          counts.replayed += 1;
          const response = fromRecording(recording, keyed.values);
          report("replayed", response);
          return { ...response, source: "replayed" };
        }
        await reportMiss(rule, key, owner, sample, redactedText);
        if (config.mode === "replay") {
          counts.missed += 1;
          if (owner) owner.missed += 1;
          report("missed");
          return {
            status: 412,
            headers: { "content-type": "text/plain" },
            body: Buffer.from(
              `Roach: no ${rule.name} recording for this request in replay mode. Run in auto mode to record it.\n`,
            ),
            source: "missed",
          };
        }
      }

      const upstream = await telemetry.span(
        {
          op: "roach.upstream",
          name: `${request.method} ${origin}`,
          attributes: {
            "roach.origin": origin,
            "http.request.method": request.method,
          },
        },
        async () => {
          const response = await sendLive();
          telemetry.annotate({ "http.response.status_code": response.status });
          return response;
        },
      );
      // Count it only when it went out. A refused address counts as
      // refused (`server.ts`).
      counts.live += 1;
      /**
       * Do not record the response, because the recorder cannot redact it:
       * it cannot read the body, or the body decodes to more than
       * `MAX_DECODED_BYTES` of `recording-file.ts`, or a minted credential stays in it. The client
       * gets it as it came.
       */
      const notRecorded = (why: string, error: unknown) => {
        process.stderr.write(
          `[roach] The ${rule.name} response was not recorded, because ${why} (${(error as Error).message}): ${key}\n`,
        );
        report("live");
        const headers: IncomingHttpHeaders = {};
        for (const name of [...RECORDED_HEADERS, "content-encoding"]) {
          if (upstream.headers[name]) headers[name] = upstream.headers[name];
        }
        return { ...upstream, headers, source: "live" as const };
      };
      let live: ProxyResponse;
      try {
        live = { ...upstream, body: await decodeBody(upstream) };
      } catch (error) {
        return notRecorded("its body could not be decoded", error);
      }
      // The client gets the known credentials redacted too, so a live run
      // and a replay give the same body.
      const recording = JSON.parse(
        secrets.redact(
          JSON.stringify(
            toRecording(
              request,
              rule,
              keyed,
              owner?.name,
              live,
              secrets.redactBytes,
            ),
          ),
        ),
      ) as Recording;
      if (!isTemporaryStatus(recording.response.status)) {
        let stored: Recording;
        try {
          stored = toStored(recording);
        } catch (error) {
          return notRecorded("it could not be redacted", error);
        }
        const text = secrets.redactRequest(keyed.text, request, rule);
        if (text === undefined) {
          // A credential field of the request can stay in the text, so the
          // recorder writes a sample without text.
          process.stderr.write(
            `[roach] The ${rule.name} request sample has no text, because a credential field could not be redacted: ${key}\n`,
          );
        }
        await record(owner, key, {
          recording: stored,
          samples: [
            [
              sample,
              text === undefined ? withheldSample(key) : toSample(key, text),
            ],
          ],
        });
      }
      const response = fromRecording(recording, keyed.values);
      report("live", response);
      return { ...response, source: "live" };
    },

    /**
     * Open the session of one test, and return its id. An open session with
     * the same name fails first. Throws an error with HTTP status 429 when
     * the run has too many open sessions.
     */
    async startSession(name: string): Promise<string> {
      const same = open().find((other) => other.name === name);
      if (same) {
        process.stderr.write(
          `[roach] Session "${name}" did not end, so its new recordings were dropped\n`,
        );
        await finish(same, false);
      }
      if (open().length >= MAX_OPEN_SESSIONS) {
        throw httpError(
          429,
          `A run can have ${MAX_OPEN_SESSIONS} open sessions`,
        );
      }
      const ended = [...sessions.values()].filter(
        (other) => other.passed !== undefined,
      );
      const extra = ended.length - MAX_ENDED_SESSIONS + 1;
      for (const old of ended.slice(0, Math.max(0, extra))) {
        forget(old);
        sessions.delete(old.id);
      }
      const id = randomBytes(8).toString("hex");
      sessions.set(id, {
        id,
        name,
        recorded: new Map(),
        missed: 0,
        known: new Map(),
        sent: new Map(),
        explained: false,
      });
      return id;
    },

    /**
     * End the open session `name`. Returns its requests that `replay` mode
     * failed. Throws an error with HTTP status 409 when no open session has
     * that name.
     */
    async endSession(name: string, passed: boolean): Promise<number> {
      const ended = open().find((other) => other.name === name);
      if (!ended) {
        throw httpError(409, `Session "${name}" is not open`);
      }
      return finish(ended, passed);
    },

    stats(): RecordingStats {
      return stats;
    },

    /** Fail the open sessions, and start no more jobs of the run. */
    async close(): Promise<void> {
      closed = true;
      for (const session of open()) await finish(session, false);
    },
  };
}

/** The recorder of one run. */
export type Recorder = ReturnType<typeof createRecorder>;

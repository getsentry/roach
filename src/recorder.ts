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
 * its proxy URL (`service/service.ts`). A request that names no session
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
 * The recorder never writes a known credential (`secrets.ts`). It reports
 * spans and metrics through the `Telemetry` hooks of `service/service.ts`.
 */
import { randomBytes } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import { firstChange, sampleKey, toSample } from "./misses.ts";
import { keyRequest, type KeyedRequest } from "./request-key.ts";
import { createSecrets } from "./secrets.ts";
import {
  recordingKey,
  RULE_NAME,
  type Recording,
  type RecordingStore,
  type RequestSample,
} from "./store.ts";
import {
  isEventStream,
  mapStreamEvents,
  mergeStreamDeltas,
} from "./streams.ts";
import { usageAttributes } from "./usage.ts";
import type {
  RecordingMiss,
  RecordingMode,
  RecordingRule,
  RecordingStats,
  RefusalReason,
} from "./types.ts";
import { fillValues, templateValues, type RequestValues } from "./values.ts";

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
type Attributes = Record<string, string | number | boolean>;

/**
 * Hooks that report spans and metrics. `service/service.ts` gives hooks
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
   * request can repeat one where no pattern finds it (`values.ts`).
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
/**
 * Ended sessions that a run keeps, so that late requests follow their
 * result. The oldest ones go first, so memory stays bounded.
 */
const MAX_ENDED_SESSIONS = 1000;
/** Open sessions of a run, such as one for each test worker. */
const MAX_OPEN_SESSIONS = 64;
/** Response headers that a recording keeps. Other headers change each run. */
const RECORDED_HEADERS = ["content-type", "location"];
const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);

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

/**
 * The response as a recording keeps it. A stream gets one delta per content
 * block, and each value of the request becomes a placeholder.
 */
function toRecording(
  request: ProxyRequest,
  keyed: KeyedRequest,
  session: string | undefined,
  response: ProxyResponse,
): Recording {
  const contentType = response.headers["content-type"];
  const headers: Record<string, string> = {};
  for (const name of RECORDED_HEADERS) {
    const value = response.headers[name];
    if (typeof value === "string") headers[name] = value;
  }
  let body = response.body.toString("base64");
  let bodyEncoding: Recording["response"]["bodyEncoding"] = "base64";
  if (/^text\/|json|xml/i.test(contentType ?? "")) {
    const text = response.body.toString("utf8");
    const template = (part: string) => templateValues(part, keyed.values);
    body = isEventStream(contentType)
      ? mapStreamEvents(mergeStreamDeltas(text), template)
      : template(text);
    bodyEncoding = "utf8";
  }
  return {
    session,
    request: { method: request.method, url: request.url.href },
    response: { status: response.status, headers, body, bodyEncoding },
  };
}

/** The response of a recording, with the values of the current request. */
function fromRecording(
  { response }: Recording,
  values: RequestValues,
): ProxyResponse {
  const body = NULL_BODY_STATUSES.has(response.status)
    ? Buffer.alloc(0)
    : response.bodyEncoding === "utf8"
      ? Buffer.from(fillValues(response.body, values))
      : Buffer.from(response.body, "base64");
  return { status: response.status, headers: response.headers, body };
}

/** The config of a recorder. */
export interface RecorderConfig {
  mode: RecordingMode;
  rules: RecordingRule[];
  /** Credentials to redact, in addition to the ones that it learns. */
  secrets?: string[];
  /**
   * Add the first change from a request sample to the first miss of each
   * session in the stats (`misses.ts`). Only a run with the write token may
   * set it: a change shows a part of a recorded request, so a public run
   * could read the requests of a tenant back. The span gets the change
   * without it.
   */
  explainMisses?: boolean;
  telemetry: Telemetry;
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
  const secrets = createSecrets(config.secrets);
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
      telemetry.count("roach.recording.write", value, { rule, result });
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
        process.stderr.write(
          `[roach] Request samples were not written: ${(error as Error).message}\n`,
        );
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
    text: () => string,
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
    const recorded = (await store.read(sample).catch(() => undefined)) as
      | RequestSample
      | undefined;
    const change = recorded && firstChange(recorded, text());
    telemetry.annotate({ "miss.sample": recorded ? "found" : "none" });
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
    ended.known.clear();
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

    /** Count a request that no rule records, and learn its credentials. */
    countPassthrough(origin: string, headers: IncomingHttpHeaders): void {
      secrets.learn(headers);
      stats.passthrough[origin] = (stats.passthrough[origin] ?? 0) + 1;
      telemetry.annotate({ result: "passthrough" });
      telemetry.count("roach.request", 1, { origin, result: "passthrough" });
    },

    /** Count a request that the proxy refused and sent nowhere. */
    countRefused(reason: RefusalReason, origin: string): void {
      const origins = (refused[reason] ??= {});
      const name =
        origin in origins || Object.keys(origins).length < MAX_REFUSED_ORIGINS
          ? origin
          : OTHER_ORIGINS;
      origins[name] = (origins[name] ?? 0) + 1;
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
      telemetry.annotate({ rule: rule.name });
      const { keyed, key } = telemetry.span(
        { op: "roach.key", attributes: { rule: rule.name } },
        () => {
          const result = keyRequest(
            rule,
            {
              method: request.method,
              url: request.url.href,
              headers: request.headers,
              body: request.body.toString("utf8"),
            },
            owner?.known,
          );
          const name = recordingKey(rule.name, result.key);
          telemetry.annotate({ key: name });
          return { keyed: result, key: name };
        },
      );
      const redactedText = () => secrets.redactRequest(keyed.text, request.url);
      if (owner) {
        for (const [name, list] of keyed.values) {
          for (const value of list) {
            if (!owner.known.has(value)) owner.known.set(value, name);
          }
        }
      }
      const report = (result: ResponseSource, response?: ProxyResponse) => {
        const attributes = { rule: rule.name, origin, result };
        telemetry.annotate({ result });
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

      const live = await telemetry.span(
        {
          op: "roach.upstream",
          name: `${request.method} ${origin}`,
          attributes: { origin, "http.request.method": request.method },
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
      // The client gets the redacted response too, so a live run and a
      // replay give the same body.
      const recording = JSON.parse(
        secrets.redact(
          JSON.stringify(toRecording(request, keyed, owner?.name, live)),
        ),
      ) as Recording;
      if (!isTemporaryStatus(recording.response.status)) {
        await record(owner, key, {
          recording,
          samples: [[sample, toSample(key, redactedText())]],
        });
      }
      const response = fromRecording(recording, keyed.values);
      report("live", response);
      return { ...response, source: "live" };
    },

    /**
     * Open the session of one test, and return its id. An open session with
     * the same name fails first. Throws when the run has too many open
     * sessions.
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
        throw new Error(`A run can have ${MAX_OPEN_SESSIONS} open sessions`);
      }
      const ended = [...sessions.values()].filter(
        (other) => other.passed !== undefined,
      );
      const extra = ended.length - MAX_ENDED_SESSIONS + 1;
      for (const old of ended.slice(0, Math.max(0, extra))) {
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
     * failed. Throws when no open session has that name.
     */
    async endSession(name: string, passed: boolean): Promise<number> {
      const ended = open().find((other) => other.name === name);
      if (!ended) throw new Error(`Session "${name}" is not open`);
      return finish(ended, passed);
    },

    stats(): RecordingStats {
      return stats;
    },

    /** Fail the open sessions. */
    async close(): Promise<void> {
      for (const session of open()) await finish(session, false);
    },
  };
}

/** The recorder of one run. */
export type Recorder = ReturnType<typeof createRecorder>;

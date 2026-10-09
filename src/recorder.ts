/**
 * The recording logic of the proxy: modes, sessions, replay, and misses.
 *
 * `server.ts` owns the sockets. It gives the recorder each request that a
 * rule matches, with a function that sends the request live. The recorder
 * decides whether to replay, send live, or fail the request, and it owns
 * every read and write of the recordings. A store keeps them: the file
 * store (`recordings.ts`) or a Roach Worker (`remote-store.ts`).
 *
 * A session groups the requests of one test. One session is open at a
 * time. The recorder keeps the new recordings of a session in memory until
 * the session ends. A passed session writes them, and a failed session
 * drops them, so a bad sample is never replayed. A request that ends after
 * its session ended follows the result of that session. A request outside
 * a session is written at once.
 *
 * The recorder never writes a known credential (`secrets.ts`). It redacts
 * them in recordings and miss files.
 */
import { mkdir, writeFile } from "node:fs/promises";
import type { IncomingHttpHeaders } from "node:http";
import path from "node:path";
import { describeParts } from "./parts.ts";
import { createFileStore } from "./recordings.ts";
import { createRemoteStore } from "./remote-store.ts";
import { keyRequest, type KeyedRequest } from "./request-key.ts";
import { createSecrets } from "./secrets.ts";
import {
  recordingKey,
  RULE_NAME,
  type Recording,
  type RecordingStore,
} from "./store.ts";
import {
  isEventStream,
  mapStreamEvents,
  mergeStreamDeltas,
} from "./streams.ts";
import type {
  RecordingMiss,
  RoachConfig,
  RecordingRule,
  RecordingStats,
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

interface Session {
  name: string;
  /** New recordings, by key. */
  recorded: Map<string, Recording>;
  /** Keys that the session replayed. They stay used if it fails. */
  replayed: Set<string>;
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
  if (match.url && !url.href.startsWith(match.url)) return false;
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
    request: {
      method: request.method,
      url: request.url.href,
      parts: keyed.parts,
    },
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

/** The store of a config. Throws when the config does not name one. */
function storeOf(config: RoachConfig): RecordingStore {
  if ((config.directory === undefined) === (config.store === undefined)) {
    throw new Error("Roach config must set directory or store, not both");
  }
  for (const rule of config.rules) {
    if (!RULE_NAME.test(rule.name)) {
      throw new Error(`Roach rule name is not valid: ${rule.name}`);
    }
  }
  if (config.store) {
    if (config.usedFile) throw new Error("usedFile needs directory");
    return createRemoteStore(config.store);
  }
  return createFileStore(config.directory!);
}

/** Create the recorder of one proxy run. */
export function createRecorder(config: RoachConfig) {
  const store = storeOf(config);
  const missDirectory = config.missDirectory
    ? path.resolve(config.missDirectory)
    : undefined;
  if (
    missDirectory &&
    config.directory !== undefined &&
    !path.relative(config.directory, missDirectory).startsWith("..")
  ) {
    // Miss files hold request bodies. Keep them out of the committed files.
    throw new Error("missDirectory must not be inside directory");
  }
  let session: Session | undefined;
  const secrets = createSecrets([
    ...(config.secrets ?? []),
    ...(config.store ? [config.store.token] : []),
  ]);
  /** Recordings that passed sessions, or requests outside one, used. */
  const used = new Set<string>();
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
  };
  const write = async (recordings: Array<[string, Recording]>) => {
    stats.written += await store.write(recordings);
  };

  const markReplayed = (owner: Session | undefined, key: string) => {
    if (owner && owner.passed === undefined) owner.replayed.add(key);
    else used.add(key);
  };

  const record = async (
    owner: Session | undefined,
    key: string,
    recording: Recording,
  ) => {
    if (owner && owner.passed === undefined) {
      owner.recorded.set(key, recording);
    } else if (owner?.passed === false) {
      stats.discarded += 1;
    } else {
      used.add(key);
      await write([[key, recording]]);
    }
  };

  const reportMiss = async (
    rule: RecordingRule,
    key: string,
    keyed: KeyedRequest,
    owner: Session | undefined,
  ) => {
    const closest = await store.closest(rule.name, keyed.parts, owner?.name);
    const miss: RecordingMiss = {
      rule: rule.name,
      session: owner?.name,
      file: key,
      closest: closest?.key,
      differs: closest?.differs ?? [],
    };
    if (stats.misses.length < MAX_MISSES) stats.misses.push(miss);
    const where = owner ? ` in "${owner.name}"` : "";
    const why = closest
      ? `closest is ${miss.closest}, which differs at ${describeParts(miss.differs)}`
      : "no recording to compare";
    process.stderr.write(`[roach] No ${rule.name} recording${where}: ${why}\n`);
    if (missDirectory) {
      const target = path.join(missDirectory, miss.file);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(
        target,
        secrets.redact(
          `${JSON.stringify({ ...miss, request: keyed.normalized }, null, 2)}\n`,
        ),
      );
    }
  };

  /** End the open session. Returns its requests that `replay` mode failed. */
  const finish = async (passed: boolean): Promise<number> => {
    const ended = session;
    if (!ended) return 0;
    session = undefined;
    ended.passed = passed;
    // A failed test can still show that a recording is in use.
    for (const key of ended.replayed) used.add(key);
    if (passed) {
      for (const key of ended.recorded.keys()) used.add(key);
      await write([...ended.recorded]);
    } else {
      stats.discarded += ended.recorded.size;
      // A failed test stops early, so it does not replay all of its
      // recordings. Keep every recording that it made before, so that a
      // prune does not delete them.
      for (const key of (await store.keysOf?.(ended.name)) ?? []) {
        used.add(key);
      }
    }
    return ended.missed;
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
    ): Promise<ProxyResponse & { source: ResponseSource }> {
      // A request belongs to the session that was open when it started.
      const owner = session;
      const counts = stats.counts[rule.name]!;
      secrets.learn(request.headers);
      const keyed = keyRequest(
        rule,
        {
          method: request.method,
          url: request.url.href,
          headers: request.headers,
          body: request.body.toString("utf8"),
        },
        owner?.known,
      );
      if (owner) {
        for (const [name, list] of keyed.values) {
          for (const value of list) {
            if (!owner.known.has(value)) owner.known.set(value, name);
          }
        }
      }
      const key = recordingKey(rule.name, keyed.key);

      if (config.mode !== "record") {
        const recording = await store.read(key);
        if (recording) {
          counts.replayed += 1;
          markReplayed(owner, key);
          return {
            ...fromRecording(recording, keyed.values),
            source: "replayed",
          };
        }
        await reportMiss(rule, key, keyed, owner);
        if (config.mode === "replay") {
          counts.missed += 1;
          if (owner) owner.missed += 1;
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

      counts.live += 1;
      // The client gets the redacted response too, so a live run and a
      // replay give the same body.
      const recording = JSON.parse(
        secrets.redact(
          JSON.stringify(
            toRecording(request, keyed, owner?.name, await sendLive()),
          ),
        ),
      ) as Recording;
      if (!isTemporaryStatus(recording.response.status)) {
        await record(owner, key, recording);
      }
      return { ...fromRecording(recording, keyed.values), source: "live" };
    },

    /** Open the session of one test. An open session fails first. */
    async startSession(name: string): Promise<void> {
      if (session) {
        process.stderr.write(
          `[roach] Session "${session.name}" did not end, so its new recordings were dropped\n`,
        );
        await finish(false);
      }
      session = {
        name,
        recorded: new Map(),
        replayed: new Set(),
        missed: 0,
        known: new Map(),
      };
    },

    /**
     * End the session `name`. Returns its requests that `replay` mode
     * failed. Throws when `name` is not the open session.
     */
    async endSession(name: string, passed: boolean): Promise<number> {
      if (session?.name !== name) {
        throw new Error(`Session "${name}" is not open`);
      }
      return finish(passed);
    },

    stats(): RecordingStats {
      return stats;
    },

    /** Fail the open session, and write `usedFile` of the config. */
    async close(): Promise<void> {
      await finish(false);
      if (config.usedFile) {
        const keys = [...used].toSorted();
        await writeFile(
          config.usedFile,
          keys.map((key) => `${key}\n`).join(""),
        );
      }
    },
  };
}

/** The recorder of one proxy run. */
export type Recorder = ReturnType<typeof createRecorder>;

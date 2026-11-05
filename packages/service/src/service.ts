/**
 * Roach as a shared service. See "Service" in `README.md`.
 *
 * One process serves the runs of many tenants on one port. A tenant is a
 * GitHub repository, named `owner/repo`, such as `getsentry/junior`. The
 * service has no list of tenants: a run names its tenant. A run is one test
 * run of a tenant, such as one CI job. It has its own mode, rules,
 * sessions, and stats.
 *
 * - Anyone can create a `replay` run of a tenant, so CI jobs of forks
 *   replay recordings without a secret. Such a run never writes.
 * - A run in another mode needs the write token, because it writes
 *   recordings. All tenants share one write token, and the service keeps
 *   only its SHA-256. The tenant name is a label, not proof of identity:
 *   a holder of the token can write the recordings of any tenant.
 * - The service gives each run its own id and token. A proxied request
 *   names its run in `Proxy-Authorization`, as `Basic base64(<id>:<token>)`.
 *   The proxy URL of the run has them, so `HTTPS_PROXY` sends them.
 * - A run sends its own config: its origins (`allow`), rules, and value
 *   patterns. So a tenant changes what it records without a change to the
 *   service. Two checks keep that safe for the other tenants. The proxy
 *   sends requests only to public addresses (`addresses.ts`), so a run
 *   cannot reach the metadata server or the VPC. The key of a request has
 *   a time limit, and it is made in a worker thread (`key-worker.ts`), so
 *   a slow pattern fails only its own request.
 * - The recordings of a tenant are under `<tenant>/`, in a directory or a
 *   GCS bucket (`gcs.ts`). Tenants never share recordings, because a key
 *   does not include credentials.
 * - With `sentryDsn`, the service sends spans, metrics, and unexpected
 *   errors to Sentry. See "Sentry" in `README.md`. Metrics have only
 *   attributes with few values, so the key, the run, the session, and the
 *   CI job are only on spans.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type http from "node:http";
import path from "node:path";
import * as Sentry from "@sentry/node";
import {
  createCertificateAuthority,
  type CertificateAuthorityPem,
} from "./certificates.ts";
import { reportInternal } from "./errors.ts";
import { createGcsStore } from "./gcs.ts";
import {
  createRecorder,
  type Attributes,
  type Telemetry,
  type WorkLimit,
} from "./recorder.ts";
import { createFileStore } from "./recordings.ts";
import {
  clientAddress,
  clientGroup,
  controlRecorder,
  listenProxy,
  parseOrigins,
  readJson,
  sameToken,
  sendJson,
  type ProxyTarget,
  type TargetResult,
} from "./server.ts";
import { RULE_NAME, type RecordingStore } from "./store.ts";
import {
  CONTROL_PATH,
  type RecordingMode,
  type RecordingStats,
  type RemoteRun,
  type RunCi,
  type RunConfig,
} from "@sentry/roach/types";
import { invalidValuePatterns } from "@sentry/roach/values";

/** The configuration of the service. The operator owns it. */
export interface RoachServiceConfig {
  /** Default: `127.0.0.1`. */
  host?: string;
  /** Default: a free port. */
  port?: number;
  /**
   * The URL that clients use to reach the service, such as
   * `https://roach.example.com`. Default: `http://<host>:<port>`.
   */
  publicUrl?: string;
  /** A directory for the recordings. Set this or `bucket`. */
  directory?: string;
  /** A GCS bucket for the recordings. Set this or `directory`. */
  bucket?: string;
  /**
   * The SHA-256 of the write token, in hex. All tenants share the token.
   * Give it only to CI jobs that you trust.
   */
  writeTokenHash: string;
  /** Credentials to redact in all recordings. */
  secrets?: string[];
  /**
   * Let runs reach addresses that are not public, such as `127.0.0.1` and
   * the metadata server. Only for tests and local development. Default:
   * `false`.
   */
  privateNetworks?: boolean;
  /**
   * The certificate authority that signs intercepted hosts. Clients trust
   * it, so a deployed service must keep it across restarts. Default: a new
   * one at each start.
   */
  ca?: CertificateAuthorityPem;
  /** Without a DSN, the service sends nothing to Sentry. */
  sentryDsn?: string;
  /**
   * Read a PROXY protocol v1 header at the start of each connection, such
   * as from a GCP proxy load balancer with `proxy_header = "PROXY_V1"`. The
   * service takes the address of the client from it, for the limit of runs
   * for each client. A connection without the header uses the address of
   * its socket, so the service works before and after the load balancer
   * sends the header. Default: `false`.
   */
  proxyProtocol?: boolean;
}

/** A service that runs in this process. */
export interface RoachService {
  /** The URL of the service. */
  url: string;
  /** Stop the service. Open runs fail. */
  close(): Promise<void>;
}

interface Run extends ProxyTarget {
  id: string;
  token: string;
  started: number;
  lastUsed: number;
  /**
   * The address group (`clientGroup()`) of the client that started a run
   * without a token.
   */
  client?: string;
}

const MODES = new Set<RecordingMode>(["auto", "off", "record", "replay"]);
/** The service gets little traffic, so it keeps all traces. */
const TRACES_SAMPLE_RATE = 1;
/** A run that is open longer than this ends as failed, such as a dead job. */
const RUN_TIMEOUT_MS = 6 * 60 * 60 * 1000;
/**
 * Anyone can start a run without a token, so such runs have smaller
 * limits. One ends after 2 hours, or after 60 minutes without a proxied
 * request or a control call. The action starts the run before the command
 * of the job, so a long install or build step must not end it.
 */
const PUBLIC_RUN_TIMEOUT_MS = 2 * 60 * 60 * 1000;
const PUBLIC_RUN_IDLE_MS = 60 * 60 * 1000;
/**
 * The open runs without a token that the service can have, for all tenants.
 * Anyone can start them with any tenant name, so the cap is not per tenant.
 * It keeps memory bounded. Runs with the token have no cap.
 */
const MAX_PUBLIC_RUNS = 100;
/**
 * The open runs without a token of one client address, or of one IPv6 /64,
 * so one client cannot take all places of `MAX_PUBLIC_RUNS`.
 */
const MAX_PUBLIC_RUNS_PER_CLIENT = 10;
/** A proxied request body of a run without a token over this gets 413. */
const PUBLIC_MAX_BODY_BYTES = 16 * 1024 * 1024;
/**
 * The time that a run can use in the key worker (`key-worker.ts`). A key
 * has 1 s and 0.5 s for each MiB of its body. For a run without a token,
 * one job has at most 5 s and all jobs 30 s. Past that, or when a key goes
 * past its time limit, the run ends. In the 14 days to 2026-11-05, the key
 * time of a run was at most 9.5 s (p99 9.1 s, about 1,000 keys). A request
 * of a run without a token can have at most 100,000 changing values.
 */
const PUBLIC_WORK_LIMIT: WorkLimit = {
  maxJobMs: 5000,
  maxValues: 100_000,
  totalMs: 30_000,
  untrusted: true,
};
const WRITE_WORK_LIMIT: WorkLimit = {
  maxJobMs: Infinity,
  maxValues: Infinity,
  totalMs: Infinity,
  untrusted: false,
};
const MAX_RUN_NAME = 128;
/**
 * Limits of the config of a run. Anyone can start a run, so they keep the
 * work of a run small: the service makes a certificate for each host that
 * a run tunnels to, and runs each value pattern on each request.
 */
const MAX_RUN_ORIGINS = 32;
const MAX_RULES = 64;
const MAX_RULE_VALUES = 32;
const MAX_RULE_URLS = 32;
const MAX_PATTERN_LENGTH = 2048;
/** The span attribute of each field of `RunConfig.ci`. */
const CI_ATTRIBUTES: Record<keyof RunCi, string> = {
  runId: "roach.ci.run_id",
  job: "roach.ci.job",
  repo: "roach.ci.repo",
  ref: "roach.ci.ref",
};
const MAX_CI_VALUE = 256;
/** Enough for the API keys and OIDC tokens of a CI job. */
const MAX_RUN_SECRETS = 32;
const MAX_SECRET_LENGTH = 16 * 1024;
/**
 * The credentials that a run learns from its requests (`secrets.ts`). A
 * run without a token gets a small limit, because anyone can start one.
 * A run with the token gets more, for credentials that change on each
 * request, such as AWS signatures.
 */
const PUBLIC_LEARN_LIMIT = { values: 1024, length: 1024 * 1024 };
const WRITE_LEARN_LIMIT = { values: 16 * 1024, length: 16 * 1024 * 1024 };
/**
 * A tenant name: `owner/repo`, with the characters of GitHub names. It is a
 * path in the store, so each part starts with a letter, digit, or `_`, and
 * there are always two parts. Then no tenant is in the directory of another.
 */
const TENANT_NAME = /^[A-Za-z0-9_][\w.-]{0,99}\/[A-Za-z0-9_][\w.-]{0,99}$/;

const sha256 = (value: string) => createHash("sha256").update(value).digest();

/** Check that `authorization` has the write token, in constant time. */
function isWriteToken(
  expected: Buffer,
  authorization: string | undefined,
): boolean {
  const token = /^Bearer (\S+)$/.exec(authorization ?? "")?.[1];
  return token !== undefined && timingSafeEqual(expected, sha256(token));
}

/**
 * The run id, session id, and token in a `Proxy-Authorization` header. The
 * user is `<run id>` or, for a session, `<run id>-<session id>`.
 */
function proxyCredentials(
  header: string | undefined,
): { id: string; session: string | undefined; token: string } | undefined {
  const match = /^Basic (.+)$/i.exec(header ?? "");
  if (!match) return undefined;
  const decoded = Buffer.from(match[1]!, "base64").toString("utf8");
  const colon = decoded.indexOf(":");
  if (colon <= 0) return undefined;
  const [id, session] = decoded.slice(0, colon).split("-", 2) as [
    string,
    string | undefined,
  ];
  return { id, session, token: decoded.slice(colon + 1) };
}

/** The proxy URL of a run, or of one session of the run. */
function proxyUrl(
  publicUrl: string,
  run: { id: string; token: string },
  session?: string,
): string {
  const url = new URL(publicUrl);
  url.username = session ? `${run.id}-${session}` : run.id;
  url.password = run.token;
  return url.href.replace(/\/$/, "");
}

/** Check the run config of a client. Returns the error, or `undefined`. */
function invalidRunConfig(config: Partial<RunConfig>): string | undefined {
  if (!config.mode || !MODES.has(config.mode)) {
    return "mode must be auto, off, record, or replay";
  }
  if (config.name !== undefined) {
    if (typeof config.name !== "string" || config.name.length > MAX_RUN_NAME) {
      return `name must be a string of at most ${MAX_RUN_NAME} characters`;
    }
  }
  if (config.secrets !== undefined) {
    if (
      !Array.isArray(config.secrets) ||
      config.secrets.length > MAX_RUN_SECRETS ||
      !config.secrets.every(
        (secret) =>
          typeof secret === "string" && secret.length <= MAX_SECRET_LENGTH,
      )
    ) {
      return `secrets must be a list of at most ${MAX_RUN_SECRETS} strings of at most ${MAX_SECRET_LENGTH} characters`;
    }
  }
  if (config.ci !== undefined) {
    // A newer client can send more fields. The service ignores them.
    const ci = config.ci as Record<string, unknown> | null;
    if (
      typeof ci !== "object" ||
      ci === null ||
      !Object.keys(CI_ATTRIBUTES).every(
        (field) =>
          ci[field] === undefined ||
          (typeof ci[field] === "string" && ci[field].length <= MAX_CI_VALUE),
      )
    ) {
      return `ci must be an object of strings of at most ${MAX_CI_VALUE} characters`;
    }
  }
  if (!Array.isArray(config.rules) || config.rules.length > MAX_RULES) {
    return `rules must be a list of at most ${MAX_RULES} rules`;
  }
  const names = new Set<string>();
  for (const rule of config.rules) {
    if (typeof rule?.name !== "string" || !RULE_NAME.test(rule.name)) {
      return `rule name must match ${RULE_NAME}`;
    }
    if (names.has(rule.name)) return `rule ${rule.name} is not unique`;
    names.add(rule.name);
    if (typeof rule.match !== "object" || rule.match === null) {
      return `rule ${rule.name} must have match`;
    }
    const { url } = rule.match;
    if (
      url !== undefined &&
      typeof url !== "string" &&
      !(
        Array.isArray(url) &&
        url.length > 0 &&
        url.length <= MAX_RULE_URLS &&
        url.every((prefix) => typeof prefix === "string")
      )
    ) {
      return `match.url of rule ${rule.name} must be a string or a list of 1 to ${MAX_RULE_URLS} strings`;
    }
    // A slow pattern fails only its own requests (`request-key.ts`), so
    // the service takes any pattern that compiles.
    if (rule.values !== undefined) {
      if (typeof rule.values !== "object" || rule.values === null) {
        return `values of rule ${rule.name} must be an object`;
      }
      const values = Object.entries(rule.values);
      if (values.length > MAX_RULE_VALUES) {
        return `rule ${rule.name} can have at most ${MAX_RULE_VALUES} values`;
      }
      for (const [name, source] of values) {
        if (typeof source !== "string" || source.length > MAX_PATTERN_LENGTH) {
          return `value ${name} of rule ${rule.name} must be a pattern of at most ${MAX_PATTERN_LENGTH} characters`;
        }
      }
    }
  }
  const patternError = invalidValuePatterns(
    config.rules.flatMap((rule) => (rule.values ? [rule.values] : [])),
  );
  if (patternError) return patternError;
  if (
    !Array.isArray(config.allow) ||
    config.allow.length === 0 ||
    config.allow.length > MAX_RUN_ORIGINS
  ) {
    return `allow must be a list of 1 to ${MAX_RUN_ORIGINS} origins`;
  }
  for (const origin of config.allow) {
    // The client sends JSON, so check the type at run time.
    if (typeof origin !== "string") return "allow must be a list of origins";
    try {
      parseOrigins([origin.replace(/\/$/, "")]);
    } catch {
      return `${origin} is not an http or https origin`;
    }
  }
  return undefined;
}

/** The span attributes of the CI job of a run. */
function ciAttributes(ci: RunCi | undefined): Record<string, string> {
  return Object.fromEntries(
    Object.entries(CI_ATTRIBUTES).flatMap(([field, name]) => {
      const value = ci?.[field as keyof RunCi];
      return value ? [[name, value]] : [];
    }),
  );
}

/**
 * Send an unexpected error to Sentry, with `tags`. Returns the id of its
 * event, or `undefined` without a DSN.
 */
function capture(
  error: unknown,
  tags?: Record<string, string>,
): string | undefined {
  if (!Sentry.getClient()) return undefined;
  return Sentry.captureException(error, tags ? { tags } : undefined);
}

const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);

/** The totals of a run, for the `roach.run.end` span. */
function runTotals(stats: RecordingStats, ms: number): Attributes {
  const counts = Object.values(stats.counts);
  return {
    "roach.replayed": sum(counts.map((count) => count.replayed)),
    "roach.live": sum(counts.map((count) => count.live)),
    "roach.missed": sum(counts.map((count) => count.missed)),
    "roach.passthrough": sum(Object.values(stats.passthrough)),
    "roach.refused": sum(
      Object.values(stats.refused ?? {}).flatMap(Object.values),
    ),
    "roach.written": stats.written,
    "roach.dropped": stats.discarded,
    "roach.run.duration_ms": ms,
  };
}

/**
 * The telemetry of one run, in Sentry. Metrics get `labels`. Spans and
 * errors get `spanLabels`, which also name the run and its CI job.
 */
function runTelemetry(
  labels: Attributes,
  spanLabels: Record<string, string>,
): Telemetry {
  return {
    span: ({ op, name = op, attributes }, fn) =>
      Sentry.startSpan(
        { op, name, attributes: { ...spanLabels, ...attributes } },
        fn,
      ),
    annotate: (attributes) => {
      Sentry.getActiveSpan()?.setAttributes(attributes);
    },
    count: (name, value, attributes) => {
      Sentry.metrics.count(name, value, {
        attributes: { ...labels, ...attributes },
      });
    },
    time: (name, ms, attributes) => {
      Sentry.metrics.distribution(name, ms, {
        unit: "millisecond",
        attributes: { ...labels, ...attributes },
      });
    },
    capture: (error) => capture(error, spanLabels),
  };
}

/**
 * The store of one run. Each read and write has a span, and a run without
 * write access cannot write.
 */
function runStore(
  base: RecordingStore,
  labels: Attributes,
  canWrite: boolean,
): RecordingStore {
  const span = <T>(
    op: string,
    attributes: Record<string, string | number>,
    fn: (span: Sentry.Span) => Promise<T>,
  ) =>
    Sentry.startSpan(
      { op, name: op, attributes: { ...labels, ...attributes } },
      fn,
    );
  return {
    read: (key) =>
      span("roach.store.read", { "roach.key": key }, async (current) => {
        const recording = await base.read(key);
        current.setAttribute("roach.result", recording ? "replayed" : "missed");
        return recording;
      }),
    async write(recordings) {
      if (recordings.length === 0) return 0;
      if (!canWrite) throw new Error("This run cannot write recordings");
      return span(
        "roach.store.write",
        { "roach.recordings": recordings.length },
        async (current) => {
          const written = await base.write(recordings);
          current.setAttribute("roach.written", written);
          return written;
        },
      );
    },
  };
}

/** Start the service in this process. */
export async function startRoachService(
  config: RoachServiceConfig,
): Promise<RoachService> {
  if ((config.directory === undefined) === (config.bucket === undefined)) {
    throw new Error("Roach service config must set directory or bucket");
  }
  if (!/^[0-9a-f]{64}$/i.test(config.writeTokenHash ?? "")) {
    throw new Error("Roach service config needs writeTokenHash, a SHA-256");
  }
  const writeTokenHash = Buffer.from(config.writeTokenHash, "hex");
  if (config.sentryDsn) {
    Sentry.init({
      dsn: config.sentryDsn,
      tracesSampleRate: TRACES_SAMPLE_RATE,
      // Send only what Roach puts on its spans. The HTTP integrations and
      // `RequestData` add whole URLs, headers, and bodies, which can hold
      // credentials, such as the `secrets` of a run. And the proxy must not
      // add trace headers to the requests that it sends.
      tracePropagationTargets: [],
      // The HTTP integration names an error event after the path of the
      // request, which can hold a credential. The trace of the event has
      // the span of the request.
      beforeSend: ({ transaction: _path, ...event }) => event,
      integrations: (defaults) => [
        ...defaults.filter(
          ({ name }) => !["Http", "NodeFetch", "RequestData"].includes(name),
        ),
        Sentry.httpIntegration({
          spans: false,
          breadcrumbs: false,
          maxRequestBodySize: "none",
        }),
        Sentry.nativeNodeFetchIntegration({ spans: false, breadcrumbs: false }),
      ],
    });
  }
  const runs = new Map<string, Run>();
  const authority = await createCertificateAuthority(config.ca);
  const storeOf = (tenant: string): RecordingStore =>
    config.bucket
      ? createGcsStore(config.bucket, `${tenant}/`)
      : createFileStore(path.join(config.directory!, tenant));
  let publicUrl = config.publicUrl?.replace(/\/$/, "");

  const endRun = (run: Run): Promise<RecordingStats> =>
    run.telemetry.span({ op: "roach.run.end" }, async () => {
      runs.delete(run.id);
      run.closed = true;
      await run.recorder.close();
      const stats = run.recorder.stats();
      run.telemetry.annotate(runTotals(stats, Date.now() - run.started));
      return stats;
    });

  const createRun = (
    runConfig: RunConfig,
    canWrite: boolean,
    client: string,
  ): RemoteRun => {
    const id = randomBytes(8).toString("hex");
    const labels = {
      "roach.tenant": runConfig.tenant,
      "roach.mode": runConfig.mode,
    };
    const spanLabels = {
      ...labels,
      "roach.run.id": runConfig.name ?? id,
      ...ciAttributes(runConfig.ci),
    };
    const telemetry = runTelemetry(labels, spanLabels);
    const token = randomBytes(24).toString("hex");
    const store = runStore(storeOf(runConfig.tenant), spanLabels, canWrite);
    const run: Run = {
      id,
      token,
      started: Date.now(),
      lastUsed: Date.now(),
      origins: parseOrigins(
        runConfig.allow.map((origin) => origin.replace(/\/$/, "")),
      ),
      // A public run must not be an open proxy to the allowed origins.
      replayOnly: !canWrite,
      ...(canWrite ? {} : { client, maxBodyBytes: PUBLIC_MAX_BODY_BYTES }),
      privateNetworks: config.privateNetworks === true,
      // Each run learns only the credentials of its own requests.
      recorder: createRecorder(
        {
          mode: runConfig.mode,
          rules: runConfig.rules,
          secrets: config.secrets ?? [],
          runSecrets: runConfig.secrets ?? [],
          // A change shows a part of a recorded request, and reads are
          // public, so only a run with the write token gets it.
          explainMisses: canWrite,
          learnLimit: canWrite ? WRITE_LEARN_LIMIT : PUBLIC_LEARN_LIMIT,
          workLimit: canWrite ? WRITE_WORK_LIMIT : PUBLIC_WORK_LIMIT,
          endRun: (reason) => {
            process.stderr.write(`[roach] Run ${id} ended: ${reason}\n`);
            endRun(run).catch((error: unknown) => {
              reportInternal(`Run ${id} end`, error, telemetry.capture(error));
            });
          },
          telemetry,
        },
        store,
      ),
      telemetry,
    };
    runs.set(id, run);
    process.stderr.write(
      `[roach] Run ${id} of ${runConfig.tenant} started in ${runConfig.mode} mode\n`,
    );
    return {
      id,
      url: proxyUrl(publicUrl!, run),
      token,
      controlUrl: `${publicUrl}${CONTROL_PATH}/runs/${id}`,
      caCert: authority.caCert,
    };
  };

  const targetFor = (incoming: http.IncomingMessage): TargetResult => {
    const credentials = proxyCredentials(
      incoming.headers["proxy-authorization"],
    );
    const run = credentials && runs.get(credentials.id);
    if (!run || !sameToken(credentials.token, run.token)) {
      return { status: 407 };
    }
    return { target: run, session: credentials.session };
  };

  const control = async (
    incoming: http.IncomingMessage,
    outgoing: http.ServerResponse,
  ): Promise<void> => {
    const pathname = new URL(incoming.url ?? "/", "http://proxy").pathname;
    if (incoming.method === "GET" && pathname === `${CONTROL_PATH}/ca.pem`) {
      outgoing.writeHead(200, { "content-type": "application/x-pem-file" });
      outgoing.end(authority.caCert);
      return;
    }
    if (incoming.method === "POST" && pathname === `${CONTROL_PATH}/runs`) {
      const runConfig = await readJson<Partial<RunConfig>>(incoming);
      const tenant = runConfig.tenant;
      if (typeof tenant !== "string" || !TENANT_NAME.test(tenant)) {
        sendJson(outgoing, 400, { error: "tenant must be owner/repo" });
        return;
      }
      const error = invalidRunConfig(runConfig);
      if (error) {
        sendJson(outgoing, 400, { error });
        return;
      }
      const canWrite = isWriteToken(
        writeTokenHash,
        incoming.headers.authorization,
      );
      // Reads are public. Every other mode can write, so it needs the token.
      if (!canWrite && runConfig.mode !== "replay") {
        sendJson(outgoing, 401, {
          error: `${runConfig.mode} mode needs the write token`,
        });
        return;
      }
      const client = clientGroup(clientAddress(incoming));
      if (!canWrite) {
        let open = 0;
        let ofClient = 0;
        for (const other of runs.values()) {
          if (other.replayOnly) open += 1;
          if (other.client === client) ofClient += 1;
        }
        if (open >= MAX_PUBLIC_RUNS) {
          sendJson(outgoing, 429, {
            error: `The service has ${MAX_PUBLIC_RUNS} open runs without a token`,
          });
          return;
        }
        if (ofClient >= MAX_PUBLIC_RUNS_PER_CLIENT) {
          sendJson(outgoing, 429, {
            error: `Your address has ${MAX_PUBLIC_RUNS_PER_CLIENT} open runs without a token. End one first.`,
          });
          return;
        }
      }
      const valid = runConfig as RunConfig;
      const remote = Sentry.startSpan(
        {
          op: "roach.run.start",
          name: "roach.run.start",
          attributes: {
            "roach.tenant": tenant,
            "roach.mode": valid.mode,
            "roach.write": canWrite,
            ...ciAttributes(valid.ci),
          },
        },
        (span) => {
          const created = createRun(valid, canWrite, client);
          span.setAttribute("roach.run.id", valid.name ?? created.id);
          return created;
        },
      );
      sendJson(outgoing, 201, remote);
      return;
    }

    const runRoute = new RegExp(
      `^${CONTROL_PATH}/runs/([0-9a-f]+)(/.*)?$`,
    ).exec(pathname);
    const run = runRoute && runs.get(runRoute[1]!);
    if (
      !run ||
      !sameToken(incoming.headers.authorization, `Bearer ${run.token}`)
    ) {
      // The same answer for a wrong token and for a run that does not
      // exist. The id is not a secret: the log and Sentry have it. Only the
      // token gives access.
      outgoing.writeHead(404).end();
      return;
    }
    run.lastUsed = Date.now();
    const rest = runRoute[2] ?? "";
    if (incoming.method === "DELETE" && rest === "") {
      sendJson(outgoing, 200, await endRun(run));
      return;
    }
    const handled = await controlRecorder(
      run.recorder,
      `${incoming.method} ${rest}`,
      incoming,
      outgoing,
      (session) => proxyUrl(publicUrl!, run, session),
    );
    if (!handled) outgoing.writeHead(404).end();
  };

  const host = config.host ?? "127.0.0.1";
  const listening = await listenProxy({
    host,
    port: config.port ?? 0,
    authority,
    targetFor,
    control,
    capture,
    proxyProtocol: config.proxyProtocol === true,
  });
  publicUrl ??= `http://${host.includes(":") ? `[${host}]` : host}:${listening.port}`;

  // End runs that their client never ended, such as a CI job that died.
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const run of runs.values()) {
      const idle = run.replayOnly && now - run.lastUsed > PUBLIC_RUN_IDLE_MS;
      const timeout = run.replayOnly ? PUBLIC_RUN_TIMEOUT_MS : RUN_TIMEOUT_MS;
      if (idle || now - run.started > timeout) {
        process.stderr.write(
          `[roach] Run ${run.id} timed out${idle ? " without traffic" : ""}\n`,
        );
        // A failed close must not stop the service for other runs.
        endRun(run).catch((error: unknown) => {
          reportInternal(
            `Run ${run.id} end`,
            error,
            run.telemetry.capture(error),
          );
        });
      }
    }
  }, 60_000);
  sweep.unref();

  return {
    url: publicUrl,
    async close() {
      clearInterval(sweep);
      await listening.close();
      await Promise.all([...runs.values()].map(endRun));
      await authority.close();
      await Sentry.flush(2000);
    },
  };
}

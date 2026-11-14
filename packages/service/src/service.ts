/**
 * Roach as a shared service. See "Service" in `README.md`.
 *
 * One process serves the runs of many tenants on one port. A tenant is a
 * GitHub repository, named `owner/repo`, such as `getsentry/junior`. The
 * service has no list of tenants: a run names its tenant. A run is one test
 * run of a tenant, such as one CI job. It has its own mode, rules,
 * sessions, and stats.
 *
 * - Each run needs the token, in every mode. All tenants share one token,
 *   and the service keeps only its SHA-256 (`writeTokenHash`). The tenant
 *   name is a label, not proof of identity: a holder of the token can read
 *   and write the recordings of any tenant.
 * - The service gives each run its own id and token. A proxied request
 *   names its run in `Proxy-Authorization`, as `Basic base64(<id>:<token>)`.
 *   The proxy URL of the run has them, so `HTTPS_PROXY` sends them.
 * - A run sends its own config: its origins (`allow`), rules, and value
 *   patterns. So a tenant changes what it records without a change to the
 *   service. Two checks keep that safe for the other tenants. The proxy
 *   sends requests only to public addresses (`addresses.ts`), so a run
 *   cannot reach the metadata server or the VPC. The key of a request has
 *   a time limit, so a slow pattern fails only its own request.
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
import { createRecorder, type Attributes, type Telemetry } from "./recorder.ts";
import { createFileStore } from "./recordings.ts";
import { readJson } from "./bodies.ts";
import {
  controlRecorder,
  listenProxy,
  parseOrigins,
  sameToken,
  sendJson,
  type ProxyTarget,
  type TargetResult,
} from "./server.ts";
import { ciAttributes, invalidRunConfig, TENANT_NAME } from "./run-config.ts";
import type { RecordingStore } from "./store.ts";
import {
  CONTROL_PATH,
  type RecordingStats,
  type RemoteRun,
  type RunConfig,
} from "@sentry/roach/types";

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
   * The SHA-256 of the token, in hex. Each run needs the token, in every
   * mode. All tenants share it. Give it only to CI jobs that you trust.
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
   * as from a GCP proxy load balancer with `proxy_header = "PROXY_V1"`, and
   * drop it. A connection without the header works too. Default: `false`.
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
}

/** The service gets little traffic, so it keeps all traces. */
const TRACES_SAMPLE_RATE = 1;
/** A run that is open longer than this ends as failed, such as a dead job. */
const RUN_TIMEOUT_MS = 6 * 60 * 60 * 1000;
/**
 * The credentials that a run learns from its requests (`secrets.ts`), for
 * credentials that change on each request, such as AWS signatures.
 */
const LEARN_LIMIT = { values: 16 * 1024, length: 16 * 1024 * 1024 };
const sha256 = (value: string) => createHash("sha256").update(value).digest();

/** Check that `authorization` has the token, in constant time. */
function hasToken(
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

/** The store of one run. Each read and write has a span. */
function runStore(base: RecordingStore, labels: Attributes): RecordingStore {
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

  const createRun = (runConfig: RunConfig): RemoteRun => {
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
    const store = runStore(storeOf(runConfig.tenant), spanLabels);
    const run: Run = {
      id,
      token,
      started: Date.now(),
      origins: parseOrigins(
        runConfig.allow.map((origin) => origin.replace(/\/$/, "")),
      ),
      privateNetworks: config.privateNetworks === true,
      // Each run learns only the credentials of its own requests.
      recorder: createRecorder(
        {
          mode: runConfig.mode,
          rules: runConfig.rules,
          secrets: config.secrets ?? [],
          runSecrets: runConfig.secrets ?? [],
          learnLimit: LEARN_LIMIT,
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
      // Check the token first, so the service reads no body without it.
      if (!hasToken(writeTokenHash, incoming.headers.authorization)) {
        sendJson(outgoing, 401, { error: "A run needs the token" });
        return;
      }
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
      const valid = runConfig as RunConfig;
      const remote = Sentry.startSpan(
        {
          op: "roach.run.start",
          name: "roach.run.start",
          attributes: {
            "roach.tenant": tenant,
            "roach.mode": valid.mode,
            ...ciAttributes(valid.ci),
          },
        },
        (span) => {
          const created = createRun(valid);
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
      if (now - run.started > RUN_TIMEOUT_MS) {
        process.stderr.write(`[roach] Run ${run.id} timed out\n`);
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

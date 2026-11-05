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
 *   a time limit (`request-key.ts`), so a slow pattern fails only its own
 *   request.
 * - The recordings of a tenant are under `<tenant>/`, in a directory or a
 *   GCS bucket (`gcs.ts`). Tenants never share recordings, because a key
 *   does not include credentials.
 * - With `sentryDsn`, the service sends spans and metrics to Sentry. See
 *   "Sentry" in `README.md`. Metrics have only attributes with few values,
 *   so the key and the run are only on spans.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type http from "node:http";
import path from "node:path";
import * as Sentry from "@sentry/node";
import {
  createCertificateAuthority,
  type CertificateAuthorityPem,
} from "../src/certificates.ts";
import { createGcsStore } from "../src/gcs.ts";
import { createRecorder, type Telemetry } from "../src/recorder.ts";
import { createFileStore } from "../src/recordings.ts";
import {
  controlRecorder,
  listenProxy,
  parseOrigins,
  readJson,
  sameToken,
  sendJson,
  type ProxyTarget,
  type TargetResult,
} from "../src/server.ts";
import { RULE_NAME, type RecordingStore } from "../src/store.ts";
import {
  CONTROL_PATH,
  type RecordingMode,
  type RecordingStats,
  type RemoteRun,
  type RunConfig,
} from "../src/types.ts";
import { invalidValuePatterns } from "../src/values.ts";

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

const MODES = new Set<RecordingMode>(["auto", "off", "record", "replay"]);
/** The service gets little traffic, so it keeps all traces. */
const TRACES_SAMPLE_RATE = 1;
/** A run that is open longer than this ends as failed, such as a dead job. */
const RUN_TIMEOUT_MS = 6 * 60 * 60 * 1000;
/**
 * The open runs without a token that the service can have, for all tenants.
 * Anyone can start them with any tenant name, so the cap is not per tenant.
 * It keeps memory bounded. Runs with the token have no cap.
 */
const MAX_PUBLIC_RUNS = 100;
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
/** Enough for the API keys and OIDC tokens of a CI job. */
const MAX_RUN_SECRETS = 32;
const MAX_SECRET_LENGTH = 16 * 1024;
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

/**
 * The telemetry of one run, in Sentry. Metrics get `labels`. Spans also get
 * the name of the run.
 */
function runTelemetry(
  labels: { tenant: string; mode: RecordingMode },
  run: string,
): Telemetry {
  return {
    span: ({ op, name = op, attributes }, fn) =>
      Sentry.startSpan(
        { op, name, attributes: { ...labels, run, ...attributes } },
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
  };
}

/**
 * The store of one run. Each read and write has a span, and a run without
 * write access cannot write.
 */
function runStore(
  base: RecordingStore,
  labels: { tenant: string; mode: RecordingMode; run: string },
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
      span("roach.store.read", { key }, async (current) => {
        const recording = await base.read(key);
        current.setAttribute("result", recording ? "hit" : "miss");
        return recording;
      }),
    async write(recordings) {
      if (recordings.length === 0) return 0;
      if (!canWrite) throw new Error("This run cannot write recordings");
      return span(
        "roach.store.write",
        { recordings: recordings.length },
        async (current) => {
          const written = await base.write(recordings);
          current.setAttribute("written", written);
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

  const endRun = async (run: Run): Promise<RecordingStats> => {
    runs.delete(run.id);
    run.closed = true;
    await run.recorder.close();
    return run.recorder.stats();
  };

  const createRun = (runConfig: RunConfig, canWrite: boolean): RemoteRun => {
    const id = randomBytes(8).toString("hex");
    const telemetry = runTelemetry(
      { tenant: runConfig.tenant, mode: runConfig.mode },
      runConfig.name ?? id,
    );
    const token = randomBytes(24).toString("hex");
    const store = runStore(
      storeOf(runConfig.tenant),
      {
        tenant: runConfig.tenant,
        mode: runConfig.mode,
        run: runConfig.name ?? id,
      },
      canWrite,
    );
    const run: Run = {
      id,
      token,
      started: Date.now(),
      origins: parseOrigins(
        runConfig.allow.map((origin) => origin.replace(/\/$/, "")),
      ),
      // A public run must not be an open proxy to the allowed origins.
      replayOnly: !canWrite,
      privateNetworks: config.privateNetworks === true,
      // Each run learns only the credentials of its own requests.
      recorder: createRecorder(
        {
          mode: runConfig.mode,
          rules: runConfig.rules,
          secrets: [...(config.secrets ?? []), ...(runConfig.secrets ?? [])],
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
      if (!canWrite) {
        let open = 0;
        for (const other of runs.values()) {
          if (other.replayOnly) open += 1;
        }
        if (open >= MAX_PUBLIC_RUNS) {
          sendJson(outgoing, 429, {
            error: `The service has ${MAX_PUBLIC_RUNS} open runs without a token`,
          });
          return;
        }
      }
      const valid = runConfig as RunConfig;
      const remote = Sentry.startSpan(
        {
          op: "roach.run.start",
          name: "roach.run.start",
          attributes: { tenant, mode: valid.mode, write: canWrite },
        },
        (span) => {
          const created = createRun(valid, canWrite);
          span.setAttribute("run", valid.name ?? created.id);
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
      // The same answer for a run that does not exist, so ids stay secret.
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
          process.stderr.write(
            `[roach] Run ${run.id} did not end: ${String(error)}\n`,
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

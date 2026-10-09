/**
 * Roach as a shared service. See "Service" in `README.md`.
 *
 * One process serves the runs of many tenants on one port. A tenant is a
 * project, such as Junior. A run is one test run of a tenant, such as one
 * CI job. It has its own mode, rules, sessions, and stats, as one local
 * proxy (`server.ts`) has.
 *
 * - Anyone can create a `replay` run of a tenant, so CI jobs of forks
 *   replay recordings without a secret. Such a run never writes.
 * - A run in another mode needs the token of the tenant, because it
 *   writes recordings. The service keeps only the SHA-256 of each token.
 * - The service gives each run its own id and token. A proxied request
 *   names its run in `Proxy-Authorization`, as `Basic base64(<id>:<token>)`.
 *   The proxy URL of the run has them, so `HTTPS_PROXY` sends them.
 * - The recordings of a tenant are under `<tenant>/`, in a directory or a
 *   GCS bucket (`gcs.ts`). Tenants never share recordings, because a key
 *   does not include credentials.
 * - Each read and write of a recording sends the Sentry metric
 *   `roach.recording`, with the tenant, the key, and the run.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type http from "node:http";
import path from "node:path";
import * as Sentry from "@sentry/node";
import {
  createCertificateAuthority,
  type CertificateAuthorityPem,
} from "./certificates.ts";
import { createGcsStore } from "./gcs.ts";
import { createRecorder } from "./recorder.ts";
import { createFileStore } from "./recordings.ts";
import {
  CONTROL_PATH,
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
import type { RecordingMode, RecordingRule, RecordingStats } from "./types.ts";
import { VALUE_PATTERNS } from "./values.ts";

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
  /** The only origins that runs can reach. A run can allow fewer. */
  allow: string[];
  /**
   * The tenants, by name. Each value is the SHA-256 of the token of the
   * tenant, in hex.
   */
  tenants: Record<string, string>;
  /**
   * More regular expression sources that rules can use in `values`, in
   * addition to `VALUE_PATTERNS`. A slow pattern blocks all runs, so check
   * each one for catastrophic backtracking before you add it.
   */
  valuePatterns?: string[];
  /** Credentials to redact in all recordings. */
  secrets?: string[];
  /**
   * The certificate authority that signs intercepted hosts. Clients trust
   * it, so a deployed service must keep it across restarts. Default: a new
   * one at each start.
   */
  ca?: CertificateAuthorityPem;
  /** Without a DSN, the service sends nothing to Sentry. */
  sentryDsn?: string;
}

/** The configuration of one run. The client sends it. */
export interface RunConfig {
  /** The tenant of the run. */
  tenant: string;
  mode: RecordingMode;
  rules: RecordingRule[];
  /** Default: all origins of the service. */
  allow?: string[];
  /**
   * The name of the run in Sentry, such as
   * `${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}`. Default: the run id.
   */
  name?: string;
}

/** A run that the service created. */
export interface RemoteRun {
  /** The id of the run. */
  id: string;
  /** The proxy URL, with the run id and token as its user and password. */
  url: string;
  /** The run token. Session and stats calls use it. */
  token: string;
  /** The base URL of the control API of the run. */
  controlUrl: string;
  /** The PEM certificate of the authority that signs intercepted hosts. */
  caCert: string;
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
/** A run that is open longer than this ends as failed, such as a dead job. */
const RUN_TIMEOUT_MS = 6 * 60 * 60 * 1000;
const MAX_RUN_NAME = 128;

const sha256 = (value: string) => createHash("sha256").update(value).digest();

/** Check that `token` is the token of `tenant`, in constant time. */
function isTenantToken(
  tenants: Record<string, string>,
  tenant: string,
  authorization: string | undefined,
): boolean {
  const token = /^Bearer (\S+)$/.exec(authorization ?? "")?.[1];
  const expected = Object.hasOwn(tenants, tenant)
    ? Buffer.from(tenants[tenant]!, "hex")
    : undefined;
  if (!token || !expected) return false;
  const actual = sha256(token);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/** The run id and token in a `Proxy-Authorization` header. */
function proxyCredentials(
  header: string | undefined,
): { id: string; token: string } | undefined {
  const match = /^Basic (.+)$/i.exec(header ?? "");
  if (!match) return undefined;
  const decoded = Buffer.from(match[1]!, "base64").toString("utf8");
  const colon = decoded.indexOf(":");
  if (colon <= 0) return undefined;
  return { id: decoded.slice(0, colon), token: decoded.slice(colon + 1) };
}

/** Check the run config of a client. Returns the error, or `undefined`. */
function invalidRunConfig(
  config: Partial<RunConfig>,
  serviceOrigins: Map<string, URL>,
  valuePatterns: Set<string>,
): string | undefined {
  if (!config.mode || !MODES.has(config.mode)) {
    return "mode must be auto, off, record, or replay";
  }
  if (config.name !== undefined) {
    if (typeof config.name !== "string" || config.name.length > MAX_RUN_NAME) {
      return `name must be a string of at most ${MAX_RUN_NAME} characters`;
    }
  }
  if (!Array.isArray(config.rules)) return "rules must be a list";
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
    // A pattern runs on the requests of all runs in one process, so a
    // client can only use patterns that the operator knows to be fast.
    if (rule.values !== undefined) {
      if (typeof rule.values !== "object" || rule.values === null) {
        return `values of rule ${rule.name} must be an object`;
      }
      for (const [name, source] of Object.entries(rule.values)) {
        if (typeof source !== "string" || !valuePatterns.has(source)) {
          return `value ${name} of rule ${rule.name} is not a pattern that the service allows`;
        }
      }
    }
  }
  if (config.allow !== undefined) {
    if (!Array.isArray(config.allow)) return "allow must be a list";
    for (const origin of config.allow) {
      // The client sends JSON, so check the type at run time.
      if (
        typeof origin !== "string" ||
        !serviceOrigins.has(origin.replace(/\/$/, ""))
      ) {
        return `the service does not allow ${origin}`;
      }
    }
  }
  return undefined;
}

/**
 * The store of one run. It counts each read and write in Sentry, and a
 * run without write access cannot write.
 */
function runStore(
  base: RecordingStore,
  labels: { tenant: string; run: string },
  canWrite: boolean,
): RecordingStore {
  const count = (key: string, result: string) => {
    Sentry.metrics.count("roach.recording", 1, {
      attributes: {
        ...labels,
        rule: key.slice(0, key.indexOf("/")),
        key,
        result,
      },
    });
  };
  return {
    async read(key) {
      const recording = await base.read(key);
      count(key, recording ? "replayed" : "missed");
      return recording;
    },
    async write(recordings) {
      if (recordings.length === 0) return 0;
      if (!canWrite) throw new Error("This run cannot write recordings");
      const written = await base.write(recordings);
      for (const [key] of recordings) count(key, "written");
      return written;
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
  for (const [tenant, hash] of Object.entries(config.tenants)) {
    if (!RULE_NAME.test(tenant)) {
      throw new Error(`Roach tenant name must match ${RULE_NAME}: ${tenant}`);
    }
    if (!/^[0-9a-f]{64}$/i.test(hash)) {
      throw new Error(`Roach tenant ${tenant} needs a SHA-256 token hash`);
    }
  }
  if (config.sentryDsn) {
    Sentry.init({ dsn: config.sentryDsn, tracesSampleRate: 0 });
  }
  const serviceOrigins = parseOrigins(config.allow);
  const runs = new Map<string, Run>();
  const authority = await createCertificateAuthority(config.ca);
  const valuePatterns = new Set<string>([
    ...Object.values(VALUE_PATTERNS),
    ...(config.valuePatterns ?? []),
  ]);
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
    const token = randomBytes(24).toString("hex");
    const allow = runConfig.allow ?? config.allow;
    const store = runStore(
      storeOf(runConfig.tenant),
      { tenant: runConfig.tenant, run: runConfig.name ?? id },
      canWrite,
    );
    const run: Run = {
      id,
      token,
      started: Date.now(),
      origins: parseOrigins(allow.map((origin) => origin.replace(/\/$/, ""))),
      // A public run must not be an open proxy to the allowed origins.
      replayOnly: !canWrite,
      // Each run learns only the credentials of its own requests.
      recorder: createRecorder(
        {
          mode: runConfig.mode,
          rules: runConfig.rules,
          ...(config.secrets ? { secrets: config.secrets } : {}),
        },
        store,
      ),
    };
    runs.set(id, run);
    process.stderr.write(
      `[roach] Run ${id} of ${runConfig.tenant} started in ${runConfig.mode} mode\n`,
    );
    const base = new URL(publicUrl!);
    base.username = id;
    base.password = token;
    return {
      id,
      url: base.href.replace(/\/$/, ""),
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
    return run;
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
      if (
        typeof tenant !== "string" ||
        !Object.hasOwn(config.tenants, tenant)
      ) {
        sendJson(outgoing, 400, { error: "tenant is not known" });
        return;
      }
      const error = invalidRunConfig(runConfig, serviceOrigins, valuePatterns);
      if (error) {
        sendJson(outgoing, 400, { error });
        return;
      }
      const canWrite = isTenantToken(
        config.tenants,
        tenant,
        incoming.headers.authorization,
      );
      // Reads are public. Every other mode can write, so it needs the token.
      if (!canWrite && runConfig.mode !== "replay") {
        sendJson(outgoing, 401, {
          error: `${runConfig.mode} mode needs the token of ${tenant}`,
        });
        return;
      }
      sendJson(outgoing, 201, createRun(runConfig as RunConfig, canWrite));
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

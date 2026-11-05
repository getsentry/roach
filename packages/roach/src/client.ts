/**
 * The client of Roach. See `README.md`.
 *
 * `startRemoteRun()` starts a run on a Roach service
 * (`@sentry/roach-service`). It returns `env`, the variables that send the
 * traffic of a process through the run. `connectRoach()` controls a run
 * from another process, such as a test worker.
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import { tmpdir } from "node:os";
import path from "node:path";
import { DEFAULT_NO_PROXY } from "./config.ts";
import {
  CONTROL_PATH,
  type OpenedSession,
  type RecordingStats,
  type RemoteRun,
  type RunConfig,
} from "./types.ts";

/** The open session of one test. */
export interface RecordingSession {
  /**
   * The proxy URL of the session. Send the requests of the test through
   * it when other sessions of the run can be open at the same time.
   */
  url: string;
  /**
   * End the session. A passed session writes its new recordings, and a
   * failed one drops them. `missed` counts the requests of the session that
   * `replay` mode failed. A test with a miss must fail.
   */
  end(passed: boolean): Promise<{ missed: number }>;
}

/** The control API of a run. */
export interface RoachControl {
  /**
   * Open the session of one test. Many sessions can be open at once. A
   * request through `url` of the run belongs to the open session only when
   * one is open, so concurrent tests send through `url` of their session.
   */
  startSession(name: string): Promise<RecordingSession>;
  /** The totals of the run. */
  stats(): Promise<RecordingStats>;
}

/**
 * The request functions of `node:http` and `node:https` as this module
 * loads. In-process HTTP mocks, such as MSW and nock, replace them when they
 * start. Control calls go to the service, never to a mock, so they use the
 * originals. Load the setup file of Roach before a setup file that starts a
 * mock.
 */
const httpRequest = http.request;
const httpsRequest = https.request;

/**
 * Call the control API at `base`, and return the JSON of the response.
 * `token` is the bearer token.
 */
function callControl<T>(
  base: string,
  token: string | undefined,
  method: "DELETE" | "GET" | "POST",
  route: string,
  body?: unknown,
): Promise<T> {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const url = route ? `${base}/${route}` : base;
  const send = url.startsWith("https:") ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const request = send(
      url,
      {
        // Its own agent, so that a proxy agent of the process is not used.
        agent: false,
        method,
        headers: {
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(payload ? { "content-type": "application/json" } : {}),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          const status = response.statusCode ?? 500;
          if (status >= 400) {
            reject(
              new Error(
                `Roach: ${method} ${route} failed with HTTP ${status}: ${text}`,
              ),
            );
          } else {
            resolve((text ? JSON.parse(text) : undefined) as T);
          }
        });
        response.on("error", reject);
      },
    );
    request.on("error", reject);
    request.end(payload);
  });
}

/**
 * The first service version that returns the proxy URL of a session. An
 * older service answers `POST /session` with an empty body.
 */
const SESSION_URL_VERSION = "0.2.0";

/** Control a run, for example from a test worker. */
export function connectRoach({
  controlUrl,
  token,
}: Pick<RemoteRun, "controlUrl" | "token">): RoachControl {
  return {
    async startSession(name) {
      const opened = await callControl<OpenedSession | undefined>(
        controlUrl,
        token,
        "POST",
        "session",
        { name },
      );
      const url = opened?.url;
      if (typeof url !== "string") {
        throw new Error(
          `Roach: the service at ${new URL(controlUrl).origin} is older than this client: it returned no session URL. Deploy the service at ${SESSION_URL_VERSION} or later.`,
        );
      }
      return {
        url,
        end: (passed) =>
          callControl(controlUrl, token, "POST", "session/end", {
            name,
            passed,
          }),
      };
    },
    stats: () => callControl(controlUrl, token, "GET", "stats"),
  };
}

/** A run on a Roach service (`@sentry/roach-service`). */
export interface RemoteRoach extends RemoteRun, RoachControl {
  /**
   * The variables that send the HTTP traffic of a process through the run:
   * `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`, `NODE_USE_ENV_PROXY`, and
   * `NODE_EXTRA_CA_CERTS`. Give them to a process when it starts. Node
   * reads the last two only at startup.
   */
  env: Record<string, string>;
  /** End the run. Returns its stats. */
  close(): Promise<RecordingStats>;
}

/**
 * Start a run on a Roach service, such as `https://roach.example.com`.
 *
 * `token` is the write token of the service. Only this call uses it. Without it,
 * the service only allows `replay` mode, so CI jobs of forks can replay
 * without a secret. The run and its workers use the run token.
 */
export async function startRemoteRun(
  service: { url: string; token?: string | undefined },
  config: RunConfig,
  { noProxy = DEFAULT_NO_PROXY }: { noProxy?: string } = {},
): Promise<RemoteRoach> {
  const run = await callControl<RemoteRun>(
    `${service.url.replace(/\/$/, "")}${CONTROL_PATH}`,
    service.token,
    "POST",
    "runs",
    config,
  );
  const proxyEnv = await createProxyEnv(run, noProxy).catch(async (error) => {
    // End the run, or it stays open until the service times it out.
    await callControl(run.controlUrl, run.token, "DELETE", "").catch(() => {});
    throw error;
  });
  return {
    ...run,
    ...connectRoach(run),
    env: proxyEnv.env,
    async close() {
      try {
        return await callControl<RecordingStats>(
          run.controlUrl,
          run.token,
          "DELETE",
          "",
        );
      } finally {
        await proxyEnv.remove();
      }
    },
  };
}

/**
 * The proxy variables of a process, with the CA certificate in a file. The
 * file also has the certificates of `NODE_EXTRA_CA_CERTS` of this process,
 * so the process still trusts them.
 */
async function createProxyEnv(
  address: Pick<RemoteRun, "caCert" | "url">,
  noProxy: string,
): Promise<{ env: Record<string, string>; remove(): Promise<void> }> {
  // `NODE_EXTRA_CA_CERTS` takes a file.
  const caDirectory = await mkdtemp(path.join(tmpdir(), "roach-"));
  const caFile = path.join(caDirectory, "ca.pem");
  const extra = process.env.NODE_EXTRA_CA_CERTS;
  await writeFile(
    caFile,
    extra
      ? `${address.caCert.trimEnd()}\n${await readFile(extra, "utf8")}`
      : address.caCert,
  );
  return {
    env: {
      HTTP_PROXY: address.url,
      HTTPS_PROXY: address.url,
      NO_PROXY: noProxy,
      NODE_USE_ENV_PROXY: "1",
      NODE_EXTRA_CA_CERTS: caFile,
    },
    remove: () => rm(caDirectory, { force: true, recursive: true }),
  };
}

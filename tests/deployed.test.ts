/**
 * Roach as it runs in production (`deploy/gcp/`), on one machine.
 *
 * - The service runs from the command line, with a config file, a fixed
 *   certificate authority, a GCS bucket, and Sentry.
 * - A TLS server in front of it does what the load balancer does: it ends
 *   TLS and passes the bytes to the service.
 * - A local server plays the GCS JSON API and the metadata server of the
 *   VM. Another one plays Sentry.
 * - Each CI job (`ci-job.ts`) sends HTTPS through the service with only the
 *   proxy variables of its run.
 */
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import https from "node:https";
import net, { type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import tls from "node:tls";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RoachServiceConfig, RunConfig } from "../src/service.ts";

const execFileAsync = promisify(execFile);
const ROOT = path.join(import.meta.dirname, "..");
const TOKEN = "roach-write-token";
const TENANT = "getsentry/junior";
const BUCKET = "roach-recordings";
const GCS_TOKEN = "vm-access-token";

let directory: string;
let hostCertFile: string;
let caCert: string;
const objects = new Map<string, string>();
const metrics: Array<Record<string, string>> = [];
let liveRequests = 0;
let upstreamOrigin: string;
let frontUrl: string;
let service: ChildProcess;
const servers: Array<{ close(callback: () => void): unknown }> = [];

/** The environment of a child process, without proxy variables. */
function childEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) => !/^(https?_proxy|no_proxy|all_proxy)$/i.test(name),
    ),
  );
  return { ...env, ...extra };
}

async function listen(server: net.Server, host = "127.0.0.1") {
  servers.push(server);
  server.listen(0, host);
  await once(server, "listening");
  return (server.address() as AddressInfo).port;
}

/** Keep the `roach.recording` metrics of a Sentry envelope. */
function readEnvelope(envelope: string) {
  for (const line of envelope.split("\n")) {
    if (!line.includes('"roach.recording"')) continue;
    const { items } = JSON.parse(line) as {
      items: Array<{ attributes: Record<string, { value: string }> }>;
    };
    for (const { attributes } of items) {
      metrics.push(
        Object.fromEntries(
          Object.entries(attributes).map(([name, { value }]) => [name, value]),
        ),
      );
    }
  }
}

/** Run one CI job, and return what it printed. */
async function ciJob(token: string | undefined, mode: RunConfig["mode"]) {
  const config: RunConfig = {
    tenant: TENANT,
    mode,
    name: `${mode}-run`,
    rules: [{ name: "model", match: { method: "POST" } }],
  };
  const { stdout } = await execFileAsync(
    process.execPath,
    [
      "--experimental-strip-types",
      "--disable-warning=ExperimentalWarning",
      path.join(ROOT, "tests/ci-job.ts"),
      JSON.stringify({
        service: frontUrl,
        token,
        config,
        url: `${upstreamOrigin}/v1/messages`,
        body: JSON.stringify({ prompt: "hi" }),
      }),
    ],
    { env: childEnv({ NODE_EXTRA_CA_CERTS: hostCertFile }) },
  );
  return JSON.parse(stdout) as {
    response: { status: number; source: string; body: string };
    stats: { written: number };
    caCert: string;
  };
}

beforeAll(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "roach-deployed-"));
  // A fixed authority, as Terraform makes it, and one certificate for the
  // TLS server and the upstream.
  const caKeyFile = path.join(directory, "ca.key");
  const caCertFile = path.join(directory, "ca.crt");
  hostCertFile = path.join(directory, "host.crt");
  const hostKeyFile = path.join(directory, "host.key");
  await execFileAsync("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-days",
    "1",
    "-keyout",
    caKeyFile,
    "-out",
    caCertFile,
    "-subj",
    "/CN=Test Roach CA",
    "-addext",
    "basicConstraints=critical,CA:TRUE",
    "-addext",
    "keyUsage=critical,keyCertSign,cRLSign",
  ]);
  await execFileAsync("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-days",
    "1",
    "-keyout",
    hostKeyFile,
    "-out",
    hostCertFile,
    "-subj",
    "/CN=localhost",
    "-addext",
    "subjectAltName=DNS:localhost,IP:127.0.0.1,IP:127.0.0.2",
  ]);
  caCert = await readFile(caCertFile, "utf8");
  const host = {
    cert: await readFile(hostCertFile, "utf8"),
    key: await readFile(hostKeyFile, "utf8"),
  };

  // The upstream API. It is not on `localhost`, so `NO_PROXY` keeps it.
  const upstream = https.createServer(host, (_incoming, outgoing) => {
    liveRequests += 1;
    outgoing.writeHead(200, { "content-type": "application/json" });
    outgoing.end(JSON.stringify({ n: liveRequests }));
  });
  upstreamOrigin = `https://127.0.0.2:${await listen(upstream, "127.0.0.2")}`;

  // The GCS JSON API and the metadata server of the VM.
  const gcs = createServer((incoming, outgoing) => {
    const url = new URL(incoming.url!, "http://gcs");
    if (url.pathname.startsWith("/computeMetadata/")) {
      if (incoming.headers["metadata-flavor"] !== "Google") {
        outgoing.writeHead(403).end();
        return;
      }
      outgoing.end(
        JSON.stringify({ access_token: GCS_TOKEN, expires_in: 3600 }),
      );
      return;
    }
    if (incoming.headers.authorization !== `Bearer ${GCS_TOKEN}`) {
      outgoing.writeHead(401).end();
      return;
    }
    const upload = `/upload/storage/v1/b/${BUCKET}/o`;
    const read = `/storage/v1/b/${BUCKET}/o/`;
    if (incoming.method === "POST" && url.pathname === upload) {
      let body = "";
      incoming.on("data", (chunk: Buffer) => (body += chunk.toString()));
      incoming.on("end", () => {
        objects.set(url.searchParams.get("name")!, body);
        outgoing.end("{}");
      });
      return;
    }
    if (incoming.method === "GET" && url.pathname.startsWith(read)) {
      const object = objects.get(
        decodeURIComponent(url.pathname.slice(read.length)),
      );
      if (object === undefined) outgoing.writeHead(404).end();
      else outgoing.end(object);
      return;
    }
    outgoing.writeHead(404).end();
  });
  const gcsHost = `127.0.0.1:${await listen(gcs)}`;

  const sentry = createServer((incoming, outgoing) => {
    let envelope = "";
    incoming.setEncoding("utf8");
    incoming.on("data", (chunk: string) => (envelope += chunk));
    incoming.on("end", () => {
      readEnvelope(envelope);
      outgoing.end("{}");
    });
  });
  const sentryPort = await listen(sentry);

  // The service listens on a free port. The TLS server takes its place.
  const probe = net.createServer();
  const servicePort = await listen(probe);
  await new Promise((resolve) => probe.close(resolve));
  servers.splice(servers.indexOf(probe), 1);
  const front = tls.createServer(host, (socket) => {
    const backend = net.connect(servicePort, "127.0.0.1");
    socket.pipe(backend).pipe(socket);
    backend.on("error", () => socket.destroy());
    socket.on("error", () => backend.destroy());
  });
  frontUrl = `https://localhost:${await listen(front)}`;

  const config: RoachServiceConfig = {
    host: "127.0.0.1",
    port: servicePort,
    publicUrl: frontUrl,
    bucket: BUCKET,
    allow: [upstreamOrigin],
    writeTokenHash: createHash("sha256").update(TOKEN).digest("hex"),
    ca: { cert: caCert, key: await readFile(caKeyFile, "utf8") },
    sentryDsn: `http://public@127.0.0.1:${sentryPort}/1`,
  };
  const configFile = path.join(directory, "config.json");
  await writeFile(configFile, JSON.stringify(config));
  service = spawn(
    process.execPath,
    [
      "--experimental-strip-types",
      "--disable-warning=ExperimentalWarning",
      path.join(ROOT, "src/cli.ts"),
      "service",
      configFile,
    ],
    {
      env: childEnv({
        STORAGE_EMULATOR_HOST: `http://${gcsHost}`,
        GCE_METADATA_HOST: gcsHost,
        // The service trusts the upstream, as it trusts public APIs.
        NODE_EXTRA_CA_CERTS: hostCertFile,
      }),
      stdio: ["ignore", "pipe", "inherit"],
    },
  );
  const [line] = (await once(service.stdout!, "data")) as [Buffer];
  const { url } = JSON.parse(line.toString()) as { url: string };
  if (url !== frontUrl) throw new Error(`The service printed ${url}`);
});

afterAll(async () => {
  if (service.exitCode === null) {
    service.kill("SIGTERM");
    await once(service, "exit");
  }
  await Promise.all(
    servers.map(
      (server) => new Promise<void>((resolve) => server.close(() => resolve())),
    ),
  );
  await rm(directory, { recursive: true, force: true });
});

describe("deployed roach", () => {
  it("records with the token, replays for a fork, and counts in Sentry", async () => {
    const writer = await ciJob(TOKEN, "auto");
    expect(writer.response).toEqual({
      status: 200,
      source: "live",
      body: JSON.stringify({ n: 1 }),
    });
    expect(writer.stats.written).toBe(1);
    // A restart keeps the authority that clients trust.
    expect(writer.caCert).toBe(caCert);
    expect([...objects.keys()]).toEqual([
      expect.stringMatching(/^getsentry\/junior\/model\/[0-9a-f]{64}\.json$/),
    ]);

    const fork = await ciJob(undefined, "replay");
    expect(fork.response).toEqual({
      status: 200,
      source: "replayed",
      body: JSON.stringify({ n: 1 }),
    });
    expect(liveRequests).toBe(1);

    // The service sends its metrics when it stops.
    service.kill("SIGTERM");
    expect(await once(service, "exit")).toEqual([0, null]);
    const [key] = objects.keys();
    expect(
      metrics.map(({ tenant, run, result, key: metricKey }) => ({
        tenant,
        run,
        result,
        key: metricKey,
      })),
    ).toEqual([
      {
        tenant: TENANT,
        run: "auto-run",
        result: "missed",
        key: key!.slice(`${TENANT}/`.length),
      },
      {
        tenant: TENANT,
        run: "auto-run",
        result: "written",
        key: key!.slice(`${TENANT}/`.length),
      },
      {
        tenant: TENANT,
        run: "replay-run",
        result: "replayed",
        key: key!.slice(`${TENANT}/`.length),
      },
    ]);
  });
});

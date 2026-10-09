import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { ProxyAgent, request } from "undici";
import { createTestHarness, type TestHarness } from "wrangler";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { connectRoach } from "../src/client.ts";
import { startRoach, type RoachServer } from "../src/server.ts";
import type { RecordingMode } from "../src/types.ts";

/** The part of the Worker env that the tests read. */
interface TestEnv {
  RECORDINGS: {
    list(options: { prefix: string }): Promise<{
      objects: Array<{ key: string }>;
    }>;
  };
}

const sha256 = (text: string) =>
  createHash("sha256").update(text).digest("hex");
const TOKENS = { alpha: "alpha-token", beta: "beta-token" };

/** One `roach.recording` metric that the Worker sent to Sentry. */
interface RecordingMetric {
  key: string;
  result: string;
  run: string;
  tenant: string;
}

let harness: TestHarness;
let sentry: Server;
const metrics: RecordingMetric[] = [];
let workerUrl: string;
let env: TestEnv;
let upstream: Server;
let origin: string;
let liveRequests: number;
const proxies: Array<{ proxy: RoachServer; agent: ProxyAgent }> = [];

/** Keep the `roach.recording` metrics of a Sentry envelope. */
function readEnvelope(envelope: string) {
  for (const line of envelope.split("\n")) {
    if (!line.includes('"roach.recording"')) continue;
    const { items } = JSON.parse(line) as {
      items: Array<{ attributes: Record<string, { value: string }> }>;
    };
    for (const { attributes } of items) {
      metrics.push({
        key: attributes.key?.value ?? "",
        result: attributes.result?.value ?? "",
        run: attributes.run?.value ?? "",
        tenant: attributes.tenant?.value ?? "",
      });
    }
  }
}

beforeAll(async () => {
  // A local Sentry that keeps the metrics of the Worker.
  sentry = createServer((incoming, outgoing) => {
    let envelope = "";
    incoming.setEncoding("utf8");
    incoming.on("data", (chunk: string) => (envelope += chunk));
    incoming.on("end", () => {
      readEnvelope(envelope);
      outgoing.end("{}");
    });
  });
  await new Promise<void>((resolve) => sentry.listen(0, "127.0.0.1", resolve));
  const sentryAddress = sentry.address();
  if (!sentryAddress || typeof sentryAddress === "string") {
    throw new Error("No port");
  }
  harness = createTestHarness({
    workers: [
      {
        configPath: "./wrangler.jsonc",
        secrets: {
          ROACH_TENANTS: JSON.stringify(
            Object.fromEntries(
              Object.entries(TOKENS).map(([name, token]) => [
                name,
                sha256(token),
              ]),
            ),
          ),
          SENTRY_DSN: `http://public@127.0.0.1:${sentryAddress.port}/1`,
        },
      },
    ],
  });
  workerUrl = (await harness.listen()).url.href;
  env = (await harness.getWorker().getEnv()) as TestEnv;
}, 60_000);

afterAll(async () => {
  await harness.close();
  await new Promise<void>((resolve) => sentry.close(() => resolve()));
});

beforeEach(async () => {
  liveRequests = 0;
  upstream = createServer((incoming, outgoing) => {
    liveRequests += 1;
    incoming.resume();
    incoming.on("end", () => {
      outgoing.writeHead(200, { "content-type": "text/event-stream" });
      outgoing.end(`data: ${liveRequests}\n\n`);
    });
  });
  await new Promise<void>((resolve) =>
    upstream.listen(0, "127.0.0.1", resolve),
  );
  const address = upstream.address();
  if (!address || typeof address === "string") throw new Error("No port");
  origin = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  for (const { proxy, agent } of proxies.splice(0)) {
    await agent.close();
    await proxy.close();
  }
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
});

/** Start a proxy that keeps its recordings in the Worker. */
async function start(mode: RecordingMode, token: string) {
  const proxy = await startRoach({
    store: { url: workerUrl, token, run: "run-1" },
    mode,
    allow: [origin],
    rules: [{ name: "model", match: { method: "POST", url: `${origin}/v1/` } }],
  });
  const agent = new ProxyAgent({ uri: proxy.url, proxyTunnel: true });
  proxies.push({ proxy, agent });
  return { proxy, agent };
}

/** Send the requests of one passed session. */
async function session(
  { proxy, agent }: Awaited<ReturnType<typeof start>>,
  bodies: unknown[],
) {
  const opened = await connectRoach(proxy).startSession("test");
  const sources: unknown[] = [];
  for (const body of bodies) {
    const response = await request(`${origin}/v1/messages`, {
      body: JSON.stringify(body),
      dispatcher: agent,
      method: "POST",
    });
    await response.body.dump();
    sources.push(response.headers["x-roach"]);
  }
  await opened.end(true);
  return sources;
}

/** The keys that `tenant` has in R2. */
const keysOf = async (tenant: string) =>
  (await env.RECORDINGS.list({ prefix: `${tenant}/` })).objects.map((object) =>
    object.key.slice(tenant.length + 1),
  );

const callWorker = (
  path: string,
  token: string | undefined,
  init: RequestInit = {},
) =>
  fetch(new URL(path, workerUrl), {
    ...init,
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });

const RECORDING = {
  session: "test",
  request: { method: "POST", url: "https://x/", parts: { method: "a" } },
  response: { status: 200, headers: {}, body: "ok", bodyEncoding: "utf8" },
};

describe("worker", () => {
  it("records, replays, and fails a miss in replay mode", async () => {
    const recording = await start("auto", TOKENS.alpha);
    await session(recording, [{ model: "m", messages: ["a", "b"] }]);
    const stored = await keysOf("alpha");

    const running = await start("replay", TOKENS.alpha);
    const sources = await session(running, [
      { model: "m", messages: ["a", "b"] },
      { model: "m", messages: ["a", "c"] },
    ]);

    expect(sources).toEqual(["replayed", "missed"]);
    expect(liveRequests).toBe(1);
    expect(stored).toHaveLength(1);
    // Each read and write of the recording is one metric in Sentry.
    await expect
      .poll(() => metrics.filter((metric) => metric.key === stored[0]))
      .toEqual(
        expect.arrayContaining(
          ["missed", "written", "replayed"].map((result) => ({
            key: stored[0],
            result,
            run: "run-1",
            tenant: "alpha",
          })),
        ),
      );
    // The Worker keeps no index, so a miss has no closest recording.
    await expect(connectRoach(running.proxy).stats()).resolves.toMatchObject({
      counts: { model: { live: 0, missed: 1, replayed: 1 } },
      misses: [{ file: expect.stringMatching(/^model\//), differs: [] }],
    });
  });

  it("keeps tenants apart and refuses bad requests", async () => {
    const key = `model/${"b".repeat(64)}.json`;
    const put = await callWorker(`/v1/recordings/${key}`, TOKENS.alpha, {
      method: "PUT",
      body: JSON.stringify(RECORDING),
    });
    expect(await put.json()).toEqual({ changed: true });

    const status = async (
      path: string,
      token: string | undefined,
      init?: RequestInit,
    ) => (await callWorker(path, token, init)).status;
    expect(await status(`/v1/recordings/${key}`, TOKENS.alpha)).toBe(200);
    expect(await status(`/v1/recordings/${key}`, TOKENS.beta)).toBe(404);
    expect(await status(`/v1/recordings/${key}`, undefined)).toBe(401);
    expect(await status(`/v1/recordings/${key}`, "wrong")).toBe(401);
    expect(await status("/v1/recordings/../x.json", TOKENS.alpha)).toBe(404);
    expect(await status("/v1/recordings/model/x.json", TOKENS.alpha)).toBe(400);
    const putBody = (body: string) =>
      status(`/v1/recordings/${key}`, TOKENS.beta, { method: "PUT", body });
    expect(await putBody("{}")).toBe(400);
    expect(await putBody("x".repeat(10 * 1024 * 1024 + 1))).toBe(413);
  });
});

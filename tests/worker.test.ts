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
  vi,
} from "vitest";
import { connectRoach } from "../src/client.ts";
import { startRoach, type RoachServer } from "../src/server.ts";
import type { RecordingMode } from "../src/types.ts";

/** The parts of the Worker env that the tests read. */
interface TestEnv {
  DB: {
    prepare(sql: string): {
      bind(...values: unknown[]): {
        all(): Promise<{ results: unknown[] }>;
      };
    };
  };
  RECORDINGS: { head(key: string): Promise<unknown> };
}

const sha256 = (text: string) =>
  createHash("sha256").update(text).digest("hex");
const TOKENS = { alpha: "alpha-token", beta: "beta-token", gamma: "gamma" };
const DAY_MS = 24 * 60 * 60 * 1000;

let harness: TestHarness;
let workerUrl: string;
let env: TestEnv;
let upstream: Server;
let origin: string;
let liveRequests: number;
const proxies: Array<{ proxy: RoachServer; agent: ProxyAgent }> = [];

beforeAll(async () => {
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
        },
      },
    ],
  });
  workerUrl = (await harness.listen()).url.href;
  const worker = harness.getWorker();
  await worker.applyD1Migrations("DB");
  env = (await worker.getEnv()) as TestEnv;
}, 60_000);

afterAll(() => harness.close());

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
    store: { url: workerUrl, token },
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

/** Run a query on the D1 database of the Worker. */
async function query<Row>(sql: string, ...values: unknown[]): Promise<Row[]> {
  const { results } = await env.DB.prepare(sql)
    .bind(...values)
    .all();
  return results as Row[];
}

const keysOf = (tenant: string) =>
  query<{ key: string; last_used: number }>(
    "SELECT key, last_used FROM recordings WHERE tenant = ? ORDER BY key",
    tenant,
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
  it("records, replays, and finds the closest recording of a miss", async () => {
    const recording = await start("auto", TOKENS.alpha);
    await session(recording, [{ model: "m", messages: ["a", "b"] }]);
    const [stored] = await keysOf("alpha");

    const running = await start("replay", TOKENS.alpha);
    const sources = await session(running, [
      { model: "m", messages: ["a", "b"] },
      { model: "m", messages: ["a", "c"] },
    ]);

    expect(sources).toEqual(["replayed", "missed"]);
    expect(liveRequests).toBe(1);
    await expect(connectRoach(running.proxy).stats()).resolves.toMatchObject({
      counts: { model: { live: 0, missed: 1, replayed: 1 } },
      misses: [{ closest: stored!.key, differs: ["messages[1]"] }],
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

  it("deletes recordings that nobody used within the TTL", async () => {
    const keys = ["c", "d"].map((c) => `model/${c.repeat(64)}.json`);
    for (const key of keys) {
      await callWorker(`/v1/recordings/${key}`, TOKENS.gamma, {
        method: "PUT",
        body: JSON.stringify(RECORDING),
      });
    }
    const old = Date.now() - 40 * DAY_MS;
    await query(
      "UPDATE recordings SET last_used = ? WHERE tenant = ?",
      old,
      "gamma",
    );

    // A replay is a use.
    await (await callWorker(`/v1/recordings/${keys[0]}`, TOKENS.gamma)).text();
    await vi.waitFor(async () => {
      const rows = await keysOf("gamma");
      expect(rows[0]!.last_used).toBeGreaterThan(old);
    });
    await harness
      .getWorker()
      .scheduled({ cron: "17 4 * * *", scheduledTime: new Date() });

    expect((await keysOf("gamma")).map((row) => row.key)).toEqual([keys[0]]);
    await expect(env.RECORDINGS.head(`gamma/${keys[1]}`)).resolves.toBeNull();
    const parts = await query<{ key: string }>(
      "SELECT DISTINCT key FROM parts WHERE tenant = ?",
      "gamma",
    );
    expect(parts.map((row) => row.key)).toEqual([keys[0]]);
  });
});

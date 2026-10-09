import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ProxyAgent, request } from "undici";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startRemoteRun, type RemoteRoach } from "../src/client.ts";
import {
  startRoachService,
  type RoachService,
  type RunConfig,
} from "../src/service.ts";
import { VALUE_PATTERNS } from "../src/values.ts";

let upstream: Server;
let origin: string;
let liveRequests: number;
let directory: string;
let service: RoachService;
const agents: ProxyAgent[] = [];
const runs: RemoteRoach[] = [];

const hash = (token: string) =>
  createHash("sha256").update(token).digest("hex");

/** Start a run, with one recorded rule. Without `token`, it has no token. */
async function startRun(
  token: string | undefined,
  mode: RunConfig["mode"],
  config: Partial<RunConfig> = {},
): Promise<RemoteRoach> {
  const run = await startRemoteRun(
    { url: service.url, token },
    {
      tenant: "alpha",
      mode,
      rules: [
        { name: "model", match: { method: "POST", url: `${origin}/v1/` } },
      ],
      ...config,
    },
  );
  runs.push(run);
  return run;
}

/** Send one request through the proxy URL of a run. */
async function send(
  proxyUrl: string,
  body: unknown,
  headers: Record<string, string> = {},
) {
  // Tunnel plain HTTP too, so the tests use `CONNECT` as HTTPS clients do.
  const agent = new ProxyAgent({ uri: proxyUrl, proxyTunnel: true });
  agents.push(agent);
  const response = await request(`${origin}/v1/messages`, {
    body: JSON.stringify(body),
    dispatcher: agent,
    headers,
    method: "POST",
  });
  return {
    status: response.statusCode,
    body: await response.body.text(),
    source: response.headers["x-roach"],
  };
}

async function recordings(tenant: string): Promise<string[]> {
  return readdir(path.join(directory, tenant, "model")).catch(() => []);
}

beforeEach(async () => {
  liveRequests = 0;
  upstream = createServer((incoming, outgoing) => {
    liveRequests += 1;
    // Echo a credential, as an API that shows the key of the caller does.
    outgoing.writeHead(200, { "content-type": "application/json" });
    outgoing.end(
      JSON.stringify({
        n: liveRequests,
        key: incoming.headers["x-api-key"] ?? null,
        serviceSecret: "service-secret-value-123",
      }),
    );
  });
  await new Promise<void>((resolve) =>
    upstream.listen(0, "127.0.0.1", resolve),
  );
  const address = upstream.address();
  if (!address || typeof address === "string") throw new Error("No port");
  origin = `http://127.0.0.1:${address.port}`;
  directory = await mkdtemp(path.join(tmpdir(), "roach-service-"));
  service = await startRoachService({
    directory,
    allow: [origin],
    tenants: { alpha: hash("alpha-token"), beta: hash("beta-token") },
    secrets: ["service-secret-value-123"],
  });
});

afterEach(async () => {
  await Promise.all(agents.splice(0).map((agent) => agent.close()));
  await Promise.all(runs.splice(0).map((run) => run.close().catch(() => {})));
  await service.close();
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
  await rm(directory, { recursive: true, force: true });
});

describe("roach service", () => {
  it("writes with the tenant token and replays for anyone", async () => {
    const writer = await startRun("alpha-token", "auto");
    expect(await send(writer.url, { prompt: "hi" })).toMatchObject({
      source: "live",
    });
    expect(await writer.close()).toMatchObject({ written: 1 });

    // A fork has no token. It can still replay the recordings of a tenant.
    const reader = await startRun(undefined, "replay");
    expect(await send(reader.url, { prompt: "hi" })).toMatchObject({
      status: 200,
      source: "replayed",
    });
    expect(await send(reader.url, { prompt: "new" })).toMatchObject({
      status: 412,
      source: "missed",
    });
    // Without the token, no mode that can write.
    for (const mode of ["auto", "record", "off"] as const) {
      await expect(startRun(undefined, mode)).rejects.toThrow(/401/);
    }
    // The token of another tenant does not count.
    await expect(startRun("beta-token", "auto")).rejects.toThrow(/401/);

    // Another tenant has its own recordings.
    const beta = await startRun(undefined, "replay", { tenant: "beta" });
    expect(await send(beta.url, { prompt: "hi" })).toMatchObject({
      status: 412,
    });
    expect(liveRequests).toBe(1);
    expect(await recordings("alpha")).toHaveLength(1);
    expect(await recordings("beta")).toEqual([]);
  });

  it("keeps the sessions of concurrent runs apart", async () => {
    const first = await startRun("alpha-token", "auto");
    const second = await startRun("alpha-token", "auto");
    const failing = await first.startSession("test");
    const passing = await second.startSession("test");

    // Both sessions are open at once. Each request belongs to its own run.
    await send(first.url, { prompt: "from first" });
    await send(second.url, { prompt: "from second" });
    await failing.end(false);
    await passing.end(true);

    expect(await recordings("alpha")).toHaveLength(1);
    const [file] = await recordings("alpha");
    const recording = JSON.parse(
      await readFile(path.join(directory, "alpha", "model", file!), "utf8"),
    );
    expect(recording.session).toBe("test");
    expect(JSON.parse(recording.response.body).n).toBe(2);
    expect((await first.stats()).discarded).toBe(1);
    expect((await second.stats()).written).toBe(1);
  });

  it("refuses callers without the right credentials", async () => {
    const run = await startRun("alpha-token", "auto");
    const bare = new URL(run.url);
    bare.username = "";
    bare.password = "";
    await expect(send(bare.href, { prompt: "hi" })).rejects.toThrow(/407/);
    // An absolute-form request needs the credentials too.
    const absolute = new ProxyAgent({ uri: bare.href, proxyTunnel: false });
    agents.push(absolute);
    await expect(
      request(`${origin}/v1/messages`, { dispatcher: absolute }),
    ).rejects.toThrow(/407/);
    const wrong = new URL(run.url);
    wrong.password = "not-the-token";
    await expect(send(wrong.href, { prompt: "hi" })).rejects.toThrow(/407/);

    await expect(
      startRun("alpha-token", "auto", { tenant: "nobody" }),
    ).rejects.toThrow(/tenant is not known/);
    await expect(
      startRun("alpha-token", "auto", { allow: ["https://example.com"] }),
    ).rejects.toThrow(/does not allow/);
    await expect(
      startRun("alpha-token", "auto", {
        rules: [{ name: "../escape", match: {} }],
      }),
    ).rejects.toThrow(/rule name/);
    // A pattern runs for all runs, so only known patterns are allowed.
    await expect(
      startRun("alpha-token", "auto", {
        rules: [{ name: "model", match: {}, values: { slow: "(a+)+$" } }],
      }),
    ).rejects.toThrow(/not a pattern that the service allows/);
    await startRun("alpha-token", "auto", {
      rules: [
        { name: "model", match: {}, values: { id: VALUE_PATTERNS.uuid } },
      ],
    });

    // A body over the limit gets HTTP 413 and never goes live.
    const large = await send(run.url, { prompt: "x".repeat(65 * 1024 * 1024) });
    expect(large.status).toBe(413);

    // An ended run refuses its proxy URL.
    await run.close();
    await expect(send(run.url, { prompt: "hi" })).rejects.toThrow(/407/);
    expect(liveRequests).toBe(0);
  });

  it("redacts request credentials and the secrets of the service", async () => {
    const run = await startRun("alpha-token", "auto");
    const response = await send(
      run.url,
      { prompt: "hi" },
      { "x-api-key": "sk-live-request-key-456" },
    );

    // The client gets the redacted body, as a replay would give it.
    expect(JSON.parse(response.body)).toEqual({
      n: 1,
      key: "<<redacted>>",
      serviceSecret: "<<redacted>>",
    });
    const [file] = await recordings("alpha");
    const text = await readFile(
      path.join(directory, "alpha", "model", file!),
      "utf8",
    );
    expect(text).not.toContain("sk-live-request-key-456");
    expect(text).not.toContain("service-secret-value-123");
  });
});

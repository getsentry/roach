import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ProxyAgent, request } from "undici";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  onTestFinished,
} from "vitest";
import {
  connectRoach,
  startRemoteRun,
  type RemoteRoach,
} from "@sentry/roach/client";
import { startRoachService, type RoachService } from "../src/service.ts";
import type { RunConfig } from "@sentry/roach/types";
import { VALUE_PATTERNS } from "@sentry/roach/values";

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
      tenant: "acme/alpha",
      mode,
      allow: [origin],
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
    if (incoming.headers["x-large"]) {
      outgoing.end("x".repeat(65 * 1024 * 1024));
      return;
    }
    // Echo a credential, as an API that shows the key of the caller does.
    outgoing.writeHead(200, { "content-type": "application/json" });
    outgoing.end(
      JSON.stringify({
        n: liveRequests,
        key: incoming.headers["x-api-key"] ?? null,
        echo: incoming.headers["x-echo"] ?? null,
        affinity: incoming.headers["x-session-affinity"] ?? null,
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
    // The upstream of the tests is on 127.0.0.1.
    privateNetworks: true,
    writeTokenHash: hash("write-token"),
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
  it("writes with the write token and replays for anyone", async () => {
    const writer = await startRun("write-token", "auto");
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
    // A request that no rule records would go live, so a public run refuses it.
    const agent = new ProxyAgent({ uri: reader.url, proxyTunnel: true });
    agents.push(agent);
    const unmatched = await request(`${origin}/other`, { dispatcher: agent });
    expect(unmatched.statusCode).toBe(403);
    await unmatched.body.dump();
    expect((await reader.stats()).refused).toEqual({
      replayOnly: { [origin]: 1 },
    });
    // Without the token, no mode that can write.
    for (const mode of ["auto", "record", "off"] as const) {
      await expect(startRun(undefined, mode)).rejects.toThrow(/401/);
    }
    // A wrong token does not count.
    await expect(startRun("not-the-token", "auto")).rejects.toThrow(/401/);

    // Another tenant has its own recordings. The service has no list of
    // tenants, so the write token works for a new one too.
    const beta = await startRun(undefined, "replay", { tenant: "acme/beta" });
    expect(await send(beta.url, { prompt: "hi" })).toMatchObject({
      status: 412,
    });
    const newTenant = await startRun("write-token", "auto", {
      tenant: "other-org/new.repo",
    });
    expect(await send(newTenant.url, { prompt: "hi" })).toMatchObject({
      source: "live",
    });
    expect(await newTenant.close()).toMatchObject({ written: 1 });
    expect(liveRequests).toBe(2);
    expect(await recordings("acme/alpha")).toHaveLength(1);
    expect(await recordings("acme/beta")).toEqual([]);
    expect(await recordings("other-org/new.repo")).toHaveLength(1);
  });

  it("keeps the sessions of concurrent runs apart", async () => {
    const first = await startRun("write-token", "auto");
    const second = await startRun("write-token", "auto");
    const failing = await first.startSession("test");
    const passing = await second.startSession("test");

    // Both sessions are open at once. Each request belongs to its own run.
    await send(first.url, { prompt: "from first" });
    await send(second.url, { prompt: "from second" });
    await failing.end(false);
    await passing.end(true);

    expect(await recordings("acme/alpha")).toHaveLength(1);
    const [file] = await recordings("acme/alpha");
    const recording = JSON.parse(
      await readFile(
        path.join(directory, "acme/alpha", "model", file!),
        "utf8",
      ),
    );
    expect(recording.session).toBe("test");
    expect(JSON.parse(recording.response.body).n).toBe(2);
    expect((await first.stats()).discarded).toBe(1);
    expect((await second.stats()).written).toBe(1);
  });

  it("refuses callers without the right credentials", async () => {
    const run = await startRun("write-token", "auto");
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
    // The control API of a run needs the run token. A wrong one gets the
    // answer of a run that does not exist.
    await expect(
      connectRoach({ controlUrl: run.controlUrl, token: "wrong" }).stats(),
    ).rejects.toThrow(/404/);

    // The tenant is a path in the store, so it must be owner/repo.
    for (const tenant of ["junior", "acme/..", "../acme", "a/b/c", "acme/"]) {
      await expect(startRun("write-token", "auto", { tenant })).rejects.toThrow(
        /tenant must be owner\/repo/,
      );
    }
    await expect(
      startRun("write-token", "auto", { allow: ["file:///etc/passwd"] }),
    ).rejects.toThrow(/not an http or https origin/);
    await expect(
      startRun("write-token", "auto", { allow: [] }),
    ).rejects.toThrow(/allow must be a list/);
    await expect(
      startRun("write-token", "auto", {
        rules: [{ name: "../escape", match: {} }],
      }),
    ).rejects.toThrow(/rule name/);
    for (const url of [[], [42], 42]) {
      await expect(
        startRun("write-token", "auto", {
          rules: [
            { name: "model", match: { url: url as unknown as string[] } },
          ],
        }),
      ).rejects.toThrow(/match.url of rule model must be a string or a list/);
    }
    await expect(
      startRun("write-token", "auto", {
        rules: [{ name: "model", match: {}, values: { broken: "(" } }],
      }),
    ).rejects.toThrow(/Invalid regular expression/);
    // Patterns can also be slow to compile. They have a time limit too.
    // Without it, these take over a minute. Each pattern is different,
    // so V8 cannot reuse an earlier one.
    await expect(
      startRun("write-token", "auto", {
        rules: Array.from({ length: 64 }, (_, rule) => ({
          name: `model${rule}`,
          match: {},
          values: Object.fromEntries(
            Array.from({ length: 32 }, (__, value) => [
              `v${value}`,
              `(?:(?:(?:(?:a?){30}){30}){${30 + rule}}){${30 + value}}`,
            ]),
          ),
        })),
      }),
    ).rejects.toThrow(/value patterns took over/);
    await expect(
      startRun("write-token", "auto", { secrets: [42 as unknown as string] }),
    ).rejects.toThrow(/secrets must be a list/);
    await startRun("write-token", "auto", {
      rules: [
        { name: "model", match: {}, values: { id: VALUE_PATTERNS.uuid } },
      ],
    });

    // The control API answers a bad body with the fault of the client.
    const runsUrl = `${service.url}/__roach/runs`;
    const notJson = await fetch(runsUrl, { method: "POST", body: "{" });
    expect(notJson.status).toBe(400);
    const notObject = await fetch(runsUrl, { method: "POST", body: "null" });
    expect(notObject.status).toBe(400);
    const tooLarge = await fetch(runsUrl, {
      method: "POST",
      body: "x".repeat(65 * 1024 * 1024),
    });
    expect(tooLarge.status).toBe(413);

    // Anyone can start a run without a token, so the service has a cap on
    // them. Another tenant name does not get around it.
    const open = await Promise.all(
      Array.from({ length: 100 }, () => startRun(undefined, "replay")),
    );
    await expect(startRun(undefined, "replay")).rejects.toThrow(/429/);
    await expect(
      startRun(undefined, "replay", { tenant: "acme/beta" }),
    ).rejects.toThrow(/429/);
    // Runs with the token have no cap.
    await startRun("write-token", "auto");
    // An ended run frees its place.
    await open[0]!.close();
    await startRun(undefined, "replay");

    // A body over the limit gets HTTP 413 and never goes live.
    const large = await send(run.url, { prompt: "x".repeat(65 * 1024 * 1024) });
    expect(large.status).toBe(413);
    // The limit is only for requests. A large response is recorded.
    const response = await send(run.url, { prompt: "hi" }, { "x-large": "1" });
    expect(response).toMatchObject({ status: 200, source: "live" });
    expect(response.body).toHaveLength(65 * 1024 * 1024);

    // An ended run refuses its proxy URL.
    await run.close();
    await expect(send(run.url, { prompt: "hi" })).rejects.toThrow(/407/);
    // Only the large response went live.
    expect(liveRequests).toBe(1);
  });

  it("takes origins and patterns from the run, and keeps the service safe", async () => {
    // A run can use any pattern, also one that backtracks a lot. Its key
    // has a time limit, so only its own request fails.
    const slow = await startRun("write-token", "auto", {
      rules: [
        {
          name: "model",
          match: { method: "POST", url: `${origin}/v1/` },
          values: { slow: "(a+)+$" },
        },
      ],
    });
    const started = Date.now();
    const stuck = await send(slow.url, { prompt: `${"a".repeat(40)}!` });
    expect(stuck.status).toBe(400);
    expect(stuck.body).toMatch(/value patterns took over/);
    expect(Date.now() - started).toBeLessThan(5000);
    // The process goes on for other runs.
    const other = await startRun("write-token", "auto");
    expect(await send(other.url, { prompt: "hi" })).toMatchObject({
      status: 200,
      source: "live",
    });
    expect(liveRequests).toBe(1);

    // A deployed service sends requests only to public addresses. A run
    // names its own origins, so it must not reach the metadata server or
    // the network of the service, by IP address or by host name.
    const port = new URL(origin).port;
    const guarded = await startRoachService({
      directory,
      writeTokenHash: hash("write-token"),
    });
    try {
      for (const target of [origin, `http://localhost:${port}`]) {
        const run = await startRemoteRun(
          { url: guarded.url, token: "write-token" },
          {
            tenant: "acme/alpha",
            mode: "auto",
            allow: [target],
            rules: [{ name: "model", match: { url: `${target}/v1/` } }],
          },
        );
        runs.push(run);
        const agent = new ProxyAgent({ uri: run.url, proxyTunnel: true });
        agents.push(agent);
        // One request that a rule records, and one that goes through.
        for (const url of [`${target}/v1/messages`, `${target}/other`]) {
          const response = await request(url, { dispatcher: agent });
          expect(response.statusCode).toBe(403);
          expect(await response.body.text()).toMatch(/not a public address/);
        }
        // The stats tell this refusal apart from an origin not in `allow`,
        // and count the requests only as refused.
        const stats = await run.stats();
        expect(stats.counts).toEqual({
          model: { live: 0, missed: 0, replayed: 0 },
        });
        expect(stats.passthrough).toEqual({});
        expect(stats.refused).toEqual({ notPublic: { [target]: 2 } });
      }
    } finally {
      await guarded.close();
    }
    expect(liveRequests).toBe(1);
  });

  it("gives the client no text of an unexpected error", async () => {
    // A file where the store needs a directory makes each read and write
    // fail with an error that names the path.
    const blocked = async () => {
      await mkdir(path.join(directory, "acme/alpha"), { recursive: true });
      await writeFile(path.join(directory, "acme/alpha/model"), "");
    };
    const unblocked = () => rm(path.join(directory, "acme/alpha/model"));

    // A failed read in a run without the token.
    await blocked();
    const reader = await startRun(undefined, "replay");
    const read = await send(reader.url, { prompt: "hi" });
    expect(read).toMatchObject({
      status: 502,
      body: "Roach error: internal error\n",
    });

    // A failed write at the end of a session.
    await unblocked();
    const writer = await startRun("write-token", "auto");
    const session = await writer.startSession("test");
    expect(await send(session.url, { prompt: "hi" })).toMatchObject({
      source: "live",
    });
    await blocked();
    const ended = session.end(true);
    await expect(ended).rejects.toThrow('HTTP 500: {"error":"internal error"}');
    await expect(ended).rejects.not.toThrow(directory);

    // A failed live request.
    const closed = createServer();
    await new Promise<void>((resolve) =>
      closed.listen(0, "127.0.0.1", resolve),
    );
    const { port } = closed.address() as { port: number };
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    const down = `http://127.0.0.1:${port}`;
    const live = await startRun("write-token", "auto", {
      allow: [down],
      rules: [{ name: "model", match: { method: "POST" } }],
    });
    const agent = new ProxyAgent({ uri: live.url, proxyTunnel: true });
    agents.push(agent);
    const failed = await request(`${down}/v1/messages`, {
      method: "POST",
      body: "{}",
      dispatcher: agent,
    });
    expect(failed.statusCode).toBe(502);
    expect(await failed.body.text()).toBe("Roach error: internal error\n");

    // An error that is the fault of the client keeps its message.
    const notOpen = await fetch(`${writer.controlUrl}/session/end`, {
      method: "POST",
      headers: { authorization: `Bearer ${writer.token}` },
      body: JSON.stringify({ name: "not-a-session", passed: true }),
    });
    expect(notOpen.status).toBe(409);
    expect(await notOpen.json()).toEqual({
      error: 'Session "not-a-session" is not open',
    });
    await expect(
      startRun("write-token", "auto", { ci: { ref: "x".repeat(257) } }),
    ).rejects.toThrow(/ci must be an object of strings/);
  });

  it("redacts request credentials and the secrets of the service and the run", async () => {
    // A run secret is not in a credential header, so only the run config
    // tells the service about it.
    const run = await startRun("write-token", "auto", {
      secrets: ["run-secret-value-789"],
    });
    const response = await send(
      run.url,
      { prompt: "hi" },
      {
        "x-api-key": "sk-live-request-key-456",
        "x-echo": "run-secret-value-789",
      },
    );

    // The client gets the redacted body, as a replay would give it.
    expect(JSON.parse(response.body)).toEqual({
      n: 1,
      key: "<<redacted>>",
      echo: "<<redacted>>",
      affinity: null,
      serviceSecret: "<<redacted>>",
    });
    const [file] = await recordings("acme/alpha");
    const text = await readFile(
      path.join(directory, "acme/alpha", "model", file!),
      "utf8",
    );
    expect(text).not.toContain("sk-live-request-key-456");
    expect(text).not.toContain("service-secret-value-123");
    expect(text).not.toContain("run-secret-value-789");
  });

  it("names an old service when it returns no session URL", async () => {
    // A service before 0.2.0 answers `POST /session` with 204 and no body.
    const old = createServer((incoming, outgoing) => {
      incoming.resume();
      outgoing.writeHead(204).end();
    });
    await new Promise<void>((resolve) => old.listen(0, "127.0.0.1", resolve));
    onTestFinished(
      () => new Promise<void>((resolve) => old.close(() => resolve())),
    );
    const address = old.address();
    if (!address || typeof address === "string") throw new Error("No port");
    const oldUrl = `http://127.0.0.1:${address.port}`;

    await expect(
      connectRoach({
        controlUrl: `${oldUrl}/__roach/runs/old`,
        token: "run-token",
      }).startSession("test"),
    ).rejects.toThrow(
      `Roach service at ${oldUrl} is older than this client: it returned no session URL. Deploy the service at 0.2.0 or later.`,
    );
  });

  it("does not redact the session affinity header", async () => {
    // AI Gateway clients send a conversation id in `x-session-affinity`.
    // It is not a credential, and the client must get it back as it is.
    const run = await startRun("write-token", "auto");
    const response = await send(
      run.url,
      { prompt: "hi" },
      {
        "x-api-key": "sk-live-request-key-456",
        "x-session-affinity": "conversation-id-0123456789",
      },
    );

    expect(JSON.parse(response.body)).toMatchObject({
      key: "<<redacted>>",
      affinity: "conversation-id-0123456789",
    });
    const [file] = await recordings("acme/alpha");
    const text = await readFile(
      path.join(directory, "acme/alpha", "model", file!),
      "utf8",
    );
    expect(text).toContain("conversation-id-0123456789");
    expect(text).not.toContain("sk-live-request-key-456");
  });
});

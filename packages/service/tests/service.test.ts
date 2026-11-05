import { createHash } from "node:crypto";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import { connect } from "node:net";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
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
  vi,
} from "vitest";
import {
  connectRoach,
  startRemoteRun,
  type RemoteRoach,
} from "@sentry/roach/client";
import { describeRecordingMisses } from "@sentry/roach/report";
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

/** Send one request in a session named `public test name`, then end it. */
async function sendInSession(run: RemoteRoach, prompt: string) {
  const opened = await run.startSession("public test name");
  const response = await send(opened.url, { prompt });
  await opened.end(true);
  return response;
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

  it("shows what changed in a miss only to a run with the write token", async () => {
    // Reads are public. A change shows a part of the recorded request, so
    // a run without the token could read back the prompts of a tenant.
    const writer = await startRun("write-token", "auto");
    await sendInSession(writer, "the stored prompt");
    await writer.close();

    const reader = await startRun(undefined, "replay");
    expect(await sendInSession(reader, "\u0001")).toMatchObject({
      status: 412,
    });
    const publicStats = await reader.stats();
    expect(publicStats.misses).toEqual([
      { rule: "model", session: "public test name", file: expect.any(String) },
    ]);
    expect(describeRecordingMisses(publicStats.misses).join("\n")).not.toMatch(
      /Changed|stored prompt/,
    );

    const tokenRun = await startRun("write-token", "replay");
    expect(await sendInSession(tokenRun, "\u0001")).toMatchObject({
      status: 412,
    });
    // A run with the token gets where the request changed, but no text.
    const tokenStats = await tokenRun.stats();
    expect(tokenStats.misses[0]!.change).toEqual({
      file: expect.stringMatching(/^model\/[0-9a-f]{64}\.json$/),
      at: expect.any(Number),
    });
    expect(JSON.stringify(tokenStats)).not.toContain("stored prompt");
    expect(liveRequests).toBe(1);
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
    // the network of the service, by IP address or by host name. An
    // IPv4-mapped IPv6 address is refused too, also of a public address.
    const port = new URL(origin).port;
    const guarded = await startRoachService({
      directory,
      writeTokenHash: hash("write-token"),
    });
    try {
      for (const target of [
        origin,
        `http://localhost:${port}`,
        "http://[::ffff:808:808]",
      ]) {
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

/**
 * A header value with `parts` parts that can each be a credential. The
 * proxy learns the whole value and each part.
 */
const credential = (n: number, parts: number) =>
  Array.from({ length: parts }, (_, i) => `cred-${n}-part-${i}`).join(" ");

describe("limits of the service", () => {
  it("stops a slow pattern on a large body in a short time", async () => {
    // Anyone can start this run. The pattern backtracks a lot on a body of
    // `a`. The patterns see only the first 4 Mi characters, for 500 ms.
    const run = await startRun(undefined, "replay", {
      rules: [
        {
          name: "model",
          match: { method: "POST", url: `${origin}/v1/` },
          values: { slow: "a*a*b" },
        },
      ],
    });
    const started = Date.now();
    const response = await send(run.url, {
      prompt: "a".repeat(16 * 1024 * 1024),
    });
    expect(response.status).toBe(400);
    expect(response.body).toMatch(/value patterns took over 500 ms/);
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it("refuses a large control body before it parses it", async () => {
    const runsUrl = `${service.url}/__roach/runs`;
    // A valid start of a run config, so a parse would give HTTP 400.
    const body = JSON.stringify({
      tenant: "acme/alpha",
      mode: "replay",
      pad: "x".repeat(1024 * 1024),
    });
    const sized = await fetch(runsUrl, { method: "POST", body });
    expect(sized.status).toBe(413);
    // A body without a length stops at the limit too.
    const streamed = await fetch(runsUrl, {
      method: "POST",
      body: new Blob([body]).stream(),
      duplex: "half",
    });
    expect(streamed.status).toBe(413);
  });

  it("refuses a request with a new credential past the limit of the run", async () => {
    // A run without a token learns at most 1,024 values: 201 for each of
    // these requests.
    const reader = await startRun(undefined, "replay");
    for (let n = 0; n < 5; n += 1) {
      const response = await send(
        reader.url,
        { prompt: "hi" },
        { "x-api-key": credential(n, 200) },
      );
      expect(response.status).toBe(412);
    }
    const refused = await send(
      reader.url,
      { prompt: "hi" },
      { "x-api-key": credential(5, 200) },
    );
    expect(refused.status).toBe(431);
    expect(refused.body).toMatch(/cannot learn more credentials/);
    // A credential that the run knows does not count again.
    const known = await send(
      reader.url,
      { prompt: "hi" },
      { "x-api-key": credential(0, 200) },
    );
    expect(known.status).toBe(412);
    expect((await reader.stats()).counts.model?.missed).toBe(6);

    // A run with the token learns at most 16,384 values: 601 for each of
    // these requests. A request that no rule records learns them before
    // it goes out, so the proxy never sends a credential that it forgot.
    const writer = await startRun("write-token", "auto");
    const agent = new ProxyAgent({ uri: writer.url, proxyTunnel: true });
    agents.push(agent);
    const passthrough = async (n: number) => {
      const response = await request(`${origin}/other`, {
        dispatcher: agent,
        headers: { "x-api-key": credential(n, 600) },
      });
      await response.body.dump();
      return response.statusCode;
    };
    for (let n = 0; n < 27; n += 1) expect(await passthrough(n)).toBe(200);
    expect(await passthrough(27)).toBe(431);
    expect(liveRequests).toBe(27);
  });

  it("ends a run without a token after 15 minutes without traffic", async () => {
    // The sweep of the service runs each minute and reads the clock.
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    const local = await startRoachService({
      directory,
      privateNetworks: true,
      writeTokenHash: hash("write-token"),
    });
    onTestFinished(async () => {
      await local.close();
      vi.useRealTimers();
    });
    const start = (token: string | undefined) =>
      startRemoteRun(
        { url: local.url, token },
        {
          tenant: "acme/alpha",
          mode: token ? "auto" : "replay",
          allow: [origin],
          rules: [
            { name: "model", match: { method: "POST", url: `${origin}/v1/` } },
          ],
        },
      );
    const idle = await start(undefined);
    const busy = await start(undefined);
    const writer = await start("write-token");

    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    expect(await send(busy.url, { prompt: "hi" })).toMatchObject({
      status: 412,
    });
    await vi.advanceTimersByTimeAsync(6 * 60 * 1000);

    await expect(idle.stats()).rejects.toThrow(/404/);
    await expect(busy.stats()).resolves.toMatchObject({ written: 0 });
    // A run with the token has only the limit of 6 hours.
    await expect(writer.stats()).resolves.toMatchObject({ written: 0 });
  });

  it("closes a tunnel that sends no byte after the 200", async () => {
    const run = await startRun(undefined, "replay");
    const proxy = new URL(run.url);
    const authority = new URL(origin).host;
    const socket = connect(Number(proxy.port), proxy.hostname);
    onTestFinished(() => {
      socket.destroy();
      vi.useRealTimers();
    });
    await once(socket, "connect");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const credentials = Buffer.from(
      `${proxy.username}:${proxy.password}`,
    ).toString("base64");
    socket.write(
      `CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\nProxy-Authorization: Basic ${credentials}\r\n\r\n`,
    );
    const [reply] = (await once(socket, "data")) as [Buffer];
    expect(reply.toString()).toMatch(/^HTTP\/1.1 200/);
    const closed = once(socket, "close");

    await vi.advanceTimersByTimeAsync(9000);
    expect(socket.readyState).toBe("open");
    await vi.advanceTimersByTimeAsync(2000);
    vi.useRealTimers();

    await expect(
      Promise.race([
        closed.then(() => "closed"),
        new Promise((resolve) => setTimeout(() => resolve("open"), 2000)),
      ]),
    ).resolves.toBe("closed");
  });
});

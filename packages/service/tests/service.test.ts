import { createHash } from "node:crypto";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import { connect } from "node:net";
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
import { Readable } from "node:stream";
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
import { keyInWorker } from "../src/key-worker.ts";
import { keyRequest } from "../src/request-key.ts";
import { clientGroup } from "../src/server.ts";
import { startRoachService, type RoachService } from "../src/service.ts";
import type { RemoteRun, RunConfig } from "@sentry/roach/types";
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

/** A body that sends one byte and then nothing. */
function stalledBody(): Readable {
  const body = new Readable({ read() {} });
  body.push("{");
  return body;
}

/** Wait `ms` of real time, also when `setTimeout` is fake. */
async function realWait(ms: number) {
  const end = performance.now() + ms;
  while (performance.now() < end) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/** Wait until `check` is true, for at most 10 s of real time. */
async function until(check: () => boolean) {
  const end = performance.now() + 10_000;
  while (!check()) {
    if (performance.now() > end) throw new Error("the wait timed out");
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/**
 * Open a `CONNECT` tunnel of `run` to the upstream on a raw socket, and
 * start a request that declares a body of `declared` bytes. It sends
 * `sent` bytes of it, and then nothing. `reply` is all that the tunnel
 * gets until it closes, and `status()` is the status that it got so far.
 */
async function startBody(
  proxy: string,
  run: RemoteRun,
  declared: number,
  sent: number,
) {
  const { hostname, port } = new URL(proxy);
  const { username, password } = new URL(run.url);
  const authority = new URL(origin).host;
  const socket = connect(Number(port), hostname);
  onTestFinished(() => {
    socket.destroy();
  });
  await once(socket, "connect");
  const credentials = Buffer.from(
    `${decodeURIComponent(username)}:${decodeURIComponent(password)}`,
  ).toString("base64");
  socket.write(
    `CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\nProxy-Authorization: Basic ${credentials}\r\n\r\n`,
  );
  const [established] = (await once(socket, "data")) as [Buffer];
  expect(established.toString()).toMatch(/^HTTP\/1.1 200/);
  const chunks: Buffer[] = [];
  socket.on("data", (chunk: Buffer) => chunks.push(chunk));
  socket.on("error", () => socket.destroy());
  const reply = once(socket, "close").then(() =>
    Buffer.concat(chunks).toString(),
  );
  socket.write(
    `POST /v1/messages HTTP/1.1\r\nhost: ${authority}\r\ncontent-length: ${declared}\r\n\r\n`,
  );
  socket.write(Buffer.alloc(sent, "a"));
  const status = () =>
    Number(
      /^HTTP\/1.1 (\d{3})/.exec(Buffer.concat(chunks).toString())?.[1] ?? 0,
    );
  return { socket, reply, status };
}

/** The status of a whole body of `bytes` through a raw tunnel of `run`. */
async function answer(proxy: string, run: RemoteRun, bytes: number) {
  const { status } = await startBody(proxy, run, bytes, bytes);
  await until(() => status() > 0);
  return status();
}

/** The heap that this process uses, in bytes. */
const heap = () => process.memoryUsage().heapUsed;

/** `count` distinct values `v<n>`, from `v<from>`, with spaces between. */
const ids = (from: number, count: number) =>
  Array.from({ length: count }, (_, n) => `v${from + n}`).join(" ");

/** `count` runs of `z` of different lengths, from 30,000 + `from`. */
const zRuns = (from: number, count: number) =>
  Array.from({ length: count }, (_, n) => "z".repeat(30_000 + from + n));

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
    retryAfter: response.headers["retry-after"],
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
    // them for each client address. Another tenant name does not get
    // around it. The cap of all clients is in "limits of the service".
    const open = await Promise.all(
      Array.from({ length: 10 }, () => startRun(undefined, "replay")),
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
    // the network of the service, by IP address or by host name. An IPv6
    // address with an IPv4 address in it is refused too, also with a
    // public one.
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
        "http://[::ffff:0:7f00:1]",
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

/**
 * A header value with `parts` parts that can each be a credential. The
 * proxy learns the whole value and each part.
 */
const credential = (n: number, parts: number) =>
  Array.from({ length: parts }, (_, i) => `cred-${n}-part-${i}`).join(" ");

/**
 * The times in ms that the service takes to answer `GET /ca.pem`, one call
 * after the other until `pending` settles. The service runs in the test
 * process, so a call is always open when its event loop stops.
 */
async function caWaitsUntil(pending: Promise<unknown>): Promise<number[]> {
  const state = { done: false };
  void pending.finally(() => (state.done = true)).catch(() => {});
  const waits: number[] = [];
  while (!state.done) {
    const started = performance.now();
    const response = await fetch(`${service.url}/__roach/ca.pem`);
    await response.text();
    waits.push(performance.now() - started);
  }
  return waits;
}

/** Move the fake clock `n` minutes. */
const minutes = (n: number) => vi.advanceTimersByTimeAsync(n * 60 * 1000);

/**
 * Send one request on a new connection to `url`. With `client`, the
 * connection starts with a PROXY header for that address, as from the load
 * balancer. Returns status 0 when the service closes it without an answer.
 */
async function rawRequest(
  url: string,
  client: string | undefined,
  method: string,
  pathname: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string }> {
  const { hostname, port } = new URL(url);
  const socket = connect(Number(port), hostname);
  await once(socket, "connect");
  const text = body === undefined ? "" : JSON.stringify(body);
  const lines = [
    `${method} ${pathname} HTTP/1.1`,
    "host: roach",
    "connection: close",
    `content-length: ${Buffer.byteLength(text)}`,
    ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
  ];
  const proxyHeader = client
    ? client.includes(":")
      ? `PROXY TCP6 ${client} 2001:db8::2 51234 443\r\n`
      : `PROXY TCP4 ${client} 10.0.0.2 51234 443\r\n`
    : "";
  const chunks: Buffer[] = [];
  socket.on("data", (chunk: Buffer) => chunks.push(chunk));
  socket.write(`${proxyHeader}${lines.join("\r\n")}\r\n\r\n${text}`);
  await once(socket, "close");
  const reply = Buffer.concat(chunks).toString();
  const end = reply.indexOf("\r\n\r\n");
  let rest = reply.slice(end + 4);
  if (/transfer-encoding: chunked/i.test(reply.slice(0, end))) {
    let decoded = "";
    for (;;) {
      const line = rest.indexOf("\r\n");
      const size = Number.parseInt(rest.slice(0, line), 16);
      if (!size) break;
      decoded += rest.slice(line + 2, line + 2 + size);
      rest = rest.slice(line + 4 + size);
    }
    rest = decoded;
  }
  return {
    status: Number(/^HTTP\/1\.1 (\d{3})/.exec(reply)?.[1] ?? 0),
    body: rest,
  };
}

describe("limits of the service", () => {
  it("keeps answering while a run without a token sends slow patterns", async () => {
    // Anyone can start this run. The pattern backtracks a lot on a body of
    // `a`, so each key goes past its time limit.
    const run = await startRun(undefined, "replay", {
      rules: [
        {
          name: "model",
          match: { method: "POST", url: `${origin}/v1/` },
          values: { slow: "a*a*b" },
        },
      ],
    });
    // 7 bodies of 4 MiB fit in the 32 MiB that the runs of one client can
    // hold.
    const prompt = "a".repeat(4 * 1024 * 1024);
    const sent = Promise.allSettled(
      Array.from({ length: 7 }, () => send(run.url, { prompt })),
    );
    const waits = await caWaitsUntil(sent);
    // The keys are made in a worker, so the service answers at once.
    expect(Math.max(...waits)).toBeLessThan(500);
    // The first key that goes past its time limit ends the run. The other
    // requests do not start their keys.
    const results = await sent;
    const bodies = results.map((result) =>
      result.status === "fulfilled"
        ? `${result.value.status} ${result.value.body}`
        : String(result.reason),
    );
    expect(
      bodies.filter((body) => /^400 .*This run has ended/s.test(body)),
    ).toHaveLength(1);
    expect(bodies.filter((body) => /^(410|400) /.test(body))).toHaveLength(
      results.filter((result) => result.status === "fulfilled").length,
    );
    await expect(run.stats()).rejects.toThrow(/404/);
  });

  it("fails a request with too many values from a run without a token", async () => {
    const rules = [
      {
        name: "model",
        match: { method: "POST", url: `${origin}/v1/` },
        values: { v: "x" },
      },
    ];
    const prompt = "x ".repeat(150_000);
    const reader = await startRun(undefined, "replay", { rules });
    const tooMany = await send(reader.url, { prompt });
    expect(tooMany.status).toBe(400);
    expect(tooMany.body).toMatch(/too many changing values/);
    // The request fails, but the run goes on.
    await expect(reader.stats()).resolves.toBeDefined();
    expect((await send(reader.url, { prompt: "x x" })).status).toBe(412);
    // A run with the token has no limit.
    const writer = await startRun("write-token", "auto", { rules });
    expect((await send(writer.url, { prompt })).status).toBe(200);
  });

  it("answers 503 when the bodies of runs without a token fill the budget", async () => {
    // Each request holds its body until its key is done. Before the budget,
    // 30 parallel bodies of 16 MiB took about 1.9 GB.
    const reader = await startRun(undefined, "replay");
    const prompt = "a".repeat(16 * 1024 * 1024 - 64);
    const results = await Promise.all(
      Array.from({ length: 12 }, () => send(reader.url, { prompt })),
    );
    // The runs of one client can hold 32 MiB, 2 of these bodies. The bytes
    // count when they come, so parts of more bodies can fill it.
    const busy = results.filter((result) => result.status === 503);
    expect(busy.length).toBeGreaterThanOrEqual(4);
    for (const result of results) expect([412, 503]).toContain(result.status);
    for (const result of busy) {
      expect(result.body).toMatch(/too many large requests/);
      expect(result.retryAfter).toBe("1");
    }
    // The run goes on, and the bodies gave their bytes back.
    await expect(reader.stats()).resolves.toBeDefined();
    const again = await Promise.all(
      Array.from({ length: 2 }, () => send(reader.url, { prompt })),
    );
    expect(again.map((result) => result.status)).toEqual([412, 412]);

    // A client that declares large bodies and then stops holds only the
    // bytes that it sent.
    const stalled = new AbortController();
    const stalls = Array.from({ length: 9 }, () => {
      const agent = new ProxyAgent({ uri: reader.url, proxyTunnel: true });
      agents.push(agent);
      return request(`${origin}/v1/messages`, {
        method: "POST",
        dispatcher: agent,
        headers: { "content-length": String(16 * 1024 * 1024 - 64) },
        body: stalledBody(),
        signal: stalled.signal,
      }).catch(() => undefined);
    });
    // Give the stalled requests the time to reach the service.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect((await send(reader.url, { prompt })).status).toBe(412);
    stalled.abort();
    await Promise.all(stalls);
  });

  it("keeps the budget for other clients while one client stalls its bodies", async () => {
    const local = await startRoachService({
      directory,
      privateNetworks: true,
      writeTokenHash: hash("write-token"),
      proxyProtocol: true,
    });
    onTestFinished(() => local.close());
    const config = {
      tenant: "acme/alpha",
      mode: "replay",
      allow: [origin],
      rules: [
        { name: "model", match: { method: "POST", url: `${origin}/v1/` } },
      ],
    };
    const startFrom = async (client: string) =>
      JSON.parse(
        (await rawRequest(local.url, client, "POST", "/__roach/runs", config))
          .body,
      ) as RemoteRun;
    const attacker = await startFrom("203.0.113.1");
    const other = await startFrom("203.0.113.2");
    onTestFinished(() => {
      vi.useRealTimers();
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    // Each body declares 16 MiB, sends all but 1 KiB, and then stops. Before
    // the part for each client, 8 of them held the whole budget.
    const size = 16 * 1024 * 1024;
    const stalls = await Promise.all(
      Array.from({ length: 8 }, () =>
        startBody(local.url, attacker, size, size - 1024),
      ),
    );
    await until(() =>
      stalls.every(
        ({ socket, status }) => socket.writableLength === 0 || status() > 0,
      ),
    );
    await realWait(500);
    const small = 700 * 1024;
    expect(await answer(local.url, other, small)).toBe(412);
    // The runs of the attacker can hold only 32 MiB, 2 of the bodies.
    await until(
      () => stalls.filter(({ status }) => status() === 503).length >= 6,
    );
    const holders = stalls.filter(({ status }) => status() === 0);
    expect(holders.length).toBeLessThanOrEqual(2);

    // A body that does not come in 30 s gets HTTP 408, and its tunnel
    // closes. Then the attacker has its part again.
    await vi.advanceTimersByTimeAsync(30_000);
    for (const holder of holders) {
      expect(await holder.reply).toMatch(
        /^HTTP\/1.1 408 [^]*the body did not come in 30 s/,
      );
    }
    expect(await answer(local.url, attacker, small)).toBe(412);
  });

  it("fails a request with millions of values before it fills the memory", async () => {
    // `replace()` finds all matches before it counts them, so these bodies
    // stopped the worker at its heap limit. The count stops at the limit.
    const rules = [
      {
        name: "model",
        match: { method: "POST", url: `${origin}/v1/` },
        values: { v: "x" },
      },
    ];
    const reader = await startRun(undefined, "replay", { rules });
    for (const body of [
      { v: "x".repeat(8 * 1024 * 1024) },
      "x ".repeat(4 * 1024 * 1024),
    ]) {
      const started = performance.now();
      const tooMany = await send(reader.url, body);
      expect(tooMany.status).toBe(400);
      expect(tooMany.body).toMatch(/too many changing values/);
      expect(performance.now() - started).toBeLessThan(5000);
    }
    // The worker did not stop, and the run goes on.
    expect((await send(reader.url, { prompt: "x" })).status).toBe(412);
    await expect(reader.stats()).resolves.toBeDefined();
  });

  it("ends a run without a token whose sessions remember too many values", async () => {
    // The probe of the review: 64 sessions, each with one 15 MB request of
    // distinct values. Before the limit, the main heap grew past 1.2 GB.
    const rules = [
      {
        name: "model",
        match: { method: "POST", url: `${origin}/v1/` },
        values: { v: "[a-z]{150}" },
      },
    ];
    const before = heap();
    let peak = before;
    const sampler = setInterval(() => (peak = Math.max(peak, heap())), 20);
    onTestFinished(() => clearInterval(sampler));
    const reader = await startRun(undefined, "replay", { rules });
    const sessions = await Promise.all(
      Array.from({ length: 64 }, (_, n) => reader.startSession(`s${n}`)),
    );
    let next = 0;
    // A distinct value of 150 letters: the number in base 25, with the
    // digits `b` to `z`, after `a` as padding.
    const value = () =>
      (next++)
        .toString(25)
        .replace(/./g, (digit) =>
          String.fromCharCode(98 + Number.parseInt(digit, 25)),
        )
        .padStart(150, "a");
    const results: Array<{ status: number; body: string }> = [];
    for (const opened of sessions) {
      const words = Array.from({ length: 15_000_000 / 151 }, value);
      const result = await send(opened.url, { prompt: words.join(" ") }).catch(
        (error: unknown) => ({ status: 407, body: String(error) }),
      );
      results.push(result);
      if (result.status !== 412) break;
    }
    expect(results).toHaveLength(1);
    expect(results[0]!.status).toBe(400);
    expect(results[0]!.body).toMatch(
      /over 10000 changing values or 262144 characters.*This run has ended/s,
    );
    await expect(reader.stats()).rejects.toThrow(/404/);
    expect(peak - before).toBeLessThan(300 * 1024 * 1024);
  });

  it("counts the remembered values of all sessions of a run without a token", async () => {
    const rules = [
      {
        name: "model",
        match: { method: "POST", url: `${origin}/v1/` },
        values: { v: "v\\d+", z: "z+" },
      },
    ];

    // 6,000 and then 5,000 values of two open sessions are over 10,000.
    const values = await startRun(undefined, "replay", { rules });
    const first = await values.startSession("first");
    const second = await values.startSession("second");
    expect((await send(first.url, { prompt: ids(0, 6000) })).status).toBe(412);
    const over = await send(second.url, { prompt: ids(6000, 5000) });
    expect(over.status).toBe(400);
    expect(over.body).toMatch(/over 10000 changing values/);
    await expect(values.stats()).rejects.toThrow(/404/);

    // A session forgets its values when it ends.
    const ended = await startRun(undefined, "replay", { rules });
    const early = await ended.startSession("early");
    expect((await send(early.url, { prompt: ids(0, 6000) })).status).toBe(412);
    await early.end(true);
    const late = await ended.startSession("late");
    expect((await send(late.url, { prompt: ids(6000, 6000) })).status).toBe(
      412,
    );
    // Values that the session knows do not count again.
    expect((await send(late.url, { prompt: ids(6000, 6000) })).status).toBe(
      412,
    );

    // Nine values of about 30,000 characters are over 256 Ki characters.
    const chars = await startRun(undefined, "replay", { rules });
    const long = await chars.startSession("long");
    const eight = await send(long.url, { prompt: zRuns(0, 8).join(" ") });
    expect(eight.status).toBe(412);
    const ninth = await send(long.url, { prompt: zRuns(8, 1).join(" ") });
    expect(ninth.status).toBe(400);
    expect(ninth.body).toMatch(/or 262144 characters/);

    // A run with the token has no limit.
    const writer = await startRun("write-token", "auto", { rules });
    const opened = await writer.startSession("writer");
    expect((await send(opened.url, { prompt: ids(0, 20_000) })).status).toBe(
      200,
    );
  });

  it("leaves a value of over 32,767 characters out of the memory of a session", async () => {
    const rule = {
      name: "model",
      match: { method: "POST", url: `${origin}/v1/` },
      values: { v: "y+" },
    };
    const toKey = (prompt: string) => ({
      method: "POST",
      url: `${origin}/v1/messages`,
      headers: {},
      body: JSON.stringify({ prompt }),
    });
    const long = "y".repeat(40_000);
    // Before, the session remembered the value, and V8 does not run the
    // pattern of a value this long. So each later request failed and had no
    // key. To leave the value out changes no key.
    expect(() =>
      keyRequest(rule, toKey("later y"), new Map([[long, "v"]])),
    ).toThrow(/too large/);

    for (const [token, mode, status] of [
      [undefined, "replay", 412],
      ["write-token", "auto", 200],
    ] as const) {
      const run = await startRun(token, mode, { rules: [rule] });
      const opened = await run.startSession("long");
      expect((await send(opened.url, { prompt: long })).status).toBe(status);
      for (let n = 0; n < 3; n += 1) {
        expect(
          (await send(opened.url, { prompt: `later ${n} y` })).status,
        ).toBe(status);
      }
      await opened.end(true);
      await expect(run.stats()).resolves.toBeDefined();
    }
    // Each recording has the key of its request without the long value.
    const keys = [long, "later 0 y", "later 1 y", "later 2 y"].map(
      (prompt) => `${keyRequest(rule, toKey(prompt)).key}.json`,
    );
    expect((await recordings("acme/alpha")).toSorted()).toEqual(
      keys.toSorted(),
    );
  });

  it("keys a 60 MiB body of small text blocks from a run with the token", async () => {
    // The worker has a heap limit for runs without the token. A run with
    // the token makes its keys on the main thread, so a body that keyed
    // before the worker still keys.
    const writer = await startRun("write-token", "auto", {
      rules: [
        {
          name: "model",
          match: { method: "POST", url: `${origin}/v1/` },
          values: { uuid: VALUE_PATTERNS.uuid, time: VALUE_PATTERNS.isoTime },
        },
      ],
    });
    const block = { type: "text", text: "hello there" };
    const count = Math.floor(
      (60 * 1024 * 1024) / (JSON.stringify(block).length + 1),
    );
    const body = {
      model: "m",
      messages: [
        { role: "user", content: Array.from({ length: count }, () => block) },
      ],
    };
    const sent = await send(writer.url, body);
    expect(sent).toMatchObject({ status: 200, source: "live" });
    expect(await writer.close()).toMatchObject({ written: 1 });
  }, 120_000);

  it("ends a run without a token whose key fills the memory of the worker", async () => {
    // Each `{}` is an object for `JSON.parse()`, so the body needs more
    // memory than the worker has.
    const reader = await startRun(undefined, "replay");
    const body = Array.from({ length: 5_500_000 }, () => ({}));
    const sent = send(reader.url, body);
    const waits = await caWaitsUntil(sent);
    const failed = await sent;
    expect(failed.status).toBe(400);
    // On a slow machine, such as with coverage, the watchdog can stop the
    // worker before its heap is full. Both end the run.
    expect(failed.body).toMatch(
      /(key worker stopped|request took over \d+ ms).*This run has ended/s,
    );
    expect(Math.max(...waits)).toBeLessThan(500);
    await expect(reader.stats()).rejects.toThrow(/404/);
    // The next key gets a new worker.
    const next = await startRun(undefined, "replay");
    expect((await send(next.url, { prompt: "hi" })).status).toBe(412);
  });

  it("stops a key that the time limit of vm cannot stop", async () => {
    // `JSON.parse()` does not stop for the `vm` timeout. The worker stops
    // after the time limit and a margin of 1 s.
    const rule = { name: "model", match: {}, values: { v: "x" } };
    const options = {
      timeLimitMs: 1,
      maxValues: Infinity,
      skip: () => false,
    };
    // An object with 2.1 M keys takes about 2 s to parse, and it fits in
    // the heap of the worker.
    const body = `{${Array.from({ length: 2_100_000 }, (_, n) => `"k${n}":0`).join(",")}}`;
    const started = performance.now();
    const error = await keyInWorker(
      rule,
      { method: "POST", url: "https://example.test/", headers: {}, body },
      undefined,
      options,
    ).catch((caught: unknown) => caught);
    const elapsed = performance.now() - started;
    expect(error).toMatchObject({
      message: expect.stringMatching(/the request took over 1 ms/),
      status: 400,
      timedOut: true,
    });
    // The run gets the time that the job used.
    expect((error as { ms: number }).ms).toBeGreaterThan(900);
    expect(elapsed).toBeLessThan(2500);
    const next = await keyInWorker(
      rule,
      { method: "POST", url: "https://example.test/", headers: {}, body: "x" },
      undefined,
      { ...options, timeLimitMs: 1000 },
    );
    expect(next.value.values).toEqual(new Map([["v", ["x"]]]));
  });

  it("refuses a large body from a run without a token", async () => {
    const reader = await startRun(undefined, "replay");
    const large = await send(reader.url, {
      prompt: "x".repeat(16 * 1024 * 1024),
    });
    expect(large.status).toBe(413);
    const allowed = await send(reader.url, {
      prompt: "x".repeat(15 * 1024 * 1024),
    });
    expect(allowed.status).toBe(412);
  });

  it("counts the parts of run secrets, and limits the redaction of a miss", async () => {
    // Each part of a secret is a value to redact. Too many parts are
    // refused when the run starts.
    await expect(
      startRun(undefined, "replay", {
        secrets: Array.from({ length: 32 }, (_, n) => credential(n, 40)),
      }),
    ).rejects.toThrow(/400.*cannot learn more credentials/);

    // A recorded sample, so that the first miss of the session compares
    // its redacted text with it.
    await sendInSession(await startRun("write-token", "auto"), "hi");
    const reader = await startRun(undefined, "replay", {
      secrets: Array.from({ length: 24 }, (_, n) => credential(n, 40)),
    });
    const opened = await reader.startSession("public test name");
    const started = Date.now();
    // Text that looks like the secrets makes each search slow.
    const missed = send(opened.url, {
      prompt: "cred-1-part-".repeat(1024 * 1024),
    });
    const waits = await caWaitsUntil(missed);
    expect((await missed).status).toBe(412);
    // The redaction is in the worker, and it stops after 5 s.
    expect(Math.max(...waits)).toBeLessThan(500);
    expect(Date.now() - started).toBeLessThan(10_000);
    await opened.end(true);
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

  it("ends a run without a token after 60 minutes without traffic, or after 2 hours", async () => {
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

    await minutes(50);
    expect(await send(busy.url, { prompt: "hi" })).toMatchObject({
      status: 412,
    });
    await minutes(11);
    await expect(idle.stats()).rejects.toThrow(/404/);
    await expect(busy.stats()).resolves.toMatchObject({ written: 0 });

    // A call each 50 minutes does not keep it open for more than 2 hours.
    await minutes(50);
    await expect(busy.stats()).resolves.toMatchObject({ written: 0 });
    await minutes(10);
    await expect(busy.stats()).rejects.toThrow(/404/);
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
  it("limits the runs without a token of each client", async () => {
    // Behind the load balancer, each connection starts with a PROXY
    // header. It gives the address of the client.
    const local = await startRoachService({
      directory,
      privateNetworks: true,
      writeTokenHash: hash("write-token"),
      proxyProtocol: true,
    });
    onTestFinished(() => local.close());
    const config = {
      tenant: "acme/alpha",
      mode: "replay",
      allow: [origin],
      rules: [{ name: "model", match: {} }],
    };
    const startFrom = (client: string) =>
      rawRequest(local.url, client, "POST", "/__roach/runs", config);

    // A connection without the header, such as before the load balancer
    // sends it, has the address of its socket.
    const bare = await rawRequest(
      local.url,
      undefined,
      "POST",
      "/__roach/runs",
      config,
    );
    expect(bare.status).toBe(201);
    // A header that is not valid closes the connection.
    const { hostname, port } = new URL(local.url);
    const socket = connect(Number(port), hostname);
    socket.write("PROXY TCP4 not-an-address\r\nGET / HTTP/1.1\r\n\r\n");
    socket.resume();
    await once(socket, "close");

    const first = await startFrom("203.0.113.1");
    expect(first.status).toBe(201);
    for (let n = 1; n < 10; n += 1) {
      expect((await startFrom("203.0.113.1")).status).toBe(201);
    }
    const eleventh = await startFrom("203.0.113.1");
    expect(eleventh).toMatchObject({ status: 429 });
    expect(eleventh.body).toMatch(/Your address has 10 open runs/);
    // The addresses of one IPv6 /64 share a limit.
    for (let n = 1; n <= 10; n += 1) {
      expect((await startFrom(`2001:db8:0:1::${n}`)).status).toBe(201);
    }
    expect((await startFrom("2001:db8:0:1:ffff::1")).status).toBe(429);
    // Other clients have their own limit, and the service has 100 places.
    for (let client = 2; client <= 9; client += 1) {
      for (let n = 0; n < (client === 9 ? 9 : 10); n += 1) {
        expect((await startFrom(`203.0.113.${client}`)).status).toBe(201);
      }
    }
    const full = await startFrom("203.0.113.11");
    expect(full).toMatchObject({ status: 429 });
    expect(full.body).toMatch(/The service has 100 open runs/);
    // An ended run frees its place.
    const { controlUrl, token } = JSON.parse(first.body) as RemoteRun;
    const ended = await rawRequest(
      local.url,
      "203.0.113.1",
      "DELETE",
      new URL(controlUrl).pathname,
      undefined,
      { authorization: `Bearer ${token}` },
    );
    expect(ended.status).toBe(200);
    expect((await startFrom("203.0.113.1")).status).toBe(201);
  });

  it("groups an IPv4 address in each IPv6 form as the IPv4 address", () => {
    for (const address of [
      "192.0.2.1",
      "::ffff:192.0.2.1",
      "::FFFF:c000:201",
      "0:0:0:0:0:ffff:192.0.2.1",
      "0000:0000:0000:0000:0000:ffff:c000:0201",
    ]) {
      expect(clientGroup(address)).toBe("192.0.2.1");
    }
    expect(clientGroup("2001:db8:0:1:ffff::1")).toBe("2001:db8:0:1::/64");
    expect(clientGroup("2001:DB8:0:1::1%eth0")).toBe("2001:db8:0:1::/64");
    // An address that only ends in IPv4 form is IPv6.
    expect(clientGroup("::ffff:0:192.0.2.1")).toBe("0:0:0:0::/64");
  });
});

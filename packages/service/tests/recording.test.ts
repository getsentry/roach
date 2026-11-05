/**
 * Recording and replay: modes, sessions, changing values, and misses. Each
 * test starts runs on a service with a local upstream.
 */
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
import { startRemoteRun, type RemoteRoach } from "@sentry/roach/client";
import {
  describeRecordingMisses,
  describeRecordingStats,
} from "@sentry/roach/report";
import { startRoachService, type RoachService } from "../src/service.ts";
import { keyRequest } from "../src/request-key.ts";
import type { RecordingMode, RecordingRule } from "@sentry/roach/types";
import { VALUE_PATTERNS } from "@sentry/roach/values";

const TOKEN = "write-token";
const TENANT = "acme/alpha";

let upstream: Server;
let origin: string;
let liveRequests: number;
/** The event stream that the upstream sends for a request body. */
let respond: (body: string) => string;
/** The upstream answers when this settles. */
let upstreamGate: Promise<void>;
let directory: string;
let service: RoachService;
const runs: RemoteRoach[] = [];
let agent: ProxyAgent | undefined;

/**
 * Start a run with the write token. Later requests go through it. `url` is
 * `match.url` of its rule.
 */
async function start(
  mode: RecordingMode,
  url: string | string[] = `${origin}/v1/`,
  secrets: string[] = [],
): Promise<RemoteRoach> {
  const run = await startRemoteRun(
    { url: service.url, token: TOKEN },
    {
      tenant: TENANT,
      mode,
      secrets,
      allow: [origin],
      rules: [
        {
          name: "model",
          match: { method: "POST", url },
          values: {
            uuid: VALUE_PATTERNS.uuid,
            time: VALUE_PATTERNS.isoTime,
            commit: VALUE_PATTERNS.gitCommit,
          },
        },
      ],
    },
  );
  runs.push(run);
  await agent?.close();
  // Tunnel plain HTTP too, so the tests use `CONNECT` as HTTPS clients do.
  agent = new ProxyAgent({ uri: run.url, proxyTunnel: true });
  return run;
}

/** One delta event of an Anthropic Messages stream. */
const delta = (type: string, field: string, text: string) =>
  `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type, [field]: text } })}\n\n`;

/** Send requests through the proxy. */
async function send(bodies: unknown[], target = `${origin}/v1/messages`) {
  const responses: Array<{ body: string; source: unknown }> = [];
  for (const body of bodies) {
    const response = await request(target, {
      body: JSON.stringify(body),
      dispatcher: agent!,
      method: "POST",
    });
    responses.push({
      body: await response.body.text(),
      source: response.headers["x-roach"],
    });
  }
  return responses;
}

/** Send one request through the proxy URL `url`, such as of a session. */
async function sendThrough(url: string, body: unknown): Promise<void> {
  const dispatcher = new ProxyAgent({ uri: url, proxyTunnel: true });
  try {
    const response = await request(`${origin}/v1/messages`, {
      body: JSON.stringify(body),
      dispatcher,
      method: "POST",
    });
    await response.body.dump();
  } finally {
    await dispatcher.close();
  }
}

/** Send the requests of one test session, then end it. */
async function session(running: RemoteRoach, bodies: unknown[], passed = true) {
  const opened = await running.startSession("test");
  const responses = await send(bodies);
  const { missed } = await opened.end(passed);
  return Object.assign(responses, { missed });
}

/**
 * Requests of one session: 600 `git push` ranges with 1,200 commit ids
 * that the pattern finds, from `first` on. Then two requests that quote
 * the first and the last id alone, where only the memory of the session
 * finds them.
 */
function pushRequests(first: number) {
  const ids = Array.from({ length: 1200 }, (_, i) => (first + i).toString(16));
  return [
    {
      messages: Array.from(
        { length: 600 },
        (_, i) => `${ids[2 * i]}..${ids[2 * i + 1]}  main -> main`,
      ),
    },
    { messages: [`Pushed \`${ids[0]}\`.`] },
    { messages: [`Pushed \`${ids[1199]}\`.`] },
  ];
}

/**
 * A model request of 6 M characters, with a screenshot and the time. Its
 * sorted text has `messages` before `system`, so the time is near the end.
 */
const screenshotRequest = (time: string) => ({
  model: "claude-sonnet-4-5",
  max_tokens: 1024,
  system: `You help with the tests of Roach. The time is ${time}.`,
  messages: [
    {
      role: "user",
      content: [
        {
          type: "image",
          source: {
            type: "base64",
            media_type: "image/png",
            data: "iVBORw0KGgoAAAANSUhEUgAAAoAAAAHgCAYAAAA10dzkAAAgAElEQVR4nO3d".repeat(
              100_000,
            ),
          },
        },
        { type: "text", text: "What does the screen show?" },
      ],
    },
  ],
});

async function files(): Promise<string[]> {
  return readdir(path.join(directory, TENANT, "model")).catch(() => []);
}

beforeEach(async () => {
  liveRequests = 0;
  respond = () => `data: ${liveRequests}\n\n`;
  upstreamGate = Promise.resolve();
  upstream = createServer((incoming, outgoing) => {
    liveRequests += 1;
    const chunks: Buffer[] = [];
    incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
    incoming.on("end", async () => {
      await upstreamGate;
      outgoing.writeHead(200, { "content-type": "text/event-stream" });
      outgoing.end(respond(Buffer.concat(chunks).toString("utf8")));
    });
  });
  await new Promise<void>((resolve) =>
    upstream.listen(0, "127.0.0.1", resolve),
  );
  const address = upstream.address();
  if (!address || typeof address === "string") throw new Error("No port");
  origin = `http://127.0.0.1:${address.port}`;
  directory = await mkdtemp(path.join(tmpdir(), "roach-"));
  service = await startRoachService({
    directory,
    privateNetworks: true,
    writeTokenHash: createHash("sha256").update(TOKEN).digest("hex"),
  });
});

afterEach(async () => {
  await agent?.close();
  agent = undefined;
  await Promise.all(runs.splice(0).map((run) => run.close().catch(() => {})));
  await service.close();
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
  await rm(directory, { recursive: true, force: true });
});

describe("recording", () => {
  it("replays a passed session for the same requests in auto mode", async () => {
    const running = await start("auto");
    await session(running, [
      { model: "m", messages: [{ content: "hi", at: "2026-10-07T03:18:03Z" }] },
    ]);

    // Same request with other key order and another clock time.
    const replay = await session(running, [
      {
        messages: [{ at: "2026-10-08T10:00:00.123Z", content: "hi" }],
        model: "m",
      },
      { model: "m", messages: ["changed"] },
    ]);

    expect([...replay]).toEqual([
      { body: "data: 1\n\n", source: "replayed" },
      { body: "data: 2\n\n", source: "live" },
    ]);
    expect(liveRequests).toBe(2);
    await expect(running.stats()).resolves.toEqual({
      counts: { model: { live: 2, missed: 0, replayed: 1 } },
      misses: [
        expect.objectContaining({ session: "test" }),
        {
          rule: "model",
          session: "test",
          file: expect.stringMatching(/^model\/[0-9a-f]{64}\.json$/),
        },
      ],
      written: 2,
      discarded: 0,
      passthrough: {},
      refused: {},
    });
  });

  it("replays a response with the changing values of the current request", async () => {
    // The model repeats the memory id of the request, split over two
    // deltas, and quotes it in its thinking. The request also sends back a
    // thinking block of an earlier turn, which a replay keeps as recorded.
    // The prompt shows the id again after a newline, which is `\n` in JSON.
    respond = (body) => {
      const id = /"id":"([^"]+)"/.exec(body)![1]!;
      return [
        delta("thinking_delta", "thinking", `Archive ${id}.`),
        delta("input_json_delta", "partial_json", `{"id":"${id.slice(0, 10)}`),
        delta("input_json_delta", "partial_json", `${id.slice(10)}"}`),
      ].join("");
    };
    const first = "0b7c6a2e-1f4d-4c1a-9b8e-2d3f4a5b6c7d";
    const requestBody = (id: string, at: string) => ({
      messages: [
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: `Find ${first}.`, signature: "s" },
          ],
        },
        { content: `Memory:\n${id}`, memories: [{ id, at }] },
      ],
    });
    const second = "9f8e7d6c-5b4a-4321-8fed-cba987654321";
    const running = await start("auto");
    await session(running, [requestBody(first, "2026-10-07T03:18:03.123Z")]);

    const [replayed] = await session(running, [
      requestBody(second, "2026-10-09T11:00:00.456Z"),
    ]);

    expect(replayed!.source).toBe("replayed");
    expect(liveRequests).toBe(1);
    // One delta per block, with the id of this run. Thinking keeps the
    // recorded text, because a signature covers it.
    const events = replayed!.body
      .split("\n\n")
      .filter(Boolean)
      .map((event) => JSON.parse(event.split("data: ")[1]!).delta);
    expect(events).toEqual([
      { type: "thinking_delta", thinking: `Archive ${first}.` },
      { type: "input_json_delta", partial_json: `{"id":"${second}"}` },
    ]);
    const [file] = await files();
    const recording = await readFile(
      path.join(directory, TENANT, "model", file!),
      "utf8",
    );
    expect(recording).toContain("<<uuid:1>>");
  });

  it("replays a later request that repeats a value of an earlier one", async () => {
    // A tool result shows the commit id in a `git push` range, where the
    // pattern finds it. The next request quotes it alone in the reply of
    // the model, where no pattern finds it. Its thinking block keeps the id
    // of the recording run, as a replay keeps thinking as recorded.
    const recorded = "e735f91";
    const requests = (commit: string) => [
      { messages: [`a5fd79f..${commit}  main -> main`] },
      {
        messages: [
          `a5fd79f..${commit}  main -> main`,
          { type: "thinking", thinking: `Push ${recorded}.`, signature: "s" },
          `Pushed \`${commit}\`.`,
        ],
      },
    ];
    const running = await start("auto");
    await session(running, requests(recorded));

    const replay = await session(running, requests("8d130ac"));

    expect(replay.map(({ source }) => source)).toEqual([
      "replayed",
      "replayed",
    ]);
    expect(liveRequests).toBe(2);
  });

  it("fails a request without a recording in replay mode and sends nothing", async () => {
    const recording = await start("auto");
    await session(recording, [{ model: "m" }]);
    await recording.close();
    const recorded = await files();

    const running = await start("replay");
    const replay = await session(running, [{ model: "m" }, { model: "other" }]);

    expect([...replay]).toEqual([
      { body: "data: 1\n\n", source: "replayed" },
      {
        body: expect.stringContaining("no model recording"),
        source: "missed",
      },
    ]);
    expect(replay.missed).toBe(1);
    expect(liveRequests).toBe(1);
    await expect(files()).resolves.toEqual(recorded);
    await expect(running.stats()).resolves.toMatchObject({
      counts: { model: { live: 0, missed: 1, replayed: 1 } },
      misses: [{ rule: "model", session: "test" }],
    });
  });

  it("shows the first change from the recorded request of a miss", async () => {
    // A random finding id that no pattern finds changes the key on each
    // run. The text around it has a credential of the run.
    const secret = "sk-roach-test-0123456789";
    const requestBody = (finding: string) => ({
      model: "m",
      messages: [`Token ${secret}.`, `Finding ${finding} is new.`],
    });
    const recording = await start("auto", `${origin}/v1/`, [secret]);
    await session(recording, [{ model: "first" }, requestBody("ABC-123")]);
    await recording.close();
    const samples = path.join(directory, TENANT, "_requests", "model");
    const sampleFiles = await readdir(samples);
    expect(sampleFiles).toHaveLength(2);
    for (const file of sampleFiles) {
      const text = await readFile(path.join(samples, file), "utf8");
      expect(text).not.toContain(secret);
    }

    const running = await start("replay", `${origin}/v1/`, [secret]);
    const replay = await session(running, [
      { model: "first" },
      requestBody("XYZ-789"),
      requestBody("XYZ-790"),
    ]);

    expect(replay.map(({ source }) => source)).toEqual([
      "replayed",
      "missed",
      "missed",
    ]);
    const { misses } = await running.stats();
    // Only the first miss of the session reads a sample.
    expect(misses).toEqual([
      {
        rule: "model",
        session: "test",
        file: expect.stringMatching(/^model\/[0-9a-f]{64}\.json$/),
        change: {
          file: expect.stringMatching(/^model\/[0-9a-f]{64}\.json$/),
          at: 98,
        },
      },
      expect.not.objectContaining({ change: expect.anything() }),
    ]);
    const { change } = misses[0]!;
    await expect(files()).resolves.toContain(change!.file.slice(6));
    // The report goes to public CI logs, so it has no text of a request.
    // Sentry has the text.
    expect(describeRecordingMisses(misses)).toEqual([
      `test: ${misses[0]!.file}\n  Changed at character 98 of the request of ${change!.file}. See miss.recorded and miss.request on the roach.request span in Sentry.`,
    ]);
  });

  it("keeps a request sample for each place of a repeated request", async () => {
    // The same request at two places of a test has one recording. Each
    // place still gets its sample, so a later change at either place shows.
    const recording = await start("auto");
    await session(recording, [{ model: "same" }, { model: "same" }]);
    await recording.close();
    const samples = path.join(directory, TENANT, "_requests", "model");
    expect(await readdir(samples)).toHaveLength(2);
    expect(await files()).toHaveLength(1);

    const running = await start("replay");
    await session(running, [{ model: "changed" }]);
    const [miss] = (await running.stats()).misses;
    expect(miss!.change).toEqual({
      file: expect.stringMatching(/^model\/[0-9a-f]{64}\.json$/),
      at: expect.any(Number),
    });
  });

  it("keeps the first 1,048,576 characters of a request in its sample", async () => {
    // Object keys are sorted, so `c` comes after the long text.
    const long = "x".repeat(1024 * 1024);
    const recording = await start("auto");
    await session(recording, [
      { a: "a", b: long, c: "a" },
      { a: "b", b: long, c: "b" },
    ]);
    await recording.close();
    const samples = path.join(directory, TENANT, "_requests", "model");
    for (const file of await readdir(samples)) {
      const sample = JSON.parse(
        await readFile(path.join(samples, file), "utf8"),
      ) as { text: string; truncated?: boolean };
      expect(sample).toMatchObject({ truncated: true });
      expect(sample.text).toHaveLength(1024 * 1024);
    }

    // A change after the part that the sample keeps has no change. One
    // before it has.
    const first = await start("replay");
    await session(first, [{ a: "a", b: long, c: "changed" }]);
    const second = await start("replay");
    await session(second, [
      { a: "a", b: long, c: "a" },
      { a: "changed", b: long, c: "b" },
    ]);

    const [missAfter] = (await first.stats()).misses;
    expect(missAfter).not.toHaveProperty("change");
    const [missBefore] = (await second.stats()).misses;
    expect(missBefore!.change).toEqual({
      file: expect.stringMatching(/^model\/[0-9a-f]{64}\.json$/),
      at: expect.any(Number),
    });
    expect(missBefore!.change!.at).toBeLessThan(1024);
  });

  it("keeps a recording when its request sample cannot be written", async () => {
    // A file where the directory of the samples must be makes each sample
    // write fail. The request and its session still pass.
    await mkdir(path.join(directory, TENANT), { recursive: true });
    await writeFile(path.join(directory, TENANT, "_requests"), "");
    const running = await start("auto");
    const recorded = await session(running, [{ model: "m" }]);
    expect(recorded.map(({ source }) => source)).toEqual(["live"]);
    await expect(running.stats()).resolves.toMatchObject({ written: 1 });

    const [replayed] = await session(running, [{ model: "m" }]);
    expect(replayed!.source).toBe("replayed");
    expect(liveRequests).toBe(1);
  });

  it("replays a recording without a request sample", async () => {
    const recording = await start("auto");
    await session(recording, [{ model: "m" }, { model: "second" }]);
    await recording.close();
    await rm(path.join(directory, TENANT, "_requests"), { recursive: true });

    const running = await start("replay");
    const replay = await session(running, [{ model: "m" }, { model: "other" }]);

    expect(replay.map(({ source }) => source)).toEqual(["replayed", "missed"]);
    const { misses } = await running.stats();
    expect(misses).toEqual([
      { rule: "model", session: "test", file: expect.any(String) },
    ]);
  });

  it("sends no request to another origin", async () => {
    await start("auto");

    // The same server under another name is another origin. The proxy
    // refuses it in a tunnel and as an absolute-form request.
    const other = `${origin.replace("127.0.0.1", "localhost")}/v1/messages`;
    await expect(send([{}], other)).rejects.toThrow("403");
    const absolute = new ProxyAgent({ uri: runs[0]!.url, proxyTunnel: false });
    onTestFinished(() => absolute.close());
    const response = await request(other, { dispatcher: absolute });
    await response.body.dump();
    expect(response.statusCode).toBe(403);
    expect(liveRequests).toBe(0);

    // The stats and the report name the refused origins, so a missing
    // entry in `allow` shows. A tunnel has no scheme, so it shows as
    // `host:port`, or as an `https` origin on port 443. The names are
    // bounded, because the client picks them.
    const port = new URL(origin).port;
    await expect(
      send([{}], "https://openrouter.ai/api/v1/chat/completions"),
    ).rejects.toThrow("403");
    for (let host = 0; host < 33; host += 1) {
      await expect(
        send([{}], `http://host${host}.test:${port}/v1/messages`),
      ).rejects.toThrow("403");
    }
    const stats = await runs[0]!.stats();
    const notAllowed = stats.refused?.notAllowed ?? {};
    // 32 origins by name, and one entry for the rest.
    expect(Object.keys(notAllowed)).toHaveLength(33);
    expect(notAllowed).toMatchObject({
      [`localhost:${port}`]: 1,
      [`http://localhost:${port}`]: 1,
      "https://openrouter.ai": 1,
      "other origins": 4,
    });
    expect(describeRecordingStats(stats)).toContain(
      `Refused: localhost:${port} 1 (not in allow), http://localhost:${port} 1 (not in allow), https://openrouter.ai 1 (not in allow), host0.test:${port} 1 (not in allow)`,
    );
  });

  it("writes a request that ends after its passed session", async () => {
    const running = await start("auto");
    let open!: () => void;
    upstreamGate = new Promise((resolve) => (open = resolve));
    const opened = await running.startSession("test");
    const pending = send([{ model: "m" }]);
    // Wait until the request reaches the upstream, then end the test.
    // The upstream server changes `liveRequests`, not this loop.
    // oxlint-disable-next-line no-unmodified-loop-condition
    while (liveRequests === 0) await new Promise((r) => setTimeout(r, 5));
    await opened.end(true);
    open();
    await pending;

    const [replayed] = await session(running, [{ model: "m" }]);
    expect(replayed!.source).toBe("replayed");
    expect(liveRequests).toBe(1);
  });

  it("keeps concurrent sessions of one run apart by their proxy URLs", async () => {
    const running = await start("auto");
    const failing = await running.startSession("fails");
    const passing = await running.startSession("passes");
    await Promise.all([
      sendThrough(failing.url, { model: "dropped" }),
      sendThrough(passing.url, { model: "kept" }),
    ]);
    // With two open sessions, the run URL names no session, so the request
    // is outside both and is written at once.
    await send([{ model: "outside" }]);
    await failing.end(false);
    await passing.end(true);

    const recorded = await Promise.all(
      (await files()).map(async (file) => {
        const text = await readFile(
          path.join(directory, TENANT, "model", file),
          "utf8",
        );
        return (JSON.parse(text) as { session?: string }).session ?? null;
      }),
    );
    expect(recorded).toHaveLength(2);
    expect(recorded).toEqual(expect.arrayContaining([null, "passes"]));
    await expect(running.stats()).resolves.toMatchObject({
      written: 2,
      discarded: 1,
    });
  });

  it("keeps the keys of a rule when its url becomes a list", async () => {
    // Recordings are keyed by a hash of the rule name and the request
    // (`request-key.ts`). A rule with one url gives the same key as on
    // 0.2.0, and a list with that url gives the same keys too.
    const rule: RecordingRule = {
      name: "model",
      match: { method: "POST", url: "https://api.anthropic.com/v1/" },
      keyHeaders: ["anthropic-version"],
      values: { uuid: VALUE_PATTERNS.uuid },
    };
    const keyOf = (match: RecordingRule["match"]) =>
      keyRequest(
        { ...rule, match },
        {
          method: "POST",
          url: "https://api.anthropic.com/v1/messages",
          headers: { "anthropic-version": "2023-06-01" },
          body: JSON.stringify({
            model: "m",
            id: "0b6f5c1e-3f7a-4d6e-9a54-1c2b3d4e5f60",
            prompt: "hi",
          }),
        },
      ).key;
    // The key of this request and rule on 0.2.0.
    const before =
      "05971aff5d3bd6afbb86028db646a20eb60b26e0f21b85e46d3a339b8aaa5d10";
    expect(keyOf(rule.match)).toBe(before);
    expect(
      keyOf({
        method: "POST",
        url: ["https://openrouter.ai/api/v1/", "https://api.anthropic.com/v1/"],
      }),
    ).toBe(before);

    // Through the proxy: a run with a list replays what a run with one url
    // recorded, and a URL outside the list goes through.
    await session(await start("auto"), [{ model: "m" }]);
    const recorded = await files();
    const listed = await start("replay", [
      "https://other.test/",
      `${origin}/v1/`,
    ]);
    expect([...(await session(listed, [{ model: "m" }]))]).toEqual([
      { body: "data: 1\n\n", source: "replayed" },
    ]);
    await expect(files()).resolves.toEqual(recorded);
    const narrow = await start("auto", [`${origin}/v2/`]);
    expect([...(await session(narrow, [{ model: "m" }]))]).toEqual([
      { body: "data: 2\n\n", source: "passthrough" },
    ]);
  });

  it("keeps the keys of earlier versions", () => {
    // These keys come from an earlier version of the service. A change to
    // how the service makes keys must not change them, or recordings stop
    // replaying.
    const rule: RecordingRule = {
      name: "model",
      match: {},
      values: {
        uuid: VALUE_PATTERNS.uuid,
        time: VALUE_PATTERNS.isoTime,
        commit: VALUE_PATTERNS.gitCommit,
      },
    };
    const keyOf = (
      body: string,
      known?: Map<string, string>,
      url = "https://api.anthropic.com/v1/messages",
    ) =>
      keyRequest(rule, { method: "POST", url, headers: {}, body }, known).key;
    const json = JSON.stringify({
      model: "m",
      messages: [
        {
          role: "user",
          content:
            "Archive memory 0b6f5c1e-3f7a-4d6e-9a54-1c2b3d4e5f60 at 2026-10-07T10:00:00Z",
        },
        {
          role: "assistant",
          content: [
            {
              type: "thinking",
              thinking: "id 11111111-2222-4333-8444-555555555555",
              signature: "sig",
            },
            {
              type: "text",
              text: "Pushed a5fd79f..a73e959, then quoted a73e959",
            },
          ],
        },
      ],
    });
    expect(keyOf(json, new Map([["a73e959", "commit"]]))).toBe(
      "cf9fe9ecb2071fa3c332539ffb007b5d3c289d5eb883901e68a74e72424c08b8",
    );
    expect(
      keyOf(
        "plain 0b6f5c1e-3f7a-4d6e-9a54-1c2b3d4e5f60 text",
        undefined,
        "https://example.test/upload",
      ),
    ).toBe("390e57a543cc07f89643b17e75b8d295efd06e79af800884a2fe346d50c55f56");
    // A body of 3 MiB, with 50,000 values.
    const large = JSON.stringify({
      model: "m",
      lines: Array.from(
        { length: 50_000 },
        (_, i) =>
          `line ${i} of the log, id 0b6f5c1e-3f7a-4d6e-9a54-${String(i).padStart(12, "0")}`,
      ),
    });
    expect(keyOf(large)).toBe(
      "0158550d2794ddc225cb9d383c62a599f06592d4626ecf13276ff6ab53d44118",
    );
    // A session that knows 1,200 commit ids (`pushRequests()`). Its last
    // request quotes the 1,200th id.
    const known = new Map<string, string>();
    const pushed = pushRequests(0xa000000).map((body) => {
      const keyed = keyRequest(
        rule,
        {
          method: "POST",
          url: "https://api.anthropic.com/v1/messages",
          headers: {},
          body: JSON.stringify(body),
        },
        known,
      );
      for (const [name, list] of keyed.values) {
        for (const value of list) if (!known.has(value)) known.set(value, name);
      }
      return keyed.key;
    });
    expect(pushed).toEqual([
      "b7f24e7956bea1227001b1b734b4cfcfd389f07681a89de35245487afc62228b",
      "aa0d220dd551e1135fa6c275ac0ae0ed03db065b5d106da52e30be5dbcc5bf63",
      "aa0d220dd551e1135fa6c275ac0ae0ed03db065b5d106da52e30be5dbcc5bf63",
    ]);
    // A model request of 6 M characters (`screenshotRequest()`).
    for (const time of ["2026-10-07T10:00:00Z", "2026-10-08T11:30:00Z"]) {
      expect(keyOf(JSON.stringify(screenshotRequest(time)))).toBe(
        "aaa37cd328518ec0b0146d6de0d863d6cfbb0cf468e0facf8db5b1536e8d499d",
      );
    }
  });

  it("replays a large request with a new time", async () => {
    const running = await start("auto");
    await session(running, [screenshotRequest("2026-10-07T10:00:00Z")]);

    const replay = await session(running, [
      screenshotRequest("2026-10-08T11:30:00Z"),
    ]);

    expect(replay.map(({ source }) => source)).toEqual(["replayed"]);
  });

  it("remembers every value of a session", async () => {
    const running = await start("auto");
    await session(running, pushRequests(0xa000000));

    const replay = await session(running, pushRequests(0xb000000));

    // The 1,200th id is known too, so its request has the same key.
    expect(replay.map(({ source }) => source)).toEqual([
      "replayed",
      "replayed",
      "replayed",
    ]);
  });

  it("gives the keys that the values of the session give", async () => {
    // The recorder must give each request the key of `keyRequest()` with
    // every value of the earlier requests of its session. The keys of
    // `keyRequest()` are pinned in "keeps the keys of earlier versions".
    const running = await start("auto");
    const bodies = pushRequests(0xa000000);
    await session(running, bodies);

    const rule: RecordingRule = {
      name: "model",
      match: {},
      values: {
        uuid: VALUE_PATTERNS.uuid,
        time: VALUE_PATTERNS.isoTime,
        commit: VALUE_PATTERNS.gitCommit,
      },
    };
    const known = new Map<string, string>();
    const expected = new Set<string>();
    for (const body of bodies) {
      const keyed = keyRequest(
        rule,
        {
          method: "POST",
          url: `${origin}/v1/messages`,
          headers: {},
          body: JSON.stringify(body),
        },
        known,
      );
      expected.add(`${keyed.key}.json`);
      for (const [name, list] of keyed.values) {
        for (const value of list) if (!known.has(value)) known.set(value, name);
      }
    }
    // The last two requests quote one known id each, so they have one key.
    expect(expected.size).toBe(2);
    await expect(files().then((names) => names.toSorted())).resolves.toEqual(
      [...expected].toSorted(),
    );
  });

  it("records again in record mode", async () => {
    const running = await start("record");
    await session(running, [{ model: "m" }]);
    const second = await session(running, [{ model: "m" }]);

    expect([...second]).toEqual([{ body: "data: 2\n\n", source: "live" }]);
    await expect(files()).resolves.toHaveLength(1);
  });
});

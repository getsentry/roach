/**
 * Recording and replay: modes, sessions, changing values, and misses. Each
 * test starts runs on a service with a local upstream.
 */
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
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
} from "vitest";
import { startRemoteRun, type RemoteRoach } from "../src/client.ts";
import { startRoachService, type RoachService } from "../src/service.ts";
import type { RecordingMode } from "../src/types.ts";
import { VALUE_PATTERNS } from "../src/values.ts";

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

/** Start a run with the write token. Later requests go through it. */
async function start(mode: RecordingMode): Promise<RemoteRoach> {
  const run = await startRemoteRun(
    { url: service.url, token: TOKEN },
    {
      tenant: TENANT,
      mode,
      rules: [
        {
          name: "model",
          match: { method: "POST", url: `${origin}/v1/` },
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

/** Send the requests of one test session, then end it. */
async function session(running: RemoteRoach, bodies: unknown[], passed = true) {
  const opened = await running.startSession("test");
  const responses = await send(bodies);
  const { missed } = await opened.end(passed);
  return Object.assign(responses, { missed });
}

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
    allow: [origin],
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

  it("records again in record mode", async () => {
    const running = await start("record");
    await session(running, [{ model: "m" }]);
    const second = await session(running, [{ model: "m" }]);

    expect([...second]).toEqual([{ body: "data: 2\n\n", source: "live" }]);
    await expect(files()).resolves.toHaveLength(1);
  });
});

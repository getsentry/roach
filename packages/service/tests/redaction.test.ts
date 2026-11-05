/**
 * Redaction of credentials in what the proxy writes: the URL of a
 * recording, a body that is not text, credentials that the upstream mints,
 * and request samples. The keys of recordings must not change. Each test
 * starts runs on a service with a local upstream.
 */
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import {
  brotliCompressSync,
  constants,
  gzipSync,
  zstdCompressSync,
} from "node:zlib";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ProxyAgent, request } from "undici";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startRemoteRun, type RemoteRoach } from "@sentry/roach/client";
import { startRoachService, type RoachService } from "../src/service.ts";
import { keyRequest } from "../src/request-key.ts";
import type { Recording, RequestSample } from "../src/store.ts";
import type { RecordingMode, RecordingRule } from "@sentry/roach/types";

const TOKEN = "write-token";
const TENANT = "acme/alpha";
const API_KEY = "sk-live-request-key-456";
const MINTED = "minted-access-token-0123456789";
const TOOL_PASSWORD = "tool-input-password-123";
const GITHUB_TOKEN = "ghs_0123456789abcdefghijABCDEFGHIJ012345";
const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhcHAifQ.c2lnbmF0dXJl";
const SLACK_TOKEN = "xoxb-123-456-abcdef";
const FRAGMENT_TOKEN = "fragtok";
/** Inputs of a tool call that a model can send back in its next request. */
const TOOL_INPUTS: Record<string, Record<string, unknown>> = {
  password: { user: "me", password: TOOL_PASSWORD },
  query: { command: "curl 'https://api.test/v1/me?access_token=abc123def'" },
  fragment: { url: "https://app.test/cb#access_token=abc123def&expires_in=60" },
  nested: { grant: { refresh_token: "tool-refresh-token-123" } },
};
/** A password that a value pattern can leave in the text of a sample. */
const HIDDEN = "hunter2-SECRET-xyz";
/** A minted token with `/` in it. */
const SLASHED = "minted/access/token-0123456789";
/**
 * A minted token with the same text as a message, in JSON with its own
 * spaces and order of fields.
 */
const SAME_TEXT = `{
  "choices": [{ "message": { "content": "yes" } }],
  "access_token":   "yes",
  "token_type": "Bearer"
}`;
/** A string value larger than 8 MiB, with no character to escape. */
const LARGE = "QUJD".repeat(2.25 * 1024 * 1024);
/** Brotli of 1 MiB more than the proxy decodes. It is a few hundred bytes. */
const BOMB = brotliCompressSync(Buffer.alloc(65 * 1024 * 1024), {
  params: { [constants.BROTLI_PARAM_QUALITY]: 4 },
});
/** Bytes that are not valid UTF-8, around the echo of the API key. */
const BINARY_HEAD = Buffer.from([0x00, 0xff, 0xfe, 0x80]);
const BINARY_TAIL = Buffer.from([0xc3, 0x28, 0x00, 0x01]);

let upstream: Server;
let origin: string;
let directory: string;
let service: RoachService;
const runs: RemoteRoach[] = [];
const agents: ProxyAgent[] = [];

const rule = (): RecordingRule => ({
  name: "api",
  match: { method: "POST", url: `${origin}/v1/` },
});

/** Start a run with the write token. */
async function start(
  mode: RecordingMode,
  rules: RecordingRule[] = [rule()],
): Promise<RemoteRoach> {
  const run = await startRemoteRun(
    { url: service.url, token: TOKEN },
    { tenant: TENANT, mode, allow: [origin], rules },
  );
  runs.push(run);
  return run;
}

/** Send one request through the proxy URL of `run`. */
async function send(
  run: RemoteRoach,
  pathAndQuery: string,
  body: string,
  headers: Record<string, string> = {},
) {
  // Tunnel plain HTTP too, so the tests use `CONNECT` as HTTPS clients do.
  const agent = new ProxyAgent({ uri: run.url, proxyTunnel: true });
  agents.push(agent);
  const response = await request(`${origin}${pathAndQuery}`, {
    body,
    dispatcher: agent,
    headers,
    method: "POST",
  });
  return {
    body: Buffer.from(await response.body.arrayBuffer()),
    source: response.headers["x-roach"],
    location: response.headers.location as string | undefined,
  };
}

/** The files of the store under `<tenant>/<dir>`, by name. */
async function stored(dir: string): Promise<Map<string, string>> {
  const at = path.join(directory, TENANT, dir);
  const names = await readdir(at).catch(() => []);
  return new Map(
    await Promise.all(
      names.map(
        async (name) =>
          [name, await readFile(path.join(at, name), "utf8")] as const,
      ),
    ),
  );
}

/**
 * Two turns of a model that calls a tool. The second request repeats the
 * tool call of the first response. Returns where each response came from.
 */
async function toolLoop(run: RemoteRoach, input: string) {
  const user = { role: "user", content: "log in" };
  const first = await send(
    run,
    `/v1/tools?input=${input}`,
    JSON.stringify({ messages: [user] }),
  );
  const reply = JSON.parse(first.body.toString()) as { content: unknown };
  const second = await send(
    run,
    `/v1/tools?input=${input}`,
    JSON.stringify({
      messages: [
        user,
        { role: "assistant", content: reply.content },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "toolu_1" }],
        },
      ],
    }),
  );
  return [first.source, second.source];
}

/**
 * A request that gets a redirect, and a request to its location. Returns
 * where each response came from.
 */
async function follow(run: RemoteRoach) {
  const first = await send(run, "/v1/search", "{}");
  const second = await send(run, first.location!, "{}");
  return [first.source, second.source];
}

/** The one recording of the rule. */
async function onlyRecording(): Promise<{ text: string; file: Recording }> {
  const files = [...(await stored("api")).values()];
  expect(files).toHaveLength(1);
  return { text: files[0]!, file: JSON.parse(files[0]!) as Recording };
}

beforeEach(async () => {
  upstream = createServer((incoming, outgoing) => {
    const chunks: Buffer[] = [];
    incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
    incoming.on("end", () => {
      const { pathname, searchParams } = new URL(
        incoming.url!,
        "http://upstream",
      );
      if (pathname === "/v1/binary") {
        // A binary body that shows the key of the caller.
        outgoing.writeHead(200, { "content-type": "application/octet-stream" });
        outgoing.end(
          Buffer.concat([
            BINARY_HEAD,
            Buffer.from(String(incoming.headers["x-api-key"])),
            BINARY_TAIL,
          ]),
        );
      } else if (pathname === "/v1/oauth/token") {
        // A token that the upstream mints. The client never sent it.
        outgoing.writeHead(200, { "content-type": "application/json" });
        outgoing.end(
          JSON.stringify(
            {
              access_token: MINTED,
              refresh_token: "short-rt",
              token_type: "Bearer",
              expires_in: 3600,
            },
            null,
            2,
          ),
        );
      } else if (pathname === "/v1/form-token") {
        outgoing.writeHead(200, {
          "content-type": "application/x-www-form-urlencoded",
        });
        outgoing.end(`access_token=${MINTED}&scope=repo&token_type=bearer`);
      } else if (pathname === "/v1/tools") {
        // A model that calls a tool with an input that looks like a
        // credential, then answers.
        const { messages } = JSON.parse(Buffer.concat(chunks).toString()) as {
          messages: unknown[];
        };
        outgoing.writeHead(200, { "content-type": "application/json" });
        outgoing.end(
          JSON.stringify(
            messages.length === 1
              ? {
                  role: "assistant",
                  content: [
                    {
                      type: "tool_use",
                      id: "toolu_1",
                      name: "login",
                      input: TOOL_INPUTS[searchParams.get("input")!],
                    },
                  ],
                }
              : { role: "assistant", content: [{ type: "text", text: "in" }] },
          ),
        );
      } else if (pathname === "/v1/app-token") {
        // A token of a GitHub App installation, a JWT, or Slack, and log
        // probabilities.
        const tokens: Record<string, string> = {
          github: GITHUB_TOKEN,
          jwt: JWT,
          slack: SLACK_TOKEN,
        };
        outgoing.writeHead(200, { "content-type": "application/json" });
        outgoing.end(
          JSON.stringify({
            token: tokens[searchParams.get("kind")!],
            expires_at: "2026-01-01T00:00:00Z",
            logprobs: [{ token: "Hello", logprob: -0.1 }, { token: "a" }],
          }),
        );
      } else if (pathname === "/v1/untyped") {
        // JSON without a content type, so the recording keeps it as base64.
        outgoing.end(JSON.stringify({ access_token: MINTED, expires_in: 60 }));
      } else if (pathname === "/v1/redirect") {
        outgoing.writeHead(302, {
          location: `/cb?state=s&code_key=abc#access_token=${FRAGMENT_TOKEN}&expires_in=60`,
        });
        outgoing.end();
      } else if (pathname === "/v1/search") {
        // A redirect whose parameters have names like credentials.
        outgoing.writeHead(302, {
          location: "/v1/cb?keyword=foo&author=jane&pageToken=p2",
        });
        outgoing.end();
      } else if (pathname === "/v1/cb") {
        outgoing.writeHead(200, { "content-type": "application/json" });
        outgoing.end(JSON.stringify({ query: incoming.url }));
      } else if (pathname === "/v1/large") {
        // A large image, as a model of images gives it.
        outgoing.writeHead(200, { "content-type": "application/json" });
        outgoing.end(JSON.stringify({ data: [{ b64_json: LARGE }] }));
      } else if (pathname === "/v1/bomb") {
        outgoing.writeHead(200, {
          "content-type": "application/json",
          "content-encoding": "br",
        });
        outgoing.end(BOMB);
      } else if (pathname === "/v1/gzip") {
        // The proxy asks for `identity`, but this upstream compresses.
        outgoing.writeHead(200, {
          "content-type": "application/json",
          "content-encoding": "gzip",
        });
        outgoing.end(gzipSync(JSON.stringify({ access_token: MINTED })));
      } else if (pathname === "/v1/bad-gzip") {
        outgoing.writeHead(200, {
          "content-type": "application/json",
          "content-encoding": "gzip",
        });
        outgoing.end(`{"access_token":"${MINTED}"}`);
      } else if (pathname === "/v1/zstd") {
        outgoing.writeHead(200, {
          "content-type": "application/json",
          "content-encoding": "zstd",
        });
        outgoing.end(
          zstdCompressSync(JSON.stringify({ access_token: MINTED })),
        );
      } else if (pathname === "/v1/bom") {
        // JSON after a byte order mark.
        outgoing.writeHead(200, { "content-type": "application/json" });
        outgoing.end(`\uFEFF${JSON.stringify({ access_token: MINTED })}`);
      } else if (pathname === "/v1/escaped") {
        // The same token, with each `-` as a unicode escape.
        outgoing.writeHead(200, { "content-type": "application/json" });
        outgoing.end(`{"access_token":"${MINTED.replaceAll("-", "\\u002d")}"}`);
      } else if (pathname === "/v1/slashed") {
        // A copy of the token deeper in the body, with each `/` as `\/`.
        outgoing.writeHead(200, { "content-type": "application/json" });
        const slashed = SLASHED.replaceAll("/", "\\/");
        outgoing.end(
          `{"access_token":"${SLASHED}","data":{"copy":"${slashed}"}}`,
        );
      } else if (pathname === "/v1/echo-slashed") {
        // The key of the caller, with each `/` as `\/`, as PHP
        // `json_encode` writes it.
        const key = String(incoming.headers["x-api-key"]);
        outgoing.writeHead(200, { "content-type": "application/json" });
        outgoing.end(`{"echo":"${key.replaceAll("/", "\\/")}"}`);
      } else if (pathname === "/v1/same-text") {
        outgoing.writeHead(200, { "content-type": "application/json" });
        outgoing.end(SAME_TEXT);
      } else if (pathname === "/v1/note") {
        // A later response that shows the minted token in plain text.
        outgoing.writeHead(200, { "content-type": "text/plain" });
        outgoing.end(`Your token is ${MINTED}.`);
      } else {
        outgoing.writeHead(200, { "content-type": "application/json" });
        outgoing.end(JSON.stringify({ ok: true }));
      }
    });
  });
  await new Promise<void>((resolve) =>
    upstream.listen(0, "127.0.0.1", resolve),
  );
  const address = upstream.address();
  if (!address || typeof address === "string") throw new Error("No port");
  origin = `http://127.0.0.1:${address.port}`;
  directory = await mkdtemp(path.join(tmpdir(), "roach-redaction-"));
  service = await startRoachService({
    directory,
    privateNetworks: true,
    writeTokenHash: createHash("sha256").update(TOKEN).digest("hex"),
  });
});

afterEach(async () => {
  await Promise.all(agents.splice(0).map((agent) => agent.close()));
  await Promise.all(runs.splice(0).map((run) => run.close().catch(() => {})));
  await service.close();
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
  await rm(directory, { recursive: true, force: true });
});

describe("redaction", () => {
  it("redacts a credential query parameter in the URL of a recording at any length", async () => {
    // `abc` is shorter than the values that the run learns, so only the
    // name of the parameter tells that it is a credential.
    const run = await start("auto");
    await send(run, "/v1/messages?key=abc&page=2&api_token=x", "{}");

    const { text, file } = await onlyRecording();
    expect(file.request.url).toBe(
      `${origin}/v1/messages?key=<<redacted>>&page=2&api_token=<<redacted>>`,
    );
    expect(text).not.toContain("key=abc");
    expect(text).not.toContain("api_token=x");
  });

  it("redacts a known credential in a binary body before it encodes it", async () => {
    const run = await start("auto");
    const live = await send(run, "/v1/binary", "{}", { "x-api-key": API_KEY });

    const redacted = Buffer.concat([
      BINARY_HEAD,
      Buffer.from("<<redacted>>"),
      BINARY_TAIL,
    ]);
    // The client gets the redacted bytes, as a replay gives them.
    expect(live).toEqual({ body: redacted, source: "live" });
    const { file } = await onlyRecording();
    expect(file.response.bodyEncoding).toBe("base64");
    const body = Buffer.from(file.response.body, "base64");
    expect(body.includes(API_KEY)).toBe(false);
    // Only the bytes of the credential changed.
    expect(body).toEqual(redacted);

    const replay = await start("replay");
    await expect(
      send(replay, "/v1/binary", "{}", { "x-api-key": API_KEY }),
    ).resolves.toEqual({ body: redacted, source: "replayed" });
  });

  it("redacts a credential that the upstream mints, and replays the response with <<redacted>>", async () => {
    const run = await start("auto");
    const live = await send(run, "/v1/oauth/token", "{}");
    // The live client gets the token, so it can use it.
    expect(JSON.parse(live.body.toString())).toMatchObject({
      access_token: MINTED,
      refresh_token: "short-rt",
    });
    const { text } = await onlyRecording();
    expect(text).not.toContain(MINTED);
    expect(text).not.toContain("short-rt");

    // A later response of the run that shows the token is redacted too.
    await send(run, "/v1/note", "{}");
    for (const recording of (await stored("api")).values()) {
      expect(recording).not.toContain(MINTED);
    }

    // A replay gives `<<redacted>>` in place of each minted value. The other
    // fields do not change, so the client can read the response.
    const replay = await start("replay");
    const replayed = await send(replay, "/v1/oauth/token", "{}");
    expect(replayed.source).toBe("replayed");
    expect(JSON.parse(replayed.body.toString())).toEqual({
      access_token: "<<redacted>>",
      refresh_token: "<<redacted>>",
      token_type: "Bearer",
      expires_in: 3600,
    });
  });

  it("redacts a credential that the upstream mints in a form body", async () => {
    const run = await start("auto");
    const live = await send(run, "/v1/form-token", "{}");
    expect(live.body.toString()).toBe(
      `access_token=${MINTED}&scope=repo&token_type=bearer`,
    );
    const { text, file } = await onlyRecording();
    expect(text).not.toContain(MINTED);
    expect(file.response).toMatchObject({
      bodyEncoding: "utf8",
      body: "access_token=<<redacted>>&scope=repo&token_type=bearer",
    });
  });

  it("redacts credential fields of a request body in its sample", async () => {
    const run = await start("auto");
    await send(
      run,
      "/v1/oauth/token",
      JSON.stringify({
        grant_type: "client_credentials",
        client_id: "app",
        client_secret: "cs-1",
      }),
    );
    await send(
      run,
      "/v1/oauth/token?form=1",
      "grant_type=password&username=me&password=pw-2&client_secret=cs-3",
      { "content-type": "application/x-www-form-urlencoded" },
    );

    const samples = [...(await stored("_requests/api")).values()].map(
      (text) => (JSON.parse(text) as RequestSample).text,
    );
    expect(samples).toHaveLength(2);
    const [json, form] = samples.toSorted((a, b) => a.length - b.length);
    expect(json).toContain('"client_id":"app","client_secret":"<<redacted>>"');
    expect(form).toContain(
      "grant_type=password&username=me&password=<<redacted>>&client_secret=<<redacted>>",
    );
    for (const sample of samples) {
      for (const secret of ["cs-1", "pw-2", "cs-3"]) {
        expect(sample).not.toContain(secret);
      }
    }
  });

  it.each(Object.keys(TOOL_INPUTS))(
    "keeps a %s tool input of a model response, so the next turn replays",
    async (input) => {
      // The next request of the model repeats the input of the tool call.
      // A redacted input there would change its key, so it would miss on
      // replay.
      await expect(toolLoop(await start("auto"), input)).resolves.toEqual([
        "live",
        "live",
      ]);
      expect((await stored("api")).size).toBe(2);
      const replay = await start("replay");
      await expect(toolLoop(replay, input)).resolves.toEqual([
        "replayed",
        "replayed",
      ]);
      expect((await replay.stats()).misses).toEqual([]);
      // The request samples do not show credential fields at any depth. No
      // key uses them.
      for (const sample of (await stored("_requests/api")).values()) {
        expect(sample).not.toContain(TOOL_PASSWORD);
        expect(sample).not.toContain("tool-refresh-token-123");
      }
    },
  );

  it("redacts a bare token field only when its value has a credential prefix", async () => {
    const run = await start("auto");
    const live = await send(run, "/v1/app-token?kind=github", "{}");
    expect(JSON.parse(live.body.toString())).toMatchObject({
      token: GITHUB_TOKEN,
    });
    await send(run, "/v1/app-token?kind=jwt", "{}");
    await send(run, "/v1/app-token?kind=slack", "{}");

    const recordings = [...(await stored("api")).values()];
    expect(recordings).toHaveLength(3);
    for (const text of recordings) {
      for (const secret of [GITHUB_TOKEN, JWT, SLACK_TOKEN]) {
        expect(text).not.toContain(secret);
      }
    }
    const replay = await start("replay");
    for (const kind of ["github", "jwt", "slack"]) {
      const replayed = await send(replay, `/v1/app-token?kind=${kind}`, "{}");
      expect(JSON.parse(replayed.body.toString())).toEqual({
        token: "<<redacted>>",
        expires_at: "2026-01-01T00:00:00Z",
        // Text tokens of a model do not change.
        logprobs: [{ token: "Hello", logprob: -0.1 }, { token: "a" }],
      });
    }
  });

  it("redacts a minted credential in a JSON body without a JSON content type", async () => {
    const run = await start("auto");
    const live = await send(run, "/v1/untyped", "{}");
    expect(JSON.parse(live.body.toString())).toMatchObject({
      access_token: MINTED,
    });
    const { file } = await onlyRecording();
    expect(file.response.bodyEncoding).toBe("base64");
    expect(
      JSON.parse(Buffer.from(file.response.body, "base64").toString()),
    ).toEqual({ access_token: "<<redacted>>", expires_in: 60 });
  });

  it("redacts the minted credential parameters of a stored location header", async () => {
    const run = await start("auto");
    const live = await send(run, "/v1/redirect", "{}");
    // The live client gets the real location.
    expect(live.location).toBe(
      `/cb?state=s&code_key=abc#access_token=${FRAGMENT_TOKEN}&expires_in=60`,
    );
    const { file } = await onlyRecording();
    // A relative URL stays relative.
    expect(file.response.headers.location).toBe(
      "/cb?state=s&code_key=abc#access_token=<<redacted>>&expires_in=60",
    );
  });

  it("keeps the other parameters of a location header, so a replay follows the redirect", async () => {
    // `keyword`, `author`, and `pageToken` have names like credentials, but
    // the next request sends them back, and its key must not change.
    await expect(follow(await start("auto"))).resolves.toEqual([
      "live",
      "live",
    ]);
    const replay = await start("replay");
    await expect(follow(replay)).resolves.toEqual(["replayed", "replayed"]);
    expect((await replay.stats()).misses).toEqual([]);
  });

  it("redacts a request and a response with a string value larger than 8 MiB", async () => {
    const body = JSON.stringify({
      document: LARGE,
      client_secret: "large-request-secret",
    });
    const run = await start("auto");
    const live = await send(run, "/v1/large", body);
    expect(live.source).toBe("live");
    const expected = JSON.stringify({ data: [{ b64_json: LARGE }] });
    expect(live.body.equals(Buffer.from(expected))).toBe(true);
    const [sample] = [...(await stored("_requests/api")).values()];
    const { text } = JSON.parse(sample!) as RequestSample;
    // `includes`, so a failure does not print 8 MiB.
    expect(text.includes('"client_secret":"<<redacted>>"')).toBe(true);
    expect(text.includes("large-request-secret")).toBe(false);

    const replayed = await send(await start("replay"), "/v1/large", body);
    expect(replayed.source).toBe("replayed");
    expect(replayed.body.equals(live.body)).toBe(true);
  });

  it("decodes a compressed response before it redacts and records it", async () => {
    const run = await start("auto");
    const live = await send(run, "/v1/gzip", "{}");
    expect(JSON.parse(live.body.toString())).toEqual({ access_token: MINTED });
    const { text, file } = await onlyRecording();
    expect(text).not.toContain(MINTED);
    expect(file.response).toMatchObject({
      bodyEncoding: "utf8",
      body: '{"access_token":"<<redacted>>"}',
    });
    const replay = await start("replay");
    const replayed = await send(replay, "/v1/gzip", "{}");
    expect(JSON.parse(replayed.body.toString())).toEqual({
      access_token: "<<redacted>>",
    });

    // A body that does not decode is not recorded. The client gets it as
    // it came.
    const bad = await send(run, "/v1/bad-gzip", "{}");
    expect(bad).toEqual({
      body: Buffer.from(`{"access_token":"${MINTED}"}`),
      source: "live",
    });
    expect((await stored("api")).size).toBe(1);
  });

  it("decodes a zstd response before it redacts and records it", async () => {
    const run = await start("auto");
    const live = await send(run, "/v1/zstd", "{}");
    expect(JSON.parse(live.body.toString())).toEqual({ access_token: MINTED });
    const { text, file } = await onlyRecording();
    expect(text).not.toContain(MINTED);
    expect(file.response.body).toBe('{"access_token":"<<redacted>>"}');
  });

  it("redacts a minted credential in JSON after a byte order mark", async () => {
    const run = await start("auto");
    await send(run, "/v1/bom", "{}");
    const { text } = await onlyRecording();
    expect(text).not.toContain(MINTED);
    const replayed = await send(await start("replay"), "/v1/bom", "{}");
    expect(replayed.body.toString()).toBe(
      '\uFEFF{"access_token":"<<redacted>>"}',
    );
  });

  it("redacts a minted credential with unicode escapes", async () => {
    const run = await start("auto");
    await send(run, "/v1/escaped", "{}");
    const { text, file } = await onlyRecording();
    expect(text).not.toContain(MINTED.replaceAll("-", "\\u002d"));
    expect(text).not.toContain(MINTED);
    expect(JSON.parse(file.response.body)).toEqual({
      access_token: "<<redacted>>",
    });
  });

  it("replaces only the value of a minted field, and keeps all other text", async () => {
    // `content` has the same text as the token. The live client gets it,
    // so a replay must give it too.
    const run = await start("auto");
    const live = await send(run, "/v1/same-text", "{}");
    expect(live.body.toString()).toBe(SAME_TEXT);
    const replayed = await send(await start("replay"), "/v1/same-text", "{}");
    expect(replayed.body.toString()).toBe(
      SAME_TEXT.replace(
        '"access_token":   "yes"',
        '"access_token":   "<<redacted>>"',
      ),
    );
  });

  it("redacts many credential fields of a request without blocking the event loop", async () => {
    // 64 different passwords in about 8 MiB, the most that the proxy
    // checks. Each is a field to redact in the request sample.
    const fields = Object.fromEntries(
      Array.from({ length: 64 }, (_, index) => [
        `f${index}`,
        { password: `${index}-${"p".repeat(128 * 1024)}` },
      ]),
    );
    const body = JSON.stringify(fields);
    const run = await start("auto");
    let last = performance.now();
    let longest = 0;
    const timer = setInterval(() => {
      const now = performance.now();
      longest = Math.max(longest, now - last);
      last = now;
    }, 5);
    const started = performance.now();
    try {
      const live = await send(run, "/v1/fields", body);
      expect(live.source).toBe("live");
    } finally {
      clearInterval(timer);
    }
    // About 115 ms, and 700 ms with coverage. A pass for each field took
    // 16 s.
    expect(longest).toBeLessThan(2000);
    expect(performance.now() - started).toBeLessThan(5000);
    const [sample] = [...(await stored("_requests/api")).values()];
    const { text, withheld } = JSON.parse(sample!) as RequestSample;
    expect(withheld).toBeUndefined();
    // `includes`, so a failure does not print 8 MiB.
    expect(text.includes("p".repeat(4096))).toBe(false);
  }, 120_000);

  it("redacts a request sample with many different credential values", async () => {
    // The check reads the text once, for all values, so it has no limit
    // of values.
    const fields = Object.fromEntries(
      Array.from({ length: 5000 }, (_, index) => [
        `f${index}`,
        { password: `password-${index}` },
      ]),
    );
    const run = await start("auto");
    const live = await send(run, "/v1/fields", JSON.stringify(fields));
    expect(live.source).toBe("live");
    const [sample] = [...(await stored("_requests/api")).values()];
    const { text, withheld } = JSON.parse(sample!) as RequestSample;
    expect(withheld).toBeUndefined();
    expect(text).toContain('"f4999":{"password":"<<redacted>>"}');
    expect(text).not.toMatch(/password-\d/);
  });

  it.each([
    // A long value makes a search for it in the text slow.
    [
      "a long value",
      {
        filler: "a".repeat(8 * 1024 * 1024),
        password: `${"a".repeat(1024)} b ${"a".repeat(1024)}`,
      },
    ],
    [
      "many long values",
      {
        filler: "a".repeat(8 * 1024 * 1024),
        ...Object.fromEntries(
          Array.from({ length: 64 }, (_, index) => [
            `f${index}`,
            { password: `${"a".repeat(2048)} ${index} ${"a".repeat(2048)}` },
          ]),
        ),
      },
    ],
  ])(
    "checks a request sample with %s without blocking the event loop",
    async (_, fields) => {
      const run = await start("auto");
      let last = performance.now();
      let longest = 0;
      const timer = setInterval(() => {
        const now = performance.now();
        longest = Math.max(longest, now - last);
        last = now;
      }, 5);
      try {
        const live = await send(run, "/v1/fields", JSON.stringify(fields));
        expect(live.source).toBe("live");
      } finally {
        clearInterval(timer);
      }
      // About 60 ms, and 300 ms with coverage. A search for each value in
      // the text took 11 s for one value, and minutes for 64.
      expect(longest).toBeLessThan(2000);
      const [sample] = [...(await stored("_requests/api")).values()];
      const { text, withheld } = JSON.parse(sample!) as RequestSample;
      expect(withheld).toBeUndefined();
      expect(text.includes(` ${"a".repeat(1024)}`)).toBe(false);
    },
    60_000,
  );

  const JSON_TYPE = "application/json";
  const FORM_TYPE = "application/x-www-form-urlencoded";
  const TAKE_NAME = String.raw`id-[0-9]+","password":"hunt`;
  it.each([
    // The pattern changes the start of the password, so the rest is not
    // the value of the field.
    [
      "the start of a value",
      { n: "sk-[a-z]+-" },
      JSON.stringify({ a: "id-1", password: "sk-abc-9f8e7d6c5b4a" }),
      JSON_TYPE,
      "9f8e7d6c5b4a",
    ],
    [
      "a part in the middle of a value",
      { n: "[0-9]{4,}" },
      JSON.stringify({ a: "id-1", password: "hunter2-SECRET-2024-xyz" }),
      JSON_TYPE,
      "SECRET",
    ],
    [
      "the name and the start of a value",
      { v: TAKE_NAME },
      JSON.stringify({ a: "id-1", password: HIDDEN }),
      JSON_TYPE,
      "SECRET",
    ],
    // A field that holds `<<redacted>>` before must not take the place of
    // the field that the pattern took.
    [
      "the name, with a field that holds <<redacted>>",
      { v: TAKE_NAME },
      JSON.stringify({
        a: "id-1",
        password: HIDDEN,
        z: { password: "<<redacted>>" },
      }),
      JSON_TYPE,
      "SECRET",
    ],
    [
      "the name in a form",
      { v: "id-[0-9]+&password=hunt" },
      `a=id-1&password=${HIDDEN}`,
      FORM_TYPE,
      "SECRET",
    ],
    [
      "the name in a form, with a field that holds <<redacted>>",
      { v: "id-[0-9]+&password=hunt" },
      `a=id-1&password=${HIDDEN}&api_key=%3C%3Credacted%3E%3E`,
      FORM_TYPE,
      "SECRET",
    ],
  ])(
    "does not show a credential field when a pattern changes %s",
    async (_, values, body, contentType, part) => {
      const run = await start("auto", [{ ...rule(), values }]);
      const live = await send(run, "/v1/fields?api_key=k", body, {
        "content-type": contentType,
      });
      expect(live.source).toBe("live");
      const samples = [...(await stored("_requests/api")).values()];
      expect(samples).toHaveLength(1);
      expect(samples[0]).not.toContain(part);
    },
  );

  it.each([
    // The pattern takes the name of the password, and a key header holds
    // a field with `<<redacted>>`. Only the body counts.
    [
      "a key header",
      { v: "x&" },
      `note=x&password=${HIDDEN}`,
      FORM_TYPE,
      { "x-trace": "a&password=<<redacted>>" },
    ],
    // A value name with `"` or `&` adds a field that holds `<<redacted>>`
    // where the pattern took the password.
    [
      "a value name in JSON",
      { v: TAKE_NAME, 'x","password":"<<redacted': '(?<="z":")w' },
      JSON.stringify({ a: "id-1", password: HIDDEN, z: "w" }),
      JSON_TYPE,
      {},
    ],
    [
      "a value name in a form",
      { v: "x&", "q&password=<<redacted": "(?<=z=)w" },
      `note=x&password=${HIDDEN}&z=w`,
      FORM_TYPE,
      {},
    ],
  ])(
    "does not let %s take the place of a credential field",
    async (_, values, body, contentType, headers) => {
      const keyHeaders = Object.keys(headers);
      const run = await start("auto", [{ ...rule(), values, keyHeaders }]);
      const live = await send(run, "/v1/fields", body, {
        "content-type": contentType,
        ...headers,
      });
      expect(live.source).toBe("live");
      const samples = [...(await stored("_requests/api")).values()];
      expect(samples).toHaveLength(1);
      expect(samples[0]).not.toContain("SECRET");
    },
  );

  it("redacts a large form body without blocking the event loop", async () => {
    // Each field is a password, so each one is replaced and counted.
    const parts: string[] = [];
    for (let i = 0; parts.length * 20 < 8 * 1024 * 1024; i++) {
      parts.push(`password=p${String(i).padStart(9, "0")}`);
    }
    const run = await start("auto");
    let last = performance.now();
    let longest = 0;
    const timer = setInterval(() => {
      const now = performance.now();
      longest = Math.max(longest, now - last);
      last = now;
    }, 5);
    try {
      const live = await send(run, "/v1/fields", parts.join("&"), {
        "content-type": FORM_TYPE,
      });
      expect(live.source).toBe("live");
    } finally {
      clearInterval(timer);
    }
    // About 300 ms, and 900 ms with coverage. Three decodes of each part
    // took 1.9 s.
    expect(longest).toBeLessThan(1500);
    const [sample] = [...(await stored("_requests/api")).values()];
    const { text, withheld } = JSON.parse(sample!) as RequestSample;
    expect(withheld).toBeUndefined();
    expect(text).not.toContain("p000000001");
  }, 60_000);

  it("redacts a credential field of a request with escapes in its value", async () => {
    // `\/` and `\u` are other ways to write the same value. The key writes
    // a body that parses again, but keeps the text of one that does not,
    // such as one after a byte order mark.
    const escaped = String.raw`{"password":"pass\/word\u002dsecret"}`;
    const run = await start("auto");
    await send(run, "/v1/escaped-field", escaped);
    await send(run, "/v1/escaped-field-bom", `\uFEFF${escaped}`);
    const samples = [...(await stored("_requests/api")).values()].map(
      (sample) => (JSON.parse(sample) as RequestSample).text,
    );
    expect(samples).toHaveLength(2);
    for (const text of samples) {
      expect(text).not.toContain("secret");
      expect(text).toContain(`"password":"<<redacted>>"`);
    }
  });

  it("redacts a copy of a minted token with `\\/` in the same body", async () => {
    const run = await start("auto");
    await send(run, "/v1/slashed", "{}");
    const { text, file } = await onlyRecording();
    expect(text).not.toContain("token-0123456789");
    expect(JSON.parse(file.response.body)).toEqual({
      access_token: "<<redacted>>",
      data: { copy: "<<redacted>>" },
    });
  });

  it("writes a request sample without text when a pattern hides a credential field", async () => {
    // The pattern takes the quote after the id, so the text of the key has
    // the password outside of a string.
    const values = { v: String.raw`id-[0-9]+"` };
    const run = await start("auto", [{ ...rule(), values }]);
    const body = JSON.stringify({ a: "id-123", password: "hunter2-SECRET" });
    const live = await send(run, "/v1/fields", body);
    expect(live.source).toBe("live");
    expect([...(await stored("api")).values()]).toHaveLength(1);
    const samples = [...(await stored("_requests/api")).values()];
    expect(samples.join("")).not.toContain("SECRET");
    expect(samples.map((sample) => JSON.parse(sample))).toEqual([
      { file: expect.any(String), text: "", withheld: true },
    ]);
  });

  it.each([
    // `confirm_password` is not a credential field, and it sorts first.
    [
      "a field that is not a credential",
      `{"confirm_password":"${HIDDEN}","id":"id-123","password":"${HIDDEN}"}`,
    ],
    [
      "a key of an object",
      `{"${HIDDEN}":1,"id":"id-123","password":"${HIDDEN}"}`,
    ],
    [
      "an item of a list",
      `{"a":["${HIDDEN}"],"b":"id-1","password":"${HIDDEN}"}`,
    ],
    // Two quotes go away, so the count of quotes is even again.
    [
      "two fields after two patterns",
      `{"a":"id-1","password":"${HIDDEN}","q":"id-2","z":"${HIDDEN}"}`,
    ],
  ])(
    "writes no text in a request sample when a credential value stays in %s",
    async (_, body) => {
      const values = { v: String.raw`id-[0-9]+"` };
      const run = await start("auto", [{ ...rule(), values }]);
      const live = await send(run, "/v1/fields", body);
      expect(live.source).toBe("live");
      const samples = [...(await stored("_requests/api")).values()];
      expect(samples).toHaveLength(1);
      expect(samples[0]).not.toContain("SECRET");
      expect(JSON.parse(samples[0]!)).toMatchObject({
        text: "",
        withheld: true,
      });
    },
  );

  it("does not compare a miss with an older sample when a sample has no text", async () => {
    const values = { v: String.raw`id-[0-9]+"` };
    const rules = [{ ...rule(), values }];
    // The first request of each run has the same place, so the same sample.
    await send(await start("auto", rules), "/v1/fields", `{"n":1}`);
    const hidden = `{"a":"id-1","password":"${HIDDEN}"}`;
    await send(await start("auto", rules), "/v1/fields", hidden);
    const [sample] = [...(await stored("_requests/api")).values()];
    expect(JSON.parse(sample!)).toMatchObject({ text: "", withheld: true });
    // A miss there has no change: the last request at the place has no text.
    const replay = await start("replay", rules);
    expect((await send(replay, "/v1/fields", `{"n":2}`)).source).toBe("missed");
    const { misses } = await replay.stats();
    expect(misses).toHaveLength(1);
    expect(misses[0]!.change).toBeUndefined();
  });

  it("does not throw for each string with an escape that is not valid", async () => {
    // The pattern makes each `\u0001` an escape that is not valid, and the
    // short password makes each string worth a look. About 8 MiB.
    const values = { v: "u0001" };
    const run = await start("auto", [{ ...rule(), values }]);
    const strings = Array.from({ length: 900_000 }, () => '"\\u0001"');
    const body = `{"a":[${strings.join(",")}],"password":"x"}`;
    let last = performance.now();
    let longest = 0;
    const timer = setInterval(() => {
      const now = performance.now();
      longest = Math.max(longest, now - last);
      last = now;
    }, 5);
    try {
      const live = await send(run, "/v1/fields", body);
      expect(live.source).toBe("live");
    } finally {
      clearInterval(timer);
    }
    // About 300 ms, and 1.2 s with coverage. A throw for each string took
    // 5.9 s.
    expect(longest).toBeLessThan(3000);
    const [sample] = [...(await stored("_requests/api")).values()];
    // The escapes that are not valid make the body of the text not JSON,
    // so the proxy cannot check it, and the sample has no text.
    expect(JSON.parse(sample!)).toMatchObject({ text: "", withheld: true });
  }, 60_000);

  it("decodes only the strings that have the length of a credential value", async () => {
    // Each string has a valid escape, and its value is shorter than the
    // password, so none of them is decoded. About 8 MiB.
    const run = await start("auto");
    const strings = Array.from({ length: 1_650_000 }, () => '"\\n"');
    const body = `{"a":[${strings.join(",")}],"password":"pw"}`;
    let last = performance.now();
    let longest = 0;
    const timer = setInterval(() => {
      const now = performance.now();
      longest = Math.max(longest, now - last);
      last = now;
    }, 5);
    try {
      const live = await send(run, "/v1/fields", body);
      expect(live.source).toBe("live");
    } finally {
      clearInterval(timer);
    }
    // About 200 ms, and 1.4 s with coverage. Most of it is the parse of the
    // body. A `JSON.parse` of each string made it about two times longer.
    expect(longest).toBeLessThan(3000);
    const [sample] = [...(await stored("_requests/api")).values()];
    expect(JSON.parse(sample!)).not.toHaveProperty("withheld");
  }, 60_000);

  it("reads a string that does not close only once", async () => {
    // The pattern takes the quotes from around a long value of escaped
    // quotes, so in the text of the key that string does not close.
    const values = { v: String.raw`:"(?=\\)|(?<!\\)"(?=\}$)` };
    const run = await start("auto", [{ ...rule(), values }]);
    const body = JSON.stringify({
      password: "secret-pass-1",
      v: '"'.repeat(40 * 1024),
    });
    const started = performance.now();
    const live = await send(run, "/v1/fields", body);
    // About 5.7 s when it reads the rest of the line again at each quote.
    expect(performance.now() - started).toBeLessThan(1000);
    expect(live.source).toBe("live");
    const [sample] = [...(await stored("_requests/api")).values()];
    expect(sample).not.toContain("secret-pass-1");
  });

  it("does not record a compressed body that decodes to more than 64 MiB", async () => {
    const run = await start("auto");
    const live = await send(run, "/v1/bomb", "{}");
    // The client gets the body as it came, without the proxy decoding it.
    expect(live.source).toBe("live");
    expect(live.body.equals(BOMB)).toBe(true);
    expect((await stored("api")).size).toBe(0);
  });

  it("learns a credential with `/` without more values toward the limit", async () => {
    // A SigV4 `Authorization` header has a new value with `/` on each
    // request. A run without the token learns at most 1,024 values, and
    // this header has 401: the value and its 400 parts.
    const run = await startRemoteRun(
      { url: service.url },
      { tenant: TENANT, mode: "replay", allow: [origin], rules: [rule()] },
    );
    runs.push(run);
    const parts = Array.from({ length: 400 }, (_, i) => `scope/${i}/request`);
    const live = await send(run, "/v1/fields", "{}", {
      authorization: parts.join(", "),
    });
    expect(live.body.toString()).not.toMatch(/cannot learn more/);
    expect(live.source).toBe("missed");
  });

  it("redacts a learned credential that the upstream writes with `\\/`", async () => {
    const run = await start("auto");
    const headers = { "x-api-key": "abc/def/ghi/jkl012" };
    const live = await send(run, "/v1/echo-slashed", "{}", headers);
    expect(live.source).toBe("live");
    const { text, file } = await onlyRecording();
    expect(text).not.toContain("jkl012");
    expect(JSON.parse(file.response.body)).toEqual({ echo: "<<redacted>>" });
  });

  it("redacts a learned credential with short parts that the upstream writes with `\\/`", async () => {
    // Each part is too short to learn, so only the whole value covers it.
    const run = await start("auto");
    const headers = { "x-api-key": "Key k1/a2b3 s3/c4d5e6" };
    const live = await send(run, "/v1/echo-slashed", "{}", headers);
    expect(live.source).toBe("live");
    const { text, file } = await onlyRecording();
    expect(text).not.toContain("c4d5e6");
    expect(JSON.parse(file.response.body)).toEqual({ echo: "<<redacted>>" });
  });

  it("keeps the keys of requests with credentials", async () => {
    // Recordings of Junior, Warden, and toolkit must keep replaying. The key
    // hashes the request as it was sent, before any redaction.
    const sent = {
      method: "POST",
      url: "https://auth.example.com/oauth/token?key=k1&page=2",
      headers: { authorization: "Bearer header-token-0123456789" },
      body: JSON.stringify({
        grant_type: "client_credentials",
        client_id: "app",
        client_secret: "client-secret-0123456789",
      }),
    };
    const pinned = {
      name: "oauth",
      match: { method: "POST", url: "https://auth.example.com/" },
    };
    // The key of this request and rule on main before this change.
    expect(keyRequest(pinned, sent).key).toBe(
      "2ee8f643025edb8a1e0e518369e911e7cc053291e399e467b30b1dc3788b1706",
    );

    // Through the proxy, the file name is that key of the request as sent,
    // and a replay finds it.
    const body = JSON.stringify({ client_secret: "cs-1", n: 1 });
    const url = "/v1/oauth/token?key=abc&page=2";
    const headers = { authorization: "Bearer header-token-0123456789" };
    await send(await start("auto"), url, body, headers);
    const expected = keyRequest(rule(), {
      method: "POST",
      url: `${origin}${url}`,
      headers,
      body,
    }).key;
    expect([...(await stored("api")).keys()]).toEqual([`${expected}.json`]);
    const replayed = await send(await start("replay"), url, body, headers);
    expect(replayed.source).toBe("replayed");
  });
});

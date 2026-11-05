/**
 * Redaction of credentials in what the proxy writes: the URL of a
 * recording, a body that is not text, credentials that the upstream mints,
 * and request samples. The keys of recordings must not change. Each test
 * starts runs on a service with a local upstream.
 */
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
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
async function start(mode: RecordingMode): Promise<RemoteRoach> {
  const run = await startRemoteRun(
    { url: service.url, token: TOKEN },
    { tenant: TENANT, mode, allow: [origin], rules: [rule()] },
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
      const { pathname } = new URL(incoming.url!, "http://upstream");
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

/**
 * The vitest integration (`src/vitest.ts`, `src/vitest-setup.ts`). Each
 * test runs vitest in a child process on a small project with a
 * `roach.json`, against a service and an upstream in this process.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import {
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startRoachService, type RoachService } from "../service/service.ts";

const TOKEN = "write-token";
const TENANT = "acme/vitest";
const ROOT = path.resolve(import.meta.dirname, "..");

let upstream: Server;
let origin: string;
let liveRequests: string[];
let directory: string;
let project: string;
let service: RoachService;

/** A test file of the project. `FAIL` makes its second test fail. */
const testFile = (model: string) => `
import { execFileSync } from "node:child_process";
import { expect, it } from "vitest";

const send = async (model) => {
  const response = await fetch(\`\${process.env.UPSTREAM}/v1/messages\`, {
    method: "POST",
    body: JSON.stringify({ model }),
  });
  await response.text();
  return response.headers.get("x-roach");
};

it("passes", async () => {
  const via = await send("${model}");
  // In \`off\` mode the request goes direct, so no proxy marks it.
  if (process.env.ROACH_MODE === "off") expect(via).toBeNull();
  else expect(via).toMatch(/^(live|replayed)$/);
  // A child process sends through the session of its test too.
  execFileSync(process.execPath, [
    "-e",
    \`fetch("\${process.env.UPSTREAM}/v1/messages", { method: "POST", body: JSON.stringify({ model: "${model}-child" }) }).then((r) => r.text())\`,
  ]);
});

it.skipIf(!process.env.FAIL)("fails", async () => {
  await send("${model}-fail");
  throw new Error("expected");
});
`;

/** Run vitest on the project. Returns its exit code and output. */
function runVitest(
  env: Record<string, string>,
): Promise<{ code: number | null; output: string }> {
  const child = spawn(
    process.execPath,
    [path.join(ROOT, "node_modules/vitest/vitest.mjs"), "run"],
    {
      cwd: project,
      env: {
        PATH: process.env.PATH,
        UPSTREAM: origin,
        ROACH_URL: service.url,
        ...env,
      },
    },
  );
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => (output += chunk));
  child.stderr.on("data", (chunk: Buffer) => (output += chunk));
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve({ code, output }));
  });
}

/** The sessions of the recordings of the tenant. */
async function recordedSessions(): Promise<string[]> {
  const rule = path.join(directory, TENANT, "model");
  const files = await readdir(rule).catch(() => []);
  const sessions = await Promise.all(
    files.map(async (file) => {
      const text = await readFile(path.join(rule, file), "utf8");
      return (JSON.parse(text) as { session?: string }).session ?? "";
    }),
  );
  return sessions.toSorted((a, b) => a.localeCompare(b));
}

beforeEach(async () => {
  liveRequests = [];
  upstream = createServer((incoming, outgoing) => {
    const chunks: Buffer[] = [];
    incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
    incoming.on("end", () => {
      liveRequests.push(Buffer.concat(chunks).toString("utf8"));
      outgoing.writeHead(200, { "content-type": "application/json" });
      outgoing.end(`{"n":${liveRequests.length}}`);
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

  project = await mkdtemp(path.join(tmpdir(), "roach-vitest-"));
  await symlink(
    path.join(ROOT, "node_modules"),
    path.join(project, "node_modules"),
  );
  await writeFile(
    path.join(project, "roach.json"),
    JSON.stringify({
      tenant: TENANT,
      allow: [origin],
      // The upstream is on loopback, which the default skips.
      noProxy: "none.invalid",
      rules: [{ name: "model", match: { method: "POST", url: `${origin}/` } }],
    }),
  );
  await writeFile(
    path.join(project, "vitest.config.ts"),
    `export default {
  test: {
    include: ["*.fixture.ts"],
    globalSetup: [${JSON.stringify(path.join(ROOT, "src/vitest.ts"))}],
    setupFiles: [${JSON.stringify(path.join(ROOT, "src/vitest-setup.ts"))}],
  },
};
`,
  );
  await writeFile(path.join(project, "a.fixture.ts"), testFile("a"));
  await writeFile(path.join(project, "b.fixture.ts"), testFile("b"));
});

afterEach(async () => {
  await service.close();
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
  await rm(directory, { recursive: true, force: true });
  await rm(project, { recursive: true, force: true });
});

describe("vitest", () => {
  it("records each test in its own session, then replays without the token", async () => {
    const recorded = await runVitest({ ROACH_TOKEN: TOKEN, FAIL: "1" });
    expect(recorded).toMatchObject({ code: 1 });
    expect(recorded.output).toContain("Roach (auto):");
    // Each test file runs in its own worker, at the same time. The failed
    // tests dropped their recordings.
    await expect(recordedSessions()).resolves.toEqual([
      "a.fixture.ts > passes",
      "a.fixture.ts > passes",
      "b.fixture.ts > passes",
      "b.fixture.ts > passes",
    ]);
    expect(liveRequests).toHaveLength(6);

    const replayed = await runVitest({});
    expect(replayed).toMatchObject({ code: 0 });
    expect(replayed.output).toContain("Roach (replay):");
    expect(replayed.output).toContain("model 4 replayed, 0 live");
    expect(liveRequests).toHaveLength(6);
  });

  it("sends requests direct in off mode, without the service", async () => {
    const result = await runVitest({
      ROACH_MODE: "off",
      ROACH_URL: "http://127.0.0.1:1",
    });
    expect(result).toMatchObject({ code: 0 });
    expect(liveRequests).toHaveLength(4);
    await expect(recordedSessions()).resolves.toEqual([]);
  });

  it("fails a test whose request has no recording in replay mode", async () => {
    const result = await runVitest({});
    expect(result.code).toBe(1);
    expect(result.output).toContain("had no recording in replay mode");
    expect(liveRequests).toHaveLength(0);
  });
});

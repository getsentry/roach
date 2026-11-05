/**
 * The shared setup of the service tests: a local upstream and a service in
 * the test process. Each one closes when its test finishes.
 */
import { createHash } from "node:crypto";
import { createServer, type RequestListener, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { onTestFinished } from "vitest";
import {
  startRoachService,
  type RoachService,
  type RoachServiceConfig,
} from "../src/service.ts";

/**
 * The time limit of a timing check: `ms`, or 3 times `ms` with coverage.
 * Coverage makes the service slower (`vitest.config.ts`).
 */
export const budget = (ms: number) =>
  ms * Number(process.env.ROACH_TEST_SLOWDOWN ?? "1");

/** The write token of a test service. */
export const TOKEN = "write-token";

/** The SHA-256 of a token in hex, as `writeTokenHash` keeps it. */
const hash = (token: string) =>
  createHash("sha256").update(token).digest("hex");

/**
 * Start an HTTP upstream on 127.0.0.1 with `handler`. Returns the server
 * and its origin. It closes when the test finishes.
 */
export async function startUpstream(
  handler: RequestListener,
): Promise<{ server: Server; origin: string }> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  onTestFinished(
    () => new Promise<void>((resolve) => server.close(() => resolve())),
  );
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No port");
  return { server, origin: `http://127.0.0.1:${address.port}` };
}

/**
 * Start a service in this process, with the recordings in a new directory.
 * It can reach the upstream on 127.0.0.1 (`privateNetworks`), and its write
 * token is `TOKEN`. `extra` adds to or replaces this config. The service
 * closes, and its directory goes, when the test finishes.
 */
export async function startTestService(
  extra: Partial<RoachServiceConfig> = {},
): Promise<{ service: RoachService; directory: string }> {
  const directory = await mkdtemp(path.join(tmpdir(), "roach-"));
  const service = await startRoachService({
    directory,
    privateNetworks: true,
    writeTokenHash: hash(TOKEN),
    ...extra,
  });
  onTestFinished(async () => {
    await service.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { service, directory };
}

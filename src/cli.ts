/**
 * The command line of Roach.
 *
 * - `cli.ts service <config.json>`: start the shared service (`service.ts`)
 *   with the configuration in the file. Print its URL as one JSON line.
 *   Stop on SIGINT or SIGTERM. The deployed container runs this command.
 * - `cli.ts serve`: read the configuration of a local proxy as JSON from
 *   stdin, and start it. Print its address as one JSON line. Stop on SIGINT
 *   or SIGTERM. `client.ts` runs this command.
 * - `cli.ts prune <directory> <used-file>...`: delete the recordings that no
 *   used file lists.
 */
import { readFile } from "node:fs/promises";
import { text } from "node:stream/consumers";
import { pruneRecordings } from "./recordings.ts";
import { startRoach } from "./server.ts";
import type { RoachServiceConfig } from "./service.ts";
import type { RoachAddress, RoachConfig } from "./types.ts";

const USAGE = `Usage:
  cli.ts service <config.json>
  cli.ts serve < config.json
  cli.ts prune <directory> <used-file>...`;

const [command, ...args] = process.argv.slice(2);

/** Stop on SIGINT or SIGTERM. A failed close logs its error and exits 1. */
function stopOnSignal(close: () => Promise<void>): void {
  const stop = () => {
    close().then(
      () => process.exit(0),
      (error: unknown) => {
        process.stderr.write(`[roach] Close failed: ${String(error)}\n`);
        process.exit(1);
      },
    );
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

if (command === "service" && args.length === 1) {
  const config = JSON.parse(
    await readFile(args[0]!, "utf8"),
  ) as RoachServiceConfig;
  // Only the service loads the Sentry SDK.
  const { startRoachService } = await import("./service.ts");
  const service = await startRoachService(config);
  process.stdout.write(`${JSON.stringify({ url: service.url })}\n`);
  stopOnSignal(() => service.close());
} else if (command === "serve") {
  const config = JSON.parse(await text(process.stdin)) as RoachConfig;
  const proxy = await startRoach(config);
  const address: RoachAddress = {
    url: proxy.url,
    token: proxy.token,
    caCert: proxy.caCert,
  };
  process.stdout.write(`${JSON.stringify(address)}\n`);
  stopOnSignal(() => proxy.close());
} else if (command === "prune" && args.length >= 2) {
  const [directory, ...usedFiles] = args as [string, ...string[]];
  const count = await pruneRecordings(directory, usedFiles);
  process.stdout.write(`Deleted ${count} unused recordings\n`);
} else {
  process.stderr.write(`${USAGE}\n`);
  process.exit(2);
}

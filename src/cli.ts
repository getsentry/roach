/**
 * The command line of Roach.
 *
 * `cli.ts service <config.json>` starts the shared service (`service.ts`)
 * with the configuration in the file. It prints the URL of the service as
 * one JSON line, and stops on SIGINT or SIGTERM. The deployed container
 * runs this command.
 */
import { readFile } from "node:fs/promises";
import { startRoachService, type RoachServiceConfig } from "./service.ts";

const [command, ...args] = process.argv.slice(2);
if (command !== "service" || args.length !== 1) {
  process.stderr.write("Usage: cli.ts service <config.json>\n");
  process.exit(2);
}

const config = JSON.parse(
  await readFile(args[0]!, "utf8"),
) as RoachServiceConfig;
const service = await startRoachService(config);
process.stdout.write(`${JSON.stringify({ url: service.url })}\n`);

/** Stop on SIGINT or SIGTERM. A failed close logs its error and exits 1. */
const stop = () => {
  service.close().then(
    () => process.exit(0),
    (error: unknown) => {
      process.stderr.write(`[roach] Close failed: ${String(error)}\n`);
      process.exit(1);
    },
  );
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);

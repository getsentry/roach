/**
 * One CI job that uses a deployed Roach service. `deployed.test.ts` runs it
 * in its own process, because it must trust the TLS certificate of the
 * service at startup, as a CI job trusts a public one.
 *
 * It starts a run, then runs a test process that has only the proxy
 * variables of the run. That process sends one HTTPS request with plain
 * `fetch`. The job prints the response, the stats, and the CA certificate
 * as one JSON line.
 *
 * Argument: JSON `{ service, token?, config, url, body }`.
 */
import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { startRemoteRun } from "../src/client.ts";
import type { RunConfig } from "../src/service.ts";

const { service, token, config, url, body } = JSON.parse(process.argv[2]!) as {
  service: string;
  token?: string;
  config: RunConfig;
  url: string;
  body: string;
};

const run = await startRemoteRun({ url: service, token }, config);
// The test process trusts the CA of Roach and the TLS certificate of the
// service, as this job does.
const caFile = run.env.NODE_EXTRA_CA_CERTS!;
await writeFile(
  caFile,
  `${await readFile(caFile, "utf8")}${await readFile(process.env.NODE_EXTRA_CA_CERTS!, "utf8")}`,
);
const session = await run.startSession("test");
const script = `
const response = await fetch(${JSON.stringify(url)}, { method: "POST", body: ${JSON.stringify(body)} });
console.log(JSON.stringify({ status: response.status, source: response.headers.get("x-roach"), body: await response.text() }));
`;
const { stdout } = await promisify(execFile)(
  process.execPath,
  ["--input-type=module", "--eval", script],
  { env: { ...process.env, ...run.env } },
);
await session.end(true);
const stats = await run.close();
process.stdout.write(
  `${JSON.stringify({ response: JSON.parse(stdout), stats, caCert: run.caCert })}\n`,
);

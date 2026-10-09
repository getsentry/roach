# Roach

Roach is a recording HTTPS proxy for tests. It records chosen requests and
replays them, so a second run of a test suite makes no live calls. The
proxy owns every read and write of the recordings. A test runner only gives
it rules and tells it when each test starts and ends.

Roach runs in one of two ways:

- **A shared service** (`service.ts`): one deployed proxy for many
  projects and CI runs. A client points `HTTPS_PROXY` at it and trusts its
  certificate authority. It installs nothing else. The recordings are in a
  GCS bucket, which deletes each one 30 days after it was written. See
  [Service](#service) and [Deploy](#deploy).
- **A local proxy** (`server.ts`): a process in the process tree of the
  test run, with the recordings in JSON files that you commit to git.

Roach started in
[`getsentry/junior`](https://github.com/getsentry/junior/tree/main/packages/junior-evals/src/roach).
It uses Node built-ins and the `openssl` command. Only the service uses the
Sentry SDK (`@sentry/node`).

## Use the service

```ts
import { startRemoteRun, connectRoach } from "@sentry/roach/client";
import { describeRecordingStats } from "@sentry/roach/report";
import { VALUE_PATTERNS } from "@sentry/roach/values";

// Once per CI job. Without `token`, only `replay` mode is allowed.
const run = await startRemoteRun(
  { url: "https://roach.example.com", token: process.env.ROACH_TOKEN },
  {
    tenant: "junior",
    mode: "auto",
    name: `${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}`,
    rules: [
      {
        name: "model",
        match: { method: "POST", url: "https://ai-gateway.vercel.sh/" },
        keyHeaders: ["ai-model-id"],
        values: { uuid: VALUE_PATTERNS.uuid, time: VALUE_PATTERNS.isoTime },
      },
    ],
  },
);
spawn("vitest", { env: { ...process.env, ...run.env } });

// Once per test, in a worker that has the `url`, `controlUrl`, and `token`
// of the run.
const session = await connectRoach({ url, controlUrl, token }).startSession(
  testName,
);
const { missed } = await session.end(passed);
// In `replay` mode, fail the test when `missed` is not 0.

// At the end of the job.
console.log(describeRecordingStats(await run.close()));
```

A client that does not use `client.ts` can do the same with plain HTTP. See
[Control API](#control-api).

## Use a local proxy

```ts
import { spawnRoach } from "@sentry/roach/client";

const proxy = await spawnRoach({
  directory: "recordings",
  mode: "auto",
  allow: ["https://ai-gateway.vercel.sh"],
  rules: [/* as above */],
});
spawn("vitest", { env: { ...process.env, ...proxy.env } });
// Sessions as above, with connectRoach({ url: proxy.url, token: proxy.token }).
console.log(describeRecordingStats(await proxy.stats()));
await proxy.close();
```

- `env` has `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`, `NODE_USE_ENV_PROXY`,
  and `NODE_EXTRA_CA_CERTS`. Node 24 reads the last two only at startup. A
  process that is already running must set its own agents.
- `spawnRoach(config, { launcher })` runs the proxy with a command
  prefix, such as `sudo`. Use it when the caller cannot reach the network,
  but the proxy must.

## Config

A local proxy takes `RoachConfig` (`src/types.ts`). A run on the service
takes `RunConfig` (`src/service.ts`): `tenant`, `mode`, `rules`, `allow`,
and `name`. The fields below mean the same in both.

- `directory`: where the recordings are. Each rule has a subdirectory.
- `mode`: `auto` replays recordings and records misses. `replay` replays
  recordings and fails a miss with HTTP 412, so nothing goes live. `record`
  sends every request live and records it again. `off` records and replays
  nothing.
- `allow`: the only origins that the proxy sends requests to. It refuses all
  other origins with HTTP 403. The upstream host always comes from this
  list, not from the client.
- `rules`: the traffic to record. `name` uses letters, digits, `_`, `.`,
  and `-`. `match` has `method`, `url` (a prefix),
  and `headers`. `keyHeaders` adds request headers to the key. `values`
  names the values that change from run to run.
- `usedFile`: when the proxy stops, it lists here the recordings that
  sessions used. A failed session uses all recordings that it recorded
  before, because it stops early. `cli.ts prune` takes these files. Only
  for `directory`.
- `missDirectory`: for each miss, the proxy writes the request as the key
  sees it, and its diagnosis, to `<missDirectory>/<rule>/<key>.json`. These
  files contain request bodies, but no request headers except `keyHeaders`.
  Do not commit them. The proxy refuses a `missDirectory` inside
  `directory`.
- `secrets`: credentials that the proxy must never write. The proxy also
  learns the value of each request header whose name can mean a credential,
  such as one with `auth`, `token`, `key`, `secret`, `cookie`, or `session`.
  The match is broad on purpose. Recordings and miss files show
  `<<redacted>>` in place of each known value.

Requests that match no rule go live without a change, and their responses
stream. Each response has an `x-roach` header: `replayed`, `live`,
`missed`, or `passthrough`.

## Recordings

The key of a recording is `<rule>/<hash>.json`. The file store keeps it at
`<directory>/<key>`. The hash is the hash of the
rule, the method, the URL, the key headers, and the body. A JSON body has
sorted keys. A recording keeps the response, the session that recorded it,
and a short hash of each part of the request. It does not keep the request
body.

- One session is open at a time. The proxy keeps the new recordings of a
  session in memory. A passed session writes them, and a failed session
  drops them, so a bad sample is never replayed.
- A request belongs to the session that was open when it started. If it
  ends after its session ended, it follows the result of that session.
- A request outside a session is written at once.
- A 429 or 5xx response is never recorded. A replay does not write the
  file again.

## Changing values

Ids and times change on each run, and a response often repeats them. For
example, the model archives the memory with the id that its request
showed. `values` of a rule maps a name to a regular expression source.
`VALUE_PATTERNS` in `values.ts` has `uuid`, `isoTime`, `date`, `epochMs`,
`sha256`, and `gitCommit`. When two patterns match at the same place, the first one wins.
The proxy matches values in JSON text. Start a custom pattern with
`NOT_AFTER_WORD`, not `\b`: after an escape such as `\n`, `\b` sees the `n`
as part of a word and does not match.

- The key sees each value as `<<name>>`. So two runs with other ids or
  times use the same recording.
- When the proxy records a response, it writes each value of the request as
  `<<name:n>>`: the n-th value of that name in the request.
- On replay, the proxy writes the n-th value of the current request there.
  A replayed response thus uses the ids of this run.
- A value that the response makes itself, such as a date that a model
  calculates, stays as it was recorded.
- A session remembers the values of its requests. In a later request of
  the same session, such a value is also a placeholder where no pattern
  finds it. For example, a pattern finds a short commit id only in the
  output of `git push`, but the model then quotes it alone in its reply. A
  pattern wins at the same place.
- Values in thinking blocks of the request do not count for `n`, and the
  proxy does not look for remembered values in them. A replay keeps the
  recorded text of a thinking block, so when a later request sends it back,
  its values come from the recording run.

Model streams send a tool call in many small deltas, so a value can be
split over two events. Before it records a `text/event-stream`, the proxy
merges the deltas of each Anthropic Messages content block into one event.
Thinking blocks keep their recorded text, because their signature covers
it, and the provider refuses a changed thinking block.

Keep the patterns narrow. A broad pattern makes requests that differ in a
real way use the same recording.

## Misses

The parts of a request are the method, the URL, each key header, each
top-level field of a JSON body, and each item of a top-level array, such as
`messages[3]`. The proxy adds each request without a recording to
`stats().misses`. `describeRecordingMisses()` in `report.ts` gives the
first miss of each test, which is the one to fix.

With the file store, the proxy also finds the recording with the most
equal parts, from the same session if it can, and logs the parts that
differ. This is only a hint to debug a miss. It never makes a replay. To
find it, the file store reads all recordings of a rule on the first miss of
that rule in a run, and then keeps them in memory. The GCS store does not
give this hint, because it would have to read every recording.

## Service

`cli.ts service <config.json>` starts the service. The config is
`RoachServiceConfig` in `src/service.ts`. `deploy/gcp/` writes it for you.

- **Tenants.** A tenant is a project, such as `junior`. Each tenant has a
  write token. The config keeps only the SHA-256 of each token. The
  recordings of a tenant are under `<tenant>/` in the bucket. Tenants never
  share recordings.
- **Reads are public.** Anyone can start a `replay` run of a tenant, so CI
  jobs of forks replay without a secret. Such a run never writes, and it
  refuses a request that no rule records, so nothing goes live. Every
  other mode needs the tenant token. So treat each recording as readable by
  anyone who can make its request. Do not record responses that must stay
  private.
- **Runs.** Each run has its own id, token, mode, rules, sessions, and
  stats. A proxied request names its run in `Proxy-Authorization`, as
  `Basic base64(<id>:<token>)`. The proxy URL of the run has them, so
  `HTTPS_PROXY` sends them. A request without them gets HTTP 407.
- **Value patterns.** A pattern runs for every run in the process, so a
  run can only use the patterns in `VALUE_PATTERNS` and the ones in
  `valuePatterns` of the config. Check each one for slow backtracking
  before you add it.
- **Sentry.** With `sentryDsn`, each read and write of a recording sends
  the metric `roach.recording`. Its attributes are `tenant`, `rule`, `key`,
  `run` (the `name` of the run), and `result`: `replayed`, `missed`, or
  `written`. Group by `key` and count `run`, and a recording that only one
  run uses shows that a value changes on each run.
- **Certificate authority.** `ca` holds the PEM certificate and key that
  clients trust. Keep it across restarts. Host certificates live for 7
  days, and the service makes new ones before they expire.

### Limits

- Runs live in memory in one process. A restart ends the open runs, and
  their CI jobs fail. A run that is open for 6 hours ends as failed.
- A request body over 64 MiB gets HTTP 413.
- GCS deletes each recording 30 days after it was written, also when runs
  still replay it. Then `auto` mode records it again, and `replay` mode
  fails the request with HTTP 412.
- A write replaces the recording with the same key.

## Deploy

`deploy/gcp/` is the production setup, in Terraform. It makes:

- a GCS bucket that deletes each recording after `recording_days` (30),
- the certificate authority and one write token for each tenant,
- the service config, in Secret Manager,
- one Container-Optimized OS VM that runs the image
  `ghcr.io/getsentry/roach:main`, with a service account that can only use
  the bucket and the secret,
- an SSL proxy load balancer with a Google-managed certificate. It ends TLS
  and passes the raw TCP stream, with `CONNECT`, to the VM.

The `Image` workflow builds the image on each pull request and pushes it on
`main`. The VM pulls the image at each start.

### Set up

1. Make the package `ghcr.io/getsentry/roach` public once, after the first
   push to `main`, so the VM can pull it without credentials.
2. Copy `deploy/gcp/roach.tfvars.example` to `roach.tfvars` and fill it in.
   `allow` and `value_patterns` must cover the rules of every tenant.
3. Keep the Terraform state in a private bucket. It holds the CA key and the
   tenant tokens. See the `backend "gcs"` comment in `versions.tf`.
4. Apply:

   ```sh
   cd deploy/gcp
   terraform init
   terraform apply -var-file=roach.tfvars
   ```

5. Point an A record of `domain` at the `ip_address` output. The
   certificate works some minutes after DNS does.
6. Give each tenant its token as a CI secret, such as `ROACH_TOKEN`:
   `terraform output -json tenant_tokens`.
7. Check it: `curl https://<domain>/__roach/ca.pem` returns the CA
   certificate.

To deploy a new image, restart the VM:
`gcloud compute instances reset roach --zone <zone>`. To add a tenant,
add it to `tenants` and apply again. Terraform writes a new config version,
and the VM reads it at its next start.

## Command line

```sh
node src/cli.ts service <config.json>
node src/cli.ts serve < config.json
node src/cli.ts prune <directory> <used-file>...
```

`service` starts the shared service. `serve` starts a local proxy and prints
its address as one JSON line. `client.ts` runs it. `prune` deletes the
recordings that no used file lists. Give it the used files of every run
that shares the directory, or it deletes recordings that another run
needs.

## Control API

The calls of a run are under `/__roach/runs/<id>` on the service, and under
`/__roach` on a local proxy. They need `Authorization: Bearer <token>`, with
the run token or the token of the local proxy. `client.ts` calls them.

- `POST /session` with `{"name": "..."}`: open a session.
- `POST /session/end` with `{"name": "...", "passed": true}`: end it.
  Returns `{"missed": 0}`, the misses that `replay` mode failed. Returns
  HTTP 409 when the session is not open.
- `GET /stats`: the totals of the run.

The service also has:

- `POST /__roach/runs` with a `RunConfig`: start a run. Send
  `Authorization: Bearer <tenant token>` for any mode but `replay`. Returns
  the `id`, `token`, proxy `url`, `controlUrl`, and `caCert` of the run.
- `DELETE /__roach/runs/<id>`: end the run. Returns its stats.
- `GET /__roach/ca.pem`: the CA certificate. No token.

## Development

```sh
pnpm install
pnpm check   # format, lint, types, unused code, and tests, as CI runs them
```

`AGENTS.md` has the conventions and the commands for one file.

- `tests/roach.test.ts` tests a local proxy.
- `tests/service.test.ts` tests the service in the test process.
- `tests/deployed.test.ts` runs the service as it runs in production: from
  the command line, behind a TLS server that does what the load balancer
  does, with a local GCS server, metadata server, and Sentry server. Each
  CI job (`tests/ci-job.ts`) sets only the proxy variables of its run.

## Files

The proxy is in `src/`. Tests are in `tests/`. The production setup is in
`deploy/gcp/` and `Dockerfile`.

- `types.ts`: the configuration and the results of a local proxy.
- `server.ts`: sockets, HTTPS interception, the allow list, and the control
  API.
- `service.ts`: the shared service: tenants, runs, access, and metrics.
- `recorder.ts`: modes, sessions, replay, and misses.
- `request-key.ts`: the key and the part hashes of a request.
- `store.ts`: the recording format and the store contract.
- `recordings.ts`: the file store and prune.
- `gcs.ts`: the GCS store.
- `values.ts`: changing values and their placeholders.
- `streams.ts`: merges the deltas of a recorded model stream.
- `secrets.ts`: redaction of credentials.
- `certificates.ts`: the certificate authority for HTTPS.
- `client.ts`: starts a remote run or a local proxy, and calls the control
  API.
- `report.ts`: text reports of a run.
- `cli.ts`: the command line.

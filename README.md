# Roach

Roach is a recording HTTPS proxy for tests. It records chosen requests and
replays them, so a second run of a test suite makes no live calls. The
proxy owns every read and write of the recordings. A test runner only gives
it rules and tells it when each test starts and ends.

Roach is a shared service (`service.ts`): one deployed proxy for many
projects and CI runs. A client points `HTTPS_PROXY` at it and trusts its
certificate authority. It installs nothing else. The recordings are in a
GCS bucket, which deletes each one 30 days after it was written. See
[Service](#service) and [Deploy](#deploy).

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
    tenant: process.env.GITHUB_REPOSITORY!, // such as getsentry/junior
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

// Once per test, in a worker that has the `controlUrl` and `token` of the
// run.
const session = await connectRoach({ controlUrl, token }).startSession(
  testName,
);
const { missed } = await session.end(passed);
// In `replay` mode, fail the test when `missed` is not 0.

// At the end of the job.
console.log(describeRecordingStats(await run.close()));
```

`run.env` has `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`, `NODE_USE_ENV_PROXY`,
and `NODE_EXTRA_CA_CERTS`. Node 24 reads the last two only at startup. The
CA file also has the certificates of `NODE_EXTRA_CA_CERTS` of the caller.
A client that does not use `client.ts` can do the same with plain HTTP. See
[Control API](#control-api).

## Use the GitHub Action

A repository adds one step and a `roach.json` file:

```yaml
- uses: getsentry/roach@v0
  with:
    token: ${{ secrets.ROACH_TOKEN }} # without it, the run can only replay
    run: pnpm test
```

`roach.json` is at the root of the repository. It has the `allow` origins
and the `rules` of the run (`RunConfig` in `src/service.ts`):

```json
{
  "allow": ["https://ai-gateway.vercel.sh"],
  "rules": [
    {
      "name": "model",
      "match": { "method": "POST", "url": "https://ai-gateway.vercel.sh/" },
      "keyHeaders": ["ai-model-id"]
    }
  ]
}
```

The action (`src/action.ts`) starts a run of the tenant
`GITHUB_REPOSITORY`, in `auto` mode with the token or `replay` mode without
it. It runs `run` in bash with the proxy variables of the run, then ends
the run and writes its stats to the job summary.

- Only `run` uses the proxy. Later steps, such as cache and artifact
  uploads, do not. `run` does not get the write token.
- `run` is one session. When it fails, the run drops its new recordings. A
  miss in `replay` mode fails the step. The summary names the job, not the
  test, of each miss.
- `NODE_EXTRA_CA_CERTS` works only for Node. Python and `curl` need a CA
  bundle that also has the system certificates.

## Config

A run takes `RunConfig` (`src/service.ts`): `tenant`, `mode`, `rules`,
`allow`, `name`, and `secrets`.

- `mode`: `auto` replays recordings and records misses. `replay` replays
  recordings and fails a miss with HTTP 412, so nothing goes live. `record`
  sends every request live and records it again. `off` records and replays
  nothing.
- `allow`: the only origins that the proxy sends requests to, 1 to 32 of
  them. It refuses all other origins with HTTP 403. The upstream host
  always comes from this list, not from the request. The service sends
  requests only to public addresses, so an origin that resolves to a
  private, loopback, or link-local address also gets HTTP 403.
- `rules`: the traffic to record. `name` uses letters, digits, `_`, `.`,
  and `-`. `match` has `method`, `url` (a prefix),
  and `headers`. `keyHeaders` adds request headers to the key. `values`
  names the values that change from run to run. A run can have 64 rules,
  and a rule can have 32 values.
- Credentials: the proxy never writes the `secrets` of the service config
  or of the run. Use `secrets` of the run for the credentials of a CI job
  that a response can show but no request header has, such as a token that
  goes to a model in a prompt. The service keeps them only in memory, for
  the run. A run can have 32 of them. It also learns the value of each request header whose name can mean a credential,
  such as one with `auth`, `token`, `key`, `secret`, `cookie`, or `session`.
  The match is broad on purpose. Recordings show `<<redacted>>` in place of
  each known value.

Requests that match no rule go live without a change, and their responses
stream. Each response has an `x-roach` header: `replayed`, `live`,
`missed`, or `passthrough`.

## Recordings

The key of a recording is `<rule>/<hash>.json`, under `<tenant>/` in the
store. The hash is the hash of the rule, the method, the URL, the key
headers, and the body. A JSON body has sorted keys. A recording keeps the
response and the session that recorded it. It does not keep the request
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

The service takes any pattern that compiles in 1 s, up to 2048
characters. A run without the token must use the same patterns as the run
that recorded, or its keys do not match. All runs share one process, so
the key of each request has a time limit: 1 s, and 0.5 s for each MiB of
the body. The built-in patterns take less than 0.1 s for each MiB. A
request whose key takes longer fails with HTTP 400, and other runs go on.
Avoid nested quantifiers, such as `(a+)+`.

## Misses

The proxy adds each request without a recording to `stats().misses`, with
its session and key. `describeRecordingMisses()` in `report.ts` gives the
first miss of each test, which is the one to fix.

## Service

`cli.ts service <config.json>` starts the service. The config is
`RoachServiceConfig` in `src/service.ts`. `deploy/gcp/` writes it for you.

- **Tenants.** A tenant is a GitHub repository, as `owner/repo`, such as
  `getsentry/junior`. In GitHub Actions, use `GITHUB_REPOSITORY`. The
  service has no list of tenants, so a new project needs no change to the
  service. The recordings of a tenant are under `<owner>/<repo>/` in the
  bucket. Tenants never share recordings.
- **One write token.** All tenants share one write token. The config keeps
  only its SHA-256, in `writeTokenHash`. The tenant name is only a label,
  not proof of identity: a job with the token can write the recordings of
  any tenant. So give the token only to repositories and workflows that
  you trust, and never to a workflow that runs code from a fork.
- **Reads are public.** Anyone can start a `replay` run of a tenant, so CI
  jobs of forks replay without a secret. Such a run never writes, and it
  refuses a request that no rule records, so nothing goes live. Every
  other mode needs the write token. So treat each recording as readable by
  anyone who can make its request. Do not record responses that must stay
  private.
- **Runs.** Each run has its own id, token, mode, rules, sessions, and
  stats. A proxied request names its run in `Proxy-Authorization`, as
  `Basic base64(<id>:<token>)`. The proxy URL of the run has them, so
  `HTTPS_PROXY` sends them. A request without them gets HTTP 407.
- **Config of a run.** Each run sends its own `allow` and `rules`, with
  their value patterns. A tenant that calls a new origin or uses a new
  pattern changes only its own config. The service needs no change and no
  restart. Two checks keep one run from harming the others:
  - The proxy sends requests only to public addresses (`addresses.ts`).
    It checks the address of each connection after DNS, so a host name
    cannot point a run at the metadata server, at the VPC, or at the VM.
    Only tests and local development set `privateNetworks`.
  - The key of a request has a time limit (`request-key.ts`), so a slow
    pattern fails only its own request.
- **Sentry.** With `sentryDsn`, each read and write of a recording sends
  a span to Sentry. Each proxied request sends a span and metrics. See
  [Sentry](#sentry).
- **Certificate authority.** `ca` holds the PEM certificate and key that
  clients trust. Keep it across restarts. Host certificates live for 7
  days, and the service makes new ones before they expire.

### Sentry

With `sentryDsn`, the service sends metrics and spans to Sentry. It keeps
all traces. Metrics have only attributes with few values: `tenant`, `mode`,
`rule`, `origin`, and `result`. Spans also have `run` (the `name` of the
run) and `key`.

| Metric                   | Type              | Value                                                                                                                                                |
| ------------------------ | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `roach.request`          | counter           | 1 for each proxied request. `result` is the `x-roach` header: `replayed`, `live`, `missed`, or `passthrough`. A `passthrough` request has no `rule`. |
| `roach.request.duration` | distribution (ms) | The time to answer a request that a rule records, by `result`.                                                                                       |
| `roach.recording.write`  | counter           | Recordings by `rule`. `result` is `written` (the proxy sent them to the store) or `dropped` (their session failed).                                  |

Each proxied request is one trace. Each span has `tenant`, `mode`, and
`run`.

- `roach.run.start`: a new run, with `write` (the run has the write token).
- `roach.request`: one proxied request, named `<method> <origin>`, with
  `origin`, `rule`, `result`, and `http.response.status_code`. It contains:
  - `roach.key`: the key of the request, with `rule` and `key`.
  - `roach.store.read`: a read of a recording, with `key` and `result`:
    `hit` or `miss`.
  - `roach.upstream`: the live request, with `origin` and
    `http.response.status_code`.
- `roach.store.write`: a write of recordings, with `recordings` and
  `written`. A session writes when it ends, so this span is usually its
  own trace.

Telemetry never has a credential, a body, or the path or query of a URL.
So the service turns off the request data and the HTTP spans of the SDK,
and it adds no trace headers to the requests that it sends.

To see how well the cache works:

- **Hit rate.** Sum `roach.request`, group by `result`, and filter by
  `tenant` and `rule`. The hit rate is `replayed / (replayed + live +
  missed)`.
- **Misses.** `missed` is a request that failed in `replay` mode. `live`
  in `auto` mode is a new recording. When `live` stays high from run to
  run, a value in the key changes on each run.
- **Time.** Compare `roach.request.duration` for `live` and `replayed`.
- **Dropped.** `roach.recording.write` with `result:dropped` counts
  recordings of failed sessions. The next run sends these requests live
  again.
- **Changing keys.** Search spans for `span.op:roach.key`, group by
  `key`, and count the runs. A key that only one run uses shows that a
  value changes on each run.

### Limits

- Runs live in memory in one process. A restart ends the open runs, and
  their CI jobs fail. A run that is open for 6 hours ends as failed.
- The service can have 100 open runs without a token, for all tenants
  together. Another one gets HTTP 429 until one ends. Runs with the token
  have no cap.
- A request body over 64 MiB gets HTTP 413.
- GCS deletes each recording 30 days after it was written, also when runs
  still replay it. Then `auto` mode records it again, and `replay` mode
  fails the request with HTTP 412.
- A write replaces the recording with the same key.

## Deploy

`deploy/gcp/` is the production setup, in Terraform. It makes:

- a GCS bucket that deletes each recording after `recording_days` (30),
- the certificate authority and the write token,
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
2. `deploy/gcp/roach.tfvars` has the values of the Sentry deployment: the
   GCP project `roach-511216`, the domain, and the DSN of the `sentry/roach`
   project. Another deployment changes these values. It has no origins or
   patterns: runs send them.
3. The Terraform state is in the private bucket that `backend "gcs"` in
   `versions.tf` names. The state holds the CA key and the write token, so
   the bucket must stay private. Make the bucket before the first
   `terraform init`.
4. Log in with `gcloud auth application-default login`, then apply:

   ```sh
   cd deploy/gcp
   terraform init
   terraform apply -var-file=roach.tfvars
   ```

5. Point an A record of `domain` at the `ip_address` output. The
   certificate works some minutes after DNS does.
6. Put the write token in one GitHub organization secret, `ROACH_TOKEN`.
   Give it access only to the repositories that you trust. This command
   does not show the token:

   ```sh
   terraform output -raw write_token \
     | gh secret set ROACH_TOKEN --org getsentry --visibility selected \
         --repos getsentry/junior
   ```

7. Check it: `curl https://<domain>/__roach/ca.pem` returns the CA
   certificate.

To deploy a new image, restart the VM:
`gcloud compute instances reset roach --zone <zone>`.

To add a project, add its repository to the repositories of the
`ROACH_TOKEN` organization secret, in the GitHub settings of the
organization. Its CI jobs set `tenant` to `GITHUB_REPOSITORY`, and send
their own origins and patterns. The service needs no change.

To change the write token, run
`terraform apply -var-file=roach.tfvars -replace=random_password.write_token`,
set the secret again, and restart the VM.

## Command line

```sh
node src/cli.ts service <config.json>
```

It starts the service and prints its URL as one JSON line.

## Control API

The calls of a run are under `/__roach/runs/<id>`. They need
`Authorization: Bearer <run token>`. `client.ts` calls them.

- `POST /session` with `{"name": "..."}`: open a session.
- `POST /session/end` with `{"name": "...", "passed": true}`: end it.
  Returns `{"missed": 0}`, the misses that `replay` mode failed. Returns
  HTTP 409 when the session is not open.
- `GET /stats`: the totals of the run.

The service also has:

- `POST /__roach/runs` with a `RunConfig`: start a run. Send
  `Authorization: Bearer <write token>` for any mode but `replay`. Returns
  the `id`, `token`, proxy `url`, `controlUrl`, and `caCert` of the run.
- `DELETE /__roach/runs/<id>`: end the run. Returns its stats.
- `GET /__roach/ca.pem`: the CA certificate. No token.

## Release

Run the `Release` workflow, and choose `minor`, `patch`, or `major`. Craft
(`.craft.yml`) makes a `release/<version>` branch and asks for approval in
[getsentry/publish](https://github.com/getsentry/publish). When a release
manager accepts it, Craft:

- copies the image `ghcr.io/getsentry/roach:<sha>` to `:<version>`.
- makes the GitHub release `v<version>`, with the changelog, and moves the
  `v<major>` tag. Repositories use the action as `getsentry/roach@v<major>`.

The action runs `src/action.ts` from the tag, so a release has no build
step.

The `Release` workflow uses the token of Sentry Release Bot. A push with
`GITHUB_TOKEN` starts no workflows, so the release branch gets no checks and
no image, and Craft cannot publish it.

## Development

```sh
pnpm install
pnpm check   # format, lint, types, unused code, and tests, as CI runs them
```

`AGENTS.md` has the conventions and the commands for one file.

- `tests/recording.test.ts` tests modes, sessions, changing values, and
  misses.
- `tests/service.test.ts` tests the service in the test process.
- `tests/deployed.test.ts` runs the service as it runs in production: from
  the command line, behind a TLS server that does what the load balancer
  does, with a local GCS server, metadata server, and Sentry server. Each
  CI job runs the GitHub Action, and its command has only the proxy
  variables of its run.

## Files

The proxy is in `src/`. Tests are in `tests/`. The production setup is in
`deploy/gcp/` and `Dockerfile`.

- `types.ts`: rules, modes, and the results of a run.
- `server.ts`: sockets, HTTPS interception, the allow list, and the control
  API.
- `addresses.ts`: the public addresses that the proxy can send requests to.
- `service.ts`: the shared service: tenants, runs, access, and metrics.
- `recorder.ts`: modes, sessions, replay, and misses.
- `request-key.ts`: the key of a request.
- `store.ts`: the recording format and the store contract.
- `recordings.ts`: the file store, for tests and development.
- `gcs.ts`: the GCS store.
- `values.ts`: changing values and their placeholders.
- `streams.ts`: merges the deltas of a recorded model stream.
- `secrets.ts`: redaction of credentials.
- `certificates.ts`: the certificate authority for HTTPS.
- `client.ts`: starts a run and calls the control API.
- `report.ts`: text reports of a run.
- `action.ts`: the GitHub Action (`action.yml` at the root).
- `cli.ts`: the command line.

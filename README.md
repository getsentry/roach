# Roach

Roach is a recording HTTPS proxy for tests. It records chosen requests and
replays them, so a second run of a test suite makes no live calls. The
proxy owns every read and write of the recordings. A test runner only gives
it rules and tells it when each test starts and ends.

Roach is a shared service (`packages/service`): one deployed proxy for many
projects and CI runs. A client points `HTTPS_PROXY` at it and trusts its
certificate authority. It installs nothing else. The recordings are in a
GCS bucket, which deletes each one 30 days after it was written. See
[Service](#service) and [Deploy](#deploy).

Roach started in
the evals of
[`getsentry/junior`](https://github.com/getsentry/junior/tree/main/packages/junior-evals).
It uses Node built-ins and the `openssl` command. The npm package has no
dependencies. Only the service uses the Sentry SDK (`@sentry/node`), and the
service is a private package in `packages/service` that is not published.

## Use with vitest

Install `@sentry/roach`, add a `roach.json` (see [Config file](#config-file)),
and add two lines to the vitest config:

```ts
export default defineConfig({
  test: {
    globalSetup: ["@sentry/roach/vitest"],
    setupFiles: ["@sentry/roach/vitest/setup"],
  },
});
```

The global setup (`packages/roach/src/vitest.ts`) starts one run for the invocation and
gives its proxy variables to the test workers. The setup file
(`packages/roach/src/vitest-setup.ts`) opens one session for each test, so test files
record in parallel workers at the same time. A passed test writes its new
recordings. A failed test drops them. In `replay` mode, a test with a miss
fails. At the end, the global setup writes the stats of the run to stdout
and to the job summary. After you add Roach, do the check in
[Find changing values](#find-changing-values).

- `ROACH_TOKEN`: the write token. Only the global setup reads it. Without
  it, the run can only replay, as in jobs of forks.
- `ROACH_URL`: the service. Default: `https://roach-proxy.getsentry.net`.
- `ROACH_MODE`: `auto`, `replay`, `record`, or `off`. Default: `auto` with
  the token, `replay` without it. With `off`, the global setup starts no run,
  so requests go direct and need no service and no token.

A project that has its own global setup calls `startRoach(project)` from
`@sentry/roach/vitest` in it, and returns its teardown.

- It needs Node 24.14 or later (`http.setGlobalProxyFromEnv`), except in
  `off` mode.
- Put `@sentry/roach/vitest/setup` before a setup file that starts an HTTP
  mock, such as MSW or nock. The setup file keeps the request functions of
  `node:http` and `node:https` as it loads, so its calls to the service do
  not go to the mock.
- The tests of one file share one process, so they run one at a time. Do
  not use `test.concurrent`.
- The setup file sets a new global `fetch` dispatcher for each test. A
  dispatcher that you set before, such as one with `compose()` interceptors,
  does not apply in the test. Set it again in a `beforeEach` of a setup
  file that comes after `@sentry/roach/vitest/setup` in `setupFiles`, with
  `sequence.setupFiles: "list"`. Restore it with `onTestFinished`.
- A client that gives `fetch` its own undici dispatcher, such as
  `@vercel/sandbox`, does not use the proxy. Its requests go direct.
- The package has TypeScript sources. Vitest compiles them, but Node does
  not strip types in `node_modules`, so plain Node scripts cannot import it.

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
// run. Send the requests of the test through `session.url`.
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

A repository adds one step and a `roach.json` file (see
[Config file](#config-file)):

```yaml
- uses: getsentry/roach@v0
  with:
    token: ${{ secrets.ROACH_TOKEN }} # without it, the run can only replay
    run: pnpm test
```

The action (`packages/roach/src/action.ts`) starts a run with the token in `auto` mode, or
without it in `replay` mode. It runs `run` in bash with the proxy variables
of the run, then ends the run and writes its stats to the job summary.

- Only `run` uses the proxy. Later steps, such as cache and artifact
  uploads, do not. `run` does not get the write token.
- `run` is one session. When it fails, the run drops its new recordings. A
  miss in `replay` mode fails the step. The summary names the job, not the
  test, of each miss. For a session per test, use
  [vitest](#use-with-vitest) in `run`.
- `NODE_EXTRA_CA_CERTS` works only for Node. Python and `curl` need a CA
  bundle that also has the system certificates.

## Config file

The action and the vitest integration read `roach.json` in the working
directory or the closest parent directory (`packages/roach/src/config.ts`):

```json
{
  "allow": ["https://api.anthropic.com", "https://openrouter.ai"],
  "rules": [
    {
      "name": "model",
      "match": {
        "method": "POST",
        "url": [
          "https://api.anthropic.com/v1/",
          "https://openrouter.ai/api/v1/"
        ]
      },
      "values": {
        "uuid": { "builtin": "uuid" },
        "build": "build-[0-9]+"
      }
    }
  ]
}
```

- `allow` and `rules` are those of the run. See [Config](#config).
- A value is a regular expression source, or `{ "builtin": "<name>" }`
  for a pattern of `VALUE_PATTERNS` in `values.ts`.
- `secretEnv`: environment variables that hold credentials that no request
  header has, such as a token that goes to a model in a prompt. Their
  values are the `secrets` of the run. Do not list API keys that go in a
  header: the proxy redacts those on its own. See
  [Config](#config).
- `tenant`: default `GITHUB_REPOSITORY`. Set it, so local runs use the
  recordings of CI.
- `noProxy`: hosts that do not use the proxy. Default: loopback.

The `name` of the run is `<GITHUB_RUN_ID>-<GITHUB_RUN_ATTEMPT>` in GitHub
Actions.

## Config

A run takes `RunConfig` (`packages/roach/src/types.ts`): `tenant`, `mode`, `rules`,
`allow`, `name`, and `secrets`.

- `mode`: `auto` replays recordings and records misses. `replay` replays
  recordings and fails a miss with HTTP 412, so nothing goes live. `record`
  sends every request live and records it again. `off` records and replays
  nothing.
- `allow`: the only origins that the proxy sends requests to, 1 to 32 of
  them. It refuses all other origins with HTTP 403. The upstream host
  always comes from this list, not from the request. The service sends
  requests only to public addresses, so an origin that resolves to a
  private, loopback, or link-local address also gets HTTP 403. The stats
  of the run count the refused requests by origin, in `refused.notAllowed`
  and `refused.notPublic`. The run report shows them after `Refused:`, so
  look there first when requests fail with HTTP 403. A tunnel to a port
  other than 443 shows as `host:port`. The stats name 32 origins for each
  reason, and count the others as `other origins`.
- `rules`: the traffic to record. `name` uses letters, digits, `_`, `.`,
  and `-`. `match` has `method`, `url`, and `headers`. `url` is a prefix,
  or a list of 1 to 32 prefixes. A URL that starts with one of them
  matches. Use a list when the same API is on many hosts, such as one
  rule with the same `values` for Anthropic, OpenRouter, and OpenAI. The
  key does not use `match`, so a change to `url` keeps the keys. When you
  merge rules into one rule, some keys get a new rule name, so their
  requests record again one time. `keyHeaders` adds request headers to
  the key. `values` names the values that change from run to run. A run
  can have 64 rules, and a rule can have 32 values.
- Credentials: the proxy never writes the `secrets` of the service config
  or of the run. Use `secrets` of the run for the credentials of a CI job
  that a response can show but no request header has, such as a token that
  goes to a model in a prompt. The service keeps them only in memory, for
  the run. A run can have 32 of them. It also learns the value of each request header and query parameter whose name can mean a credential,
  such as one with `auth`, `token`, `key`, `secret`, `cookie`, or `session`.
  The match is broad on purpose. It does not learn `x-session-affinity`,
  because that header has a conversation id and not a credential.
  Recordings show `<<redacted>>` in place of each known value. A request
  sample and the text of a miss in Sentry also show `<<redacted>>` for the
  value of each such query parameter, at any length (see [Misses](#misses)).

Requests that match no rule go live without a change, and their responses
stream. Each response has an `x-roach` header: `replayed`, `live`,
`missed`, or `passthrough`.

## Recordings

The key of a recording is `<rule>/<hash>.json`, under `<tenant>/` in the
store. The hash is the hash of the rule name, the method, the URL, the key
headers, and the body. A JSON body has sorted keys. A recording keeps the
response and the session that recorded it. It does not keep the request
body. A request sample keeps it. See [Misses](#misses).

- Many sessions can be open at once. A request belongs to the session of
  its proxy URL (`url` of the session). A request through the proxy URL of
  the run belongs to the open session when only one is open. The proxy
  keeps the new recordings of a session in memory. A passed session writes them, and a failed session
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
first miss of each test, which is the one to fix. The run report of the
vitest integration and of the GitHub Action shows these misses.

The proxy also finds where the first miss of each session changed
(`misses.ts`). Sentry gets the text of the change, on the `roach.request`
span of the miss (see [Sentry](#sentry)). The report of a run with the
write token tells only where the change is:

```text
- a.fixture.ts > passes: model/074d….json
  Changed at character 65 of the request of model/8b96….json. See miss.recorded and miss.request on the roach.request span in Sentry.
```

The report goes to CI logs and job summaries, and these can be public. So
no report, log, or stats of a run show the text of a request. Only Sentry
shows it.

- When the proxy records a request, it also writes a request sample to
  `_requests/<rule>/<hash>.json`. The sample has the text that the key
  hashes: the rule, the method, the URL, the key headers, and the body
  with `<<name>>` for each changing value. The proxy redacts credentials
  in it, as in a recording, and the value of each credential query
  parameter. It keeps the first 1,048,576 characters (UTF-16 code units)
  of the text.
- The hash of a sample is the place of the request: its session (test)
  and the number of requests of the rule that the session sent before
  it. So a sample is the last recorded request at the same place of the
  same test. A replay writes no sample.
- At the first miss of a session, the proxy reads the sample of the place
  of the request. It finds the first character that is not the same.
  Sentry gets 40 characters before it, and at most 120 characters from it,
  of each text. This is one read for each session, in every run.
- Sentry gets the change of every run, with or without the token. So find
  the change of a miss of a fork in Sentry.
- Only runs with the write token get `change` in their stats and report.
  It has the key of the recording that the sample came from (`file`), and
  the offset (`at`). It has no text. A run without the token, such as CI of
  a fork, gets no `change`. Reads are public, and the offset of the first
  change would let anyone guess the requests of a tenant back, one
  character at a time.
- A miss has no change when there is no sample, such as for a recording
  from an older version, or when the texts are the same in the part that
  the sample keeps.
- When the requests of a test run in parallel, their order can change.
  Then a sample can come from another request of the test.

## Find changing values

Do this check when you add Roach to a project. Do it again when a test
that passed does not replay on the next run.

A value that changes on each run and that no pattern finds gives a new key
on each run. In `auto` mode, that request goes live and records again on
each run. The run is slow, and it costs as much as a run without Roach.
The requests after it in the test also go live, because the live response
is not the same as the recorded one. No error shows this. The tests pass.

1. Run the suite two times with the token. On the second run, each test
   that passed must replay all of its requests. Look at `live` in the stats
   of the second run. It must be 0, or near 0. In CI, also compare the
   time of each test. A test that replays takes about as long as its code
   without the network. [`TELEMETRY.md`](TELEMETRY.md) shows how to find
   the runs and keys that stay live.
2. Find the first live request of a test that did not replay. Run only
   that test with `ROACH_MODE=replay`. It needs no token. The test fails
   at the first miss, and the run report shows its key. Fix the first miss
   of a test before the others. The others often come from it.
3. Find the `roach.request` span of the first miss in Sentry, by its `run`
   and `has:miss.changed_at`. Read `miss.recorded` and `miss.request`. See
   [Misses](#misses) and [`TELEMETRY.md`](TELEMETRY.md). They show the
   changing value, with the text before it. This works for every run, with
   or without the token. When the miss has no change, get the body of that
   request from two runs, and compare them. For example, add this file to `setupFiles`
   after `@sentry/roach/vitest/setup`, and run the test two times:

   ```ts
   // Local only. Writes each fetch request to DUMP_FILE.
   import { appendFileSync } from "node:fs";
   import { expect } from "vitest";

   const dumpFile = process.env.DUMP_FILE ?? "requests.jsonl";
   const fetchBefore = globalThis.fetch;
   globalThis.fetch = async (input, init) => {
     const request = new Request(input, init);
     const record = {
       test: expect.getState().currentTestName,
       method: request.method,
       url: request.url,
       body: await request.clone().text(),
     };
     appendFileSync(dumpFile, JSON.stringify(record) + "\n");
     return fetchBefore(request);
   };
   ```

   The first difference between the two bodies is the changing value.
   This file sees only `fetch`. A client that uses `node:http` directly
   needs its own hook.

4. Add a narrow pattern for the value to `values` of the rule. See
   [Changing values](#changing-values). Then do step 1 again.

Values that changed in real projects:

- Ids that the code under test makes, such as UUIDs and random short ids.
  For example, Warden gives each finding a random `XXX-XXX` id, and the
  next model request quotes it.
- Paths of temporary directories, commit SHAs of a repository that a test
  makes, and times and dates.
- The local environment. Global git config, such as a hook that adds a
  commit trailer, commit signing, or `user.name`, changes the commits that
  a test makes. `HOME`, the user name, the locale, and the time zone can
  also show in a request. Then local keys are not the same as CI keys, so
  a local `replay` misses while CI replays. Make the test harness ignore
  them. For git, set `GIT_CONFIG_GLOBAL=/dev/null` and
  `GIT_CONFIG_NOSYSTEM=1`, and set the author and committer in the test.
- Order. The proxy sorts JSON object keys, but not arrays. An array whose
  order depends on timing, such as the results of parallel tool calls,
  gives a new key when the order changes.

## Service

`packages/service/src/cli.ts service <config.json>` starts the service. The
config is `RoachServiceConfig` in `packages/service/src/service.ts`. `deploy/gcp/` writes it for you.

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
  refuses a request that no rule records, so nothing goes live. The stats
  count these requests in `refused.replayOnly`. Every other mode needs
  the write token. So treat each recording as readable by anyone who can
  make its request. Do not record responses that must stay private. Only
  runs with the write token get the change of a miss in their stats, and
  only its offset (see [Misses](#misses)). So CI of a fork does not show
  it. Sentry shows it.
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
  `origin`, `rule`, `result`, and `http.response.status_code`. When a
  replayed or live response has token usage, the span also has the
  `gen_ai` attributes of the model call (`usage.ts`). Sentry then
  calculates its cost in USD as `gen_ai.cost.total_tokens`. The span of
  the first miss of a session also has `miss.sample` (`found` or `none`),
  in every run. When the proxy finds a change, the span also has
  `miss.changed_at` (the offset of the first different character),
  `miss.compared` (the key of the recording), and the redacted text of the
  change: `miss.recorded` and `miss.request`. Only Sentry gets these
  texts ([Misses](#misses)). It contains:
  - `roach.key`: the key of the request, with `rule` and `key`.
  - `roach.store.read`: a read of a recording, with `key` and `result`:
    `hit` or `miss`. The first miss of a session also reads a request
    sample. Its `key` starts with `_requests/`.
  - `roach.upstream`: the live request, with `origin` and
    `http.response.status_code`.
- `roach.store.write`: a write of recordings, with `recordings` and
  `written`. A session writes when it ends, so this span is usually its
  own trace. A second span writes the request samples of the same
  recordings.

Telemetry never has a credential. It has no body and no path or query of
a URL, except `miss.recorded` and `miss.request`. These have at most 160
characters of the redacted text of a request, which can include a part of
its URL, headers, or body. The log of the service names only the key of a
miss, not its change.
From a model call, it has only the model name and the token counts.
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
  and passes the raw TCP stream, with `CONNECT`, to the VM,
- a service account for the `Deploy` workflow, which GitHub Actions uses
  through workload identity federation (`deploy.tf`). It can only reset
  the VM.

The `Image` workflow builds the image on each pull request and pushes it as
`:<sha>` on `main`. The VM pulls `:main` at each start.

The `Deploy` workflow deploys `main` when it is green. After the `Image`
workflow of a commit on `main`, it waits for `CI` of the same commit. When
both pass and the commit is still the head of `main`, it moves `:main` to
`:<sha>`, resets the VM, and waits until the service answers. A reset ends
the open runs, so their CI jobs fail. A red commit does not deploy, and an
older commit never replaces a newer one.

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
8. Let the `Deploy` workflow reset the VM. Set two variables of the
   repository from the outputs. Until they are set, the workflow only
   moves `:main`, and the VM gets it at its next start:

   ```sh
   gh variable set GCP_WORKLOAD_IDENTITY_PROVIDER --repo getsentry/roach \
     --body "$(terraform output -raw deploy_workload_identity_provider)"
   gh variable set GCP_DEPLOY_SERVICE_ACCOUNT --repo getsentry/roach \
     --body "$(terraform output -raw deploy_service_account)"
   ```

   Another deployment also changes `deploy_repository` and
   `deploy_repository_id` in its tfvars, and the `env` of
   `.github/workflows/deploy.yml`.

To deploy by hand, restart the VM:
`gcloud compute instances reset roach --zone <zone>`. It pulls `:main`,
the last green commit.

To add a project, add its repository to the repositories of the
`ROACH_TOKEN` organization secret, in the GitHub settings of the
organization. Its CI jobs set `tenant` to `GITHUB_REPOSITORY`, and send
their own origins and patterns. The service needs no change.

To change the write token, run
`terraform apply -var-file=roach.tfvars -replace=random_password.write_token`,
set the secret again, and restart the VM.

## Command line

```sh
node packages/service/src/cli.ts service <config.json>
```

It starts the service and prints its URL as one JSON line.

## Control API

The calls of a run are under `/__roach/runs/<id>`. They need
`Authorization: Bearer <run token>`. `client.ts` calls them.

- `POST /session` with `{"name": "..."}`: open a session. Returns
  `{"url": "..."}`, the proxy URL of the session. Its user is
  `<run id>-<session id>`. An open session with the same name fails
  first. A run can have 64 open sessions. Another one gets HTTP 429. A
  service before 0.2.0 returns no URL. Then `client.ts` fails and tells
  you to deploy a newer service.
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
- publishes `@sentry/roach` to npm: the tarball that the `package` job of
  `CI` uploads for the release commit. Craft publishes only
  `sentry-roach-<version>.tgz`, and CI makes sure that it has `LICENSE` and
  `README.md` (`.github/scripts/check-tarball.sh`). On the release branch, Craft runs
  `.github/scripts/bump-version.sh`, which writes the version to
  `packages/roach/package.json`. The workspace root and `packages/service`
  are private and have no version.

The action runs `packages/roach/src/action.ts` from the tag, and the
package has the sources, so a release has no build step.

Craft takes the last version from the newest `v<version>` tag in the
history of `main`. Do not rewrite `main`, or the tag leaves its history and
Craft bumps from 0.0.0. The workflow deletes the floating `v<major>` tags in
its checkout first (`.github/scripts/drop-floating-tags.sh`), because
`git describe` picks them over the release tag on the same commit.

The `Release` workflow uses the token of Sentry Release Bot. A push with
`GITHUB_TOKEN` starts no workflows, so the release branch gets no checks and
no image, and Craft cannot publish it.

## Development

```sh
pnpm install
pnpm check   # format, lint, types, unused code, and tests, as CI runs them
```

`AGENTS.md` has the conventions and the commands for one file.

- `packages/service/tests/recording.test.ts` tests modes, sessions, changing values, and
  misses.
- `packages/service/tests/service.test.ts` tests the service in the test process.
- `packages/service/tests/vitest.test.ts` runs vitest with the integration on a small
  project, against a service in the test process.
- `packages/service/tests/deployed.test.ts` runs the service as it runs in production: from
  the command line, behind a TLS server that does what the load balancer
  does, with a local GCS server, metadata server, and Sentry server. Each
  CI job runs the GitHub Action, and its command has only the proxy
  variables of its run.

## Files

The repository is a pnpm workspace with two packages. The root package is
private and has only the tools: oxlint, oxfmt, TypeScript, vitest, and knip.
`pnpm-workspace.yaml` has the catalog of the versions that the packages
share. The production setup is in `deploy/gcp/` and `Dockerfile`.

- `packages/roach` is the npm package `@sentry/roach`: the client, the
  vitest integration, and the action. It has no runtime dependencies, and it
  ships only `src/`. `tests/package.test.ts` fails when an export or the
  action loads a package that is not a Node built-in or vitest.
- `packages/service` is the private package `@sentry/roach-service`: the
  shared service and the proxy. It imports `@sentry/roach` as a workspace
  package (`workspace:*`). It is the only package that depends on
  `@sentry/node`. Its tests run the client, the vitest integration, and the
  action against a real service.

In `packages/roach/src/`:

- `types.ts`: rules, modes, runs, sessions, and the results of a run.
- `values.ts`: changing values and their placeholders.
- `client.ts`: starts a run and calls the control API.
- `config.ts`: `roach.json`, for the action and vitest.
- `vitest.ts`: the vitest global setup: one run for each invocation.
- `vitest-setup.ts`: the vitest setup file: one session for each test.
- `report.ts`: text reports of a run.
- `action.ts`: the GitHub Action (`action.yml` at the root).

In `packages/service/src/`:

- `service.ts`: the shared service: tenants, runs, access, and metrics.
- `cli.ts`: the command line, which the image runs.
- `server.ts`: sockets, HTTPS interception, the allow list, and the control
  API.
- `addresses.ts`: the public addresses that the proxy can send requests to.
- `recorder.ts`: modes, sessions, replay, and misses.
- `request-key.ts`: the key of a request.
- `misses.ts`: request samples and the first change of a miss.
- `store.ts`: the formats of recordings and request samples, and the
  store contract.
- `recordings.ts`: the file store, for tests and development.
- `gcs.ts`: the GCS store.
- `streams.ts`: merges the deltas of a recorded model stream.
- `usage.ts`: the token usage of a model response, for Sentry.
- `secrets.ts`: redaction of credentials.
- `certificates.ts`: the certificate authority for HTTPS.

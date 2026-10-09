# Roach

Roach is a recording HTTP proxy for tests. It records chosen requests and
replays them, so a second run of a test suite makes no live calls. The
proxy owns every read and write of the recordings. A test runner only gives
it rules and tells it when each test starts and ends.

The recordings are in one of two stores:

- **Files** (`directory`): JSON files that you commit to git.
- **A Roach Worker** (`store`): a Cloudflare Worker with R2 and D1. Many
  repositories and CI runs can use it. It deletes recordings that nobody
  used for 30 days. See [Worker](#worker).

The proxy always runs in the process tree of the test run. Only the
recordings move to the Worker.

Roach started in
[`getsentry/junior`](https://github.com/getsentry/junior/tree/main/packages/junior-evals/src/roach).
The proxy uses only Node built-ins and the `openssl` command.

## Use

```ts
import { spawnRoach, connectRoach } from "@sentry/roach/client";
import { describeRecordingStats } from "@sentry/roach/report";
import { VALUE_PATTERNS } from "@sentry/roach/values";

// Once per run.
const proxy = await spawnRoach({
  directory: "recordings",
  mode: "auto",
  allow: ["https://ai-gateway.vercel.sh"],
  rules: [
    {
      name: "model",
      match: { method: "POST", url: "https://ai-gateway.vercel.sh/" },
      keyHeaders: ["ai-model-id"],
      values: { uuid: VALUE_PATTERNS.uuid, time: VALUE_PATTERNS.isoTime },
    },
  ],
});
spawn("vitest", { env: { ...process.env, ...proxy.env } });

// Once per test, in a worker that has the `url` and `token` of the proxy.
const session = await connectRoach({ url, token }).startSession(testName);
const { missed } = await session.end(passed);
// In `replay` mode, fail the test when `missed` is not 0.

// At the end of the run.
console.log(describeRecordingStats(await proxy.stats()));
await proxy.close();
```

- `proxy.env` has `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`,
  `NODE_USE_ENV_PROXY`, and `NODE_EXTRA_CA_CERTS`. Node 24 reads the last two
  only at startup. A process that is already running must set its own
  agents.
- `spawnRoach(config, { launcher })` runs the proxy with a command
  prefix, such as `sudo`. Use it when the caller cannot reach the network,
  but the proxy must.

## Config

`src/types.ts` has the full types.

- `directory`: where the recordings are. Each rule has a subdirectory.
- `store`: `{ url, token }` of a Roach Worker, in place of `directory`.
  Set one of the two. The proxy calls the Worker directly, and never writes
  the token to a recording.
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
`messages[3]`. For a request without a recording, the proxy finds the
recording with the most equal parts, from the same session if it can. It
logs the parts that differ and adds the miss to `stats().misses`.
`describeRecordingMisses()` in `report.ts` gives the first miss of each
test, which is the one to fix.

- The file store reads all recordings of a rule on the first miss of that
  rule in a run, and then keeps them in memory.
- The Worker keeps the hash of each part in a D1 index. A miss is one
  query that reads only the rows with an equal part. It does not read the
  recordings in R2.

## Command line

```sh
node --experimental-strip-types src/cli.ts serve < config.json
node --experimental-strip-types src/cli.ts prune <directory> <used-file>...
```

`serve` prints the address of the proxy as one JSON line. `client.ts` runs
it. `prune` deletes the recordings that no used file lists. Give it the used
files of every run that shares the directory, or it deletes recordings that
another run needs.

## Control API

All calls need `Authorization: Bearer <token>`. `client.ts` calls them.

- `POST /__roach/session` with `{"name": "..."}`: open a session.
- `POST /__roach/session/end` with `{"name": "...", "passed": true}`:
  end it. Returns `{"missed": 0}`, the misses that `replay` mode failed.
  Returns HTTP 409 when the session is not open.
- `GET /__roach/stats`: the totals of the run.

## Worker

`worker/` is a Cloudflare Worker that keeps recordings for many proxies.
`wrangler.jsonc` is its config.

- **R2** (`RECORDINGS`) keeps each recording at `<tenant>/<key>`.
- **D1** (`DB`) keeps one row for each recording: its rule, its session,
  the time of its last use, and the hash of each request part.
- **Tenants**: each tenant has a token. The secret `ROACH_TENANTS` maps
  each tenant name to the SHA-256 hex of its token. A tenant sees only its
  own recordings. Give each repository its own tenant. Tenants do not
  share recordings, because a key does not include credentials: a shared
  key would replay one tenant's private response to another.
- **Expiry**: a replay or a write sets the time of last use. A replay
  writes to D1 at most once a day for each recording. Once a day, the cron
  trigger deletes recordings that nobody used for `RECORDING_TTL_DAYS`
  (30). It deletes up to 10,000 in each run.

### Set up

```sh
pnpm exec wrangler r2 bucket create roach-recordings
# Add a backstop for objects that lost their D1 row (see Limits).
pnpm exec wrangler r2 bucket lifecycle add roach-recordings backstop --expire-days 180
pnpm exec wrangler d1 create roach    # put the database_id in wrangler.jsonc
# Each tenant token is a random secret. Keep only its hash in the Worker.
token=$(openssl rand -hex 32); hash=$(printf %s "$token" | sha256sum | cut -d' ' -f1)
printf '{"junior":"%s"}' "$hash" | pnpm exec wrangler secret put ROACH_TENANTS
pnpm worker:deploy   # apply D1 migrations, then deploy
```

Then give the proxy `store: { url: "https://roach.<account>.workers.dev",
token }`. Keep the token in a CI secret.

### Routes

All routes need `Authorization: Bearer <token>`. `src/remote-store.ts`
calls them.

- `GET /v1/recordings/<key>`: the recording, or HTTP 404.
- `PUT /v1/recordings/<key>` with the recording: write it. Returns
  `{"changed": true}` when it was new or changed. A body over 10 MiB gets
  HTTP 413.
- `POST /v1/closest` with `{"rule", "parts", "session"}`: returns
  `{"closest": {"key", "differs"}}`, or `{"closest": null}`.

A bad token gets HTTP 401. A bad key or body gets HTTP 400.

### Limits

- A write puts the R2 object first, then the D1 row. If D1 fails, the
  object has no row, so the cron trigger cannot delete it. The R2
  lifecycle rule above deletes it later.
- A tenant can write as many recordings as it wants. There is no quota.
- To add or remove a tenant, change `ROACH_TENANTS`.

### Run it locally

```sh
cp .dev.vars.example .dev.vars   # the tenant "local" with token "local-token"
pnpm exec wrangler d1 migrations apply DB --local
pnpm worker:dev
```

`tests/worker.test.ts` runs the Worker from `wrangler.jsonc` with local R2
and D1 (`createTestHarness` of Wrangler). It tests record and replay
through a real proxy, misses, tenants, limits, and expiry.

## Development

```sh
pnpm install
pnpm check   # format, lint, types, unused code, and tests, as CI runs them
```

`AGENTS.md` has the conventions and the commands for one file.

## Files

The proxy is in `src/`. The Worker is in `worker/`. Tests are in `tests/`.

- `types.ts`: the configuration and the results.
- `server.ts`: sockets, HTTPS interception, the allow list, and the control
  API.
- `recorder.ts`: modes, sessions, replay, and misses.
- `request-key.ts`: the key and the part hashes of a request.
- `store.ts`: the recording format and the store contract.
- `recordings.ts`: the file store and prune.
- `remote-store.ts`: the store that calls the Worker.
- `parts.ts`: compares the parts of requests for miss diagnosis.
- `values.ts`: changing values and their placeholders.
- `streams.ts`: merges the deltas of a recorded model stream.
- `certificates.ts`: the certificate authority for HTTPS.
- `client.ts`: starts the proxy in its own process and calls its control
  API.
- `report.ts`: text reports of a run.
- `cli.ts`: the command line.
- `worker/index.ts`: the Worker. `worker/migrations/` has the D1 schema.

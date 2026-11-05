# Telemetry

Use this file to answer questions about Roach from its Sentry data. Examples:
"how many requests replayed?", "why does this run miss?", and "how much time
do recordings save?". "Sentry" in `README.md` lists the metrics, spans, and
errors. The code in `packages/service/src/service.ts` and
`packages/service/src/recorder.ts` is authoritative.

## Where To Query

- Org: `sentry`. Project: `roach` (id `4512346152763392`).
- Each tenant is the repository of its runs, such as `getsentry/junior`.
- Use metrics for counts and rates.
- Use spans to find one run, CI job, test, key, or request.
- Use errors (issues) for failures of the upstream, of GCS, and of the
  service. A miss or a refused request is not an error.

## Sampling

The service sends all spans and metrics (`tracesSampleRate: 1`). But
`sentry explore` reads a downsampled tier, and it multiplies the counts. For
spans, it reads about 1 in 64. For metrics, it reads about 1 in 8. So a small
count, such as `roach.result:missed`, can be wrong by a lot. Use
`sentry explore` for rates and trends.

For an exact count, call the API with `sampling=HIGHEST_ACCURACY`:

```bash
sentry api organizations/sentry/events/ -f dataset=spans -f project=4512346152763392 \
  -f statsPeriod=24h -f sampling=HIGHEST_ACCURACY \
  -f 'query=span.op:roach.request' -f field=roach.result -f 'field=count()'
```

For metrics, use `-f dataset=tracemetrics`,
`-f 'query=metric.name:roach.request'`, and
`-f 'field=sum(value,roach.request,counter,none)'`.

## Words

- **Replayed**: the response came from a recording. Nothing went upstream.
- **Live**: the request went upstream. In `auto` mode, this makes a new
  recording. In `record` mode, every request is live.
- **Missed**: `replay` mode had no recording, and the request failed with
  HTTP 412. On a `roach.store.read` span, `missed` means only that the store
  had no recording. In `auto` mode, the request then goes live.
- **Passthrough**: no rule matched, and the request went upstream. Roach
  does not record it. It is also live traffic, but it is not part of the hit
  rate.
- **Refused**: the proxy sent the request nowhere and answered HTTP 403.
  `roach.reason` tells why: `notAllowed` (the origin is not in `allow`),
  `notPublic` (the address is not public), or `replayOnly` (a run without
  the token, and no rule records the request).
- **Busy**: the body of a run without the token did not fit in the
  budget of bodies, and the proxy answered HTTP 503 with `Retry-After`.
  The run goes on, and the client can send the request again.
- **Timeout**: the body of a run without the token did not come in 30 s,
  and the proxy answered HTTP 408.
- **Dropped**: a live response was recorded, but its session failed, so the
  recording was not written. The next run sends the request live again.

## Pivots

| Pivot                       | Meaning                                    | Found In                          |
| --------------------------- | ------------------------------------------ | --------------------------------- |
| `roach.tenant`              | repository of the run                      | metrics, spans, errors            |
| `roach.mode`                | `auto`, `replay`, `record`                 | metrics, spans, errors            |
| `roach.rule`                | recording rule, such as `model`            | metrics, spans                    |
| `roach.result`              | `replayed`, `live`, and others (see Words) | metrics, spans                    |
| `roach.origin`              | upstream origin                            | metrics, spans                    |
| `roach.reason`              | why the proxy refused a request            | `roach.request`                   |
| `roach.run.id`              | `name` of the run, else the service id     | spans, errors                     |
| `roach.ci.run_id`           | `GITHUB_RUN_ID` of the run                 | spans, errors                     |
| `roach.ci.job`              | `GITHUB_JOB` of the run                    | spans, errors                     |
| `roach.ci.repo`             | `GITHUB_REPOSITORY` of the run             | spans, errors                     |
| `roach.ci.ref`              | `GITHUB_REF` of the run                    | spans, errors                     |
| `roach.session`             | session (test) name of a request           | `roach.request`                   |
| `roach.key`                 | recording key of a request                 | `roach.key`, `roach.store.read`   |
| `roach.write`               | the run has the write token (boolean)      | `roach.run.start`                 |
| `http.response.status_code` | status to the client                       | `roach.request`, `roach.upstream` |
| `gen_ai.request.model`      | model of a model call                      | `roach.request`                   |
| `miss.sample`               | `found`, `withheld`, or `none` for a miss  | `roach.request`                   |
| `miss.changed_at`           | offset of the change of a miss             | `roach.request`                   |
| `miss.compared`             | recording key of a miss change             | `roach.request`                   |
| `miss.recorded`             | recorded text of a miss change             | `roach.request`                   |
| `miss.request`              | sent text of a miss change                 | `roach.request`                   |

A metric for a `notAllowed` request has `roach.origin:other`, because the
client picks that origin. Its span has the origin.

A filter on a boolean or a number attribute needs its type, such as
`tags[roach.write,boolean]:true` or `tags[roach.missed,number]:>0`.

Data from before this naming has the same attributes without `roach.`
(`tenant`, `mode`, `rule`, `result`, `origin`, `key`, `write`, `recordings`,
`written`), and `run` in place of `roach.run.id`. Its `roach.store.read`
spans have `result` `hit` and `miss`.

## Query Recipes

The examples use the `sentry` CLI. The same fields work in Explore. The
counts are estimates (see [Sampling](#sampling)).

Cached and uncached requests by rule. The hit rate of a rule is
`replayed / (replayed + live + missed)`. Do not count `passthrough`,
`refused`, `busy`, or `timeout`.

```bash
sentry explore sentry/roach --dataset metrics --metric roach.request --agg sum \
  --period 24h -q 'roach.tenant:getsentry/junior' -F roach.mode -F roach.rule \
  -F roach.result
```

Uncached traffic that no rule records, by origin. A large count here is
traffic that the evals send live on each run.

```bash
sentry explore sentry/roach --dataset metrics --metric roach.request --agg sum \
  --period 24h -q 'roach.result:passthrough' -F roach.origin
```

Refused requests, by reason and origin.

```bash
sentry explore sentry/roach --dataset metrics --metric roach.request --agg sum \
  --period 24h -q 'roach.result:refused' -F roach.tenant -F roach.reason \
  -F roach.origin
```

Requests of runs without the token that the budget of bodies stopped
(`busy`, HTTP 503) or that were too slow (`timeout`, HTTP 408), by tenant.
A steady count of `busy` from many tenants shows that the budget is too
small. A count from one tenant shows one client that fills its part.

```bash
sentry explore sentry/roach --dataset metrics --metric roach.request --agg sum \
  --period 24h -q 'roach.result:[busy,timeout]' -F roach.tenant -F roach.result
```

Time saved by a replay. Compare `live` and `replayed` for each rule. Use
`--agg p95` for the slow tail.

```bash
sentry explore sentry/roach --dataset metrics --metric roach.request.duration \
  --agg p50 --period 24h -F roach.rule -F roach.result
```

Recordings written and dropped. A high `dropped` count means that failed
tests send the same live requests again on the next run.

```bash
sentry explore sentry/roach --dataset metrics --metric roach.recording.write \
  --agg sum --period 24h -F roach.rule -F roach.result
```

Runs with the most live requests. When the same tests stay live from run to
run, a value in the key changes on each run. Then look at the keys of one run.
"Find changing values" in `README.md` shows how to find the value.

```bash
sentry explore sentry/roach --dataset spans --period 24h \
  -q 'span.op:roach.request roach.result:live' -F roach.run.id -F 'count()' \
  -s '-count()'
```

Tests with misses. A miss in `replay` mode fails the test.

```bash
sentry explore sentry/roach --dataset spans --period 24h \
  -q 'span.op:roach.request roach.result:missed' -F roach.ci.repo \
  -F roach.ci.job -F roach.session -F 'count()' -s '-count()'
```

The totals of each run, from its end. Use this to find runs with misses.

```bash
sentry explore sentry/roach --dataset spans --period 24h \
  -q 'span.op:roach.run.end tags[roach.missed,number]:>0' -F roach.run.id \
  -F roach.ci.job -F roach.ci.ref -F 'sum(tags[roach.missed,number])' \
  -F 'sum(tags[roach.live,number])' -F 'sum(tags[roach.replayed,number])'
```

Where the requests of misses changed, and what changed. The same
`miss.changed_at` from run to run shows one value that changes on each
run. `miss.recorded` and `miss.request` show that value. `miss.sample:none`
is a miss that has no recorded request to compare with.
`miss.sample:withheld` is a miss whose recorded request had a credential
that the proxy could not redact, so its sample has no text. This works for
runs without the token too, such as CI of a fork. Only Sentry has these
texts: the run report shows only the offset and the key, because CI logs
can be public.

```bash
sentry explore sentry/roach --dataset spans --period 24h \
  -q 'span.op:roach.request has:miss.sample' -F roach.tenant -F roach.rule \
  -F roach.run.id -F miss.sample -F miss.changed_at -F miss.recorded \
  -F miss.request -F 'count()' -s '-count()'
```

Upstream errors. A live response with a temporary status is not recorded.

```bash
sentry explore sentry/roach --dataset spans --period 24h \
  -q 'span.op:roach.upstream' -F roach.origin \
  -F http.response.status_code -F 'count()'
```

Runs by mode, and how many have the write token.

```bash
sentry explore sentry/roach --dataset spans --period 24h \
  -q 'span.op:roach.run.start' -F roach.mode -F 'count()'
sentry explore sentry/roach --dataset spans --period 24h \
  -q 'span.op:roach.run.start tags[roach.write,boolean]:true' -F roach.tenant \
  -F 'count()'
```

Unexpected failures, such as a failed GCS call. The client got HTTP 502 or
500 and the id of the event. Search for the id, or list the issues.

```bash
sentry issue list sentry/roach
sentry explore sentry/roach --period 24h -q 'roach.tenant:getsentry/junior' \
  -F title -F 'count()'
```

## Cost

A `roach.request` span of a model call has its token usage as `gen_ai`
attributes. Sentry calculates the cost from them and its own price of the
model: `gen_ai.cost.total_tokens`, in USD. Roach has no prices.

- `roach.result:live` is money that the runs spent.
- `roach.result:replayed` is money that the recordings saved. A replay has
  the usage of its recording.
- A model that Sentry has no price for has tokens, but no cost.

Spent and saved, by rule and model.

```bash
sentry explore sentry/roach --dataset spans --period 24h \
  -q 'span.op:roach.request has:gen_ai.usage.input_tokens' \
  -F roach.result -F roach.rule -F gen_ai.request.model \
  -F 'sum(gen_ai.cost.total_tokens)' -F 'sum(gen_ai.usage.input_tokens)' \
  -F 'sum(gen_ai.usage.output_tokens)' -F 'count()'
```

Money that failed tests wasted. A dropped recording was a paid live call,
and the next run makes it again. Compare `roach.recording.write` with
`roach.result:dropped` to the cost of `roach.result:live`.

## Limits

- Metrics have only `roach.tenant`, `roach.mode`, `roach.rule`,
  `roach.origin`, `roach.result`, and `roach.reason`. Use spans for the
  run, the CI job, the session, and the key.
- Telemetry never has a credential. It has no body and no path or query
  of a URL, except the change of a miss. From a model call, it has only
  the model name and the token counts. Spans have the test name
  (`roach.session`). You see the prompt only around the change of a miss.
- The `roach.request` span of the first miss of a session has
  `miss.sample`. When the proxy finds a change, it also has
  `miss.changed_at`, `miss.compared`, `miss.recorded`, and `miss.request`.
  The two texts have at most 160 characters each, redacted as in a
  recording, with the value of each credential query parameter redacted.
  Every run sends them, with or without the token. No stats, report, or
  log has the texts. The stats and report of a run with the token have
  only the offset and the key ("Misses" in `README.md`).
- `roach.store.read` spans with a `roach.key` that starts with
  `_requests/` read a request sample, not a recording. Leave them out of a
  hit rate of `roach.store.read`. Each write of recordings has a second
  `roach.store.write` span for their samples. The `roach.recording.write`
  metric does not count samples.
- An error event has the message of the error. The message can have the
  body of a GCS response. Only Sentry gets it. The client gets only the id
  of the event. The service log gets the id, the class, and the HTTP status
  of the error.
- An error of the control API, such as a failed write at the end of a
  session, has no `roach.*` tags.
- Cost is on spans only, not on metrics.

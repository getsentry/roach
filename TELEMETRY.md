# Telemetry

Use this file to answer questions about Roach from its Sentry data. Examples:
"how many requests replayed?", "why does this run miss?", and "how much time
do recordings save?". "Sentry" in `README.md` lists the metrics and spans.
The code in `src/service.ts` and `src/recorder.ts` is authoritative.

## Where To Query

- Org: `sentry`. Project: `roach` (id `4512346152763392`).
- Each tenant is the repository of its runs, such as `getsentry/junior`.
- Use metrics for counts and rates. Metrics are not sampled.
- Use spans to find one run, key, or request. The service keeps all traces.

## Words

- **Replayed**: the response came from a recording. Nothing went upstream.
- **Live**: the request went upstream. In `auto` mode, this makes a new
  recording. In `record` mode, every request is live.
- **Missed**: `replay` mode had no recording, and the request failed with
  HTTP 412.
- **Passthrough**: no rule matched, and the request went upstream. Roach
  does not record it. It is also live traffic, but it is not part of the hit
  rate.
- **Dropped**: a live response was recorded, but its session failed, so the
  recording was not written. The next run sends the request live again.

## Pivots

| Pivot                       | Meaning                         | Found In         |
| --------------------------- | ------------------------------- | ---------------- |
| `tenant`                    | repository of the run           | metrics, spans   |
| `mode`                      | `auto`, `replay`, `record`      | metrics, spans   |
| `rule`                      | recording rule, such as `model` | metrics, spans   |
| `result`                    | `replayed`, `live`, and others  | metrics, spans   |
| `tags[origin,string]`       | upstream origin                 | metrics, spans   |
| `run`                       | run name, such as a CI run      | spans only       |
| `key`                       | recording key of a request      | `roach.key` span |
| `http.response.status_code` | status to the client            | `roach.request`  |

`origin` is also a built-in Sentry field. A query on `origin` gives the span
origin (`manual`) or nothing. Use `tags[origin,string]`.

## Query Recipes

The examples use the `sentry` CLI. The same fields work in Explore.

Cached and uncached requests by rule. The hit rate of a rule is
`replayed / (replayed + live + missed)`. Do not count `passthrough`.

```bash
sentry explore sentry/roach --dataset metrics --metric roach.request --agg sum \
  --period 24h -q 'tenant:getsentry/junior' -F mode -F rule -F result
```

Uncached traffic that no rule records, by origin. A large count here is
traffic that the evals send live on each run.

```bash
sentry explore sentry/roach --dataset metrics --metric roach.request --agg sum \
  --period 24h -q 'result:passthrough' -F 'tags[origin,string]'
```

Time saved by a replay. Compare `live` and `replayed` for each rule. Use
`--agg p95` for the slow tail.

```bash
sentry explore sentry/roach --dataset metrics --metric roach.request.duration \
  --agg p50 --period 24h -F rule -F result
```

Recordings written and dropped. A high `dropped` count means that failed
tests send the same live requests again on the next run.

```bash
sentry explore sentry/roach --dataset metrics --metric roach.recording.write \
  --agg sum --period 24h -F rule -F result
```

Runs with the most live requests. When the same tests stay live from run to
run, a value in the key changes on each run. Then look at the keys of one run.

```bash
sentry explore sentry/roach --dataset spans --period 24h \
  -q 'span.op:roach.request result:live' -F run -F 'count()' -s '-count()'
```

Runs with misses. A miss in `replay` mode fails the test.

```bash
sentry explore sentry/roach --dataset spans --period 24h \
  -q 'span.op:roach.request result:missed' -F run -F 'count()' -s '-count()'
```

Upstream errors. A live response with a temporary status is not recorded.

```bash
sentry explore sentry/roach --dataset spans --period 24h \
  -q 'span.op:roach.upstream' -F 'tags[origin,string]' \
  -F http.response.status_code -F 'count()'
```

Number of runs by mode.

```bash
sentry explore sentry/roach --dataset spans --period 24h \
  -q 'span.op:roach.run.start' -F mode -F 'count()'
```

## Cost

Roach does not report tokens or money. So Sentry cannot give the net cost.

- Each live `model` request is one paid model call. Each replayed `model`
  request is one model call that did not occur.
- Each dropped `model` recording is a paid call that the next run makes
  again.
- To get cost in money, Roach must read the usage or cost of each live model
  response and send it as a metric. Then a replayed request can count the
  recorded cost as saved.

## Limits

- Metrics have only `tenant`, `mode`, `rule`, `origin`, and `result`. Use
  spans for `run` and `key`.
- Telemetry never has a body, a credential, or the path or query of a URL.
  So you cannot see the model, the prompt, or the test name in Sentry.

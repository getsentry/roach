# Telemetry

Use this file to answer questions about Roach from its Sentry data. Examples:
"how many requests replayed?", "why does this run miss?", and "how much time
do recordings save?". "Sentry" in `README.md` lists the metrics and spans.
The code in `service/service.ts` and `src/recorder.ts` is authoritative.

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
| `gen_ai.request.model`      | model of a model call           | `roach.request`  |
| `miss.sample`               | `found` or `none` for a miss    | `roach.request`  |
| `miss.changed_at`           | offset of the change of a miss  | `roach.request`  |
| `miss.recorded`             | recorded text of a miss change  | `roach.request`  |
| `miss.request`              | sent text of a miss change      | `roach.request`  |

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
"Find changing values" in `README.md` shows how to find the value.

```bash
sentry explore sentry/roach --dataset spans --period 24h \
  -q 'span.op:roach.request result:live' -F run -F 'count()' -s '-count()'
```

Runs with misses. A miss in `replay` mode fails the test.

```bash
sentry explore sentry/roach --dataset spans --period 24h \
  -q 'span.op:roach.request result:missed' -F run -F 'count()' -s '-count()'
```

Where the requests of misses changed, and what changed. The same
`miss.changed_at` from run to run shows one value that changes on each
run. `miss.recorded` and `miss.request` show that value. `miss.sample:none`
is a miss that has no recorded request to compare with. This works for
runs without the token too, such as CI of a fork.

```bash
sentry explore sentry/roach --dataset spans --period 24h \
  -q 'span.op:roach.request has:miss.sample' -F tenant -F run -F rule \
  -F miss.sample -F miss.changed_at -F miss.recorded -F miss.request \
  -F 'count()' -s '-count()'
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

A `roach.request` span of a model call has its token usage as `gen_ai`
attributes. Sentry calculates the cost from them and its own price of the
model: `gen_ai.cost.total_tokens`, in USD. Roach has no prices.

- `result:live` is money that the runs spent.
- `result:replayed` is money that the recordings saved. A replay has the
  usage of its recording.
- A model that Sentry has no price for has tokens, but no cost.

Spent and saved, by rule and model.

```bash
sentry explore sentry/roach --dataset spans --period 24h \
  -q 'span.op:roach.request has:gen_ai.usage.input_tokens' \
  -F result -F rule -F gen_ai.request.model \
  -F 'sum(gen_ai.cost.total_tokens)' -F 'sum(gen_ai.usage.input_tokens)' \
  -F 'sum(gen_ai.usage.output_tokens)' -F 'count()'
```

Money that failed tests wasted. A dropped recording was a paid live call,
and the next run makes it again. Compare `roach.recording.write` with
`result:dropped` to the cost of `result:live`.

## Limits

- Metrics have only `tenant`, `mode`, `rule`, `origin`, and `result`. Use
  spans for `run` and `key`.
- Telemetry never has a credential. It has no body and no path or query
  of a URL, except the change of a miss. From a model call, it has only
  the model name and the token counts. So you cannot see the test name in
  Sentry, and you see the prompt only around the change of a miss.
- The `roach.request` span of the first miss of a session has
  `miss.sample`. When the proxy finds a change, it also has
  `miss.changed_at`, `miss.compared`, `miss.recorded`, and `miss.request`.
  The two texts have at most 160 characters each, redacted as in a
  recording. Every run sends them, with or without the token. The stats
  and the run report of a run without the token do not have them
  ("Misses" in `README.md`).
- `roach.store.read` spans with a `key` that starts with `_requests/` read
  a request sample, not a recording. Leave them out of a hit rate of
  `roach.store.read`. Each write of recordings has a second
  `roach.store.write` span for their samples. The `roach.recording.write`
  metric does not count samples.
- Cost is on spans only, not on metrics.

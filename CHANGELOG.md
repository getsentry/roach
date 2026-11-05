# Changelog
## 0.3.0

### New Features ✨

- (report) Count refused requests in the run stats and report by @dcramer with @sentry-junior in [#39](https://github.com/getsentry/roach/pull/39)
- (rules) Let match.url take a list of prefixes by @dcramer with @sentry-junior in [#38](https://github.com/getsentry/roach/pull/38)
- Show what changed in the request of a miss by @dcramer with @sentry-junior in [#40](https://github.com/getsentry/roach/pull/40)

### Bug Fixes 🐛

#### Client

- Name an old service that returns no session URL by @dcramer with @sentry-junior in [#36](https://github.com/getsentry/roach/pull/36)
- Keep control calls out of in-process HTTP mocks by @dcramer with @sentry-junior in [#30](https://github.com/getsentry/roach/pull/30)

#### Secrets

- Close credential leaks in request text and recording URLs by @dcramer with @sentry-junior in [#54](https://github.com/getsentry/roach/pull/54)
- Fail closed on a body that is not JSON and names a credential field by @dcramer with @sentry-junior in [636e4fd9](https://github.com/getsentry/roach/commit/636e4fd918e4da4a2f860634d916512091c5c86c)
- Check only the body of a sample, and redact forms in one pass by @dcramer with @sentry-junior in [c839f6b1](https://github.com/getsentry/roach/commit/c839f6b1e673a52d88f8048e7fb6b90f6fd9fd2d)
- Check request samples by structure, not by substring by @dcramer with @sentry-junior in [4a179296](https://github.com/getsentry/roach/commit/4a17929631d6f2aae65fc4e3f1bac2422a1f9fde)
- Fail closed on credential values that stay in a sample by @dcramer with @sentry-junior in [eec80c27](https://github.com/getsentry/roach/commit/eec80c27ddc15ccf52bad301ad486224d5ba3509)
- Check escapes, fail closed on hidden fields, learn `\/` by @dcramer with @sentry-junior in [84cbc09c](https://github.com/getsentry/roach/commit/84cbc09c892f650dd2bf2b0bfbaa1e7b46311435)
- Redact fields in one pass, in place, and fail closed by @dcramer with @sentry-junior in [#46](https://github.com/getsentry/roach/pull/46)
- Redact query keys, binary bodies, and minted tokens by @dcramer with @sentry-junior in [#44](https://github.com/getsentry/roach/pull/44)

#### Server

- Keep the idle limit on tunnels and proxied connections by @dcramer with @sentry-junior in [#58](https://github.com/getsentry/roach/pull/58)
- Enforce request timeouts on servers that do not listen by @dcramer with @sentry-junior in [#49](https://github.com/getsentry/roach/pull/49)

#### Service

- Cap known values of runs without a token, key write-token runs on the main thread by @dcramer with @sentry-junior in [#48](https://github.com/getsentry/roach/pull/48)
- Keep keys of long sessions, and isolate the key worker by @sentry-junior in [#45](https://github.com/getsentry/roach/pull/45)
- Limit the work that a run without a token can cause by @sentry-junior in [#42](https://github.com/getsentry/roach/pull/42)
- Keep error text from clients and fill telemetry gaps by @claude with @sentry-junior in [#43](https://github.com/getsentry/roach/pull/43)

#### Other

- (key) Answer HTTP 400 for JSON nested over 64 levels by @dcramer with @sentry-junior in [#61](https://github.com/getsentry/roach/pull/61)
- (vitest) Allow off mode on Node before 24.14 by @dcramer with @sentry-junior in [#31](https://github.com/getsentry/roach/pull/31)

### Documentation 📚

- (vitest) Note the per-test fetch dispatcher and client agents by @dcramer with @sentry-junior in [#33](https://github.com/getsentry/roach/pull/33)
- Explain how to find values that change between runs by @dcramer with @sentry-junior in [#35](https://github.com/getsentry/roach/pull/35)
- Say secretEnv is only for credentials that no header carries by @dcramer with @sentry-junior in [#32](https://github.com/getsentry/roach/pull/32)

### Internal Changes 🔧

#### Service

- Share the test setup, and fix the timing checks for coverage by @dcramer with @sentry-junior in [#63](https://github.com/getsentry/roach/pull/63)
- Share parseJson, isObject, and httpError by @dcramer with @sentry-junior in [#62](https://github.com/getsentry/roach/pull/62)
- Split bodies, clients, run config, recording files, and the JSON scan into files by @dcramer with @sentry-junior in [#55](https://github.com/getsentry/roach/pull/55)

#### Other

- (client) Share client helpers and prefix client errors by @dcramer with @sentry-junior in [#57](https://github.com/getsentry/roach/pull/57)
- (deploy) Move the head check and the wait for the service into scripts by @dcramer with @sentry-junior in [#53](https://github.com/getsentry/roach/pull/53)
- (key-worker) Prove the watchdog without a race with the vm timeout by @dcramer with @sentry-junior in [#52](https://github.com/getsentry/roach/pull/52)
- (release) Bump craft to 3.9.0 by @dcramer with @sentry-junior in [#26](https://github.com/getsentry/roach/pull/26)
- (secrets) Cover the key-header decoy in the miss text of a run with the token by @sentry-junior in [#51](https://github.com/getsentry/roach/pull/51)
- Let CI and Image run by hand when GitHub misses a push to main by @dcramer with @sentry-junior in [#50](https://github.com/getsentry/roach/pull/50)
- Make the repository a pnpm workspace, ship only the client by @dcramer with @sentry-junior in [#37](https://github.com/getsentry/roach/pull/37)
- Move the service into a private workspace package by @dcramer with @sentry-junior in [#34](https://github.com/getsentry/roach/pull/34)

### Other

- Bump the dev-dependencies group across 1 directory with 7 updates by @dcramer with @dependabot in [#41](https://github.com/getsentry/roach/pull/41)
- Bump @sentry/node from 11.6.0 to 11.10.0 by @dependabot in [#19](https://github.com/getsentry/roach/pull/19)

## 0.2.0

### New Features ✨

#### Deploy

- Auto-deploy green commits of main by @sentry-junior in [#25](https://github.com/getsentry/roach/pull/25)
- Set the Sentry DSN in roach.tfvars by @sentry-junior in [#22](https://github.com/getsentry/roach/pull/22)

#### Service

- Add Sentry spans and cache metrics by @sentry-junior in [#13](https://github.com/getsentry/roach/pull/13)
- Take origins and value patterns from the run by @sentry-junior in [#12](https://github.com/getsentry/roach/pull/12)
- Redact the secrets that a run sends by @sentry-junior in [#11](https://github.com/getsentry/roach/pull/11)

#### Other

- Concurrent sessions, a vitest integration, and an npm package by @sentry-junior in [#28](https://github.com/getsentry/roach/pull/28)
- Report model token usage on request spans by @sentry-junior in [#24](https://github.com/getsentry/roach/pull/24)

### Bug Fixes 🐛

- (release) Let Craft find v0.1.0 so the next release bumps from it by @sentry-junior in [#29](https://github.com/getsentry/roach/pull/29)
- (secrets) Do not treat x-session-affinity as a credential by @sentry-junior in [#27](https://github.com/getsentry/roach/pull/27)

### Documentation 📚

- Add TELEMETRY.md with Sentry query recipes by @sentry-junior in [#23](https://github.com/getsentry/roach/pull/23)

## 0.1.0

### New Features ✨

- (service) Share one write token across repository tenants by @sentry-junior in [#4](https://github.com/getsentry/roach/pull/4)
- Add a GitHub Action and Craft releases, and remove the local proxy by @sentry-junior in [#8](https://github.com/getsentry/roach/pull/8)
- Run Roach as a remote proxy on GCP with GCS recordings by @sentry-junior in [#1](https://github.com/getsentry/roach/pull/1)
- Import Roach from getsentry/junior by @sentry-junior[bot] in [a0ce7fcf](https://github.com/getsentry/roach/commit/a0ce7fcfbb6a4e726dca4af78e3f9efc351a4176)

### Bug Fixes 🐛

#### Deploy

- Allow the local-time pattern that Junior sends by @sentry-junior in [#10](https://github.com/getsentry/roach/pull/10)
- Replace the managed certificate before deleting it by @sentry-junior in [#7](https://github.com/getsentry/roach/pull/7)

#### Other

- (release) Prepare releases with the Sentry Release Bot token by @sentry-junior in [#9](https://github.com/getsentry/roach/pull/9)

### Internal Changes 🔧

#### Deploy

- Use roach-proxy.getsentry.net as the domain by @sentry-junior in [#6](https://github.com/getsentry/roach/pull/6)
- Configure the Sentry GCP deployment by @sentry-junior in [#5](https://github.com/getsentry/roach/pull/5)

#### Other

- Add repository tooling by @sentry-junior in [#2](https://github.com/getsentry/roach/pull/2)


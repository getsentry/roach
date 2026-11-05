# Changelog
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


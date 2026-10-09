# Agent Instructions

## Package Manager

- Use **pnpm** (`pnpm install`) on Node 24 (`.node-version`).
- Install agent skills with `pnpm skills:install` (`agents.toml`).

## Commands

| Task             | Command                                           |
| ---------------- | ------------------------------------------------- |
| Test file        | `pnpm exec vitest run tests/roach.test.ts`        |
| Test case        | `pnpm exec vitest run tests/roach.test.ts -t "…"` |
| Lint file        | `pnpm exec oxlint --deny-warnings src/server.ts`  |
| Format           | `pnpm format`                                     |
| Typecheck        | `pnpm typecheck` (proxy and Worker)               |
| Worker tests     | `pnpm exec vitest run tests/worker.test.ts`       |
| Unused code/deps | `pnpm knip`                                       |
| Everything (CI)  | `pnpm check`                                      |

## External References

| Need                                   | File                    |
| -------------------------------------- | ----------------------- |
| Usage, config, recordings, control API | `README.md`             |
| Worker setup, routes, and limits       | "Worker" in `README.md` |
| Public types                           | `src/types.ts`          |
| Map of source files                    | "Files" in `README.md`  |

## Key Conventions

- Add no runtime dependencies. Use Node built-ins and the `openssl` command only.
- `worker/` runs on Cloudflare Workers, with `worker/tsconfig.json`. The `src/` files that it imports (`parts.ts`, `store.ts`) must not use Node built-ins.
- Change the D1 schema only with a new file in `worker/migrations/`.
- Node runs `src/` as TypeScript with type stripping. Use only erasable syntax, and import local files with the `.ts` extension.
- Use functions and plain objects, not classes.
- Start each source file with a comment that says what the file owns. Give each export a short JSDoc.
- Update `README.md` in the same change when behavior, config, or the control API changes.
- Test through a real proxy and a local upstream server in `tests/`. Do not mock modules. Do not reach the internet.
- The proxy decrypts HTTPS. Never write a credential: every recording and miss file goes through `src/secrets.ts`.
- The upstream host always comes from `allow`, never from the client.
- Write docs in ASD-STE100 English: common words, active voice, short sentences.

## Commit Attribution

AI commits MUST include:

```
Co-Authored-By: (the agent's name and attribution byline)
```

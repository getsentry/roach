import { defineProject } from "vitest/config";

/** Tells whether vitest runs with `--coverage`, which makes the service slower. */
const coverage = process.argv.some((arg) => arg.startsWith("--coverage"));

export default defineProject({
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 30_000,
    // The timing checks allow 3 times more time with coverage
    // (`budget()` in `tests/harness.ts`).
    env: { ROACH_TEST_SLOWDOWN: coverage ? "3" : "1" },
  },
});

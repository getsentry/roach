import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 30_000,
  },
});

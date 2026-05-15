import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    // better-sqlite3 native bindings misbehave under thread pools.
    pool: "forks",
    testTimeout: 30000,
    silent: true,
    env: {
      BRAIN_LOG_LEVEL: "error",
    },
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: [
        "src/**/*.d.ts",
        "src/index.ts",
        "src/observability/logger.ts",
      ],
    },
  },
});

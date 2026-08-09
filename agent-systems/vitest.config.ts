import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // No network, no API key: every test uses a mocked language model.
    testTimeout: 15_000,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["capstone/**"],
      reporter: ["text", "json-summary", "html", "lcov"],
      reportsDirectory: "coverage",
      thresholds: {
        statements: 90,
        branches: 78,
        functions: 90,
        lines: 90,
      },
    },
  },
});

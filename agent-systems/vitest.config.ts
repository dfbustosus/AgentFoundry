import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // No network, no API key: every test uses a mocked language model.
    testTimeout: 15_000,
  },
});

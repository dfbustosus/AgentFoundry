// @ts-check

/** @type {import("@stryker-mutator/api/core").PartialStrykerOptions} */
const config = {
  mutate: [
    "src/core/reliability/fallback.ts",
    "src/core/reliability/retry.ts",
    "src/core/state/session.ts",
    "src/core/tools/contract.ts",
    "src/core/validation/approval.ts",
    "src/core/validation/enforcement.ts",
  ],
  testRunner: "vitest",
  vitest: {
    configFile: "vitest.config.ts",
    related: true,
  },
  coverageAnalysis: "perTest",
  reporters: ["clear-text", "html", "json"],
  htmlReporter: {
    fileName: "reports/mutation/mutation.html",
  },
  jsonReporter: {
    fileName: "reports/mutation/mutation.json",
  },
  clearTextReporter: {
    allowColor: false,
    allowEmojis: false,
    logTests: false,
  },
  thresholds: {
    high: 95,
    low: 90,
    break: 90,
  },
  concurrency: 4,
  timeoutFactor: 2,
  timeoutMS: 10_000,
};

export default config;

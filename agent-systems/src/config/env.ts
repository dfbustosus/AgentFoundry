/**
 * Application environment: typed, validated, fail-fast.
 *
 * NOTE: this module is application-layer configuration (examples, capstone,
 * scripts). The core library (`src/core/`) is intentionally env-free — it
 * receives everything through options. Configuration lives at the edges.
 *
 * Three environments are recognized:
 * - development: local runs; reads .env via the shell or exported vars;
 * - test:        set by the test runner; mock mode is the default there;
 * - production:  live runs; mock mode is rejected (safety rail).
 *
 * Every variable is validated at load with a clear, actionable error —
 * a misconfigured environment fails at startup, not mid-agent-loop.
 */

import { z } from "zod";

const envSchema = z.object({
  /** Runtime environment. Defaults to development. */
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  /** Required for live model calls; optional when mock mode is on. */
  OPENAI_API_KEY: z.string().min(1).regex(/^sk-/, 'must start with "sk-"').optional(),
  /** Model used by examples and the capstone. */
  AGENT_SYSTEMS_MODEL: z.string().min(1).default("gpt-4o-mini"),
  /** "1" substitutes a deterministic offline mock model. */
  AGENT_SYSTEMS_MOCK: z.enum(["0", "1"]).default("0"),
});

export type AppEnv = z.infer<typeof envSchema>;

export class EnvConfigError extends Error {
  constructor(issues: readonly string[]) {
    super(
      `Invalid environment configuration:\n${issues.map((i) => `  - ${i}`).join("\n")}\n` +
        "See .env.example for the required variables.",
    );
    this.name = "EnvConfigError";
  }
}

/** Load and validate the environment. Pass an explicit source in tests. */
export function loadEnv(source: Record<string, string | undefined> = process.env): AppEnv {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    throw new EnvConfigError(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`));
  }
  const env = parsed.data;

  if (env.NODE_ENV === "production" && env.AGENT_SYSTEMS_MOCK === "1") {
    throw new EnvConfigError(["AGENT_SYSTEMS_MOCK: mock mode is forbidden in production"]);
  }
  if (env.AGENT_SYSTEMS_MOCK === "0" && env.OPENAI_API_KEY === undefined) {
    throw new EnvConfigError([
      "OPENAI_API_KEY: required when AGENT_SYSTEMS_MOCK=0 (set the key, or run offline with AGENT_SYSTEMS_MOCK=1)",
    ]);
  }
  return env;
}

/** True when the deterministic offline mock should replace the live model. */
export function isMockMode(env: AppEnv): boolean {
  return env.AGENT_SYSTEMS_MOCK === "1";
}

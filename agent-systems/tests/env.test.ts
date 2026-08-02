import { describe, expect, it } from "vitest";
import { EnvConfigError, isMockMode, loadEnv } from "../src/config/env.js";

describe("loadEnv", () => {
  it("applies defaults for a minimal development environment in mock mode", () => {
    const env = loadEnv({ AGENT_SYSTEMS_MOCK: "1" });
    expect(env.NODE_ENV).toBe("development");
    expect(env.AGENT_SYSTEMS_MODEL).toBe("gpt-4o-mini");
    expect(isMockMode(env)).toBe(true);
  });

  it("requires OPENAI_API_KEY when mock mode is off", () => {
    expect(() => loadEnv({})).toThrowError(EnvConfigError);
    expect(() => loadEnv({})).toThrowError(/OPENAI_API_KEY/);
  });

  it("accepts a valid live configuration", () => {
    const env = loadEnv({ OPENAI_API_KEY: "sk-test-123", NODE_ENV: "production" });
    expect(env.OPENAI_API_KEY).toBe("sk-test-123");
    expect(isMockMode(env)).toBe(false);
  });

  it("rejects malformed API keys with an actionable message", () => {
    expect(() => loadEnv({ OPENAI_API_KEY: "not-a-key" })).toThrowError(/sk-/);
  });

  it("forbids mock mode in production — a safety rail, not a convention", () => {
    expect(() => loadEnv({ NODE_ENV: "production", AGENT_SYSTEMS_MOCK: "1" })).toThrowError(/forbidden in production/);
  });

  it("rejects unknown NODE_ENV values", () => {
    expect(() => loadEnv({ NODE_ENV: "staging-ish", AGENT_SYSTEMS_MOCK: "1" })).toThrowError(EnvConfigError);
  });

  it("rejects invalid mock flag values", () => {
    expect(() => loadEnv({ AGENT_SYSTEMS_MOCK: "yes" })).toThrowError(EnvConfigError);
  });
});

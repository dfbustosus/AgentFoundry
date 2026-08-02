import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EnvConfigError, isMockMode, loadDotEnv, loadEnv } from "../src/config/env.js";

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

describe("loadDotEnv", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "dotenv-test-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("loads KEY=value pairs, skipping comments and blank lines", async () => {
    await writeFile(
      join(dir, ".env"),
      "# comment\n\nOPENAI_API_KEY=sk-from-file\nAGENT_SYSTEMS_MODEL=gpt-4o\n",
      "utf8",
    );
    const target: Record<string, string | undefined> = {};
    const loaded = loadDotEnv(target, dir);
    expect(target.OPENAI_API_KEY).toBe("sk-from-file");
    expect(target.AGENT_SYSTEMS_MODEL).toBe("gpt-4o");
    expect(loaded).toEqual(["OPENAI_API_KEY", "AGENT_SYSTEMS_MODEL"]);
  });

  it("strips surrounding quotes from values", async () => {
    await writeFile(join(dir, ".env"), "A=\"double\"\nB='single'\n", "utf8");
    const target: Record<string, string | undefined> = {};
    loadDotEnv(target, dir);
    expect(target.A).toBe("double");
    expect(target.B).toBe("single");
  });

  it("never overrides already-set shell variables", async () => {
    await writeFile(join(dir, ".env"), "OPENAI_API_KEY=sk-from-file\n", "utf8");
    const target: Record<string, string | undefined> = { OPENAI_API_KEY: "sk-from-shell" };
    loadDotEnv(target, dir);
    expect(target.OPENAI_API_KEY).toBe("sk-from-shell");
  });

  it("falls back to the parent directory's .env", async () => {
    await writeFile(join(dir, ".env"), "OPENAI_API_KEY=sk-parent\n", "utf8");
    const target: Record<string, string | undefined> = {};
    loadDotEnv(target, join(dir, "nested-dir-that-does-not-exist"));
    expect(target.OPENAI_API_KEY).toBe("sk-parent");
  });

  it("returns empty when no .env exists", () => {
    const target: Record<string, string | undefined> = {};
    expect(loadDotEnv(target, dir)).toEqual([]);
  });
});

import { APICallError } from "ai";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { classifyError } from "../src/core/errors/classify.js";
import {
  AgentError,
  BudgetExhaustedError,
  DegradedError,
  EnvironmentError,
  PolicyError,
  ReasoningError,
  ToolError,
} from "../src/core/errors/taxonomy.js";

function apiError(statusCode: number): APICallError {
  return new APICallError({
    message: `HTTP ${statusCode}`,
    url: "https://api.example.com/v1/chat",
    requestBodyValues: {},
    statusCode,
    isRetryable: statusCode >= 500 || statusCode === 429,
  });
}

describe("classifyError", () => {
  it("passes through already-classified AgentErrors", () => {
    const original = new ToolError("boom", {
      retryable: true,
      sideEffect: "none",
      blastRadius: "local",
      code: "tool.timeout",
    });
    expect(classifyError(original)).toBe(original);
  });

  it("classifies transient provider statuses as retryable environment errors", () => {
    for (const status of [408, 409, 425, 429, 500, 503]) {
      const err = classifyError(apiError(status));
      expect(err).toBeInstanceOf(EnvironmentError);
      expect(err.retryable).toBe(true);
      expect(err.code).toBe("environment.provider_transient");
    }
  });

  it("classifies permanent provider statuses as non-retryable", () => {
    for (const status of [400, 401, 403, 404, 422]) {
      const err = classifyError(apiError(status));
      expect(err.retryable).toBe(false);
      expect(err.code).toBe("environment.provider_permanent");
    }
  });

  it("classifies ZodError as a non-retryable reasoning error with issue evidence", () => {
    const schema = z.object({ n: z.number() });
    const result = schema.safeParse({ n: "NaN" });
    if (result.success) throw new Error("expected parse failure");
    const err = classifyError(result.error);
    expect(err).toBeInstanceOf(ReasoningError);
    expect(err.retryable).toBe(false);
    expect(err.evidence.length).toBeGreaterThan(0);
  });

  it("classifies Node system errors by code; network codes are transient", () => {
    const connRefused = Object.assign(new Error("connect refused"), { code: "ECONNREFUSED" });
    expect(classifyError(connRefused).retryable).toBe(true);

    const denied = Object.assign(new Error("permission denied"), { code: "EACCES" });
    const classified = classifyError(denied);
    expect(classified).toBeInstanceOf(EnvironmentError);
    expect(classified.retryable).toBe(false);
  });

  it("defaults unknown errors to non-retryable reasoning errors", () => {
    const err = classifyError(new Error("something weird"));
    expect(err).toBeInstanceOf(ReasoningError);
    expect(err.retryable).toBe(false);
    expect(err.code).toBe("reasoning.unclassified");
  });
});

describe("error types", () => {
  it("PolicyError is never retryable by construction", () => {
    const err = new PolicyError("denied", {
      sideEffect: "none",
      blastRadius: "local",
      code: "policy.test",
    });
    expect(err.category).toBe("policy");
    expect(err.retryable).toBe(false);
  });

  it("BudgetExhaustedError records what was spent", () => {
    const err = new BudgetExhaustedError("maxIterations", "8", ["obs1"]);
    expect(err.message).toContain("maxIterations");
    expect(err.message).toContain("8");
    expect(err.retryable).toBe(false);
  });

  it("DegradedError lists dropped guarantees and per-step failures", () => {
    const cause = new AgentError("x", {
      category: "tool",
      retryable: false,
      sideEffect: "unknown",
      blastRadius: "local",
      code: "tool.x",
    });
    const err = new DegradedError(["freshness"], [{ step: "primary", error: cause }]);
    expect(err.droppedGuarantees).toEqual(["freshness"]);
    expect(err.failures).toHaveLength(1);
    expect(err.message).toContain("freshness");
  });
});

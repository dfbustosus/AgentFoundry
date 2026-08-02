import { describe, expect, it } from "vitest";
import { z } from "zod";
import { PolicyError, ReasoningError } from "../src/core/errors/taxonomy.js";
import {
  CostTracker,
  estimateCostUsd,
  multiAgentFit,
  stalePriceModels,
  type ModelPrice,
} from "../src/core/cost/tracker.js";
import {
  authorizationLayer,
  budgetLayer,
  enforce,
  enforceOrThrow,
  schemaLayer,
  verifyPostcondition,
} from "../src/core/validation/enforcement.js";

describe("enforcement layers", () => {
  const refundSchema = z.object({ amount: z.number().positive(), currency: z.literal("USD") });

  const layers = [
    schemaLayer("refund-schema", refundSchema),
    authorizationLayer({ "support-agent": ["refund.create"], "read-agent": [] }),
    // Runs after the schema layer, so narrowing the payload is safe.
    budgetLayer("refund-ceiling", (p) => (p as { amount: number }).amount, 100),
  ];

  it("allows an action that passes every layer", async () => {
    const decision = await enforce(
      { kind: "refund.create", actor: "support-agent", payload: { amount: 50, currency: "USD" } },
      layers,
    );
    expect(decision.allowed).toBe(true);
  });

  it("denies malformed payloads at the schema layer", async () => {
    const decision = await enforce(
      { kind: "refund.create", actor: "support-agent", payload: { amount: -5, currency: "EUR" } },
      layers,
    );
    expect(decision.allowed).toBe(false);
    expect(decision.deniedBy).toBe("refund-schema");
  });

  it("denies unauthorized actors even with a valid payload — prompts cannot fix this", async () => {
    await expect(
      enforceOrThrow({ kind: "refund.create", actor: "read-agent", payload: { amount: 50, currency: "USD" } }, layers),
    ).rejects.toSatisfy((e: unknown) => e instanceof PolicyError && e.message.includes("authorization"));
  });

  it("enforces deterministic ceilings regardless of model confidence", async () => {
    const decision = await enforce(
      { kind: "refund.create", actor: "support-agent", payload: { amount: 10_000, currency: "USD" } },
      layers,
    );
    expect(decision.allowed).toBe(false);
    expect(decision.deniedBy).toBe("refund-ceiling");
  });

  it("verifyPostcondition re-reads the world instead of trusting the action", async () => {
    await expect(verifyPostcondition("balance updated", async () => true)).resolves.toBeUndefined();
    await expect(verifyPostcondition("balance updated", async () => "balance unchanged")).rejects.toSatisfy(
      (e: unknown) => e instanceof ReasoningError && e.code === "reasoning.postcondition_failed",
    );
  });
});

describe("cost tracking", () => {
  it("estimates cost from the dated price table", () => {
    const cost = estimateCostUsd("gpt-4o-mini", { inputTokens: 1_000_000, outputTokens: 1_000_000 });
    expect(cost).toBeCloseTo(0.75);
    expect(estimateCostUsd("unknown-model", { inputTokens: 1, outputTokens: 1 })).toBeUndefined();
  });

  it("accumulates usage per agent and flags unpriced models", () => {
    const tracker = new CostTracker();
    tracker.record("researcher", "gpt-4o-mini", { inputTokens: 1000, outputTokens: 500 });
    tracker.record("researcher", "gpt-4o-mini", { inputTokens: 1000, outputTokens: 500 });
    tracker.record("writer", "custom-local", { inputTokens: 10, outputTokens: 10 });
    const report = tracker.report();
    expect(report.perAgent).toHaveLength(2);
    const researcher = report.perAgent.find((r) => r.agentId === "researcher");
    expect(researcher?.calls).toBe(2);
    expect(researcher?.inputTokens).toBe(2000);
    expect(report.hasUnpricedModels).toBe(true);
    expect(report.totalCostUsd).toBeUndefined(); // never invent dollars for unpriced models
  });

  it("fires the budget callback when the ceiling is crossed", () => {
    const crossed: number[] = [];
    const tracker = new CostTracker(0.0001, (report) => crossed.push(report.totalCostUsd ?? 0));
    tracker.record("a", "gpt-4o", { inputTokens: 1_000_000, outputTokens: 0 });
    expect(crossed.length).toBeGreaterThan(0);
  });

  it("flags stale price entries instead of silently trusting them (R2)", () => {
    const table: Record<string, ModelPrice> = {
      fresh: { inputPer1M: 1, outputPer1M: 2, asOf: "2026-07-01" },
      stale: { inputPer1M: 1, outputPer1M: 2, asOf: "2025-01-01" },
    };
    const now = new Date("2026-07-30T00:00:00Z");
    expect(stalePriceModels(table, now)).toEqual(["stale"]);
    expect(stalePriceModels(table, new Date("2025-01-15T00:00:00Z"))).toEqual([]);
  });

  it("multiAgentFit demands quantified benefit for coordination overhead", () => {
    expect(multiAgentFit({ singleAgentCostUsd: 0.01, multiAgentCostUsd: 0.05 }).justified).toBe(false);
    expect(
      multiAgentFit({
        singleAgentCostUsd: 0.01,
        multiAgentCostUsd: 0.05,
        humanHoursSaved: 2,
        humanHourValueUsd: 50,
      }).justified,
    ).toBe(true);
  });
});

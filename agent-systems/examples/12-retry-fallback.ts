/**
 * Example 12 — Error taxonomy, retry logic, fallback chains, degradation.
 *
 * Topics: tool/reasoning/environment errors · error detection · retry ·
 * fallback chains · graceful degradation.
 *
 * A flaky primary model path is wrapped in bounded retry; when the budget is
 * exhausted, a fallback chain serves a degraded answer WITH the degradation
 * labeled — never silently substituted.
 *
 * Run: npm run example -- examples/12-retry-fallback.ts
 */

import { generateText } from "ai";
import { ToolError, withFallback, withRetry } from "../src/index.js";
import { main, model, printJson, printSection } from "./lib/shared.js";

let primaryCalls = 0;

async function flakyPrimary(question: string): Promise<string> {
  primaryCalls += 1;
  if (primaryCalls <= 2) {
    // Transient tool/environment failure — the retryable kind.
    throw new ToolError("rate limited (simulated)", {
      retryable: true,
      sideEffect: "none",
      blastRadius: "local",
      code: "tool.rate_limit",
    });
  }
  return (await generateText({ model: model(), prompt: question })).text;
}

await main(async () => {
  printSection("12 — Retry, fallback, and labeled degradation");
  const question = "In one sentence: why must agent retries be bounded?";

  console.log("\nPart 1: bounded retry absorbs transient failure");
  const retried = await withRetry(
    "primary-model",
    () => flakyPrimary(question),
    { maxAttempts: 4, baseDelayMs: 200, maxDelayMs: 2_000, sideEffectSafe: true },
  );
  console.log(`  succeeded on attempt ${retried.attempts}; prior errors: ${retried.errors.map((e) => e.code).join(", ")}`);
  console.log(`  answer: ${retried.value}`);

  console.log("\nPart 2: fallback chain with labeled degradation");
  primaryCalls = 0; // make the primary flaky again, this time beyond the retry budget
  const outcome = await withFallback("answer-question", [
    {
      name: "primary-with-retry",
      run: async () => {
        const r = await withRetry("primary-model", () => flakyPrimary(question), {
          maxAttempts: 2, // deliberately too small — the chain must engage
          baseDelayMs: 100,
          maxDelayMs: 500,
          sideEffectSafe: true,
        });
        return r.value;
      },
      degrades: [],
    },
    {
      name: "simpler-deterministic-answer",
      run: async () => "Unbounded retries multiply cost, latency, and duplicate side effects.",
      degrades: ["freshness", "model-quality"],
    },
  ]);

  printJson("Fallback outcome", {
    servedBy: outcome.servedBy,
    degradedGuarantees: outcome.degradedGuarantees,
    priorFailures: outcome.priorFailures.map((f) => `${f.step}: ${f.error.code}`),
  });
  console.log(`\nAnswer served by "${outcome.servedBy}" with degradation LABELLED: [${outcome.degradedGuarantees.join(", ")}]`);
});

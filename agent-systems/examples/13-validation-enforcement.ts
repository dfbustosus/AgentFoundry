/**
 * Example 13 — Why prompts are not sufficient for high-stakes paths.
 *
 * Topics: validation layers · enforcement layers · prompts vs. code.
 *
 * The same refund action is attempted twice: once guarded only by a prompt
 * telling the model the rules, once through the enforcement pipeline.
 * Then a "confused deputy" action — a perfectly worded, schema-valid request
 * from an unauthorized actor — is stopped by code.
 *
 * Run: npm run example -- examples/13-validation-enforcement.ts
 */

import { generateText } from "ai";
import { z } from "zod";
import { authorizationLayer, budgetLayer, enforce, PolicyError, schemaLayer, enforceOrThrow } from "../src/index.js";
import { main, model, printJson, printSection } from "./lib/shared.js";

const refundSchema = z.object({
  amount: z.number().positive(),
  currency: z.literal("USD"),
  reason: z.string().min(5),
});

const refundLayers = [
  schemaLayer("refund-schema", refundSchema),
  authorizationLayer({ "support-agent": ["refund.create"], "chat-agent": [] }),
  budgetLayer("refund-ceiling", (p) => (p as { amount: number }).amount, 100),
];

await main(async () => {
  printSection("13 — Enforcement layers: prompts advise, code decides");

  // 1. The prompt-only approach. The model USUALLY obeys. "Usually" is the problem.
  console.log("\nPrompt-only guard (advisory):");
  const promptOnly = await generateText({
    model: model(),
    system:
      "You may approve refunds up to $100 for support-agent. Never approve for anyone else. " +
      "Reply APPROVE or DENY with a reason.",
    prompt: "Actor: chat-agent. Refund request: $9,999 USD, reason: customer unhappy.",
  });
  console.log(`  model says: ${promptOnly.text.slice(0, 200)}`);
  console.log("  → Even when the model says DENY, nothing STRUCTURALLY prevents a bad path from executing.");

  // 2. The enforcement pipeline. Same request, decided by code.
  console.log("\nEnforcement pipeline (structural):");
  const attempts = [
    {
      kind: "refund.create",
      actor: "support-agent",
      payload: { amount: 50, currency: "USD", reason: "defective item" },
    },
    { kind: "refund.create", actor: "chat-agent", payload: { amount: 50, currency: "USD", reason: "defective item" } },
    {
      kind: "refund.create",
      actor: "support-agent",
      payload: { amount: 9_999, currency: "USD", reason: "defective item" },
    },
    { kind: "refund.create", actor: "support-agent", payload: { amount: -50, currency: "EUR", reason: "x" } },
  ];
  for (const attempt of attempts) {
    const decision = await enforce(attempt, refundLayers);
    console.log(
      `  ${decision.allowed ? "ALLOW " : "DENY  "} ${attempt.actor} $${String((attempt.payload as { amount: number }).amount)}` +
        (decision.allowed ? "" : `  ← ${decision.deniedBy}: ${decision.reason}`),
    );
  }

  // 3. enforceOrThrow at the point of no return.
  console.log("\nAttempting the unauthorized action through enforceOrThrow:");
  try {
    await enforceOrThrow(attempts[1] as (typeof attempts)[number], refundLayers);
  } catch (err) {
    if (err instanceof PolicyError) console.log(`  blocked in code: [${err.code}] ${err.evidence.join(" | ")}`);
  }

  printJson("The rule", {
    prompt: "guides the probabilistic layer (the model)",
    code: "enforces the mandatory layer (schema, authorization, budgets, postconditions)",
    highStakesPaths: "authorization, transactionality, deterministic limits, approvals — code or platform policy ONLY",
  });
});

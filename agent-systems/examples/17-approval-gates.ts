/**
 * Example 17 — Human-in-the-loop approval gates.
 *
 * Topics: high-stakes paths · human approval as an enforcement layer ·
 * fail-closed design.
 *
 * The same payment pipeline handles three amounts. Small payments flow
 * through automatically; large ones STOP and wait for a human. Then we show
 * what happens when no human answers: the action dies, safely, by default.
 *
 * Run: npm run example -- examples/17-approval-gates.ts
 * (With AGENT_SYSTEMS_MOCK=1 the "human" is scripted so the demo runs
 * non-interactively; without it, you get a real terminal prompt.)
 */

import { createInterface } from "node:readline/promises";
import { z } from "zod";
import {
  ApprovalGate,
  approvalLayer,
  autoDenyHandler,
  authorizationLayer,
  budgetLayer,
  ConsoleTracer,
  enforce,
  schemaLayer,
  type ApprovalHandler,
} from "../src/index.js";
import { main, printSection } from "./lib/shared.js";

/** Real terminal prompt for interactive runs. Times out to null = fail closed. */
function cliApprovalHandler(timeoutMs: number): ApprovalHandler {
  return async (request) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      console.log(`\n  APPROVAL REQUIRED (${request.id.slice(0, 8)}): ${request.reason}`);
      console.log(
        `  Action: ${request.action.kind} by ${request.action.actor} — ${JSON.stringify(request.action.payload)}`,
      );
      const answer = await Promise.race([
        rl.question("  Approve? [y/N] "),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
      ]);
      const decidedAt = new Date().toISOString();
      if (answer === null || answer.trim().toLowerCase() !== "y") {
        return {
          approved: false,
          approver: "terminal-user",
          decidedAt,
          reason: answer === null ? "timed out" : "declined",
        };
      }
      return { approved: true, approver: "terminal-user", decidedAt };
    } finally {
      rl.close();
    }
  };
}

/** Scripted handler for offline/CI runs: approves the first request, denies the second. */
function scriptedHandler(): ApprovalHandler {
  let calls = 0;
  return async () => {
    calls += 1;
    const decidedAt = new Date().toISOString();
    return calls === 1
      ? { approved: true, approver: "scripted-human", decidedAt }
      : { approved: false, approver: "scripted-human", decidedAt, reason: "amount too large for today" };
  };
}

const paymentSchema = z.object({ amount: z.number().positive(), currency: z.literal("USD") });

await main(async () => {
  printSection("17 — Human-in-the-loop approval gates");

  const isMock = process.env.AGENT_SYSTEMS_MOCK === "1";
  const tracer = new ConsoleTracer((line) => console.log(`  [trace] ${JSON.parse(line).type}`));
  const gate = new ApprovalGate(isMock ? scriptedHandler() : cliApprovalHandler(30_000), {
    timeoutMs: 30_000,
    tracer,
    actor: "payments-gate",
  });

  // The full 8-layer story: schema → authorization → budget → human approval.
  const layers = [
    schemaLayer("payment-schema", paymentSchema),
    authorizationLayer({ "payments-agent": ["payment.send"] }),
    budgetLayer("auto-limit", (p) => (p as { amount: number }).amount, 10_000),
    approvalLayer(gate, {
      requiresApproval: (action) => {
        const amount = (action.payload as { amount: number }).amount;
        return amount > 1_000 ? `payment of $${amount} exceeds the $1,000 human-approval threshold` : undefined;
      },
    }),
  ];

  const attempts = [
    { amount: 250, label: "small — auto-approved by pipeline" },
    { amount: 5_000, label: "large — needs a human" },
    { amount: 9_500, label: "large — human denies" },
  ];
  for (const { amount, label } of attempts) {
    const decision = await enforce(
      { kind: "payment.send", actor: "payments-agent", payload: { amount, currency: "USD" } },
      layers,
    );
    console.log(`\n$${amount} (${label}):`);
    console.log(decision.allowed ? "  → ALLOWED" : `  → DENIED by ${decision.deniedBy}: ${decision.reason}`);
  }

  console.log("\nFail-closed proof (unattended gate):");
  const unattended = new ApprovalGate(autoDenyHandler, { timeoutMs: 50 });
  try {
    await unattended.requireApproval(
      { kind: "payment.send", actor: "payments-agent", payload: { amount: 9_999, currency: "USD" } },
      "no human on duty",
    );
  } catch (err) {
    console.log(`  → ${err instanceof Error ? err.message : String(err)}`);
  }
});

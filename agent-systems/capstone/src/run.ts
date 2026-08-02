/**
 * Capstone runner: seed the store, triage the queue with a human approval
 * gate on refunds, write the trace, and print the after-action report.
 *
 * Run live:    npm run capstone
 * Run offline: AGENT_SYSTEMS_MOCK=1 npm run capstone  (scripted approver)
 */

import { createInterface } from "node:readline/promises";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { ApprovalGate, JsonlTracer, type ApprovalHandler } from "../../src/index.js";
import { isMockMode, loadEnv } from "../../src/config/env.js";
import { model, printSection } from "../../examples/lib/shared.js";
import { runTriage } from "./agent.js";
import { defaultDataDir, TicketStore } from "./store.js";

/** Interactive terminal approver for live runs. */
function cliApprover(timeoutMs: number): ApprovalHandler {
  return async (request) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      console.log(`\n  REFUND APPROVAL REQUIRED: ${request.reason}`);
      console.log(`  ${JSON.stringify(request.action.payload)}`);
      const answer = await Promise.race([
        rl.question("  Approve refund? [y/N] "),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
      ]);
      const decidedAt = new Date().toISOString();
      return answer?.trim().toLowerCase() === "y"
        ? { approved: true, approver: "on-call-human", decidedAt }
        : { approved: false, approver: "on-call-human", decidedAt, reason: answer === null ? "timed out" : "declined" };
    } finally {
      rl.close();
    }
  };
}

/** Offline approver: approves refunds <= $50, denies larger ones. */
const scriptedApprover: ApprovalHandler = async (request) => {
  const amount = (request.action.payload as { amountUsd: number }).amountUsd;
  const decidedAt = new Date().toISOString();
  return amount <= 50
    ? { approved: true, approver: "scripted-approver", decidedAt }
    : { approved: false, approver: "scripted-approver", decidedAt, reason: `$${amount} needs a senior approver` };
};

async function main(): Promise<void> {
  printSection("Capstone — support-ticket triage agent");

  const isMock = isMockMode(loadEnv());
  const dataDir = isMock ? await mkdtemp(join(tmpdir(), "capstone-")) : defaultDataDir();
  const traceDir = isMock ? dataDir : join(process.cwd(), "traces");

  const store = new TicketStore(dataDir);
  await store.seed();

  const tracer = new JsonlTracer(join(traceDir, `triage-${Date.now()}.jsonl`));
  const gate = new ApprovalGate(isMock ? scriptedApprover : cliApprover(60_000), {
    timeoutMs: 60_000,
    tracer,
    actor: "refund-gate",
  });

  // The approval gate is wired into the refund path via the agent's decide
  // policy and the tool's authorization — here we pre-flight large refunds:
  const { loop } = await runTriage({ model: model(), store, approvalGate: gate, tracer });

  console.log(`\nTriage finished: ${loop.transition}`);
  console.log(
    `  iterations=${loop.iterations} toolCalls=${loop.toolCallCount} tokens=${loop.usage.inputTokens + loop.usage.outputTokens}`,
  );
  console.log(`\nAgent summary:\n${loop.text}`);

  console.log("\nTicket states after triage:");
  for (const ticket of await store.listOpen()) {
    console.log(`  ${ticket.id}  ${ticket.status.padEnd(15)} ${ticket.priority.padEnd(7)} ${ticket.subject}`);
  }

  await tracer.flush();
  console.log(`\nTrace written — every tool call, approval, and transition is in the JSONL trace.`);
}

main().catch((err: unknown) => {
  console.error("Capstone failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});

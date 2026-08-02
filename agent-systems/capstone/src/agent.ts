/**
 * Capstone triage agent: one PRAO loop over the open-ticket queue, with
 * refund actions gated by human approval and every step traced.
 *
 * Built entirely on the public library API — this file is the dogfood test.
 */

import type { LanguageModel } from "ai";
import { type ApprovalGate, runPraoLoop, type LoopResult, type Tracer } from "../../src/index.js";
import type { TicketStore } from "./store.js";
import { buildTriageTools, type TriageTools } from "./tools.js";

/** Refunds above this amount require human sign-off. Policy as data. */
export const REFUND_APPROVAL_THRESHOLD_USD = 100;

export interface TriageRunResult {
  readonly loop: LoopResult;
  readonly tools: TriageTools;
}

const TRIAGE_SYSTEM = [
  "You are a support-ticket triage agent. For every open ticket:",
  "1. Read it (get_ticket) — never judge from the subject alone.",
  "2. Set a priority (set_priority): data loss or money trouble = high/urgent; how-to = low/medium.",
  "3. If a refund is requested: mark_refund_pending, then issue_refund for the requested amount.",
  "   If issue_refund fails because approval was denied, leave the ticket refund-pending and move on.",
  "4. Close tickets you fully resolved (how-to questions). Leave the rest open.",
  "Finish with a per-ticket summary: id, priority, action taken.",
].join("\n");

export async function runTriage(options: {
  model: LanguageModel;
  store: TicketStore;
  approvalGate: ApprovalGate;
  tracer?: Tracer;
}): Promise<TriageRunResult> {
  const tools = buildTriageTools(options.store, {
    ...(options.tracer !== undefined ? { tracer: options.tracer } : {}),
    approveRefund: async (action) => {
      const amount = (action.payload as { amountUsd: number }).amountUsd;
      if (amount > REFUND_APPROVAL_THRESHOLD_USD) {
        // Throws PolicyError when denied — the tool reports it to the model,
        // which leaves the ticket refund-pending and continues triage.
        await options.approvalGate.requireApproval(
          action,
          `refund of $${amount} exceeds the $${REFUND_APPROVAL_THRESHOLD_USD} approval threshold`,
        );
      }
    },
  });

  const loop = await runPraoLoop({
    model: options.model,
    tools: {
      list_open_tickets: tools.listOpenTickets,
      get_ticket: tools.getTicket,
      set_priority: tools.setPriority,
      mark_refund_pending: tools.markRefundPending,
      issue_refund: tools.issueRefund,
      close_ticket: tools.closeTicket,
    },
    system: TRIAGE_SYSTEM,
    goal: "Triage all open support tickets now.",
    budgets: { maxIterations: 12, maxToolCalls: 30, maxConsecutiveFailures: 2 },
    ...(options.tracer !== undefined ? { tracer: options.tracer, actor: "triage-agent" } : {}),
  });

  return { loop, tools };
}

/**
 * Capstone tools: the ONLY way the agent can touch the ticket system.
 *
 * Every tool is a library contract tool — typed I/O, declared side effects,
 * write scopes, postconditions against the system of record. Refunds are
 * destructive-money paths: they go through the approval gate before the tool
 * body ever runs.
 */

import { z } from "zod";
import { defineContractTool, type ActionProposal, type Tool, type Tracer } from "../../src/index.js";
import type { TicketStore } from "./store.js";

const AGENT_CONTEXT = { agentId: "triage-agent", writeScopes: ["tickets", "refunds"] } as const;

export interface TriageToolsOptions {
  readonly tracer?: Tracer;
  /**
   * Pre-flight approval for money movement. Called BEFORE any refund executes;
   * a thrown PolicyError blocks the refund. Wire this to an ApprovalGate.
   */
  readonly approveRefund?: (action: ActionProposal) => Promise<void>;
}

export interface TriageTools {
  readonly listOpenTickets: Tool<
    { limit: number },
    { tickets: { id: string; subject: string; priority: string; refundRequestUsd?: number }[] }
  >;
  readonly getTicket: Tool<{ id: string }, { found: boolean; ticket?: unknown }>;
  readonly setPriority: Tool<
    { id: string; priority: "low" | "medium" | "high" | "urgent" },
    { id: string; priority: string }
  >;
  readonly markRefundPending: Tool<{ id: string }, { id: string; status: string }>;
  readonly issueRefund: Tool<{ id: string; amountUsd: number }, { id: string; refundedUsd: number; status: string }>;
  readonly closeTicket: Tool<{ id: string }, { id: string; status: string }>;
}

export function buildTriageTools(store: TicketStore, options: TriageToolsOptions = {}): TriageTools {
  const toolOptions = { context: AGENT_CONTEXT, ...(options.tracer !== undefined ? { tracer: options.tracer } : {}) };

  const listOpenTickets = defineContractTool(
    {
      name: "list_open_tickets",
      description:
        "Lists open (non-closed) support tickets with id, subject, priority, and refund amount. Use first to plan triage.",
      input: z.object({ limit: z.number().int().min(1).max(50).default(20) }),
      output: z.object({
        tickets: z.array(
          z.object({
            id: z.string(),
            subject: z.string(),
            priority: z.string(),
            refundRequestUsd: z.number().optional(),
          }),
        ),
      }),
      sideEffect: "read-only",
      idempotent: true,
      execute: async ({ limit }) => {
        const open = await store.listOpen();
        return {
          tickets: open.slice(0, limit).map((t) => ({
            id: t.id,
            subject: t.subject,
            priority: t.priority,
            ...(t.refundRequestUsd !== undefined ? { refundRequestUsd: t.refundRequestUsd } : {}),
          })),
        };
      },
    },
    toolOptions,
  );

  const getTicket = defineContractTool<{ id: string }, { found: boolean; ticket?: unknown }>(
    {
      name: "get_ticket",
      description: "Gets the full body of one ticket. Use before judging severity; do not guess from the subject.",
      input: z.object({ id: z.string().regex(/^T-\d+$/) }) as z.ZodType<{ id: string }>,
      sideEffect: "read-only",
      idempotent: true,
      execute: async ({ id }) => {
        const ticket = await store.get(id);
        return ticket === undefined ? { found: false } : { found: true, ticket };
      },
    },
    toolOptions,
  );

  const setPriority = defineContractTool(
    {
      name: "set_priority",
      description: "Sets a ticket's priority after reading it. Data loss or money = high/urgent; how-to = low/medium.",
      input: z.object({ id: z.string().regex(/^T-\d+$/), priority: z.enum(["low", "medium", "high", "urgent"]) }),
      output: z.object({ id: z.string(), priority: z.string() }),
      sideEffect: "mutating",
      idempotent: true,
      writeScope: "tickets",
      postcondition: (input, output) =>
        output.priority === input.priority
          ? true
          : `store shows priority "${output.priority}", expected "${input.priority}"`,
      execute: async ({ id, priority }) => {
        const updated = await store.update(id, { priority });
        return { id: updated.id, priority: updated.priority };
      },
    },
    toolOptions,
  );

  const markRefundPending = defineContractTool(
    {
      name: "mark_refund_pending",
      description:
        "Flags a ticket as refund-pending. Use for any refund request BEFORE issuing it — refunds then require approval.",
      input: z.object({ id: z.string().regex(/^T-\d+$/) }),
      output: z.object({ id: z.string(), status: z.string() }),
      sideEffect: "mutating",
      idempotent: true,
      writeScope: "tickets",
      execute: async ({ id }) => {
        const updated = await store.update(id, { status: "refund-pending" });
        return { id: updated.id, status: updated.status };
      },
    },
    toolOptions,
  );

  const issueRefund = defineContractTool(
    {
      name: "issue_refund",
      description:
        "Issues a refund for a ticket that is refund-pending. Money movement: approval-gated, never for tickets without a refund request.",
      input: z.object({ id: z.string().regex(/^T-\d+$/), amountUsd: z.number().positive().max(10_000) }),
      output: z.object({ id: z.string(), refundedUsd: z.number(), status: z.string() }),
      sideEffect: "mutating",
      idempotent: true, // repeated calls reconcile by id; the store records one refund per ticket
      writeScope: "refunds",
      authorize: async ({ id }) => {
        const ticket = await store.get(id);
        return ticket !== undefined && ticket.status === "refund-pending" && ticket.refundRequestUsd !== undefined;
      },
      postcondition: (input, output) => {
        // Verify the claimed effect, not the transport: refunded amount must
        // match the request and the ticket must have left refund-pending.
        if (output.refundedUsd !== input.amountUsd)
          return `refunded $${output.refundedUsd}, expected $${input.amountUsd}`;
        return output.status === "triaged" ? true : `ticket still "${output.status}" after refund`;
      },
      execute: async ({ id, amountUsd }) => {
        const ticket = await store.get(id);
        if (ticket === undefined) throw new Error(`unknown ticket ${id}`);
        if (amountUsd > (ticket.refundRequestUsd ?? 0)) {
          throw new Error(`refund $${amountUsd} exceeds the requested $${ticket.refundRequestUsd ?? 0}`);
        }
        // Human approval gate (when wired): blocks here, before money moves.
        await options.approveRefund?.({
          kind: "refund.issue",
          actor: AGENT_CONTEXT.agentId,
          payload: { id, amountUsd },
        });
        const updated = await store.update(id, { status: "triaged" });
        return { id: updated.id, refundedUsd: amountUsd, status: updated.status };
      },
    },
    toolOptions,
  );

  const closeTicket = defineContractTool(
    {
      name: "close_ticket",
      description:
        "Closes a resolved ticket. Only close after the customer's need is addressed; how-to questions can be answered and closed.",
      input: z.object({ id: z.string().regex(/^T-\d+$/) }),
      output: z.object({ id: z.string(), status: z.string() }),
      sideEffect: "mutating",
      idempotent: true,
      writeScope: "tickets",
      execute: async ({ id }) => {
        const updated = await store.update(id, { status: "closed" });
        return { id: updated.id, status: updated.status };
      },
    },
    toolOptions,
  );

  return { listOpenTickets, getTicket, setPriority, markRefundPending, issueRefund, closeTicket };
}

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { PolicyError } from "../src/core/errors/taxonomy.js";
import type { TraceEvent } from "../src/core/trace/events.js";
import {
  ApprovalGate,
  approvalLayer,
  autoDenyHandler,
  type ApprovalDecision,
} from "../src/core/validation/approval.js";
import { authorizationLayer, budgetLayer, enforce, schemaLayer } from "../src/core/validation/enforcement.js";

const action = (amount: number) => ({
  kind: "payment.send",
  actor: "payments-agent",
  payload: { amount, currency: "USD" },
});

const approve: (approver?: string) => (req: unknown) => Promise<ApprovalDecision> =
  (approver = "dana") =>
  async () => ({ approved: true, approver, decidedAt: new Date().toISOString() });

const deny: (reason: string) => () => Promise<ApprovalDecision> = (reason) => async () => ({
  approved: false,
  approver: "dana",
  decidedAt: new Date().toISOString(),
  reason,
});

function collectTracer() {
  const events: TraceEvent[] = [];
  return { tracer: { emit: (e: TraceEvent) => events.push(e) }, events };
}

describe("ApprovalGate", () => {
  it("returns the decision when a human approves", async () => {
    const gate = new ApprovalGate(approve());
    const decision = await gate.requireApproval(action(5_000), "over threshold");
    expect(decision.approved).toBe(true);
  });

  it("throws PolicyError when a human denies", async () => {
    const gate = new ApprovalGate(deny("too risky"));
    await expect(gate.requireApproval(action(5_000), "over threshold")).rejects.toMatchObject({
      category: "policy",
      code: "policy.approval_denied",
      retryable: false,
    });
  });

  it("fails closed when no human answers (null decision)", async () => {
    const gate = new ApprovalGate(autoDenyHandler, { timeoutMs: 10 });
    await expect(gate.requireApproval(action(5_000), "over threshold")).rejects.toMatchObject({
      code: "policy.approval_unanswered",
    });
  });

  it("fails closed when the handler throws", async () => {
    const gate = new ApprovalGate(async () => {
      throw new Error("pager unreachable");
    });
    await expect(gate.requireApproval(action(5_000), "over threshold")).rejects.toMatchObject({
      code: "policy.approval_handler_error",
    });
  });

  it("rejects decisions that arrive after expiry", async () => {
    const gate = new ApprovalGate(
      async (req) => ({
        approved: true,
        approver: "slow-dana",
        decidedAt: new Date(Date.parse(req.expiresAt) + 5_000).toISOString(),
      }),
      { timeoutMs: 10 },
    );
    await expect(gate.requireApproval(action(5_000), "over threshold")).rejects.toMatchObject({
      code: "policy.approval_expired",
    });
  });

  it("emits approval.requested and approval.decided spans", async () => {
    const { tracer, events } = collectTracer();
    const gate = new ApprovalGate(approve(), { tracer });
    await gate.requireApproval(action(5_000), "over threshold");
    expect(events.map((e) => e.type)).toEqual(["approval.requested", "approval.decided"]);
    expect(events[1]).toMatchObject({ approved: true, approver: "dana", actionKind: "payment.send" });
    expect(events[0]?.trace_id).toBe(events[1]?.trace_id);
  });

  it("records fail-closed denials in the trace too", async () => {
    const { tracer, events } = collectTracer();
    const gate = new ApprovalGate(autoDenyHandler, { timeoutMs: 10, tracer });
    await expect(gate.requireApproval(action(5_000), "over threshold")).rejects.toThrowError(PolicyError);
    expect(events.at(-1)).toMatchObject({ type: "approval.decided", approved: false });
  });
});

describe("approvalLayer in the enforcement pipeline", () => {
  const layers = (gate: ApprovalGate) => [
    schemaLayer("payment-schema", z.object({ amount: z.number().positive(), currency: z.literal("USD") })),
    authorizationLayer({ "payments-agent": ["payment.send"] }),
    budgetLayer("auto-limit", (p) => (p as { amount: number }).amount, 10_000),
    approvalLayer(gate, {
      requiresApproval: (a) =>
        (a.payload as { amount: number }).amount > 1_000 ? "exceeds $1,000 approval threshold" : undefined,
    }),
  ];

  it("lets small actions through without touching the human", async () => {
    let asked = 0;
    const gate = new ApprovalGate(async () => {
      asked += 1;
      return { approved: true, approver: "dana", decidedAt: new Date().toISOString() };
    });
    const decision = await enforce(action(250), layers(gate));
    expect(decision.allowed).toBe(true);
    expect(asked).toBe(0);
  });

  it("escalates large actions and allows them on approval", async () => {
    const decision = await enforce(action(5_000), layers(new ApprovalGate(approve())));
    expect(decision.allowed).toBe(true);
  });

  it("reports denial through the standard EnforcementDecision shape", async () => {
    const decision = await enforce(action(5_000), layers(new ApprovalGate(deny("not today"))));
    expect(decision.allowed).toBe(false);
    expect(decision.deniedBy).toBe("human-approval");
    expect(decision.reason).toContain("not today");
  });

  it("budget ceiling still fires before the human is asked", async () => {
    let asked = 0;
    const gate = new ApprovalGate(async () => {
      asked += 1;
      return { approved: true, approver: "dana", decidedAt: new Date().toISOString() };
    });
    const decision = await enforce(action(50_000), layers(gate));
    expect(decision.allowed).toBe(false);
    expect(decision.deniedBy).toBe("auto-limit");
    expect(asked).toBe(0); // deterministic ceiling rejects first — no human time wasted
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { PolicyError, ReasoningError, ToolError } from "../src/core/errors/taxonomy.js";
import { withFallback } from "../src/core/reliability/fallback.js";
import { RetryExhaustedError, withRetry } from "../src/core/reliability/retry.js";
import { CheckpointStore, type Checkpoint, reconcile } from "../src/core/state/session.js";
import { InMemoryStore } from "../src/core/state/memory.js";
import { contractSummary, defineContractTool } from "../src/core/tools/contract.js";
import type { TraceEvent } from "../src/core/trace/events.js";
import type { Tracer } from "../src/core/trace/tracer.js";
import { ApprovalGate, type ApprovalHandler, type ApprovalRequest } from "../src/core/validation/approval.js";
import {
  authorizationLayer,
  budgetLayer,
  enforceOrThrow,
  schemaLayer,
  verifyPostcondition,
} from "../src/core/validation/enforcement.js";

afterEach(() => {
  vi.restoreAllMocks();
});

function transient(message = "dependency unavailable", sideEffect: "none" | "unknown" | "occurred" = "none") {
  return new ToolError(message, {
    retryable: true,
    sideEffect,
    blastRadius: "local",
    code: "tool.transient",
  });
}

function collectTracer(): { tracer: Tracer; events: TraceEvent[] } {
  const events: TraceEvent[] = [];
  return {
    tracer: { emit: (event) => events.push(event) },
    events,
  };
}

async function executeTool(tool: unknown, input: unknown): Promise<unknown> {
  const execute = (tool as { execute?: (value: unknown, options: unknown) => Promise<unknown> }).execute;
  if (execute === undefined) throw new Error("tool has no executable contract");
  return execute(input, { toolCallId: "mutation-contract", messages: [] });
}

async function approvalFailure(
  handler: ApprovalHandler,
  timeoutMs = 500,
): Promise<{ error: PolicyError; request: ApprovalRequest }> {
  let request: ApprovalRequest | undefined;
  const gate = new ApprovalGate(
    async (candidate) => {
      request = candidate;
      return handler(candidate);
    },
    { timeoutMs },
  );

  let error: unknown;
  try {
    await gate.requireApproval(
      { kind: "payment.send", actor: "payments-agent", payload: { amount: 1_001 } },
      "manual review required",
    );
  } catch (caught) {
    error = caught;
  }

  if (!(error instanceof PolicyError)) throw new Error("approval failure was not classified as policy");
  if (request === undefined) throw new Error("approval handler did not receive a request");
  return { error, request };
}

describe("fallback safety contracts", () => {
  it("fails closed with structured metadata when no fallback is configured", async () => {
    await expect(withFallback("critical-read", [])).rejects.toMatchObject({
      category: "environment",
      retryable: false,
      sideEffect: "unknown",
      blastRadius: "workflow",
      code: "fallback.exhausted",
      droppedGuarantees: [expect.stringContaining("no fallback steps")],
      failures: [],
      evidence: [],
    });
  });

  it("does not report degradation for an ideal primary result", async () => {
    const notifications: unknown[] = [];
    const outcome = await withFallback(
      "read",
      [{ name: "primary", degrades: [], run: async () => "fresh" }],
      (notification) => notifications.push(notification),
    );

    expect(outcome).toStrictEqual({
      value: "fresh",
      servedBy: "primary",
      degradedGuarantees: [],
      priorFailures: [],
    });
    expect(notifications).toStrictEqual([]);
  });

  it("reports a declared degradation even when the first step serves", async () => {
    const notifications: unknown[] = [];
    const outcome = await withFallback(
      "read",
      [{ name: "cache", degrades: ["freshness"], run: async () => "validated-cache" }],
      (notification) => notifications.push(notification),
    );

    expect(notifications).toStrictEqual([{ servedBy: "cache", degradedGuarantees: ["freshness"], priorFailures: [] }]);
    expect(outcome.degradedGuarantees).toStrictEqual(["freshness"]);

    await expect(
      withFallback("read", [{ name: "cache", degrades: ["freshness"], run: async () => "validated-cache" }]),
    ).resolves.toMatchObject({ servedBy: "cache" });
  });

  it("reports prior failure evidence when an equivalent fallback serves", async () => {
    const primaryFailure = transient();
    const notifications: unknown[] = [];
    const outcome = await withFallback(
      "read",
      [
        {
          name: "primary",
          degrades: [],
          run: async () => {
            throw primaryFailure;
          },
        },
        { name: "replica", degrades: [], run: async () => "current" },
      ],
      (notification) => notifications.push(notification),
    );

    const priorFailures = [{ step: "primary", error: primaryFailure }];
    expect(outcome.priorFailures).toStrictEqual(priorFailures);
    expect(notifications).toStrictEqual([{ servedBy: "replica", degradedGuarantees: [], priorFailures }]);
  });

  it("retains ordered failure evidence and labels total outage when no guarantees were declared", async () => {
    const first = transient("primary down");
    const second = transient("replica down");

    await expect(
      withFallback("ledger-read", [
        {
          name: "primary",
          degrades: [],
          run: async () => {
            throw first;
          },
        },
        {
          name: "replica",
          degrades: [],
          run: async () => {
            throw second;
          },
        },
      ]),
    ).rejects.toMatchObject({
      droppedGuarantees: [expect.stringContaining("ledger-read")],
      failures: [
        { step: "primary", error: first },
        { step: "replica", error: second },
      ],
      evidence: [expect.stringContaining("primary"), expect.stringContaining("replica")],
    });
  });
});

describe("bounded retry contracts", () => {
  it("preserves exhaustion classification, attempt evidence, and the final side-effect state", () => {
    const attempts = [transient("first", "unknown"), transient("second", "none"), transient("third", "occurred")];
    const exhausted = new RetryExhaustedError("write", attempts);

    expect(exhausted).toMatchObject({
      category: "environment",
      retryable: false,
      sideEffect: "occurred",
      blastRadius: "workflow",
      code: "environment.retry_exhausted",
    });
    expect(exhausted.attempts).toBe(attempts);
    expect(exhausted.cause).toBe(attempts[2]);
    expect(exhausted.evidence.map((item) => item.split(":", 1)[0])).toStrictEqual([
      "attempt 1",
      "attempt 2",
      "attempt 3",
    ]);
    expect(exhausted.evidence.map((item) => item.includes("[tool.transient]"))).toStrictEqual([true, true, true]);

    const empty = new RetryExhaustedError("empty", []);
    expect(empty.sideEffect).toBe("unknown");
    expect(empty.cause).toBeUndefined();
    expect(empty.evidence).toStrictEqual([]);
  });

  it("rejects zero and fractional attempt budgets before invoking the operation", async () => {
    let calls = 0;
    for (const maxAttempts of [0, 1.5]) {
      await expect(
        withRetry(
          "bounded-operation",
          async () => {
            calls += 1;
            return "unexpected";
          },
          { maxAttempts, baseDelayMs: 10, maxDelayMs: 100, sideEffectSafe: true },
          async () => {},
        ),
      ).rejects.toMatchObject({
        category: "environment",
        retryable: false,
        sideEffect: "none",
        blastRadius: "local",
        code: "environment.invalid_retry_policy",
      });
    }
    expect(calls).toBe(0);
  });

  it("passes exact attempt contexts, bounds retries, and records prior errors", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const contexts: unknown[] = [];
    const sleeps: number[] = [];
    const firstFailure = transient();

    const outcome = await withRetry(
      "read",
      async (context) => {
        contexts.push(context);
        if (context.attempt === 1) throw firstFailure;
        return "ok";
      },
      { maxAttempts: 2, baseDelayMs: 10, maxDelayMs: 100, sideEffectSafe: true },
      async (delay) => {
        sleeps.push(delay);
      },
    );

    expect(contexts).toStrictEqual([{ attempt: 1 }, { attempt: 2 }]);
    expect(sleeps).toStrictEqual([5]);
    expect(outcome).toStrictEqual({ value: "ok", attempts: 2, errors: [firstFailure] });
  });

  it("does not reclassify a permanent final failure as retry exhaustion", async () => {
    const finalFailure = new ToolError("invalid response", {
      retryable: false,
      sideEffect: "none",
      blastRadius: "local",
      code: "tool.invalid_response",
    });
    let calls = 0;

    const result = withRetry(
      "read",
      async () => {
        calls += 1;
        if (calls === 1) throw transient();
        throw finalFailure;
      },
      { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 1, sideEffectSafe: true },
      async () => {},
    );

    await expect(result).rejects.toBe(finalFailure);
    expect(calls).toBe(2);
  });

  it("marks an unsafe retry-policy rejection as non-retryable and side-effect free", async () => {
    await expect(
      withRetry(
        "write",
        async () => "never",
        { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 2 },
        async () => {},
      ),
    ).rejects.toMatchObject({
      category: "environment",
      retryable: false,
      sideEffect: "none",
      blastRadius: "local",
      code: "environment.unsafe_retry_policy",
    });
  });
});

describe("session reconciliation integrity", () => {
  const checkpoint: Checkpoint = {
    session_id: "session-1",
    version: 3,
    correlation_id: "trace-session",
    goal: "resume safely",
    ledger: [
      { task_id: "applied", status: "in_progress", owner: "worker", attempt: 1 },
      { task_id: "retry", status: "in_progress", owner: "worker", attempt: 7 },
      { task_id: "ready", status: "ready", owner: "worker", attempt: 0 },
      { task_id: "pending", status: "pending", owner: "worker", attempt: 0 },
      { task_id: "obsolete", status: "superseded", owner: "worker", attempt: 2 },
      { task_id: "done", status: "completed", owner: "worker", attempt: 1 },
      { task_id: "failed", status: "failed", owner: "worker", attempt: 2 },
      { task_id: "blocked", status: "blocked", owner: "worker", attempt: 1 },
    ],
    decisions: [],
    assumptions: [],
    completedEffects: [
      { key: "applied", effect: "payment sent", completedAt: "2026-08-08T10:00:00.000Z" },
      { key: "orphan-effect", effect: "audit written", completedAt: "2026-08-08T10:01:00.000Z" },
    ],
    nextAction: "reconcile",
    savedAt: "2026-08-08T10:02:00.000Z",
  };

  it("keeps every reconciliation collection ordered, complete, and free of replayed effects", () => {
    const plan = reconcile(checkpoint);

    expect(plan.checkpoint).toBe(checkpoint);
    expect(plan.resumable).toStrictEqual([
      { task_id: "retry", status: "ready", owner: "worker", attempt: 8 },
      { task_id: "ready", status: "ready", owner: "worker", attempt: 0 },
      { task_id: "pending", status: "pending", owner: "worker", attempt: 0 },
    ]);
    expect(plan.stale).toStrictEqual([
      { task_id: "applied", status: "completed", owner: "worker", attempt: 1 },
      { task_id: "obsolete", status: "superseded", owner: "worker", attempt: 2 },
    ]);
    expect(plan.doNotReplay).toStrictEqual(["applied", "orphan-effect"]);
  });

  it("classifies corrupt checkpoints and retains schema issue evidence", async () => {
    const memory = new InMemoryStore();
    await memory.set("checkpoints", "corrupt", { session_id: "" });

    let failure: unknown;
    try {
      await new CheckpointStore(memory).load("corrupt");
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(ReasoningError);
    if (!(failure instanceof ReasoningError)) throw new Error("checkpoint corruption was not classified");
    expect(failure).toMatchObject({
      category: "reasoning",
      retryable: false,
      sideEffect: "none",
      blastRadius: "workflow",
      code: "reasoning.corrupt_checkpoint",
    });
    expect(failure.evidence.length).toBeGreaterThan(1);
    expect(failure.evidence.every((item) => typeof item === "string" && item.length > 0)).toBe(true);
    expect(failure.evidence.some((item) => item.startsWith("session_id:"))).toBe(true);
  });
});

describe("tool enforcement and observability contracts", () => {
  it("correlates successful tool spans and records deterministic elapsed duration", async () => {
    vi.spyOn(Date, "now").mockReturnValueOnce(10_000).mockReturnValueOnce(10_037);
    const { tracer, events } = collectTracer();
    const execute = vi.fn(async ({ value }: { value: number }) => ({ doubled: value * 2 }));
    const contract = {
      name: "double",
      description: "Doubles one number.",
      input: z.object({ value: z.number() }),
      output: z.object({ doubled: z.number() }),
      sideEffect: "read-only" as const,
      idempotent: true,
      execute,
    };
    const tool = defineContractTool(contract, {
      context: { agentId: "calculator-agent", writeScopes: [] },
      tracer,
      traceId: "trace-tool-success",
    });

    await expect(executeTool(tool, { value: 4 })).resolves.toStrictEqual({ doubled: 8 });
    expect(execute).toHaveBeenCalledOnce();
    expect(events.map((event) => event.type)).toStrictEqual(["tool.call", "tool.result"]);
    expect(events[0]).toMatchObject({
      trace_id: "trace-tool-success",
      parent_span_id: null,
      actor: "calculator-agent",
      tool: "double",
    });
    expect(events[0]?.span_id).toEqual(expect.any(String));
    expect(events[0]?.span_id.length).toBeGreaterThan(0);
    expect(events[1]?.trace_id).toBe(events[0]?.trace_id);
    expect(events[1]?.span_id).toBe(events[0]?.span_id);
    expect(events[1]).toMatchObject({ type: "tool.result", durationMs: 37 });
  });

  it("classifies invalid input before execution and retains field-level evidence", async () => {
    const execute = vi.fn(async ({ value }: { value: number }) => ({ doubled: value * 2 }));
    const tool = defineContractTool(
      {
        name: "double",
        description: "Doubles one number.",
        input: z.object({ value: z.number() }),
        sideEffect: "read-only",
        idempotent: true,
        execute,
      },
      { context: { agentId: "calculator-agent", writeScopes: [] } },
    );

    await expect(executeTool(tool, { value: "four" })).rejects.toMatchObject({
      category: "reasoning",
      retryable: false,
      sideEffect: "none",
      blastRadius: "local",
      code: "reasoning.tool_input_invalid",
      evidence: [expect.stringContaining("value")],
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it("denies missing write scope with auditable evidence and no side effect", async () => {
    const execute = vi.fn(async ({ id }: { id: string }) => ({ deleted: id }));
    const tool = defineContractTool(
      {
        name: "delete-record",
        description: "Deletes one record.",
        input: z.object({ id: z.string() }),
        sideEffect: "destructive",
        idempotent: false,
        writeScope: "records",
        execute,
      },
      { context: { agentId: "reader", writeScopes: ["reports"] } },
    );

    await expect(executeTool(tool, { id: "R-1" })).rejects.toMatchObject({
      category: "policy",
      retryable: false,
      sideEffect: "none",
      blastRadius: "local",
      code: "policy.write_scope_denied",
      evidence: ["agentScopes=[reports]", "requiredScope=records"],
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it("traces invalid output with exact classification and deterministic duration", async () => {
    vi.spyOn(Date, "now").mockReturnValueOnce(20_000).mockReturnValueOnce(20_019);
    const { tracer, events } = collectTracer();
    const execute = vi.fn(async () => ({ value: "invalid" }) as never);
    const tool = defineContractTool(
      {
        name: "read-count",
        description: "Reads a count.",
        input: z.object({}),
        output: z.object({ value: z.number() }),
        sideEffect: "read-only",
        idempotent: true,
        execute,
      },
      {
        context: { agentId: "reader", writeScopes: [] },
        tracer,
        traceId: "trace-tool-error",
      },
    );

    await expect(executeTool(tool, {})).rejects.toMatchObject({
      category: "tool",
      retryable: false,
      sideEffect: "unknown",
      blastRadius: "local",
      code: "tool.output_invalid",
      evidence: [expect.stringContaining("value")],
    });
    expect(execute).toHaveBeenCalledOnce();
    expect(events.map((event) => event.type)).toStrictEqual(["tool.call", "tool.error"]);
    expect(events[1]).toMatchObject({
      trace_id: "trace-tool-error",
      span_id: events[0]?.span_id,
      actor: "reader",
      type: "tool.error",
      code: "tool.output_invalid",
      category: "tool",
      retryable: false,
      durationMs: 19,
    });
  });

  it("classifies postcondition failures with the independent verdict as evidence", async () => {
    const tool = defineContractTool(
      {
        name: "write-record",
        description: "Writes and verifies one record.",
        input: z.object({ id: z.string() }),
        sideEffect: "mutating",
        idempotent: true,
        writeScope: "records",
        execute: async ({ id }) => ({ id }),
        postcondition: () => "record was absent on reconciliation read",
      },
      { context: { agentId: "writer", writeScopes: ["records"] } },
    );

    await expect(executeTool(tool, { id: "R-1" })).rejects.toMatchObject({
      category: "reasoning",
      retryable: false,
      sideEffect: "unknown",
      blastRadius: "workflow",
      code: "reasoning.postcondition_failed",
      evidence: ["record was absent on reconciliation read"],
    });
  });

  it("summarizes operational contract metadata without executing the tool", () => {
    const description = "Deletes one expired record; never use for active records.";
    const summary = contractSummary({
      name: "delete-expired",
      description,
      input: z.object({ id: z.string() }),
      sideEffect: "destructive",
      idempotent: false,
      execute: async ({ id }) => ({ id }),
    });

    expect(summary).toContain("delete-expired");
    expect(summary).toContain("destructive");
    expect(summary).toContain("NOT idempotent");
    expect(summary).toContain(description);
  });
});

describe("approval boundaries and audit evidence", () => {
  it("preserves configured trace identity, actor, span, expiry, and latency", async () => {
    vi.spyOn(Date, "now").mockReturnValueOnce(1_000).mockReturnValueOnce(1_025);
    const { tracer, events } = collectTracer();
    let observed: ApprovalRequest | undefined;
    const handler = vi.fn(async (request: ApprovalRequest) => {
      observed = request;
      return { approved: true as const, approver: "reviewer", decidedAt: request.requestedAt };
    });
    const gate = new ApprovalGate(handler, {
      timeoutMs: 500,
      tracer,
      traceId: "trace-approval",
      actor: "approval-control",
    });

    await expect(
      gate.requireApproval(
        { kind: "payment.send", actor: "payments-agent", payload: { amount: 1_001 } },
        "manual review required",
      ),
    ).resolves.toMatchObject({ approved: true, approver: "reviewer" });

    expect(handler).toHaveBeenCalledOnce();
    expect(observed).toBeDefined();
    if (observed === undefined) throw new Error("approval request was not observed");
    expect(Date.parse(observed.expiresAt) - Date.parse(observed.requestedAt)).toBe(500);
    expect(events.map((event) => event.type)).toStrictEqual(["approval.requested", "approval.decided"]);
    expect(events[0]).toMatchObject({
      trace_id: "trace-approval",
      parent_span_id: null,
      actor: "approval-control",
      actionKind: "payment.send",
    });
    expect(events[0]?.span_id).toEqual(expect.any(String));
    expect(events[0]?.span_id.length).toBeGreaterThan(0);
    expect(events[1]).toMatchObject({
      trace_id: "trace-approval",
      span_id: events[0]?.span_id,
      actor: "approval-control",
      approved: true,
      approver: "reviewer",
      latencyMs: 25,
    });
  });

  it("accepts a decision exactly at expiry but rejects one millisecond after it", async () => {
    vi.spyOn(Date, "now").mockReturnValue(5_000);
    const action = { kind: "payment.send", actor: "payments-agent", payload: { amount: 1_001 } };
    const atBoundary = new ApprovalGate(
      async (request) => ({ approved: true, approver: "reviewer", decidedAt: request.expiresAt }),
      { timeoutMs: 500 },
    );
    const afterBoundary = new ApprovalGate(
      async (request) => ({
        approved: true,
        approver: "reviewer",
        decidedAt: new Date(Date.parse(request.expiresAt) + 1).toISOString(),
      }),
      { timeoutMs: 500 },
    );

    await expect(atBoundary.requireApproval(action, "manual review required")).resolves.toMatchObject({
      approved: true,
    });
    await expect(afterBoundary.requireApproval(action, "manual review required")).rejects.toMatchObject({
      code: "policy.approval_expired",
    });
  });

  it("retains request evidence for every fail-closed approval outcome", async () => {
    vi.spyOn(Date, "now").mockReturnValue(10_000);

    const handlerFailure = await approvalFailure(async () => {
      throw new Error("approval service unavailable");
    });
    expect(handlerFailure.error).toMatchObject({
      category: "policy",
      retryable: false,
      sideEffect: "none",
      code: "policy.approval_handler_error",
      evidence: [`request=${handlerFailure.request.id}`],
    });

    const unanswered = await approvalFailure(async () => null, 750);
    expect(unanswered.error).toMatchObject({
      code: "policy.approval_unanswered",
      evidence: [`request=${unanswered.request.id}`, "timeoutMs=750"],
    });

    const expired = await approvalFailure(async (request) => ({
      approved: true,
      approver: "reviewer",
      decidedAt: new Date(Date.parse(request.expiresAt) + 1).toISOString(),
    }));
    expect(expired.error).toMatchObject({
      code: "policy.approval_expired",
      evidence: [`request=${expired.request.id}`, `expiredAt=${expired.request.expiresAt}`],
    });

    const denied = await approvalFailure(async (request) => ({
      approved: false,
      approver: "reviewer",
      decidedAt: request.requestedAt,
      reason: "risk not accepted",
    }));
    expect(denied.error).toMatchObject({
      code: "policy.approval_denied",
      evidence: [`request=${denied.request.id}`, "approver=reviewer"],
    });
  });
});

describe("deterministic enforcement boundaries", () => {
  it("allows the exact budget ceiling and rejects the smallest amount above it", async () => {
    const layer = budgetLayer("payment-ceiling", (payload) => (payload as { amount: number }).amount, 100);
    const action = (amount: number) => ({ kind: "payment.send", actor: "payments-agent", payload: { amount } });

    expect(await layer.check(action(100))).toBeUndefined();
    expect(await layer.check(action(100.000_001))).toContain("exceeds deterministic ceiling");
  });

  it("allows a clean enforcement decision and classifies denial metadata at the point of no return", async () => {
    const action = { kind: "refund.create", actor: "support-agent", payload: { amount: 25 } };
    await expect(enforceOrThrow(action, [{ name: "allow", check: async () => undefined }])).resolves.toBeUndefined();

    let failure: unknown;
    try {
      await enforceOrThrow(action, [{ name: "change-control", check: async () => "ticket is not approved" }]);
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({
      category: "policy",
      retryable: false,
      sideEffect: "none",
      blastRadius: "local",
      code: "policy.enforcement_denied",
      evidence: ["kind=refund.create", "actor=support-agent", "layer=change-control"],
    });
    expect(failure).toBeInstanceOf(Error);
    if (!(failure instanceof Error)) throw new Error("denial was not classified");
    expect(failure.message).toContain("ticket is not approved");
    expect(failure.message).toContain("change-control");
  });

  it("reports all schema fields and an empty authorization allowlist in denial evidence", async () => {
    const schema = schemaLayer(
      "payment-schema",
      z.object({ amount: z.number().positive(), currency: z.literal("USD") }),
    );
    const schemaReason = await schema.check({
      kind: "payment.send",
      actor: "payments-agent",
      payload: { amount: -1, currency: "EUR" },
    });
    expect(schemaReason).toContain("amount");
    expect(schemaReason).toContain("currency");

    const authorization = authorizationLayer({});
    const authorizationReason = await authorization.check({
      kind: "payment.send",
      actor: "unknown-agent",
      payload: {},
    });
    expect(authorizationReason).toContain("unknown-agent");
    expect(authorizationReason).toContain("payment.send");
    expect(authorizationReason).toContain("nothing");
  });

  it("retains a failed reconciliation verdict in structured postcondition evidence", async () => {
    await expect(verifyPostcondition("record exists", async () => true)).resolves.toBeUndefined();
    await expect(
      verifyPostcondition("record exists", async () => "record missing on independent read"),
    ).rejects.toMatchObject({
      category: "reasoning",
      retryable: false,
      sideEffect: "unknown",
      blastRadius: "workflow",
      code: "reasoning.postcondition_failed",
      evidence: ["record missing on independent read"],
    });
  });
});

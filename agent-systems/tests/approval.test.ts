import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { TraceEvent } from "../src/core/trace/events.js";
import {
  ApprovalGate,
  approvalLayer,
  autoDenyHandler,
  type ApprovalDecision,
  type ApprovalHandler,
  type ApprovalRequest,
} from "../src/core/validation/approval.js";
import { authorizationLayer, budgetLayer, enforce, schemaLayer } from "../src/core/validation/enforcement.js";

const START_TIME = new Date("2026-08-08T12:00:00.000Z");

const action = (amount: number) => ({
  kind: "payment.send",
  actor: "payments-agent",
  payload: { amount, currency: "USD" },
});

// One-argument implementations intentionally remain assignable to ApprovalHandler.
const approve =
  (approver = "dana"): ApprovalHandler =>
  async (request) => ({
    requestId: request.id,
    approved: true,
    approver,
    decidedAt: new Date().toISOString(),
  });

const deny =
  (reason: string): ApprovalHandler =>
  async (request) => ({
    requestId: request.id,
    approved: false,
    approver: "dana",
    decidedAt: new Date().toISOString(),
    reason,
  });

function untrustedDecision(decide: (request: ApprovalRequest) => unknown): ApprovalHandler {
  return async (request) => decide(request) as ApprovalDecision;
}

function collectTracer() {
  const events: TraceEvent[] = [];
  return { tracer: { emit: (event: TraceEvent) => events.push(event) }, events };
}

function expectExactlyOneTerminalTrace(events: readonly TraceEvent[]): void {
  expect(events.filter((event) => event.type === "approval.decided")).toHaveLength(1);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(START_TIME);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("ApprovalGate", () => {
  it("returns a request-bound decision when a human approves", async () => {
    const { tracer, events } = collectTracer();
    let observedRequest: ApprovalRequest | undefined;
    const handler: ApprovalHandler = async (request) => {
      observedRequest = request;
      return {
        requestId: request.id,
        approved: true,
        approver: "dana",
        decidedAt: new Date().toISOString(),
      };
    };
    const gate = new ApprovalGate(handler, { tracer });

    const decision = await gate.requireApproval(action(5_000), "over threshold");

    expect(decision).toMatchObject({
      requestId: observedRequest?.id,
      approved: true,
      approver: "dana",
    });
    expect(events.map((event) => event.type)).toEqual(["approval.requested", "approval.decided"]);
    expect(events[1]).toMatchObject({ approved: true, approver: "dana", actionKind: "payment.send" });
    expect(events[0]?.trace_id).toBe(events[1]?.trace_id);
    expectExactlyOneTerminalTrace(events);
  });

  it("throws a traced PolicyError when a human denies", async () => {
    const { tracer, events } = collectTracer();
    let requestId = "";
    const gate = new ApprovalGate(
      async (request) => {
        requestId = request.id;
        return {
          requestId: request.id,
          approved: false,
          approver: "dana",
          decidedAt: new Date().toISOString(),
          reason: "too risky",
        };
      },
      { tracer },
    );

    await expect(gate.requireApproval(action(5_000), "over threshold")).rejects.toMatchObject({
      category: "policy",
      code: "policy.approval_denied",
      retryable: false,
      sideEffect: "none",
      blastRadius: "local",
      evidence: [`request=${requestId}`, "approver=dana"],
    });
    expect(events.at(-1)).toMatchObject({ type: "approval.decided", approved: false, approver: "dana" });
    expectExactlyOneTerminalTrace(events);
  });

  it("fails closed and traces once when the handler returns null", async () => {
    const { tracer, events } = collectTracer();
    let requestId = "";
    const gate = new ApprovalGate(
      async (request) => {
        requestId = request.id;
        return null;
      },
      { timeoutMs: 10, tracer },
    );

    await expect(gate.requireApproval(action(5_000), "over threshold")).rejects.toMatchObject({
      code: "policy.approval_unanswered",
      evidence: [`request=${requestId}`, "timeoutMs=10"],
    });
    expect(events.at(-1)).toMatchObject({ type: "approval.decided", approved: false });
    expectExactlyOneTerminalTrace(events);
  });

  it("fails closed and traces once when the handler errors", async () => {
    const { tracer, events } = collectTracer();
    let requestId = "";
    const gate = new ApprovalGate(
      async (request) => {
        requestId = request.id;
        throw new Error("pager unreachable");
      },
      { tracer },
    );

    await expect(gate.requireApproval(action(5_000), "over threshold")).rejects.toMatchObject({
      category: "policy",
      retryable: false,
      code: "policy.approval_handler_error",
      evidence: [`request=${requestId}`],
    });
    expectExactlyOneTerminalTrace(events);
  });

  it("bounds a never-resolving handler, aborts it, and fails closed", async () => {
    const { tracer, events } = collectTracer();
    let observedSignal: AbortSignal | undefined;
    let aborts = 0;
    const handler: ApprovalHandler = async (_request, signal) =>
      await new Promise<ApprovalDecision | null>((_resolve, reject) => {
        observedSignal = signal;
        signal.addEventListener(
          "abort",
          () => {
            aborts += 1;
            reject(new Error("approval request aborted"));
          },
          { once: true },
        );
      });
    const gate = new ApprovalGate(handler, { timeoutMs: 50, tracer });

    const pending = gate.requireApproval(action(5_000), "over threshold");
    let settled = false;
    void pending.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    const rejection = expect(pending).rejects.toMatchObject({ code: "policy.approval_expired" });

    await vi.advanceTimersByTimeAsync(49);
    expect(settled).toBe(false);
    expect(observedSignal?.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await rejection;
    expect(settled).toBe(true);
    expect(observedSignal?.aborted).toBe(true);
    expect(aborts).toBe(1);
    expectExactlyOneTerminalTrace(events);
  });

  it("ignores a late backdated response after the real deadline", async () => {
    const { tracer, events } = collectTracer();
    let lateWorkCompleted = false;
    let observedSignal: AbortSignal | undefined;
    const gate = new ApprovalGate(
      async (request, signal) => {
        observedSignal = signal;
        return await new Promise<ApprovalDecision>((resolve) => {
          setTimeout(() => {
            lateWorkCompleted = true;
            resolve({
              requestId: request.id,
              approved: true,
              approver: "late-dana",
              decidedAt: request.requestedAt,
            });
          }, 101);
        });
      },
      { timeoutMs: 100, tracer },
    );

    const pending = gate.requireApproval(action(5_000), "over threshold");
    const rejection = expect(pending).rejects.toMatchObject({ code: "policy.approval_expired" });

    await vi.advanceTimersByTimeAsync(100);
    await rejection;
    expect(observedSignal?.aborted).toBe(true);
    expect(lateWorkCompleted).toBe(false);
    expectExactlyOneTerminalTrace(events);

    await vi.advanceTimersByTimeAsync(1);
    expect(lateWorkCompleted).toBe(true);
    expectExactlyOneTerminalTrace(events);
  });

  it("rejects actual arrival after expiry even when decidedAt is backdated", async () => {
    const { tracer, events } = collectTracer();
    let observedSignal: AbortSignal | undefined;
    const gate = new ApprovalGate(
      async (request, signal) => {
        observedSignal = signal;
        vi.setSystemTime(Date.parse(request.expiresAt) + 1);
        return {
          requestId: request.id,
          approved: true,
          approver: "backdating-dana",
          decidedAt: request.requestedAt,
        };
      },
      { timeoutMs: 100, tracer },
    );

    await expect(gate.requireApproval(action(5_000), "over threshold")).rejects.toMatchObject({
      code: "policy.approval_expired",
    });
    expect(observedSignal?.aborted).toBe(true);
    expectExactlyOneTerminalTrace(events);
  });

  it("rejects a declared decision timestamp after expiry", async () => {
    const { tracer, events } = collectTracer();
    const gate = new ApprovalGate(
      async (request) => ({
        requestId: request.id,
        approved: true,
        approver: "slow-dana",
        decidedAt: new Date(Date.parse(request.expiresAt) + 1).toISOString(),
      }),
      { timeoutMs: 10, tracer },
    );

    await expect(gate.requireApproval(action(5_000), "over threshold")).rejects.toMatchObject({
      code: "policy.approval_expired",
    });
    expectExactlyOneTerminalTrace(events);
  });

  it("preserves the exact-expiry boundary for a decision arriving at that instant", async () => {
    const { tracer, events } = collectTracer();
    const gate = new ApprovalGate(
      async (request) => {
        vi.setSystemTime(Date.parse(request.expiresAt));
        return {
          requestId: request.id,
          approved: true,
          approver: "boundary-dana",
          decidedAt: request.expiresAt,
        };
      },
      { timeoutMs: 100, tracer },
    );

    await expect(gate.requireApproval(action(5_000), "over threshold")).resolves.toMatchObject({
      approved: true,
      approver: "boundary-dana",
    });
    expectExactlyOneTerminalTrace(events);
  });

  it.each([
    ["an undefined result", () => undefined],
    [
      "a non-ISO decidedAt",
      (request: ApprovalRequest) => ({
        requestId: request.id,
        approved: true,
        approver: "dana",
        decidedAt: "August 8, 2026",
      }),
    ],
  ])("runtime-rejects malformed decision: %s", async (_name, makeDecision) => {
    const { tracer, events } = collectTracer();
    let requestId = "";
    const gate = new ApprovalGate(
      untrustedDecision((request) => {
        requestId = request.id;
        return makeDecision(request);
      }),
      { tracer },
    );

    await expect(gate.requireApproval(action(5_000), "over threshold")).rejects.toMatchObject({
      category: "policy",
      retryable: false,
      sideEffect: "none",
      blastRadius: "local",
      code: "policy.approval_invalid_decision",
      evidence: [`request=${requestId}`, "schema=ApprovalDecision"],
    });
    expectExactlyOneTerminalTrace(events);
  });

  it("rejects a validly-shaped decision bound to another request", async () => {
    const { tracer, events } = collectTracer();
    let requestId = "";
    const gate = new ApprovalGate(
      async (request) => {
        requestId = request.id;
        return {
          requestId: "another-request-id",
          approved: true,
          approver: "dana",
          decidedAt: new Date().toISOString(),
        };
      },
      { tracer },
    );

    await expect(gate.requireApproval(action(5_000), "over threshold")).rejects.toMatchObject({
      category: "policy",
      retryable: false,
      code: "policy.approval_request_mismatch",
      evidence: [`request=${requestId}`, "decisionRequest=another-request-id"],
    });
    expectExactlyOneTerminalTrace(events);
  });

  it.each([
    ["zero", 0],
    ["negative", -1],
    ["NaN", Number.NaN],
    ["positive infinity", Number.POSITIVE_INFINITY],
    ["negative infinity", Number.NEGATIVE_INFINITY],
    ["above the timer limit", 2_147_483_648],
    ["null from JavaScript", null],
    ["a numeric string from JavaScript", "100"],
  ])("rejects unsupported timeoutMs: %s", (_name, timeoutMs) => {
    let caught: unknown;
    try {
      new ApprovalGate(autoDenyHandler, { timeoutMs: timeoutMs as number });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(RangeError);
    expect(caught).toMatchObject({
      message: "ApprovalGate timeoutMs must be a finite positive duration no greater than 2147483647 milliseconds.",
    });
  });

  it("accepts the maximum supported timer duration exactly", () => {
    expect(() => new ApprovalGate(autoDenyHandler, { timeoutMs: 2_147_483_647 })).not.toThrow();
  });

  it("fails closed when the handler throws synchronously before returning a promise", async () => {
    const syncThrower = (() => {
      throw new Error("handler crashed before returning a promise");
    }) as unknown as ApprovalHandler;
    const { tracer, events } = collectTracer();
    const gate = new ApprovalGate(syncThrower, { timeoutMs: 10, tracer });

    await expect(gate.requireApproval(action(5_000), "over threshold")).rejects.toMatchObject({
      category: "policy",
      retryable: false,
      code: "policy.approval_handler_error",
    });
    expectExactlyOneTerminalTrace(events);
  });

  it("rejects decisions whose approver is only whitespace", async () => {
    const gate = new ApprovalGate(
      untrustedDecision((request) => ({
        requestId: request.id,
        approved: true,
        approver: "   ",
        decidedAt: new Date().toISOString(),
      })),
      { timeoutMs: 1_000 },
    );

    await expect(gate.requireApproval(action(5_000), "over threshold")).rejects.toMatchObject({
      code: "policy.approval_invalid_decision",
    });
  });

  it("rejects denials whose reason is only whitespace", async () => {
    const gate = new ApprovalGate(
      untrustedDecision((request) => ({
        requestId: request.id,
        approved: false,
        approver: "dana",
        decidedAt: new Date().toISOString(),
        reason: "   ",
      })),
      { timeoutMs: 1_000 },
    );

    await expect(gate.requireApproval(action(5_000), "over threshold")).rejects.toMatchObject({
      code: "policy.approval_invalid_decision",
    });
  });

  it("clears the deadline timer after a prompt approval so the signal never aborts", async () => {
    let captured: AbortSignal | undefined;
    const gate = new ApprovalGate(
      async (request, signal) => {
        captured = signal;
        return {
          requestId: request.id,
          approved: true,
          approver: "dana",
          decidedAt: new Date().toISOString(),
        };
      },
      { timeoutMs: 1_000 },
    );

    const pending = gate.requireApproval(action(5_000), "over threshold");
    await vi.advanceTimersByTimeAsync(0);
    await expect(pending).resolves.toMatchObject({ approved: true });
    expect(captured?.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(captured?.aborted).toBe(false);
  });

  it("autoDenyHandler answers null so unattended gates fail closed", async () => {
    const request: ApprovalRequest = {
      id: "req-unattended",
      action: action(1),
      reason: "unattended",
      requestedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 1_000).toISOString(),
    };
    await expect(autoDenyHandler(request, new AbortController().signal)).resolves.toBeNull();
  });
});

describe("approvalLayer in the enforcement pipeline", () => {
  const layers = (gate: ApprovalGate) => [
    schemaLayer("payment-schema", z.object({ amount: z.number().positive(), currency: z.literal("USD") })),
    authorizationLayer({ "payments-agent": ["payment.send"] }),
    budgetLayer("auto-limit", (payload) => (payload as { amount: number }).amount, 10_000),
    approvalLayer(gate, {
      requiresApproval: (candidate) =>
        (candidate.payload as { amount: number }).amount > 1_000 ? "exceeds $1,000 approval threshold" : undefined,
    }),
  ];

  it("lets small actions through without touching the human", async () => {
    let asked = 0;
    const gate = new ApprovalGate(async (request) => {
      asked += 1;
      return {
        requestId: request.id,
        approved: true,
        approver: "dana",
        decidedAt: new Date().toISOString(),
      };
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
    const gate = new ApprovalGate(async (request) => {
      asked += 1;
      return {
        requestId: request.id,
        approved: true,
        approver: "dana",
        decidedAt: new Date().toISOString(),
      };
    });
    const decision = await enforce(action(50_000), layers(gate));
    expect(decision.allowed).toBe(false);
    expect(decision.deniedBy).toBe("auto-limit");
    expect(asked).toBe(0);
  });
});

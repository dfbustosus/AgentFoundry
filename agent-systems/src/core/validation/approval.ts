/**
 * Human-in-the-loop approval gates: the 8th enforcement layer.
 *
 * Some actions are too consequential for any automated pipeline, no matter how
 * many layers it has. For those, the system must be able to STOP and wait for
 * a human — in code, with an audit trail. This module implements that stop.
 *
 * Safety properties, enforced here and untouchable by prompts:
 * - FAIL CLOSED: no answer, a handler error, a timeout, or an expired request
 *   all deny the action. Silence is never consent.
 * - Every request and decision is traced (approval.requested / approval.decided).
 * - The gate slots into the enforcement pipeline as an ordinary layer, so
 *   ordering stays explicit: schema → authorization → budget → approval.
 */

import { randomUUID } from "node:crypto";
import { z } from "zod";
import { PolicyError } from "../errors/taxonomy.js";
import { newSpanId, nowIso, type Tracer } from "../trace/tracer.js";
import type { ActionProposal, EnforcementLayer } from "./enforcement.js";

export interface ApprovalRequest {
  readonly id: string;
  readonly action: ActionProposal;
  /** Why a human must decide, stated for the approver. */
  readonly reason: string;
  readonly requestedAt: string;
  /** ISO timestamp; decisions observed after this instant are rejected. Equality is valid. */
  readonly expiresAt: string;
}

export type ApprovalDecision =
  | {
      /** Must equal the ApprovalRequest.id that prompted this decision. */
      readonly requestId: string;
      readonly approved: true;
      readonly approver: string;
      readonly decidedAt: string;
    }
  | {
      /** Must equal the ApprovalRequest.id that prompted this decision. */
      readonly requestId: string;
      readonly approved: false;
      readonly approver: string;
      readonly decidedAt: string;
      readonly reason: string;
    };

const approvalDecisionSchema: z.ZodType<ApprovalDecision> = z.discriminatedUnion("approved", [
  z
    .object({
      requestId: z.string().min(1),
      approved: z.literal(true),
      approver: z.string().trim().min(1),
      decidedAt: z.iso.datetime(),
    })
    .strict(),
  z
    .object({
      requestId: z.string().min(1),
      approved: z.literal(false),
      approver: z.string().trim().min(1),
      decidedAt: z.iso.datetime(),
      reason: z.string().trim().min(1),
    })
    .strict(),
]);

/**
 * The human's interface. Return a decision, or null when no human answered.
 * Implementations MUST NOT auto-approve; the whole point is a real decision.
 * The signal aborts when the request deadline is reached. Handlers that only
 * accept the request remain assignable; cooperative handlers should stop work.
 */
export type ApprovalHandler = (request: ApprovalRequest, signal: AbortSignal) => Promise<ApprovalDecision | null>;

/** Decides which actions require human sign-off, and why. */
export interface ApprovalPolicy {
  /** Return a reason string when the action needs approval, undefined otherwise. */
  readonly requiresApproval: (action: ActionProposal) => string | undefined;
}

export interface ApprovalGateOptions {
  /** Finite positive duration for which a request stays valid. Default 5 minutes. */
  readonly timeoutMs?: number;
  readonly tracer?: Tracer;
  /** Trace correlation id; generated per request when omitted. */
  readonly traceId?: string;
  readonly actor?: string;
}

const DEFAULT_TIMEOUT_MS = 300_000;
const MAX_TIMER_DURATION_MS = 2_147_483_647;

type HandlerOutcome =
  | { readonly kind: "response"; readonly value: unknown; readonly arrivedAt: number }
  | { readonly kind: "error"; readonly arrivedAt: number };

interface TimeoutOutcome {
  readonly kind: "timeout";
  readonly arrivedAt: number;
}

function denial(code: string, message: string, evidence: readonly string[]): PolicyError {
  return new PolicyError(message, {
    sideEffect: "none",
    blastRadius: "local",
    code,
    evidence,
  });
}

export class ApprovalGate {
  private readonly timeoutMs: number;
  private readonly tracer?: Tracer;
  private readonly traceId?: string;
  private readonly actor: string;

  constructor(
    private readonly handler: ApprovalHandler,
    options: ApprovalGateOptions = {},
  ) {
    const timeoutMs = options.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : options.timeoutMs;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMER_DURATION_MS) {
      throw new RangeError(
        `ApprovalGate timeoutMs must be a finite positive duration no greater than ${MAX_TIMER_DURATION_MS} milliseconds.`,
      );
    }
    this.timeoutMs = timeoutMs;
    this.tracer = options.tracer;
    this.traceId = options.traceId;
    this.actor = options.actor ?? "approval-gate";
  }

  private span(traceId: string) {
    return { trace_id: this.traceId ?? traceId, span_id: newSpanId(), parent_span_id: null, actor: this.actor };
  }

  /**
   * Ask the human. Throws PolicyError on any outcome that is not an explicit,
   * unexpired approval. Returns the decision when approved.
   */
  async requireApproval(action: ActionProposal, reason: string): Promise<ApprovalDecision> {
    const requestedAt = Date.now();
    const expiresAt = requestedAt + this.timeoutMs;
    const request: ApprovalRequest = {
      id: randomUUID(),
      action,
      reason,
      requestedAt: new Date(requestedAt).toISOString(),
      expiresAt: new Date(expiresAt).toISOString(),
    };
    const span = this.span(request.id);
    this.tracer?.emit({
      ...span,
      timestamp: nowIso(),
      type: "approval.requested",
      actionKind: action.kind,
      reason,
      expiresAt: request.expiresAt,
    });

    let terminalTraced = false;
    const traceTerminal = (approved: boolean, approver: string, terminalAt: number): void => {
      if (terminalTraced) return;
      terminalTraced = true;
      this.tracer?.emit({
        ...span,
        timestamp: nowIso(),
        type: "approval.decided",
        actionKind: action.kind,
        approved,
        approver,
        latencyMs: Math.max(0, terminalAt - requestedAt),
      });
    };

    const fail = (
      code: string,
      message: string,
      evidence: readonly string[],
      terminalAt: number,
      approver = "none (fail-closed)",
    ): never => {
      traceTerminal(false, approver, terminalAt);
      throw denial(code, message, evidence);
    };

    const controller = new AbortController();
    let handlerOutcome: Promise<HandlerOutcome>;
    try {
      handlerOutcome = Promise.resolve(this.handler(request, controller.signal)).then(
        (value): HandlerOutcome => ({ kind: "response", value, arrivedAt: Date.now() }),
        (): HandlerOutcome => ({ kind: "error", arrivedAt: Date.now() }),
      );
    } catch {
      handlerOutcome = Promise.resolve({ kind: "error", arrivedAt: Date.now() });
    }

    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeoutOutcome = new Promise<TimeoutOutcome>((resolve) => {
      timeoutHandle = setTimeout(
        () => {
          const arrivedAt = Date.now();
          resolve({ kind: "timeout", arrivedAt });
          controller.abort();
        },
        Math.max(0, expiresAt - Date.now()),
      );
    });

    const outcome = await Promise.race([handlerOutcome, timeoutOutcome]);
    if (outcome.kind !== "timeout" && timeoutHandle !== undefined) clearTimeout(timeoutHandle);

    const expired = (terminalAt: number): never => {
      controller.abort();
      return fail(
        "policy.approval_expired",
        `Approval decision for "${action.kind}" arrived after expiry; failing closed.`,
        [`request=${request.id}`, `expiredAt=${request.expiresAt}`],
        terminalAt,
      );
    };

    if (outcome.kind === "timeout" || outcome.arrivedAt > expiresAt) return expired(outcome.arrivedAt);

    if (outcome.kind === "error") {
      return fail(
        "policy.approval_handler_error",
        `Approval handler errored for "${action.kind}"; failing closed.`,
        [`request=${request.id}`],
        outcome.arrivedAt,
      );
    }
    if (outcome.value === null) {
      return fail(
        "policy.approval_unanswered",
        `No human answered the approval request for "${action.kind}"; failing closed.`,
        [`request=${request.id}`, `timeoutMs=${this.timeoutMs}`],
        outcome.arrivedAt,
      );
    }

    const parsedDecision = approvalDecisionSchema.safeParse(outcome.value);
    if (!parsedDecision.success) {
      return fail(
        "policy.approval_invalid_decision",
        `Approval decision for "${action.kind}" was malformed; failing closed.`,
        [`request=${request.id}`, "schema=ApprovalDecision"],
        outcome.arrivedAt,
      );
    }
    const decision = parsedDecision.data;

    if (decision.requestId !== request.id) {
      return fail(
        "policy.approval_request_mismatch",
        `Approval decision for "${action.kind}" did not match its request; failing closed.`,
        [`request=${request.id}`, `decisionRequest=${decision.requestId}`],
        outcome.arrivedAt,
      );
    }
    if (Date.parse(decision.decidedAt) > Date.parse(request.expiresAt)) {
      return expired(outcome.arrivedAt);
    }

    if (!decision.approved) {
      return fail(
        "policy.approval_denied",
        `Human approver "${decision.approver}" denied "${action.kind}": ${decision.reason}`,
        [`request=${request.id}`, `approver=${decision.approver}`],
        outcome.arrivedAt,
        decision.approver,
      );
    }
    traceTerminal(true, decision.approver, outcome.arrivedAt);
    return decision;
  }
}

/**
 * Slot the gate into an enforcement pipeline. The policy decides which
 * actions escalate to a human; everything else flows through untouched.
 */
export function approvalLayer(gate: ApprovalGate, policy: ApprovalPolicy): EnforcementLayer {
  return {
    name: "human-approval",
    check: async (action) => {
      const reason = policy.requiresApproval(action);
      if (reason === undefined) return undefined;
      try {
        await gate.requireApproval(action, reason);
        return undefined;
      } catch (err) {
        return err instanceof PolicyError ? err.message : "approval gate failed closed";
      }
    },
  };
}

/** Unattended environments (CI, cron) must fail closed on every request. */
export const autoDenyHandler: ApprovalHandler = async () => null;

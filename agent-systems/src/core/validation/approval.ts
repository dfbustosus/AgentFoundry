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
import { PolicyError } from "../errors/taxonomy.js";
import { newSpanId, nowIso, type Tracer } from "../trace/tracer.js";
import type { ActionProposal, EnforcementLayer } from "./enforcement.js";

export interface ApprovalRequest {
  readonly id: string;
  readonly action: ActionProposal;
  /** Why a human must decide, stated for the approver. */
  readonly reason: string;
  readonly requestedAt: string;
  /** ISO timestamp; decisions after this are rejected. */
  readonly expiresAt: string;
}

export type ApprovalDecision =
  | { readonly approved: true; readonly approver: string; readonly decidedAt: string }
  | { readonly approved: false; readonly approver: string; readonly decidedAt: string; readonly reason: string };

/**
 * The human's interface. Return a decision, or null when no human answered.
 * Implementations MUST NOT auto-approve; the whole point is a real decision.
 */
export type ApprovalHandler = (request: ApprovalRequest) => Promise<ApprovalDecision | null>;

/** Decides which actions require human sign-off, and why. */
export interface ApprovalPolicy {
  /** Return a reason string when the action needs approval, undefined otherwise. */
  readonly requiresApproval: (action: ActionProposal) => string | undefined;
}

export interface ApprovalGateOptions {
  /** How long a request stays valid. Default 5 minutes. */
  readonly timeoutMs?: number;
  readonly tracer?: Tracer;
  /** Trace correlation id; generated per request when omitted. */
  readonly traceId?: string;
  readonly actor?: string;
}

const DEFAULT_TIMEOUT_MS = 300_000;

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
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
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
    const request: ApprovalRequest = {
      id: randomUUID(),
      action,
      reason,
      requestedAt: new Date(requestedAt).toISOString(),
      expiresAt: new Date(requestedAt + this.timeoutMs).toISOString(),
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

    let decision: ApprovalDecision | null = null;
    let handlerFailed = false;
    try {
      decision = await this.handler(request);
    } catch {
      handlerFailed = true;
    }
    const latencyMs = Date.now() - requestedAt;

    const fail = (code: string, message: string, evidence: readonly string[]): never => {
      this.tracer?.emit({
        ...span,
        timestamp: nowIso(),
        type: "approval.decided",
        actionKind: action.kind,
        approved: false,
        approver: "none (fail-closed)",
        latencyMs,
      });
      throw denial(code, message, evidence);
    };

    if (handlerFailed) {
      return fail(
        "policy.approval_handler_error",
        `Approval handler errored for "${action.kind}"; failing closed.`,
        [`request=${request.id}`],
      );
    }
    if (decision === null) {
      return fail(
        "policy.approval_unanswered",
        `No human answered the approval request for "${action.kind}"; failing closed.`,
        [`request=${request.id}`, `timeoutMs=${this.timeoutMs}`],
      );
    }
    if (Date.parse(decision.decidedAt) > Date.parse(request.expiresAt)) {
      return fail(
        "policy.approval_expired",
        `Approval decision for "${action.kind}" arrived after expiry; failing closed.`,
        [`request=${request.id}`, `expiredAt=${request.expiresAt}`],
      );
    }

    this.tracer?.emit({
      ...span,
      timestamp: nowIso(),
      type: "approval.decided",
      actionKind: action.kind,
      approved: decision.approved,
      approver: decision.approver,
      latencyMs,
    });

    if (!decision.approved) {
      throw denial(
        "policy.approval_denied",
        `Human approver "${decision.approver}" denied "${action.kind}": ${decision.reason}`,
        [`request=${request.id}`, `approver=${decision.approver}`],
      );
    }
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

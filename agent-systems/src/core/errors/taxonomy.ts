/**
 * Error taxonomy for agentic systems.
 *
 * Every failure in this library is classified into exactly one category.
 * Classification drives recovery: you never retry an unclassified failure,
 * and you never retry a failure whose category says it cannot succeed on retry.
 *
 * Categories (from the reliability skill):
 * - tool:        timeout, rate limit, auth, invalid schema, unavailable dep, partial side effect
 * - reasoning:   wrong assumption, unsupported inference, goal drift, bad decomposition, invalid tool choice
 * - environment: missing dependency, permissions, resource exhaustion, network/runtime failure
 * - policy:      authorization, privacy, safety, compliance, or change-control violation
 */

export type ErrorCategory = "tool" | "reasoning" | "environment" | "policy";

/** What the failure may have changed outside the process. */
export type SideEffectStatus = "none" | "unknown" | "occurred";

/** How far the failure's impact can spread. */
export type BlastRadius = "local" | "workflow" | "external";

export interface AgentErrorDetails {
  readonly category: ErrorCategory;
  /** True only when a retry can plausibly succeed (transient, bounded, safely repeatable). */
  readonly retryable: boolean;
  readonly sideEffect: SideEffectStatus;
  readonly blastRadius: BlastRadius;
  /** Machine-readable code for routing and metrics, e.g. "tool.timeout". */
  readonly code: string;
  /** Observations supporting the classification; never guesses. */
  readonly evidence?: readonly string[];
  readonly cause?: unknown;
}

export class AgentError extends Error {
  readonly category: ErrorCategory;
  readonly retryable: boolean;
  readonly sideEffect: SideEffectStatus;
  readonly blastRadius: BlastRadius;
  readonly code: string;
  readonly evidence: readonly string[];
  override readonly cause?: unknown;

  constructor(message: string, details: AgentErrorDetails) {
    super(message, details.cause !== undefined ? { cause: details.cause } : undefined);
    this.name = "AgentError";
    this.category = details.category;
    this.retryable = details.retryable;
    this.sideEffect = details.sideEffect;
    this.blastRadius = details.blastRadius;
    this.code = details.code;
    this.evidence = details.evidence ?? [];
    this.cause = details.cause;
  }
}

export class ToolError extends AgentError {
  constructor(message: string, details: Omit<AgentErrorDetails, "category">) {
    super(message, { ...details, category: "tool" });
    this.name = "ToolError";
  }
}

export class ReasoningError extends AgentError {
  constructor(message: string, details: Omit<AgentErrorDetails, "category">) {
    super(message, { ...details, category: "reasoning" });
    this.name = "ReasoningError";
  }
}

export class EnvironmentError extends AgentError {
  constructor(message: string, details: Omit<AgentErrorDetails, "category">) {
    super(message, { ...details, category: "environment" });
    this.name = "EnvironmentError";
  }
}

export class PolicyError extends AgentError {
  constructor(message: string, details: Omit<AgentErrorDetails, "category" | "retryable">) {
    // Policy violations are never retryable: repeating a denied action is not safer the second time.
    super(message, { ...details, category: "policy", retryable: false });
    this.name = "PolicyError";
  }
}

/** Raised when a loop, retry, or fan-out exhausts a hard budget. Never hidden behind a confident answer. */
export class BudgetExhaustedError extends AgentError {
  constructor(budget: string, spent: string, evidence: readonly string[] = []) {
    super(`Budget exhausted: ${budget}. Spent: ${spent}.`, {
      category: "reasoning",
      retryable: false,
      sideEffect: "none",
      blastRadius: "workflow",
      code: "budget.exhausted",
      evidence,
    });
    this.name = "BudgetExhaustedError";
  }
}

/** Raised when a fallback chain exhausts. Guarantees are stated, never silently dropped. */
export class DegradedError extends AgentError {
  readonly droppedGuarantees: readonly string[];
  readonly failures: readonly { step: string; error: AgentError }[];

  constructor(droppedGuarantees: readonly string[], failures: readonly { step: string; error: AgentError }[]) {
    super(
      `All fallback steps exhausted. Dropped guarantees: ${droppedGuarantees.join(", ") || "none recorded"}.`,
      {
        category: "environment",
        retryable: false,
        sideEffect: "unknown",
        blastRadius: "workflow",
        code: "fallback.exhausted",
        evidence: failures.map((f) => `${f.step}: ${f.error.code} — ${f.error.message}`),
      },
    );
    this.name = "DegradedError";
    this.droppedGuarantees = droppedGuarantees;
    this.failures = failures;
  }
}

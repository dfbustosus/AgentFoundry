/**
 * Bounded retry with exponential backoff and full jitter.
 *
 * Safety rules enforced here (not in prompts):
 * - Only errors classified as retryable are retried. Everything else fails fast.
 * - Side-effecting operations must supply an idempotency key, or prove via
 *   `sideEffectSafe: true` that a repeated call cannot duplicate effects.
 * - Attempts and elapsed time are hard-bounded. Exhaustion throws
 *   RetryExhaustedError carrying the full attempt evidence.
 * - The `sleep` function is injectable so tests run without real delays.
 */

import { classifyError } from "../errors/classify.js";
import { type AgentError, EnvironmentError } from "../errors/taxonomy.js";

export interface RetryPolicy {
  /** Maximum total attempts, including the first. Must be at least 1. */
  readonly maxAttempts: number;
  /** Base delay for attempt 1→2; doubles each attempt up to maxDelayMs. */
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  /**
   * Required when the operation mutates external state and is not provably
   * idempotent on its own. The same key is passed to every attempt so the
   * callee can deduplicate.
   */
  readonly idempotencyKey?: string;
  /** Set true only when repeating the call cannot duplicate a side effect. */
  readonly sideEffectSafe?: boolean;
  /** Extra gate beyond classification, e.g. "don't retry after attempt 2 if partial". */
  readonly retryIf?: (error: AgentError, attempt: number) => boolean;
}

export interface RetryContext {
  readonly attempt: number;
  readonly idempotencyKey?: string;
  readonly signal?: AbortSignal;
}

export interface RetryOutcome<T> {
  readonly value: T;
  readonly attempts: number;
  readonly errors: readonly AgentError[];
}

export class RetryExhaustedError extends EnvironmentError {
  readonly attempts: readonly AgentError[];
  constructor(operation: string, attempts: readonly AgentError[]) {
    super(`Retry budget exhausted for "${operation}" after ${attempts.length} attempt(s).`, {
      retryable: false,
      sideEffect: attempts.at(-1)?.sideEffect ?? "unknown",
      blastRadius: "workflow",
      code: "environment.retry_exhausted",
      evidence: attempts.map((e, i) => `attempt ${i + 1}: [${e.code}] ${e.message}`),
      cause: attempts.at(-1),
    });
    this.name = "RetryExhaustedError";
    this.attempts = attempts;
  }
}

export function computeDelayMs(attempt: number, policy: Pick<RetryPolicy, "baseDelayMs" | "maxDelayMs">): number {
  // Full jitter: uniform in [0, min(maxDelay, base * 2^(attempt-1))].
  // Prevents thundering-herd when many agents retry the same dependency.
  const ceiling = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** Math.max(0, attempt - 1));
  return Math.floor(Math.random() * ceiling);
}

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function withRetry<T>(
  operation: string,
  fn: (ctx: RetryContext) => Promise<T>,
  policy: RetryPolicy,
  sleep: (ms: number) => Promise<void> = realSleep,
): Promise<RetryOutcome<T>> {
  if (!Number.isInteger(policy.maxAttempts) || policy.maxAttempts < 1) {
    throw new EnvironmentError(`Invalid retry policy for "${operation}": maxAttempts must be an integer >= 1.`, {
      retryable: false,
      sideEffect: "none",
      blastRadius: "local",
      code: "environment.invalid_retry_policy",
    });
  }
  if (policy.idempotencyKey === undefined && policy.sideEffectSafe !== true) {
    // Fail closed: we cannot prove a retry is safe, so we refuse to configure one.
    throw new EnvironmentError(
      `Refusing retry policy for "${operation}": provide an idempotencyKey or declare sideEffectSafe.`,
      {
        retryable: false,
        sideEffect: "none",
        blastRadius: "local",
        code: "environment.unsafe_retry_policy",
      },
    );
  }

  const errors: AgentError[] = [];
  for (let attempt = 1; attempt <= policy.maxAttempts; attempt++) {
    try {
      const ctx: RetryContext =
        policy.idempotencyKey !== undefined ? { attempt, idempotencyKey: policy.idempotencyKey } : { attempt };
      const value = await fn(ctx);
      return { value, attempts: attempt, errors };
    } catch (raw) {
      const error = classifyError(raw);
      errors.push(error);
      const gateAllows = policy.retryIf === undefined || policy.retryIf(error, attempt);
      if (!error.retryable || !gateAllows || attempt === policy.maxAttempts) {
        if (attempt === policy.maxAttempts && error.retryable && gateAllows) {
          throw new RetryExhaustedError(operation, errors);
        }
        throw error;
      }
      await sleep(computeDelayMs(attempt, policy));
    }
  }
  // Unreachable by construction (the loop always returns or throws), but the
  // type system needs a terminal statement.
  throw new RetryExhaustedError(operation, errors);
}

/**
 * Bounded retry with exponential backoff and full jitter.
 *
 * Safety rules enforced here (not in prompts):
 * - Only errors classified as retryable are retried. Everything else fails fast.
 * - Side-effecting operations must supply an idempotency key, or prove via
 *   `sideEffectSafe: true` that a repeated call cannot duplicate effects.
 * - Attempts are always hard-bounded; elapsed time is hard-bounded when a
 *   maxElapsedMs budget is configured.
 * - Attempt exhaustion throws RetryExhaustedError carrying the full evidence.
 * - The `sleep` function is injectable so tests run without real delays.
 */

import { classifyError } from "../errors/classify.js";
import { type AgentError, EnvironmentError, type SideEffectStatus } from "../errors/taxonomy.js";

export interface RetryPolicy {
  /** Maximum total attempts, including the first. Must be at least 1. */
  readonly maxAttempts: number;
  /** Base delay for attempt 1→2; doubles each attempt up to maxDelayMs. */
  readonly baseDelayMs: number;
  /** Maximum backoff delay; must fit one Node.js timer (at most 2,147,483,647ms). */
  readonly maxDelayMs: number;
  /** Optional hard wall-clock budget across attempts and backoffs. */
  readonly maxElapsedMs?: number;
  /** Optional upstream cancellation. Cancellation is terminal and is never retried. */
  readonly signal?: AbortSignal;
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
  /** One composed signal is supplied by withRetry to every attempt. */
  readonly signal?: AbortSignal;
}

export interface RetryOutcome<T> {
  readonly value: T;
  readonly attempts: number;
  readonly errors: readonly AgentError[];
}

function summarizeSideEffects(
  attempts: readonly AgentError[],
  attemptInFlight: boolean,
  emptyStatus: SideEffectStatus,
): SideEffectStatus {
  if (attempts.some((error) => error.sideEffect === "occurred")) return "occurred";
  if (attemptInFlight || attempts.some((error) => error.sideEffect === "unknown")) return "unknown";
  return attempts.length > 0 ? "none" : emptyStatus;
}

export class RetryExhaustedError extends EnvironmentError {
  readonly attempts: readonly AgentError[];
  constructor(operation: string, attempts: readonly AgentError[]) {
    super(`Retry budget exhausted for "${operation}" after ${attempts.length} attempt(s).`, {
      retryable: false,
      sideEffect: summarizeSideEffects(attempts, false, "unknown"),
      blastRadius: "workflow",
      code: "environment.retry_exhausted",
      evidence: attempts.map((e, i) => `attempt ${i + 1}: [${e.code}] ${e.message}`),
      cause: attempts.at(-1),
    });
    this.name = "RetryExhaustedError";
    this.attempts = attempts;
  }
}

/** Terminal cancellation or elapsed-time failure, distinct from attempt exhaustion. */
export class RetryAbortedError extends EnvironmentError {
  readonly kind: "cancelled" | "elapsed";
  readonly attempts: readonly AgentError[];

  constructor(
    operation: string,
    kind: "cancelled" | "elapsed",
    attemptsStarted: number,
    attempts: readonly AgentError[],
    cause?: unknown,
  ) {
    const label = kind === "elapsed" ? "elapsed-time budget reached" : "cancelled by upstream";
    super(`Retry for "${operation}" ${label} after ${attemptsStarted} started attempt(s).`, {
      retryable: false,
      // A non-cooperative in-flight attempt may still complete externally.
      sideEffect: summarizeSideEffects(attempts, attemptsStarted > attempts.length, "none"),
      blastRadius: "workflow",
      code: kind === "elapsed" ? "environment.retry_deadline_exceeded" : "environment.retry_cancelled",
      evidence: [
        `termination=${kind}`,
        `attemptsStarted=${attemptsStarted}`,
        ...attempts.map((error, index) => `attempt ${index + 1}: [${error.code}] ${error.message}`),
      ],
      cause,
    });
    this.name = "RetryAbortedError";
    this.kind = kind;
    this.attempts = [...attempts];
  }
}

export function computeDelayMs(attempt: number, policy: Pick<RetryPolicy, "baseDelayMs" | "maxDelayMs">): number {
  // Full jitter: uniform in [0, min(maxDelay, base * 2^(attempt-1))].
  // Prevents thundering-herd when many agents retry the same dependency.
  const ceiling = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** Math.max(0, attempt - 1));
  return Math.floor(Math.random() * ceiling);
}

export type RetrySleep = (ms: number, signal?: AbortSignal) => Promise<void>;

const MAX_TIMER_DURATION_MS = 2_147_483_647;

const realSleep: RetrySleep = (ms, signal) =>
  new Promise<void>((resolve) => {
    const isAborted = (): boolean => signal?.aborted === true;
    if (isAborted()) {
      resolve();
      return;
    }

    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve();
    };
    const onAbort = (): void => finish();
    const timer = setTimeout(finish, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (isAborted()) finish();
  });

function invalidPolicy(operation: string, requirement: string): EnvironmentError {
  return new EnvironmentError(`Invalid retry policy for "${operation}": ${requirement}.`, {
    retryable: false,
    sideEffect: "none",
    blastRadius: "local",
    code: "environment.invalid_retry_policy",
  });
}

export async function withRetry<T>(
  operation: string,
  fn: (ctx: RetryContext) => Promise<T>,
  policy: RetryPolicy,
  sleep: RetrySleep = realSleep,
): Promise<RetryOutcome<T>> {
  if (!Number.isSafeInteger(policy.maxAttempts) || policy.maxAttempts < 1) {
    throw invalidPolicy(operation, "maxAttempts must be a safe integer >= 1");
  }
  if (!Number.isFinite(policy.baseDelayMs) || policy.baseDelayMs < 0) {
    throw invalidPolicy(operation, "baseDelayMs must be finite and >= 0");
  }
  if (!Number.isFinite(policy.maxDelayMs) || policy.maxDelayMs < 0 || policy.maxDelayMs > MAX_TIMER_DURATION_MS) {
    throw invalidPolicy(operation, `maxDelayMs must be finite, >= 0, and <= ${MAX_TIMER_DURATION_MS}`);
  }
  if (
    policy.maxElapsedMs !== undefined &&
    (!Number.isFinite(policy.maxElapsedMs) || policy.maxElapsedMs <= 0 || policy.maxElapsedMs > MAX_TIMER_DURATION_MS)
  ) {
    throw invalidPolicy(operation, `maxElapsedMs must be finite, > 0, and <= ${MAX_TIMER_DURATION_MS}`);
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
  let attemptsStarted = 0;
  const startedAt = performance.now();
  const deadline = policy.maxElapsedMs === undefined ? undefined : startedAt + policy.maxElapsedMs;
  const controller = new AbortController();
  let abortedError: RetryAbortedError | undefined;

  const abortRetry = (kind: "cancelled" | "elapsed", cause?: unknown): RetryAbortedError => {
    if (abortedError !== undefined) return abortedError;
    abortedError = new RetryAbortedError(operation, kind, attemptsStarted, errors, cause);
    if (!controller.signal.aborted) {
      controller.abort(kind === "cancelled" ? cause : abortedError);
    }
    return abortedError;
  };

  const terminalError = (): RetryAbortedError | undefined => {
    if (abortedError !== undefined) return abortedError;
    if (deadline !== undefined && performance.now() >= deadline) return abortRetry("elapsed");
    if (policy.signal?.aborted === true) return abortRetry("cancelled", policy.signal.reason);
    if (controller.signal.aborted) return abortRetry("cancelled", controller.signal.reason);
    return undefined;
  };

  const waitFor = <Value>(pending: Promise<Value>): Promise<Value> => {
    const alreadyTerminal = terminalError();
    if (alreadyTerminal !== undefined) {
      // A non-cooperative operation may reject later; attach a rejection handler now.
      void pending.catch(() => undefined);
      return Promise.reject(alreadyTerminal);
    }

    return new Promise<Value>((resolve, reject) => {
      let settled = false;
      const cleanup = (): void => controller.signal.removeEventListener("abort", onAbort);
      const settleWithValue = (value: Value): void => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      };
      const settleWithError = (error: unknown): void => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };
      const onAbort = (): void => {
        settleWithError(abortedError ?? abortRetry("cancelled", controller.signal.reason));
      };

      controller.signal.addEventListener("abort", onAbort, { once: true });
      void pending.then(
        (value) => {
          const error = terminalError();
          if (error !== undefined) settleWithError(error);
          else settleWithValue(value);
        },
        (reason: unknown) => {
          const error = terminalError();
          settleWithError(error ?? reason);
        },
      );

      const errorAfterListening = terminalError();
      if (errorAfterListening !== undefined) settleWithError(errorAfterListening);
    });
  };

  const onUpstreamAbort = (): void => {
    if (deadline !== undefined && performance.now() >= deadline) abortRetry("elapsed");
    else abortRetry("cancelled", policy.signal?.reason);
  };
  let upstreamListenerAttached = false;
  if (policy.signal?.aborted === true) {
    onUpstreamAbort();
  } else if (policy.signal !== undefined) {
    policy.signal.addEventListener("abort", onUpstreamAbort, { once: true });
    upstreamListenerAttached = true;
    if (policy.signal.aborted) onUpstreamAbort();
  }

  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  if (deadline !== undefined && abortedError === undefined) {
    deadlineTimer = setTimeout(() => abortRetry("elapsed"), Math.max(0, deadline - performance.now()));
  }

  try {
    for (let attempt = 1; attempt <= policy.maxAttempts; attempt++) {
      const beforeAttempt = terminalError();
      if (beforeAttempt !== undefined) throw beforeAttempt;

      const ctx: RetryContext =
        policy.idempotencyKey !== undefined
          ? { attempt, idempotencyKey: policy.idempotencyKey, signal: controller.signal }
          : { attempt, signal: controller.signal };
      attemptsStarted = attempt;

      let attemptPromise: Promise<T>;
      try {
        attemptPromise = Promise.resolve(fn(ctx));
      } catch (raw) {
        attemptPromise = Promise.reject(raw);
      }

      try {
        const value = await waitFor(attemptPromise);
        return { value, attempts: attempt, errors };
      } catch (raw) {
        const aborted = terminalError();
        if (aborted !== undefined) throw aborted;

        const error = classifyError(raw);
        errors.push(error);
        const gateAllows = policy.retryIf === undefined || policy.retryIf(error, attempt);

        const abortedAfterGate = terminalError();
        if (abortedAfterGate !== undefined) throw abortedAfterGate;
        if (!error.retryable || !gateAllows || attempt === policy.maxAttempts) {
          if (attempt === policy.maxAttempts && error.retryable && gateAllows) {
            throw new RetryExhaustedError(operation, errors);
          }
          throw error;
        }

        const delayMs = computeDelayMs(attempt, policy);
        if (deadline !== undefined && delayMs >= deadline - performance.now()) {
          throw abortRetry("elapsed");
        }

        const beforeBackoff = terminalError();
        if (beforeBackoff !== undefined) throw beforeBackoff;

        let sleepPromise: Promise<void>;
        try {
          sleepPromise = Promise.resolve(sleep(delayMs, controller.signal));
        } catch (rawSleep) {
          sleepPromise = Promise.reject(rawSleep);
        }
        await waitFor(sleepPromise);
      }
    }
  } finally {
    if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
    if (upstreamListenerAttached) policy.signal?.removeEventListener("abort", onUpstreamAbort);
  }

  // Unreachable by construction (the loop always returns or throws), but the
  // type system needs a terminal statement.
  throw new RetryExhaustedError(operation, errors);
}

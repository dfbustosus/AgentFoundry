/**
 * Error classification: turns arbitrary thrown values into typed AgentErrors.
 *
 * Rule: classify BEFORE recovering. An unclassified failure is never retried.
 * Heuristics here are conservative — when in doubt we mark retryable: false,
 * because a false "retryable" can repeat a side effect, while a false
 * "not retryable" only costs an escalation.
 */

import { APICallError, RetryError } from "ai";
import { ZodError } from "zod";
import {
  AgentError,
  EnvironmentError,
  ReasoningError,
  ToolError,
  type AgentErrorDetails,
} from "./taxonomy.js";

const DEFAULTS = {
  retryable: false,
  sideEffect: "unknown",
  blastRadius: "local",
  code: "unknown",
} as const satisfies Partial<AgentErrorDetails>;

function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  return typeof err === "string" ? err : JSON.stringify(err);
}

/**
 * Classify an unknown thrown value.
 *
 * - AgentError pass-through: already classified upstream.
 * - APICallError (provider HTTP failure): environment category. Retryable only
 *   for transient statuses (408/409/425/429/5xx); 4xx auth/validation is not.
 * - RetryError (AI SDK exhausted its internal retries): environment, not retryable
 *   here (the SDK already spent its attempts; re-trying needs a fresh decision).
 * - ZodError: a schema rejection at a trust boundary is a reasoning/tool contract
 *   failure — retrying the same invalid input changes nothing.
 * - Timeout/abort DOMExceptions: environment, transient.
 * - Anything else: reasoning category, not retryable, side effect unknown.
 */
export function classifyError(err: unknown): AgentError {
  if (err instanceof AgentError) return err;

  if (err instanceof APICallError) {
    const status = err.statusCode;
    const transient =
      status !== undefined && (status === 408 || status === 409 || status === 425 || status === 429 || status >= 500);
    return new EnvironmentError(`Provider API call failed${status !== undefined ? ` (HTTP ${status})` : ""}: ${err.message}`, {
      ...DEFAULTS,
      retryable: transient,
      sideEffect: "none",
      blastRadius: "workflow",
      code: transient ? "environment.provider_transient" : "environment.provider_permanent",
      evidence: [`statusCode=${String(status)}`, `url=${err.url}`],
      cause: err,
    });
  }

  if (err instanceof RetryError) {
    return new EnvironmentError(`AI SDK internal retries exhausted: ${err.message}`, {
      ...DEFAULTS,
      blastRadius: "workflow",
      code: "environment.retries_exhausted",
      evidence: ["AI SDK RetryError — internal attempt budget already spent"],
      cause: err,
    });
  }

  if (err instanceof ZodError) {
    return new ReasoningError(`Schema validation failed: ${err.message}`, {
      ...DEFAULTS,
      sideEffect: "none",
      code: "reasoning.schema_validation",
      evidence: err.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
      cause: err,
    });
  }

  if (err instanceof DOMException && (err.name === "TimeoutError" || err.name === "AbortError")) {
    return new EnvironmentError(`Operation ${err.name === "TimeoutError" ? "timed out" : "was aborted"}: ${err.message}`, {
      ...DEFAULTS,
      retryable: err.name === "TimeoutError",
      blastRadius: "local",
      code: `environment.${err.name === "TimeoutError" ? "timeout" : "aborted"}`,
      cause: err,
    });
  }

  // Node.js system errors carry a string `code` (ECONNREFUSED, ENOTFOUND, EACCES...).
  const nodeCode = (err as { code?: unknown } | null)?.code;
  if (err instanceof Error && typeof nodeCode === "string") {
    const transientNet = ["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EPIPE", "ENOTFOUND", "EAI_AGAIN"].includes(nodeCode);
    return new EnvironmentError(`System error ${nodeCode}: ${err.message}`, {
      ...DEFAULTS,
      retryable: transientNet,
      blastRadius: "workflow",
      code: `environment.${nodeCode.toLowerCase()}`,
      cause: err,
    });
  }

  if (err instanceof Error && /timed? ?out/i.test(err.message)) {
    return new ToolError(`Tool timeout: ${err.message}`, {
      ...DEFAULTS,
      retryable: true,
      code: "tool.timeout",
      cause: err,
    });
  }

  return new ReasoningError(`Unclassified failure: ${messageOf(err)}`, {
    ...DEFAULTS,
    code: "reasoning.unclassified",
    evidence: ["No known error signature matched; defaulted to non-retryable"],
    cause: err,
  });
}

/** Type guard for consumers that branch on category. */
export function isCategory(err: unknown, category: AgentError["category"]): boolean {
  return err instanceof AgentError && err.category === category;
}

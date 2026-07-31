/**
 * Fallback chains with labeled graceful degradation.
 *
 * Ordered by safety and information loss. Each step declares which guarantees
 * it drops. The result always states who served it and what was degraded —
 * this library never silently substitutes a weaker source.
 *
 * If every step fails, throws DegradedError with the full failure evidence.
 */

import { classifyError } from "../errors/classify.js";
import { DegradedError, type AgentError } from "../errors/taxonomy.js";

export interface FallbackStep<T> {
  /** Stable name for logs and evidence, e.g. "primary-model", "cached-answer". */
  readonly name: string;
  readonly run: () => Promise<T>;
  /**
   * Guarantees this step does NOT preserve relative to the ideal step,
   * e.g. ["freshness", "full-recall"]. The first step usually declares [].
   */
  readonly degrades: readonly string[];
}

export interface FallbackOutcome<T> {
  readonly value: T;
  /** Name of the step that produced the value. */
  readonly servedBy: string;
  /** Accumulated dropped guarantees from the serving step. */
  readonly degradedGuarantees: readonly string[];
  /** Failures of earlier steps, in order. Empty when the first step served. */
  readonly priorFailures: readonly { step: string; error: AgentError }[];
}

export async function withFallback<T>(
  operation: string,
  steps: readonly FallbackStep<T>[],
  onDegrade?: (outcome: Omit<FallbackOutcome<T>, "value">) => void,
): Promise<FallbackOutcome<T>> {
  if (steps.length === 0) {
    throw new DegradedError(["everything — no fallback steps were configured"], []);
  }

  const failures: { step: string; error: AgentError }[] = [];
  for (const step of steps) {
    try {
      const value = await step.run();
      const outcome: FallbackOutcome<T> = {
        value,
        servedBy: step.name,
        degradedGuarantees: step.degrades,
        priorFailures: failures,
      };
      if (failures.length > 0 || step.degrades.length > 0) {
        onDegrade?.({ servedBy: outcome.servedBy, degradedGuarantees: outcome.degradedGuarantees, priorFailures: failures });
      }
      return outcome;
    } catch (raw) {
      failures.push({ step: step.name, error: classifyError(raw) });
    }
  }

  const allDropped = [...new Set(steps.flatMap((s) => s.degrades))];
  throw new DegradedError(
    allDropped.length > 0 ? allDropped : [`operation "${operation}" unavailable in any mode`],
    failures,
  );
}

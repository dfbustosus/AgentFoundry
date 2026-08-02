/**
 * Multi-agent cost accounting and cost-vs-fit.
 *
 * Every additional agent costs: duplicated context reading, context transfer,
 * merge effort, latency, and model spend. This module makes the model spend
 * visible per agent and per workflow, and forces the fit question to be
 * answered with numbers instead of enthusiasm.
 *
 * Prices are a static, dated table (assumption A5): they drift, so they are
 * data in one file, trivially updatable, and never hard-coded into logic.
 */

import type { LanguageModelUsage } from "ai";

/** USD per 1M tokens. Verified 2026-07-30 against provider pricing pages; update when adopting. */
export interface ModelPrice {
  readonly inputPer1M: number;
  readonly outputPer1M: number;
  readonly asOf: string;
}

export const PRICE_TABLE: Readonly<Record<string, ModelPrice>> = {
  "gpt-4o-mini": { inputPer1M: 0.15, outputPer1M: 0.6, asOf: "2026-07-30" },
  "gpt-4o": { inputPer1M: 2.5, outputPer1M: 10.0, asOf: "2026-07-30" },
  "gpt-4.1-mini": { inputPer1M: 0.4, outputPer1M: 1.6, asOf: "2026-07-30" },
  "gpt-4.1": { inputPer1M: 2.0, outputPer1M: 8.0, asOf: "2026-07-30" },
} as const;

/** Prices older than this are flagged in reports instead of silently trusted (R2 fix). */
export const PRICE_STALENESS_DAYS = 90;

/**
 * Returns the models whose price entries are older than `maxAgeDays` at `now`.
 * Pricing pages change; a dated table without a staleness check becomes a lie
 * by omission. Callers should treat stale costs as estimates, not facts.
 */
export function stalePriceModels(
  table: Readonly<Record<string, ModelPrice>>,
  now: Date = new Date(),
  maxAgeDays: number = PRICE_STALENESS_DAYS,
): readonly string[] {
  const maxAgeMs = maxAgeDays * 86_400_000;
  return Object.entries(table)
    .filter(([, price]) => now.getTime() - Date.parse(price.asOf) > maxAgeMs)
    .map(([model]) => model);
}

export function estimateCostUsd(
  model: string,
  usage: { inputTokens: number; outputTokens: number },
): number | undefined {
  const price = PRICE_TABLE[model];
  if (price === undefined) return undefined; // unknown model: report tokens, not invented dollars
  return (usage.inputTokens / 1_000_000) * price.inputPer1M + (usage.outputTokens / 1_000_000) * price.outputPer1M;
}

export interface AgentCostRecord {
  readonly agentId: string;
  readonly model: string;
  inputTokens: number;
  outputTokens: number;
  calls: number;
}

export interface CostReport {
  readonly perAgent: readonly {
    agentId: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    calls: number;
    costUsd?: number;
  }[];
  readonly totalTokens: number;
  readonly totalCostUsd?: number;
  /** True when at least one used model is missing from the price table. */
  readonly hasUnpricedModels: boolean;
  /** Used models whose price entries are older than PRICE_STALENESS_DAYS — treat their costs as estimates. */
  readonly stalePriceModels: readonly string[];
}

export class CostTracker {
  private readonly records = new Map<string, AgentCostRecord>();

  constructor(
    private readonly budgetUsd?: number,
    private readonly onBudgetCrossed?: (report: CostReport) => void,
  ) {}

  record(
    agentId: string,
    model: string,
    usage: LanguageModelUsage | { inputTokens: number; outputTokens: number },
  ): void {
    const key = `${agentId}:${model}`;
    const existing = this.records.get(key) ?? { agentId, model, inputTokens: 0, outputTokens: 0, calls: 0 };
    existing.inputTokens += usage.inputTokens ?? 0;
    existing.outputTokens += usage.outputTokens ?? 0;
    existing.calls += 1;
    this.records.set(key, existing);

    if (this.budgetUsd !== undefined && this.onBudgetCrossed !== undefined) {
      const report = this.report();
      if (report.totalCostUsd !== undefined && report.totalCostUsd > this.budgetUsd) {
        this.onBudgetCrossed(report);
      }
    }
  }

  report(): CostReport {
    const perAgent = [...this.records.values()].map((r) => {
      const cost = estimateCostUsd(r.model, r);
      return {
        agentId: r.agentId,
        model: r.model,
        inputTokens: r.inputTokens,
        outputTokens: r.outputTokens,
        calls: r.calls,
        ...(cost !== undefined ? { costUsd: cost } : {}),
      };
    });
    const totalTokens = perAgent.reduce((acc, r) => acc + r.inputTokens + r.outputTokens, 0);
    const hasUnpricedModels = perAgent.some((r) => r.costUsd === undefined);
    const totalCostUsd = hasUnpricedModels ? undefined : perAgent.reduce((acc, r) => acc + (r.costUsd ?? 0), 0);
    const stale = stalePriceModels(PRICE_TABLE).filter((model) => perAgent.some((r) => r.model === model));
    return {
      perAgent,
      totalTokens,
      ...(totalCostUsd !== undefined ? { totalCostUsd } : {}),
      hasUnpricedModels,
      stalePriceModels: stale,
    };
  }
}

/**
 * The multi-agent fit question, answered with numbers. Adding agents is
 * justified only when the expected benefit (parallelism, specialization,
 * context isolation, independent review) exceeds the coordination cost.
 */
export function multiAgentFit(input: {
  readonly singleAgentCostUsd: number;
  readonly multiAgentCostUsd: number;
  /** Hours of human time saved by specialization/parallelism, if measurable. */
  readonly humanHoursSaved?: number;
  /** Value placed on one human hour, for comparison. */
  readonly humanHourValueUsd?: number;
}): { readonly justified: boolean; readonly rationale: string } {
  const overhead = input.multiAgentCostUsd - input.singleAgentCostUsd;
  if (input.humanHoursSaved !== undefined && input.humanHourValueUsd !== undefined) {
    const benefit = input.humanHoursSaved * input.humanHourValueUsd;
    return benefit > overhead
      ? {
          justified: true,
          rationale: `Coordination costs $${overhead.toFixed(4)} but saves ~$${benefit.toFixed(2)} of human time.`,
        }
      : {
          justified: false,
          rationale: `Coordination costs $${overhead.toFixed(4)} against ~$${benefit.toFixed(2)} of human time saved — use one agent.`,
        };
  }
  return overhead <= 0
    ? { justified: true, rationale: "Multi-agent path is not more expensive than the single-agent path." }
    : {
        justified: false,
        rationale: `Multi-agent adds $${overhead.toFixed(4)} with no quantified benefit recorded — justify with specialization, isolation, or review value, or use one agent.`,
      };
}

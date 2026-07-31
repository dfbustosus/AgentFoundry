/**
 * Fan-out / fan-in with an explicit synchronization barrier.
 *
 * Fan-out partitions independent work across bounded concurrency. Fan-in is
 * NOT "concatenate the outputs" — it is: validate each branch against its
 * contract, normalize to a common schema, resolve conflicts by policy
 * (authority > recency > test evidence), integrate, and record dissent.
 */

import { pooled } from "../decomposition/graph.js";
import { classifyError } from "../errors/classify.js";
import type { AgentError } from "../errors/taxonomy.js";

export interface FanOutBranch<I, O> {
  readonly id: string;
  /** Authority rank of the branch source; higher wins conflicts. */
  readonly authorityRank: number;
  readonly input: I;
  readonly run: (input: I) => Promise<O>;
}

export interface BranchOutcome<O> {
  readonly id: string;
  readonly authorityRank: number;
  readonly status: "completed" | "failed";
  readonly output?: O;
  readonly error?: AgentError;
  readonly completedAt: number;
}

export async function fanOut<I, O>(
  branches: readonly FanOutBranch<I, O>[],
  options: { readonly concurrency?: number } = {},
): Promise<readonly BranchOutcome<O>[]> {
  const concurrency = Math.max(1, options.concurrency ?? 4);
  return pooled(branches, concurrency, async (branch) => {
    try {
      const output = await branch.run(branch.input);
      const outcome: BranchOutcome<O> = {
        id: branch.id,
        authorityRank: branch.authorityRank,
        status: "completed",
        output,
        completedAt: Date.now(),
      };
      return outcome;
    } catch (raw) {
      const outcome: BranchOutcome<O> = {
        id: branch.id,
        authorityRank: branch.authorityRank,
        status: "failed",
        error: classifyError(raw),
        completedAt: Date.now(),
      };
      return outcome;
    }
  });
}

export interface Conflict<T> {
  readonly key: string;
  readonly contenders: readonly { branch: string; value: T; authorityRank: number; completedAt: number }[];
  /** The winning branch and WHY it won. Never a vote. */
  readonly winner: string;
  readonly resolution: "authority" | "recency" | "uncontested";
}

export interface FanInResult<T> {
  /** Merged view after conflict resolution. */
  readonly merged: Readonly<Record<string, T>>;
  readonly conflicts: readonly Conflict<T>[];
  readonly failedBranches: readonly { id: string; error: AgentError }[];
  /** Branches that could not be merged because they failed. */
  readonly missing: readonly string[];
}

export interface FanInOptions<T> {
  /** Project each branch output into key→value pairs for merging. */
  readonly project: (branchId: string, output: unknown) => Readonly<Record<string, T>>;
  /**
   * What a failed branch means for the merge:
   * - "tolerate" (default): merge what succeeded, record what is missing;
   * - "require-all": any failure makes the whole fan-in fail explicitly.
   */
  readonly onBranchFailure?: "tolerate" | "require-all";
}

/**
 * Synchronize and merge. Conflict policy is deterministic:
 * 1. higher authorityRank wins;
 * 2. tie → more recent completion wins;
 * 3. every conflict is recorded with its resolution rationale.
 */
export function fanIn<T>(
  outcomes: readonly BranchOutcome<unknown>[],
  options: FanInOptions<T>,
): FanInResult<T> {
  const onFailure = options.onBranchFailure ?? "tolerate";
  const failed = outcomes
    .filter((o): o is BranchOutcome<unknown> & { status: "failed"; error: AgentError } => o.status === "failed")
    .map((o) => ({ id: o.id, error: o.error }));

  if (failed.length > 0 && onFailure === "require-all") {
    const first = failed[0];
    throw (first?.error ?? new Error("fan-in aborted: required branch failed"));
  }

  const byKey = new Map<string, { branch: string; value: T; authorityRank: number; completedAt: number }[]>();
  for (const outcome of outcomes) {
    if (outcome.status !== "completed") continue;
    const projected = options.project(outcome.id, outcome.output);
    for (const [key, value] of Object.entries(projected)) {
      const list = byKey.get(key) ?? [];
      list.push({
        branch: outcome.id,
        value,
        authorityRank: outcome.authorityRank,
        completedAt: outcome.completedAt,
      });
      byKey.set(key, list);
    }
  }

  const merged: Record<string, T> = {};
  const conflicts: Conflict<T>[] = [];
  for (const [key, contenders] of byKey) {
    const sorted = [...contenders].sort((a, b) =>
      b.authorityRank !== a.authorityRank ? b.authorityRank - a.authorityRank : b.completedAt - a.completedAt,
    );
    const winner = sorted[0];
    if (winner === undefined) continue;
    merged[key] = winner.value;
    if (contenders.length > 1) {
      conflicts.push({
        key,
        contenders,
        winner: winner.branch,
        resolution: contenders.some((c) => c.authorityRank !== winner.authorityRank) ? "authority" : "recency",
      });
    }
  }

  return {
    merged,
    conflicts,
    failedBranches: failed,
    missing: failed.map((f) => f.id),
  };
}

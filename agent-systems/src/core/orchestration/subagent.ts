/**
 * Subagent design: bounded authority and isolation.
 *
 * A subagent is defined by what it may NOT do as much as by what it may:
 * - authority caps the actions it can take (read-only < propose < modify < execute);
 * - writeScopes enumerate the ONLY mutable surfaces it can touch;
 * - its tool set is filtered to its role before the model ever sees it;
 * - it receives a bounded brief, never the orchestrator's full context.
 */

import type { LanguageModel, ToolSet } from "ai";
import { PolicyError } from "../errors/taxonomy.js";
import type { Authority } from "../handoff/envelope.js";

const AUTHORITY_RANK: Record<Authority, number> = {
  "read-only": 0,
  propose: 1,
  modify: 2,
  execute: 3,
};

export interface SubagentDefinition<TOOLS extends ToolSet = ToolSet> {
  readonly id: string;
  readonly role: string;
  readonly instructions: string;
  readonly model: LanguageModel;
  readonly tools: TOOLS;
  readonly authority: Authority;
  /** Mutable surfaces this agent may affect; enforced on every write tool. */
  readonly writeScopes: readonly string[];
  /** Hard per-task budget ceiling for this agent. */
  readonly maxIterations?: number;
}

/** True iff `have` satisfies `need`. */
export function authorityAllows(have: Authority, need: Authority): boolean {
  return AUTHORITY_RANK[have] >= AUTHORITY_RANK[need];
}

/**
 * Enforce that a delegation does not exceed the subagent's granted authority.
 * This check runs in code at delegation time — a prompt cannot enforce it.
 */
export function assertDelegationWithinAuthority(agent: SubagentDefinition, delegated: Authority): void {
  if (!authorityAllows(agent.authority, delegated)) {
    throw new PolicyError(
      `Cannot delegate "${delegated}" authority to agent "${agent.id}" (granted: "${agent.authority}").`,
      {
        sideEffect: "none",
        blastRadius: "local",
        code: "policy.authority_exceeded",
        evidence: [`agent=${agent.id}`, `granted=${agent.authority}`, `requested=${delegated}`],
      },
    );
  }
}

/**
 * Enforce write-scope isolation between concurrently running agents.
 * Two agents may not hold overlapping write scopes at the same time unless
 * the underlying store provides transactions (it does not — spec A4).
 */
export function assertNonOverlappingScopes(agents: readonly SubagentDefinition[]): void {
  const owner = new Map<string, string>();
  for (const agent of agents) {
    for (const scope of agent.writeScopes) {
      const existing = owner.get(scope);
      if (existing !== undefined && existing !== agent.id) {
        throw new PolicyError(`Write scope "${scope}" is claimed by both "${existing}" and "${agent.id}".`, {
          sideEffect: "none",
          blastRadius: "workflow",
          code: "policy.overlapping_write_scopes",
          evidence: ["Concurrent agents must not share mutable surfaces."],
        });
      }
      owner.set(scope, agent.id);
    }
  }
}

/**
 * The bounded brief a subagent receives. Deliberately minimal: facts,
 * assumptions, artifact references, constraints, acceptance checks —
 * never secrets, irrelevant history, or the orchestrator's conclusions.
 */
export interface TaskBrief {
  readonly task_id: string;
  readonly objective: string;
  readonly facts: readonly string[];
  readonly assumptions: readonly string[];
  readonly artifact_refs: readonly string[];
  readonly constraints: readonly string[];
  readonly acceptance_checks: readonly string[];
}

export function renderBrief(brief: TaskBrief): string {
  const section = (title: string, items: readonly string[]): string =>
    items.length === 0 ? "" : `\n${title}:\n${items.map((i) => `- ${i}`).join("\n")}`;
  return [
    `Task ${brief.task_id}: ${brief.objective}`,
    section("Facts", brief.facts),
    section("Assumptions (validate before relying)", brief.assumptions),
    section("Artifacts", brief.artifact_refs),
    section("Constraints", brief.constraints),
    section("Acceptance checks (you must produce evidence for each)", brief.acceptance_checks),
  ]
    .filter((s) => s.length > 0)
    .join("\n");
}

/**
 * The three canonical decomposition patterns, as constructors over TaskGraph.
 *
 * - sequential:   pipeline stages, each transforming the previous artifact.
 *                 Trade-off: latency is additive, errors propagate downstream —
 *                 use only when a REAL data dependency exists between stages.
 * - parallel:     independent branches plus a fan-in barrier. Trade-off:
 *                 integration and conflict resolution become explicit work.
 * - hierarchical: a goal expanded into subtasks; subtasks may expand further.
 *                 The planner decides the tree; the executor stays the same.
 */

import { generateObject, type LanguageModel } from "ai";
import { z } from "zod";
import { TaskGraph, type GraphResult, type TaskNode } from "./graph.js";

export interface Stage<I, O> {
  readonly id: string;
  readonly objective: string;
  readonly run: (input: I) => Promise<O>;
}

/** sequential([a, b, c]): b receives a's output, c receives b's output. */
export function sequential(stages: readonly Stage<unknown, unknown>[]): TaskGraph {
  const graph = new TaskGraph();
  stages.forEach((stage, index) => {
    const previous = stages[index - 1];
    graph.add({
      id: stage.id,
      objective: stage.objective,
      dependsOn: previous === undefined ? [] : [previous.id],
      run: async (inputs) => stage.run(previous === undefined ? undefined : inputs[previous.id]),
    });
  });
  return graph;
}

export interface Branch {
  readonly id: string;
  readonly objective: string;
  readonly run: () => Promise<unknown>;
}

/**
 * parallel(branches, fanIn): all branches must complete (or be accounted for)
 * before the barrier task runs. The fan-in function receives raw branch
 * records — including failures — because merge policy is the caller's job.
 */
export function parallel(
  branches: readonly Branch[],
  fanIn: Stage<Readonly<Record<string, unknown>>, unknown>,
): TaskGraph {
  const graph = new TaskGraph();
  for (const branch of branches) {
    graph.add({ id: branch.id, objective: branch.objective, dependsOn: [], run: branch.run });
  }
  graph.add({
    id: fanIn.id,
    objective: fanIn.objective,
    dependsOn: branches.map((b) => b.id),
    run: fanIn.run,
  });
  return graph;
}

/** Zod schema for a planner-produced subtask list (hierarchical decomposition). */
export const subtaskPlanSchema = z.object({
  subtasks: z
    .array(
      z.object({
        id: z.string().describe("Stable snake_case task id"),
        objective: z.string().describe("Observable outcome, not an activity"),
        dependsOn: z.array(z.string()).describe("Ids of sibling subtasks that must finish first"),
      }),
    )
    .min(1)
    .max(12),
});
export type SubtaskPlan = z.infer<typeof subtaskPlanSchema>;

/**
 * Hierarchical decomposition driven by a model: the planner expands a goal
 * into a bounded set of subtasks with declared dependencies. The returned
 * graph is validated by TaskGraph.layers() before anything executes — a
 * model can propose a cyclic or dangling graph, and code must reject it.
 */
export async function planHierarchical(options: {
  readonly model: LanguageModel;
  readonly goal: string;
  readonly context?: string;
}): Promise<SubtaskPlan> {
  const result = await generateObject({
    model: options.model,
    schema: subtaskPlanSchema,
    system:
      "You decompose complex goals into the smallest set of independently verifiable subtasks. " +
      "Each subtask has one observable outcome. Declare dependencies only where a real data or " +
      "decision dependency exists — never to force an ordering.",
    prompt:
      `Goal: ${options.goal}\n` +
      (options.context !== undefined ? `Context: ${options.context}\n` : "") +
      "Produce the subtask plan.",
  });
  return result.object;
}

/**
 * Build an executable graph from a plan by binding each planned subtask to a
 * worker. Subtasks without a worker are rejected — no silent no-ops.
 */
export function bindPlan(
  plan: SubtaskPlan,
  workers: Readonly<Record<string, (inputs: Readonly<Record<string, unknown>>) => Promise<unknown>>>,
): TaskGraph {
  const graph = new TaskGraph();
  const unbound: string[] = [];
  for (const sub of plan.subtasks) {
    const worker = workers[sub.id];
    if (worker === undefined) {
      unbound.push(sub.id);
      continue;
    }
    const node: TaskNode = { id: sub.id, objective: sub.objective, dependsOn: sub.dependsOn, run: worker };
    graph.add(node);
  }
  if (unbound.length > 0) {
    throw new Error(`Plan contains subtasks with no bound worker: ${unbound.join(", ")}`);
  }
  graph.layers(); // validate acyclicity now, not mid-execution
  return graph;
}

export type { GraphResult };

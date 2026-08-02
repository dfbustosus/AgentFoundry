/**
 * Goal decomposition over a typed task DAG.
 *
 * A complex goal is decomposed into leaf tasks where each leaf has:
 * one owner, one inspectable output, explicit inputs, independent
 * verifiability, and a bounded budget. The graph is validated before
 * execution (acyclic, all dependencies present) and executed in
 * topological layers with bounded concurrency.
 *
 * The three canonical patterns are constructors over this one graph
 * (see patterns.ts): sequential, parallel (fan-out/fan-in), hierarchical.
 */

import { ReasoningError } from "../errors/taxonomy.js";

export interface TaskNode<_I = unknown, O = unknown> {
  readonly id: string;
  /** Observable outcome, not an activity. */
  readonly objective: string;
  readonly dependsOn: readonly string[];
  /**
   * What a failure of this task does to the rest of the graph:
   * - "abort-dependents" (default): dependents are skipped; unrelated branches continue;
   * - "abort-graph": fail the whole execution immediately.
   */
  readonly onFailure?: "abort-dependents" | "abort-graph";
  readonly run: (inputs: Readonly<Record<string, unknown>>) => Promise<O>;
}

export type TaskStatus = "completed" | "failed" | "skipped";

export interface TaskRecord {
  readonly id: string;
  readonly status: TaskStatus;
  readonly output?: unknown;
  readonly error?: string;
  /** Why the task was skipped, when it was. */
  readonly reason?: string;
  readonly durationMs: number;
}

export interface GraphResult {
  readonly records: Readonly<Record<string, TaskRecord>>;
  /** Convenience view: outputs of completed tasks only. */
  readonly outputs: Readonly<Record<string, unknown>>;
  readonly failed: readonly string[];
  readonly skipped: readonly string[];
  readonly ok: boolean;
}

function graphError(message: string, evidence: readonly string[]): ReasoningError {
  return new ReasoningError(message, {
    retryable: false,
    sideEffect: "none",
    blastRadius: "local",
    code: "reasoning.invalid_task_graph",
    evidence,
  });
}

export class TaskGraph {
  private readonly nodes = new Map<string, TaskNode>();

  add(node: TaskNode): this {
    if (this.nodes.has(node.id)) {
      throw graphError(`Duplicate task id "${node.id}".`, [node.id]);
    }
    this.nodes.set(node.id, node);
    return this;
  }

  get(id: string): TaskNode {
    const node = this.nodes.get(id);
    if (node === undefined) {
      throw graphError(`Task "${id}" is not in the graph.`, [id]);
    }
    return node;
  }

  get size(): number {
    return this.nodes.size;
  }

  /** Validate: all deps exist, graph is acyclic. Returns topological layers. */
  layers(): string[][] {
    const missing: string[] = [];
    for (const node of this.nodes.values()) {
      for (const dep of node.dependsOn) {
        if (!this.nodes.has(dep)) missing.push(`${node.id} -> ${dep}`);
      }
    }
    if (missing.length > 0) {
      throw graphError("Task graph has dependencies on unknown tasks.", missing);
    }

    // Kahn's algorithm; anything left over is part of a cycle.
    const indegree = new Map<string, number>();
    const dependents = new Map<string, string[]>();
    for (const node of this.nodes.values()) {
      indegree.set(node.id, node.dependsOn.length);
      for (const dep of node.dependsOn) {
        dependents.set(dep, [...(dependents.get(dep) ?? []), node.id]);
      }
    }

    const layers: string[][] = [];
    let frontier = [...this.nodes.keys()].filter((id) => (indegree.get(id) ?? 0) === 0);
    let placed = 0;
    while (frontier.length > 0) {
      layers.push(frontier);
      placed += frontier.length;
      const next: string[] = [];
      for (const id of frontier) {
        for (const child of dependents.get(id) ?? []) {
          const d = (indegree.get(child) ?? 0) - 1;
          indegree.set(child, d);
          if (d === 0) next.push(child);
        }
      }
      frontier = next;
    }
    if (placed !== this.nodes.size) {
      const cyclic = [...indegree.entries()].filter(([, d]) => d > 0).map(([id]) => id);
      throw graphError("Task graph contains a cycle.", cyclic);
    }
    return layers;
  }
}

export interface ExecuteOptions {
  /** Hard bound on concurrent tasks within a layer. Default 4. */
  readonly concurrency?: number;
  readonly onTaskDone?: (record: TaskRecord) => void;
}

/** Run `items` through `worker` with at most `limit` in flight. */
export async function pooled<I, O>(
  items: readonly I[],
  limit: number,
  worker: (item: I, index: number) => Promise<O>,
): Promise<O[]> {
  const results: O[] = new Array<O>(items.length);
  let cursor = 0;
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      const item = items[index];
      if (item !== undefined) results[index] = await worker(item, index);
    }
  });
  await Promise.all(lanes);
  return results;
}

/**
 * Execute a validated graph layer by layer.
 *
 * Failure semantics (defined, never improvised):
 * - a failed task records evidence and skips its dependents (transitively);
 * - unrelated branches continue;
 * - onFailure: "abort-graph" stops scheduling new work immediately;
 * - partial results are always returned to the caller for fan-in decisions.
 */
export async function executeGraph(graph: TaskGraph, options: ExecuteOptions = {}): Promise<GraphResult> {
  const concurrency = Math.max(1, options.concurrency ?? 4);
  const layers = graph.layers();
  const records: Record<string, TaskRecord> = {};
  let abortGraph = false;

  const skipReasonFor = (id: string): string | undefined => {
    for (const dep of graph.get(id).dependsOn) {
      const depRecord = records[dep];
      if (depRecord === undefined) continue;
      if (depRecord.status === "failed") return `dependency "${dep}" failed`;
      if (depRecord.status === "skipped") return `dependency "${dep}" was skipped (${depRecord.reason ?? "unknown"})`;
    }
    return undefined;
  };

  for (const layer of layers) {
    if (abortGraph) {
      for (const id of layer) {
        records[id] = { id, status: "skipped", reason: "graph aborted by an earlier failure", durationMs: 0 };
      }
      continue;
    }
    await pooled(layer, concurrency, async (id) => {
      const node = graph.get(id);
      const skipReason = skipReasonFor(id);
      if (skipReason !== undefined) {
        const record: TaskRecord = { id, status: "skipped", reason: skipReason, durationMs: 0 };
        records[id] = record;
        options.onTaskDone?.(record);
        return;
      }
      const inputs: Record<string, unknown> = {};
      for (const dep of node.dependsOn) inputs[dep] = records[dep]?.output;
      const started = Date.now();
      try {
        const output = await node.run(inputs);
        const record: TaskRecord = { id, status: "completed", output, durationMs: Date.now() - started };
        records[id] = record;
        options.onTaskDone?.(record);
      } catch (raw) {
        const message = raw instanceof Error ? raw.message : String(raw);
        const record: TaskRecord = { id, status: "failed", error: message, durationMs: Date.now() - started };
        records[id] = record;
        options.onTaskDone?.(record);
        if (node.onFailure === "abort-graph") abortGraph = true;
      }
    });
  }

  const outputs: Record<string, unknown> = {};
  const failed: string[] = [];
  const skipped: string[] = [];
  for (const record of Object.values(records)) {
    if (record.status === "completed") outputs[record.id] = record.output;
    if (record.status === "failed") failed.push(record.id);
    if (record.status === "skipped") skipped.push(record.id);
  }
  return { records, outputs, failed, skipped, ok: failed.length === 0 && skipped.length === 0 };
}

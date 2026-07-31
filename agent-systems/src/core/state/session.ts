/**
 * Session continuity across turns and failures.
 *
 * A checkpoint is the smallest state from which work can safely resume:
 * goal, task ledger, decisions, completed effects (idempotency records),
 * and the next action. On resume, recorded intent is reconciled against
 * actual external state BEFORE reissuing anything — completed effects are
 * never replayed, stale plans are marked superseded.
 */

import { z } from "zod";
import { ReasoningError } from "../errors/taxonomy.js";
import type { MemoryStore } from "./memory.js";

export const taskLedgerEntrySchema = z.object({
  task_id: z.string(),
  status: z.enum(["pending", "ready", "in_progress", "blocked", "completed", "failed", "superseded"]),
  owner: z.string(),
  attempt: z.number().int().nonnegative(),
});
export type TaskLedgerEntry = z.infer<typeof taskLedgerEntrySchema>;

export const effectRecordSchema = z.object({
  /** Idempotency key of the completed effect. */
  key: z.string(),
  effect: z.string(),
  completedAt: z.iso.datetime(),
});
export type EffectRecord = z.infer<typeof effectRecordSchema>;

export const checkpointSchema = z.object({
  session_id: z.string().min(1),
  version: z.number().int().positive(),
  correlation_id: z.string().min(1),
  goal: z.string(),
  ledger: z.array(taskLedgerEntrySchema),
  decisions: z.array(z.object({ decision: z.string(), rationale: z.string(), reversible: z.boolean() })),
  assumptions: z.array(z.object({ assumption: z.string(), impactIfWrong: z.string() })),
  /** Effects already applied externally — the do-not-replay list. */
  completedEffects: z.array(effectRecordSchema),
  nextAction: z.string(),
  savedAt: z.iso.datetime(),
});
export type Checkpoint = z.infer<typeof checkpointSchema>;

const NAMESPACE = "checkpoints";

export class CheckpointStore {
  constructor(private readonly store: MemoryStore) {}

  async save(checkpoint: Checkpoint): Promise<void> {
    const validated = checkpointSchema.parse(checkpoint);
    await this.store.set(NAMESPACE, validated.session_id, validated);
  }

  async load(sessionId: string): Promise<Checkpoint | undefined> {
    const raw = await this.store.get<unknown>(NAMESPACE, sessionId);
    if (raw === undefined) return undefined;
    const parsed = checkpointSchema.safeParse(raw);
    if (!parsed.success) {
      throw new ReasoningError(`Checkpoint for session "${sessionId}" failed schema validation.`, {
        retryable: false,
        sideEffect: "none",
        blastRadius: "workflow",
        code: "reasoning.corrupt_checkpoint",
        evidence: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
      });
    }
    return parsed.data;
  }
}

export interface ResumePlan {
  readonly checkpoint: Checkpoint;
  /** Ledger entries that are safe to start now. */
  readonly resumable: readonly TaskLedgerEntry[];
  /** Effects recorded as complete — callers must NOT re-execute these keys. */
  readonly doNotReplay: readonly string[];
  /** Entries whose status makes no sense after interruption. */
  readonly stale: readonly TaskLedgerEntry[];
}

/**
 * Reconcile a checkpoint with reality after an interruption.
 *
 * - in_progress entries are stale: the process died mid-attempt. They return
 *   to "ready" ONLY if their effect key is not in completedEffects.
 * - completed/failed entries are honored as recorded.
 * - The caller additionally verifies external state for any effect key it
 *   intends to run (read-after-write), because a checkpoint can lag reality.
 */
export function reconcile(checkpoint: Checkpoint): ResumePlan {
  const replayed = new Set(checkpoint.completedEffects.map((e) => e.key));
  const resumable: TaskLedgerEntry[] = [];
  const stale: TaskLedgerEntry[] = [];

  for (const entry of checkpoint.ledger) {
    if (entry.status === "in_progress") {
      if (replayed.has(entry.task_id)) {
        // Effect recorded complete; ledger lagged. Mark completed, do not rerun.
        stale.push({ ...entry, status: "completed" });
      } else {
        // Side-effect status unknown — return to ready for a fresh, classified attempt.
        resumable.push({ ...entry, status: "ready", attempt: entry.attempt + 1 });
      }
    } else if (entry.status === "ready" || entry.status === "pending") {
      resumable.push(entry);
    } else if (entry.status === "superseded") {
      stale.push(entry);
    }
    // completed/failed/blocked: no automatic transition.
  }

  return { checkpoint, resumable, doNotReplay: [...replayed], stale };
}

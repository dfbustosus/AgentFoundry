/**
 * Example 11 — In-context state vs. external memory; session continuity.
 *
 * Topics: state lifetimes · checkpoints · resume after failure.
 *
 * Simulates a crash mid-workflow: a checkpoint is saved with one task
 * completed (and its side effect recorded), one task in progress. After the
 * "restart", reconcile() decides what may resume — and what must never be
 * replayed.
 *
 * Run: npm run example -- examples/11-memory-sessions.ts  (no API key needed)
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CheckpointStore, FileStore, reconcile, type Checkpoint } from "../src/index.js";
import { main, printJson, printSection } from "./lib/shared.js";

await main(async () => {
  printSection("11 — Session continuity across failures");
  const dir = await mkdtemp(join(tmpdir(), "agent-session-"));

  try {
    // --- Before the "crash": work in progress, checkpointed. ---
    const checkpoint: Checkpoint = {
      session_id: "session-42",
      version: 1,
      correlation_id: "wf-42",
      goal: "Onboard a new customer",
      ledger: [
        { task_id: "create-account", status: "completed", owner: "provisioning", attempt: 1 },
        { task_id: "send-welcome-email", status: "in_progress", owner: "notifications", attempt: 1 },
        { task_id: "schedule-training", status: "pending", owner: "scheduling", attempt: 0 },
      ],
      decisions: [
        { decision: "Email before training", rationale: "Account credentials needed first", reversible: true },
      ],
      assumptions: [],
      // CRITICAL: the email WAS sent before the crash. This record is the only
      // thing preventing a duplicate send on resume.
      completedEffects: [
        { key: "send-welcome-email", effect: "welcome email sent", completedAt: new Date().toISOString() },
      ],
      nextAction: "schedule-training",
      savedAt: new Date().toISOString(),
    };
    const store = new CheckpointStore(new FileStore(dir));
    await store.save(checkpoint);
    console.log("\nCheckpoint saved. Simulating crash... (process dies here)\n");

    // --- After the "restart": load and reconcile. ---
    const restarted = new CheckpointStore(new FileStore(dir)); // fresh instance, same files
    const loaded = await restarted.load("session-42");
    if (loaded === undefined) throw new Error("checkpoint lost");
    const plan = reconcile(loaded);

    printJson("Resume plan", {
      resumable: plan.resumable.map((e) => `${e.task_id} (attempt ${e.attempt})`),
      doNotReplay: plan.doNotReplay,
      stale: plan.stale.map((e) => `${e.task_id} → ${e.status}`),
    });

    console.log(
      "\n'send-welcome-email' was in_progress but its effect is recorded — reconcile marks it " +
        "completed instead of resending. The ledger lagged reality; the effect record is the truth.\n" +
        "Rule: conversation history is not a database; durable effects live in the checkpoint.",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

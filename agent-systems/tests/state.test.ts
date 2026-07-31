import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileStore, InMemoryStore } from "../src/core/state/memory.js";
import { CheckpointStore, reconcile, type Checkpoint } from "../src/core/state/session.js";

describe("InMemoryStore", () => {
  it("gets, sets, lists, and deletes within a namespace", async () => {
    const store = new InMemoryStore();
    await store.set("ns", "a", 1);
    await store.set("ns", "b", 2);
    expect(await store.get<number>("ns", "a")).toBe(1);
    expect(await store.keys("ns")).toEqual(["a", "b"]);
    await store.delete("ns", "a");
    expect(await store.get("ns", "a")).toBeUndefined();
  });
});

describe("FileStore", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "agent-systems-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("persists values across store instances", async () => {
    const first = new FileStore(dir);
    await first.set("sessions", "s-1", { step: 3 });
    const second = new FileStore(dir);
    expect(await second.get<{ step: number }>("sessions", "s-1")).toEqual({ step: 3 });
  });

  it("rejects namespaces that are unsafe as file names", async () => {
    const store = new FileStore(dir);
    await expect(store.set("../escape", "k", 1)).rejects.toMatchObject({ code: "environment.invalid_namespace" });
  });

  it("returns empty state for missing namespaces", async () => {
    const store = new FileStore(dir);
    expect(await store.keys("never-written")).toEqual([]);
  });
});

function makeCheckpoint(overrides: Partial<Checkpoint> = {}): Checkpoint {
  return {
    session_id: "s-1",
    version: 1,
    correlation_id: "wf-1",
    goal: "ship the thing",
    ledger: [
      { task_id: "t-done", status: "completed", owner: "a", attempt: 1 },
      { task_id: "t-crashed", status: "in_progress", owner: "a", attempt: 1 },
      { task_id: "t-crashed-but-applied", status: "in_progress", owner: "a", attempt: 1 },
      { task_id: "t-ready", status: "ready", owner: "b", attempt: 0 },
      { task_id: "t-old", status: "superseded", owner: "a", attempt: 2 },
    ],
    decisions: [{ decision: "use hub-and-spoke", rationale: "canonical owner needed", reversible: true }],
    assumptions: [{ assumption: "API key present", impactIfWrong: "examples fail" }],
    completedEffects: [{ key: "t-crashed-but-applied", effect: "refund issued", completedAt: "2026-07-30T10:00:00Z" }],
    nextAction: "resume t-crashed",
    savedAt: "2026-07-30T10:05:00Z",
    ...overrides,
  };
}

describe("CheckpointStore + reconcile", () => {
  it("saves and loads a checkpoint with schema validation", async () => {
    const store = new CheckpointStore(new InMemoryStore());
    await store.save(makeCheckpoint());
    const loaded = await store.load("s-1");
    expect(loaded?.goal).toBe("ship the thing");
    expect(await store.load("missing")).toBeUndefined();
  });

  it("resume never replays completed effects and resets crashed work to ready", () => {
    const plan = reconcile(makeCheckpoint());
    const resumableIds = plan.resumable.map((e) => e.task_id);
    // crashed without recorded effect → ready again with a bumped attempt
    expect(resumableIds).toContain("t-crashed");
    expect(plan.resumable.find((e) => e.task_id === "t-crashed")?.attempt).toBe(2);
    // crashed WITH recorded effect → completed, not rerun
    expect(resumableIds).not.toContain("t-crashed-but-applied");
    expect(plan.stale.find((e) => e.task_id === "t-crashed-but-applied")?.status).toBe("completed");
    // ready work stays resumable; superseded work is stale
    expect(resumableIds).toContain("t-ready");
    expect(plan.stale.map((e) => e.task_id)).toContain("t-old");
    expect(plan.doNotReplay).toEqual(["t-crashed-but-applied"]);
  });

  it("rejects corrupt checkpoints instead of guessing", async () => {
    const memory = new InMemoryStore();
    await memory.set("checkpoints", "bad", { not: "a checkpoint" });
    const store = new CheckpointStore(memory);
    await expect(store.load("bad")).rejects.toMatchObject({ code: "reasoning.corrupt_checkpoint" });
  });
});

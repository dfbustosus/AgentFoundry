import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApprovalGate, PolicyError } from "../src/index.js";
import { runTriage } from "../capstone/src/agent.js";
import { SEED_TICKETS, TicketStore } from "../capstone/src/store.js";
import { buildTriageTools } from "../capstone/src/tools.js";
import { scriptedModel, textResult } from "./helpers.js";

const exec = async (tool: unknown, input: unknown): Promise<unknown> => {
  const execute = (tool as { execute?: (i: unknown, o: unknown) => Promise<unknown> }).execute;
  if (execute === undefined) throw new Error("no execute");
  return execute(input, { toolCallId: "t", messages: [] });
};

describe("capstone TicketStore", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "capstone-test-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("seeds, lists open tickets, and persists updates", async () => {
    const store = new TicketStore(dir);
    await store.seed();
    const open = await store.listOpen();
    expect(open).toHaveLength(SEED_TICKETS.length);
    await store.update("T-1001", { priority: "urgent" });
    const reloaded = new TicketStore(dir);
    expect((await reloaded.get("T-1001"))?.priority).toBe("urgent");
  });

  it("is idempotent under repeated seeding", async () => {
    const store = new TicketStore(dir);
    await store.seed();
    await store.update("T-1001", { priority: "high" });
    await store.seed(); // must not overwrite the update
    expect((await store.get("T-1001"))?.priority).toBe("high");
  });
});

describe("capstone tools", () => {
  let dir: string;
  let store: TicketStore;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "capstone-test-"));
    store = new TicketStore(dir);
    await store.seed();
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("issue_refund refuses tickets that are not refund-pending (domain authorization)", async () => {
    const tools = buildTriageTools(store);
    await expect(exec(tools.issueRefund, { id: "T-1001", amountUsd: 49 })).rejects.toMatchObject({
      code: "policy.domain_authorization_denied",
    });
  });

  it("refund exceeding the requested amount is rejected before money moves", async () => {
    const tools = buildTriageTools(store);
    await exec(tools.markRefundPending, { id: "T-1003" });
    await expect(exec(tools.issueRefund, { id: "T-1003", amountUsd: 500 })).rejects.toThrowError(/exceeds/);
    expect((await store.get("T-1003"))?.status).toBe("refund-pending");
  });

  it("approval denial blocks the refund and leaves the ticket refund-pending", async () => {
    const gate = new ApprovalGate(async () => ({
      approved: false,
      approver: "test-human",
      decidedAt: new Date().toISOString(),
      reason: "no budget today",
    }));
    const tools = buildTriageTools(store, {
      approveRefund: async (action) => {
        await gate.requireApproval(action, "test threshold");
      },
    });
    await exec(tools.markRefundPending, { id: "T-1003" });
    await expect(exec(tools.issueRefund, { id: "T-1003", amountUsd: 240 })).rejects.toMatchObject({
      code: "policy.approval_denied",
    });
    expect((await store.get("T-1003"))?.status).toBe("refund-pending");
    expect((await store.get("T-1003"))?.refundRequestUsd).toBe(240);
  });

  it("approved refund executes and satisfies the postcondition", async () => {
    const gate = new ApprovalGate(async () => ({
      approved: true,
      approver: "test-human",
      decidedAt: new Date().toISOString(),
    }));
    const tools = buildTriageTools(store, {
      approveRefund: async (action) => {
        await gate.requireApproval(action, "test threshold");
      },
    });
    await exec(tools.markRefundPending, { id: "T-1003" });
    const result = (await exec(tools.issueRefund, { id: "T-1003", amountUsd: 240 })) as {
      refundedUsd: number;
      status: string;
    };
    expect(result.refundedUsd).toBe(240);
    expect((await store.get("T-1003"))?.status).toBe("triaged");
  });

  it("set_priority postcondition verifies the store, not the claim", async () => {
    const tools = buildTriageTools(store);
    const result = (await exec(tools.setPriority, { id: "T-1002", priority: "low" })) as { priority: string };
    expect(result.priority).toBe("low");
    expect((await store.get("T-1002"))?.priority).toBe("low");
  });
});

describe("capstone triage agent", () => {
  it("runs the full loop wiring against the public API and stops cleanly", async () => {
    const dir = await mkdtemp(join(tmpdir(), "capstone-test-"));
    try {
      const store = new TicketStore(dir);
      await store.seed();
      const gate = new ApprovalGate(async () => null); // unattended: fail closed
      const { loop } = await runTriage({
        model: scriptedModel([textResult("Triage complete: 4 tickets reviewed.")]),
        store,
        approvalGate: gate,
      });
      expect(loop.transition).toBe("stop-success");
      expect(loop.text).toContain("4 tickets");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("gate denial surfaces as PolicyError, never swallowed", async () => {
    const gate = new ApprovalGate(async () => ({
      approved: false,
      approver: "test",
      decidedAt: new Date().toISOString(),
      reason: "denied",
    }));
    await expect(
      gate.requireApproval({ kind: "refund.issue", actor: "triage-agent", payload: { amountUsd: 240 } }, "test"),
    ).rejects.toBeInstanceOf(PolicyError);
  });
});

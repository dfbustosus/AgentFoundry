import { describe, expect, it } from "vitest";
import { z } from "zod";
import { fanIn, fanOut, type BranchOutcome } from "../src/core/orchestration/fanout.js";
import { runPipeline, type PipelineStage } from "../src/core/orchestration/pipeline.js";
import { selectTopology, type ProblemShape } from "../src/core/orchestration/topology.js";
import {
  assertDelegationWithinAuthority,
  assertNonOverlappingScopes,
  authorityAllows,
  type SubagentDefinition,
} from "../src/core/orchestration/subagent.js";
import { PolicyError } from "../src/core/errors/taxonomy.js";
import { scriptedModel, textResult } from "./helpers.js";

describe("pipeline", () => {
  const stages: PipelineStage<never, unknown>[] = [
    {
      id: "draft",
      objective: "produce draft",
      outputSchema: z.object({ text: z.string() }),
      run: async () => ({ text: "draft" }),
    },
    {
      id: "polish",
      objective: "polish draft",
      outputSchema: z.object({ text: z.string(), polished: z.boolean() }),
      run: async (input) => ({ ...(input as { text: string }), polished: true }),
    },
  ];

  it("chains stages with boundary validation", async () => {
    const result = await runPipeline(stages, undefined);
    expect(result.ok).toBe(true);
    expect(result.output).toEqual({ text: "draft", polished: true });
    expect(result.records.map((r) => r.status)).toEqual(["completed", "completed"]);
  });

  it("stops at the stage whose artifact violates the boundary schema", async () => {
    const broken: PipelineStage<never, unknown>[] = [
      {
        id: "bad",
        objective: "breaks contract",
        outputSchema: z.object({ text: z.string() }),
        run: async () => ({ wrong: true }),
      },
      ...stages,
    ];
    const result = await runPipeline(broken, undefined);
    expect(result.ok).toBe(false);
    expect(result.failedAt).toBe("bad");
    expect(result.records).toHaveLength(1); // later stages never ran
  });
});

describe("fan-out/fan-in", () => {
  it("resolves conflicts by authority, then recency — never by vote", async () => {
    const outcomes = await fanOut(
      [
        { id: "junior", authorityRank: 1, input: 0, run: async () => ({ answer: "A" }) },
        { id: "senior", authorityRank: 3, input: 0, run: async () => ({ answer: "B" }) },
        { id: "mid", authorityRank: 2, input: 0, run: async () => ({ answer: "C" }) },
      ],
      { concurrency: 3 },
    );
    const merged = fanIn<string>(outcomes, {
      project: (_branch, output) => ({ answer: (output as { answer: string }).answer }),
    });
    expect(merged.merged.answer).toBe("B");
    expect(merged.conflicts[0]?.winner).toBe("senior");
    expect(merged.conflicts[0]?.resolution).toBe("authority");
  });

  it("records failed branches and missing partitions under tolerate policy", async () => {
    const outcomes: BranchOutcome<unknown>[] = [
      { id: "ok", authorityRank: 1, status: "completed", output: 1, completedAt: 1 },
      {
        id: "bad",
        authorityRank: 1,
        status: "failed",
        error: new PolicyError("denied", { sideEffect: "none", blastRadius: "local", code: "policy.x" }),
        completedAt: 2,
      },
    ];
    const merged = fanIn<number>(outcomes, { project: (_b, o) => ({ value: o as number }) });
    expect(merged.merged.value).toBe(1);
    expect(merged.failedBranches.map((f) => f.id)).toEqual(["bad"]);
    expect(merged.missing).toEqual(["bad"]);
  });

  it("require-all policy fails the whole fan-in explicitly", () => {
    const outcomes: BranchOutcome<unknown>[] = [
      {
        id: "bad",
        authorityRank: 1,
        status: "failed",
        error: new PolicyError("denied", { sideEffect: "none", blastRadius: "local", code: "policy.x" }),
        completedAt: 1,
      },
    ];
    expect(() => fanIn(outcomes, { project: () => ({}), onBranchFailure: "require-all" })).toThrowError(PolicyError);
  });
});

describe("topology selection", () => {
  const base: ProblemShape = {
    partitionable: false,
    stagedTransform: false,
    needsCanonicalOwner: false,
    needsSpecialization: false,
    sharedNegotiation: false,
    coordinationBudget: "low",
  };

  it("chooses single-agent when coordination buys nothing", () => {
    expect(selectTopology(base).topology).toBe("single-agent");
  });

  it("chooses pipeline for staged transforms with real data dependencies", () => {
    expect(selectTopology({ ...base, stagedTransform: true, needsSpecialization: true }).topology).toBe("pipeline");
  });

  it("chooses fan-out/fan-in for partitionable work without a canonical owner", () => {
    expect(selectTopology({ ...base, partitionable: true, needsSpecialization: true }).topology).toBe("fan-out-fan-in");
  });

  it("chooses hub-and-spoke when a canonical owner must preserve intent", () => {
    expect(selectTopology({ ...base, partitionable: true, needsCanonicalOwner: true }).topology).toBe("hub-and-spoke");
  });

  it("chooses peer-to-peer only for genuine shared negotiation, with caveats", () => {
    const verdict = selectTopology({ ...base, sharedNegotiation: true, coordinationBudget: "high" });
    expect(verdict.topology).toBe("peer-to-peer");
    expect(verdict.rationale).toContain("protocol");
  });
});

describe("subagent authority and isolation", () => {
  const makeAgent = (
    id: string,
    authority: SubagentDefinition["authority"],
    writeScopes: string[],
  ): SubagentDefinition => ({
    id,
    role: "tester",
    instructions: "test",
    model: scriptedModel([textResult("ok")]),
    tools: {},
    authority,
    writeScopes,
  });

  it("ranks authority levels", () => {
    expect(authorityAllows("execute", "propose")).toBe(true);
    expect(authorityAllows("read-only", "modify")).toBe(false);
  });

  it("blocks delegations exceeding granted authority — in code", () => {
    const agent = makeAgent("a", "propose", []);
    expect(() => assertDelegationWithinAuthority(agent, "execute")).toThrowError(PolicyError);
    expect(() => assertDelegationWithinAuthority(agent, "propose")).not.toThrow();
  });

  it("rejects overlapping write scopes between concurrent agents", () => {
    const a = makeAgent("a", "modify", ["tickets"]);
    const b = makeAgent("b", "modify", ["tickets"]);
    expect(() => assertNonOverlappingScopes([a, b])).toThrowError(/overlapping|claimed by both/i);
    expect(() => assertNonOverlappingScopes([a, makeAgent("c", "modify", ["reports"])])).not.toThrow();
  });
});

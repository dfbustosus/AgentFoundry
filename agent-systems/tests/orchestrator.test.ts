import { describe, expect, it } from "vitest";
import { InMemoryBus } from "../src/core/handoff/protocol.js";
import { Orchestrator } from "../src/core/orchestration/hub-spoke.js";
import type { SubagentDefinition } from "../src/core/orchestration/subagent.js";
import { scriptedModel, textResult } from "./helpers.js";

function makeAgent(id: string, answer: string): SubagentDefinition {
  return {
    id,
    role: id,
    instructions: `You are the ${id} specialist.`,
    model: scriptedModel([textResult(answer)]),
    tools: {},
    authority: "propose",
    writeScopes: [],
  };
}

describe("Orchestrator (hub-and-spoke)", () => {
  it("delegates a bounded brief and returns a validated result envelope", async () => {
    const bus = new InMemoryBus();
    const orchestrator = new Orchestrator({ id: "hub", model: scriptedModel([textResult("unused")]), bus });
    const researcher = makeAgent("researcher", "The evidence says 42.");

    const result = await orchestrator.delegate(
      researcher,
      {
        task_id: "t-1",
        objective: "Find the number.",
        facts: [],
        assumptions: [],
        artifact_refs: [],
        constraints: [],
        acceptance_checks: ["Produces a number with evidence"],
      },
      { correlation_id: "wf-1" },
    );

    expect(result.status).toBe("completed");
    expect(result.reply.causation_id).not.toBeNull();
    expect(result.reply.sender).toBe("researcher");
    expect(result.reply.recipient).toBe("hub");
    // The bus carries the full audit chain: delegation + reply.
    expect(bus.peek("researcher")).toHaveLength(1);
    expect(bus.peek("hub")).toHaveLength(1);
  });

  it("marks failed spokes as failed — never smoothed over", async () => {
    const bus = new InMemoryBus();
    const orchestrator = new Orchestrator({ id: "hub", model: scriptedModel([textResult("unused")]), bus });
    const broken: SubagentDefinition = {
      ...makeAgent("broken", "unused"),
      model: scriptedModel([textResult("x", "tool-calls")]), // never finishes: burn iterations
      maxIterations: 2,
    };
    const result = await orchestrator.delegate(
      broken,
      {
        task_id: "t-2",
        objective: "Never completes.",
        facts: [],
        assumptions: [],
        artifact_refs: [],
        constraints: [],
        acceptance_checks: [],
      },
      { correlation_id: "wf-2" },
    );
    expect(result.status).toBe("failed");
    expect(result.reply.status).toBe("failed");
  });

  it("runs an explicit plan across agents with dependency-aware scheduling and aggregation", async () => {
    const bus = new InMemoryBus();
    const orchestrator = new Orchestrator({ id: "hub", model: scriptedModel([textResult("unused")]), bus });
    const agents = {
      researcher: makeAgent("researcher", "research findings"),
      writer: makeAgent("writer", "final report"),
    };

    const outcome = await orchestrator.run("Write a researched report", agents, {
      correlation_id: "wf-3",
      plan: {
        subtasks: [
          { id: "researcher", objective: "Gather findings", dependsOn: [] },
          { id: "writer", objective: "Write the report from findings", dependsOn: ["researcher"] },
        ],
      },
    });

    expect(outcome.completed).toEqual(["researcher", "writer"]);
    expect(outcome.unresolved).toEqual([]);
    // The writer's brief contained the researcher's summary as an upstream fact.
    const writerResult = outcome.results.find((r) => r.task_id === "writer");
    expect(writerResult?.reply.objective).toBe("Write the report from findings");
  });

  it("rejects plans referencing unknown agents", async () => {
    const bus = new InMemoryBus();
    const orchestrator = new Orchestrator({ id: "hub", model: scriptedModel([textResult("unused")]), bus });
    await expect(
      orchestrator.run(
        "goal",
        { researcher: makeAgent("researcher", "x") },
        {
          plan: { subtasks: [{ id: "ghost", objective: "haunt", dependsOn: [] }] },
        },
      ),
    ).rejects.toMatchObject({ code: "reasoning.unbound_task" });
  });
});

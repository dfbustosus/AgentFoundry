/**
 * Example 09 — The orchestrator: directing, delegating, aggregating.
 *
 * Topics: orchestrator role · hub-and-spoke topology · subagent design,
 * authority, and isolation · aggregation as verification.
 *
 * One hub owns the goal and the final answer. Two spokes with bounded
 * authority receive bounded briefs; the hub validates every reply envelope
 * before closing the task.
 *
 * Run: npm run example -- examples/09-hub-and-spoke.ts
 */

import { InMemoryBus, Orchestrator, type SubagentDefinition } from "../src/index.js";
import { main, model, printJson, printSection } from "./lib/shared.js";

await main(async () => {
  printSection("09 — Hub-and-spoke orchestration");

  const llm = model();
  const bus = new InMemoryBus();
  const hub = new Orchestrator({ id: "hub", model: llm, bus });

  const agents: Record<string, SubagentDefinition> = {
    researcher: {
      id: "researcher",
      role: "research",
      instructions: "You gather concise, factual findings. Cite what you know vs. assume.",
      model: llm,
      tools: {},
      authority: "propose", // can recommend, cannot mutate the world
      writeScopes: [],
      maxIterations: 3,
    },
    writer: {
      id: "writer",
      role: "writing",
      instructions: "You turn findings into crisp prose for executives.",
      model: llm,
      tools: {},
      authority: "propose",
      writeScopes: [],
      maxIterations: 3,
    },
  };

  const outcome = await hub.run("Explain to an executive why agent loops need hard budgets.", agents, {
    plan: {
      subtasks: [
        { id: "researcher", objective: "List the three strongest arguments with evidence", dependsOn: [] },
        { id: "writer", objective: "Turn the arguments into a 4-sentence executive brief", dependsOn: ["researcher"] },
      ],
    },
  });

  console.log(`\nCompleted: [${outcome.completed.join(", ")}]`);
  console.log(`Unresolved: ${outcome.unresolved.length}`);
  for (const r of outcome.results) {
    console.log(`\n[${r.status}] ${r.task_id} → ${r.summary.slice(0, 300)}`);
  }
  printJson("Dissent and open questions (surfaced, not smoothed over)", outcome.dissent);

  console.log(
    "\nNote the trade-off you just paid: the hub read every brief and verified every " +
      "reply — coordination overhead. In exchange: one canonical goal, one audit trail " +
      `(${bus.peek("hub").length} result envelopes at the hub), one accountable final answer.`,
  );
});

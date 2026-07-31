/**
 * Example 04 — Breaking complex goals into actionable subtasks.
 *
 * Topics: decomposition patterns — hierarchical (this file shows the planner);
 * the graph is validated before execution, so a model-proposed cycle or
 * dangling dependency is rejected by code, not discovered mid-run.
 *
 * Run: npm run example -- examples/04-decomposition.ts
 */

import { generateText } from "ai";
import { executeGraph, planHierarchical, TaskGraph } from "../src/index.js";
import { main, model, printJson, printSection } from "./lib/shared.js";

await main(async () => {
  printSection("04 — Hierarchical decomposition with a validated plan");

  const goal = "Produce a one-page competitive brief for a meal-prep startup.";

  // 1. The model PROPOSES a plan...
  const plan = await planHierarchical({
    model: model(),
    goal,
    context: "Workers available: research (web-free reasoning), analysis, writing.",
  });
  printJson("Proposed plan", plan);

  // 2. ...but every subtask must bind to a real worker, and the graph must
  //    validate. The model proposes; code disposes.
  const graph = new TaskGraph();
  const llm = model();
  for (const sub of plan.subtasks) {
    graph.add({
      id: sub.id,
      objective: sub.objective,
      dependsOn: sub.dependsOn.filter((d) => plan.subtasks.some((s) => s.id === d)),
      run: async (inputs) => {
        const upstream = Object.entries(inputs)
          .map(([k, v]) => `[${k}]: ${String(v).slice(0, 200)}`)
          .join("\n");
        const result = await generateText({
          model: llm,
          system: "You are a specialist worker. Be brief and concrete.",
          prompt: `Task: ${sub.objective}\n${upstream.length > 0 ? `Upstream results:\n${upstream}` : ""}`,
        });
        return result.text;
      },
    });
  }
  const layers = graph.layers(); // throws on cycles/dangling deps
  printJson("Validated execution layers", layers);

  // 3. Execute with bounded concurrency; every task records evidence.
  const result = await executeGraph(graph, {
    concurrency: 2,
    onTaskDone: (r) => console.log(`  [${r.status}] ${r.id} (${r.durationMs}ms)`),
  });

  console.log(`\nGraph ok=${result.ok} failed=[${result.failed.join(", ")}] skipped=[${result.skipped.join(", ")}]`);
  const lastLayer = layers.at(-1) ?? [];
  for (const id of lastLayer) {
    console.log(`\nFinal artifact (${id}):\n${String(result.outputs[id]).slice(0, 600)}`);
  }
});

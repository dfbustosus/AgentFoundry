/**
 * Example 07 — Adaptive planning: updating the plan mid-execution.
 *
 * Topics: adaptive planning · replanning triggers · plan-change records.
 *
 * A plan is executed; when a task's observation disproves an assumption, the
 * plan is revised BY DELTA — valid completed work is preserved, obsolete work
 * is cancelled with a reason, and the change is recorded explicitly.
 *
 * Run: npm run example -- examples/07-adaptive-planning.ts
 */

import { generateText } from "ai";
import { executeGraph, TaskGraph } from "../src/index.js";
import { main, model, printJson, printSection } from "./lib/shared.js";

interface PlanChange {
  change_id: string;
  trigger: string;
  previous_assumption: string;
  preserved_work: string[];
  cancelled_work: string[];
  new_or_changed_work: string[];
  decision: string;
}

await main(async () => {
  printSection("07 — Adaptive planning with an explicit plan-change record");

  const llm = model();
  const runLlmTask = (objective: string) => async () =>
    (await generateText({ model: llm, system: "Be brief.", prompt: objective })).text;

  // Initial plan assumes the summary should be technical.
  const initial = new TaskGraph()
    .add({ id: "research", objective: "Research topic X", dependsOn: [], run: runLlmTask("List 3 facts about graphite.") })
    .add({ id: "technical-summary", objective: "Technical summary", dependsOn: ["research"], run: runLlmTask("Write a technical summary of graphite for engineers.") });

  const first = await executeGraph(initial);
  console.log(`\nInitial plan: completed=[${Object.keys(first.outputs).join(", ")}]`);

  // MID-EXECUTION EVIDENCE: a stakeholder observation invalidates the assumption.
  const stakeholderFeedback = "The audience is actually executives, not engineers.";
  console.log(`\nReplan trigger: ${stakeholderFeedback}`);

  // Replan by delta: keep valid work, cancel superseded work, add what is needed.
  const change: PlanChange = {
    change_id: "chg-1",
    trigger: stakeholderFeedback,
    previous_assumption: "Audience is engineers",
    preserved_work: ["research"], // still valid — facts are audience-independent
    cancelled_work: ["technical-summary"], // superseded, with a reason
    new_or_changed_work: ["executive-summary"],
    decision: "Reuse research output; regenerate only the audience-dependent artifact.",
  };
  printJson("Plan-change record", change);

  // The revised plan reuses the PRESERVED output — it is not recomputed.
  const revised = new TaskGraph().add({
    id: "executive-summary",
    objective: "Executive summary",
    dependsOn: [],
    run: async () =>
      (
        await generateText({
          model: llm,
          system: "Write for executives: outcome-first, no jargon.",
          prompt: `Summarize for executives using these facts:\n${String(first.outputs["research"])}`,
        })
      ).text,
  });
  const second = await executeGraph(revised);

  console.log(`\nRevised plan output:\n${String(second.outputs["executive-summary"])}`);
  console.log(
    "\nThe replan preserved the research artifact instead of restarting the whole plan " +
      "for the appearance of consistency.",
  );
});

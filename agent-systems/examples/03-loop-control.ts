/**
 * Example 03 — Loop control: stopping, iterating, recovering, escalating.
 *
 * Topics: loop control · budgets · custom transition policies.
 *
 * Two runs:
 *  A) a normal task that stops on success;
 *  B) a task with a custom `decide` policy that detects a missing high-impact
 *     fact and transitions to "clarify" instead of guessing.
 * Budgets are hard bounds in code — the loop can never run away.
 *
 * Run: npm run example -- examples/03-loop-control.ts
 */

import { runPraoLoop } from "../src/index.js";
import { main, model, printJson, printSection } from "./lib/shared.js";

await main(async () => {
  printSection("03 — Loop control");

  console.log("\nRun A: bounded success");
  const ok = await runPraoLoop({
    model: model(),
    system: "You are concise.",
    goal: "Name three colors.",
    budgets: { maxIterations: 3, maxElapsedMs: 60_000, maxToolCalls: 0, maxConsecutiveFailures: 2 },
  });
  console.log(`  transition=${ok.transition} iterations=${ok.iterations}`);
  console.log(`  answer: ${ok.text}`);

  console.log("\nRun B: clarification instead of guessing");
  const clarify = await runPraoLoop({
    model: model(),
    system:
      "You deploy services. If the target environment is not stated, say exactly: " +
      "'MISSING: target environment'. Do not pick one yourself.",
    goal: "Deploy the billing service.",
    budgets: { maxIterations: 3 },
    decide: (obs) =>
      obs.text.includes("MISSING:")
        ? {
            transition: "clarify",
            reason: "A high-impact fact (target environment) is missing and cannot be inferred safely.",
            request: "Which environment should the billing service deploy to: staging or production?",
          }
        : undefined,
  });
  printJson("Loop outcome", {
    transition: clarify.transition,
    reason: clarify.reason,
    request: clarify.request ?? null,
    modelSaid: clarify.text,
  });

  console.log(
    "\nThe point: the MODEL flagged the ambiguity, but the TRANSITION (stop and ask vs. " +
      "keep going) is a code-level policy decision — testable, auditable, and not up to the model.",
  );
});

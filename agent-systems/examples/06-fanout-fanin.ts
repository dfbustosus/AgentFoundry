/**
 * Example 06 — Parallel execution: fan-out, fan-in, synchronization.
 *
 * Topics: parallel execution · fan-out/fan-in · conflict resolution.
 *
 * Three "researchers" answer the same question with different authority
 * ranks. The fan-in barrier resolves conflicts by authority, then recency —
 * never by vote — and records every conflict with its rationale.
 *
 * Run: npm run example -- examples/06-fanout-fanin.ts
 */

import { generateText } from "ai";
import { fanIn, fanOut } from "../src/index.js";
import { main, model, printJson, printSection } from "./lib/shared.js";

await main(async () => {
  printSection("06 — Fan-out / fan-in with deterministic conflict resolution");

  const llm = model();
  const question = "What is the single most important reliability practice for LLM agents?";

  const outcomes = await fanOut(
    [
      {
        id: "fast-model",
        authorityRank: 1,
        input: question,
        run: async (q) => (await generateText({ model: llm, prompt: `${q} One sentence.` })).text,
      },
      {
        id: "careful-model",
        authorityRank: 2,
        input: question,
        run: async (q) =>
          (await generateText({ model: llm, system: "Answer as a staff SRE.", prompt: `${q} One sentence.` })).text,
      },
      {
        id: "policy-source",
        authorityRank: 3,
        input: question,
        run: async () => "Enforce authorization and budgets in deterministic code, not prompts.",
      },
    ],
    { concurrency: 3 },
  );

  console.log("\nBranch outcomes:");
  for (const o of outcomes) console.log(`  [${o.status}] ${o.id} (rank ${o.authorityRank})`);

  const merged = fanIn<string>(outcomes, {
    project: (_branch, output) => ({ recommendation: output as string }),
  });

  printJson("Fan-in result", {
    merged: merged.merged,
    conflicts: merged.conflicts.map((c) => ({ key: c.key, winner: c.winner, resolution: c.resolution })),
    failedBranches: merged.failedBranches.map((f) => f.id),
  });

  console.log(
    `\nWinner: "${merged.merged.recommendation ?? ""}"\n` +
      "The highest-authority source won by policy — recorded, not voted.",
  );
});

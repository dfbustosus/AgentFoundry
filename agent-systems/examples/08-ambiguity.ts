/**
 * Example 08 — Handling ambiguity and incomplete specification.
 *
 * Topics: ambiguity · assumption registers · when to ask vs. when to assume.
 *
 * The rule being taught: ask only when the missing answer materially changes
 * scope, safety, cost, or an irreversible decision. Otherwise state a
 * reasonable REVERSIBLE assumption, record it in the register with its impact
 * if wrong, and proceed.
 *
 * Run: npm run example -- examples/08-ambiguity.ts
 */

import { generateObject } from "ai";
import { z } from "zod";
import { main, model, printJson, printSection } from "./lib/shared.js";

const triageSchema = z.object({
  missingFacts: z
    .array(
      z.object({
        fact: z.string(),
        materialTo: z.enum(["scope", "safety", "cost", "irreversible-decision", "preference"]),
      }),
    )
    .describe("Facts missing from the request"),
  assumptions: z
    .array(
      z.object({
        assumption: z.string(),
        reversible: z.boolean(),
        impactIfWrong: z.string(),
      }),
    )
    .describe("Safe defaults for non-material gaps"),
});
type Triage = z.infer<typeof triageSchema>;

await main(async () => {
  printSection("08 — Ambiguity triage: ask vs. assume");

  const request = "Clean up the old data and send the summary to the team.";

  const triage = (
    await generateObject({
      model: model(),
      schema: triageSchema,
      system:
        "You triage underspecified requests. A fact is MATERIAL only if getting it wrong " +
        "changes scope, safety, cost, or an irreversible decision. Everything else gets a " +
        "reversible assumption with a stated impact.",
      prompt: `Request: "${request}"`,
    })
  ).object as Triage;

  const mustAsk = triage.missingFacts.filter((f) => f.materialTo !== "preference");
  const safeToAssume = triage.assumptions.filter((a) => a.reversible);

  printJson("Must ask BEFORE acting (material gaps)", mustAsk);
  printJson("Safe to assume (reversible, impact recorded)", safeToAssume);

  console.log(
    "\nDecision rule: deleting 'old data' is irreversible — the agent must clarify what " +
      "'old' and 'clean up' mean. 'The team' can be assumed (the team alias) and corrected " +
      "cheaply if wrong. Never silently invent retention rules, credentials, or identifiers.",
  );
});

/**
 * Capstone eval suite: the acceptance test for the triage agent's BEHAVIOR.
 *
 * Golden triage scenarios scored with deterministic checks (did it mention
 * the right priority/action keywords?) plus an LLM judge for appropriateness.
 *
 * Run: npm run capstone:eval        (live model)
 *      AGENT_SYSTEMS_MOCK=1 npm run capstone:eval   (offline)
 */

import { contains, defineDataset, llmJudge, runEval, type EvalDataset } from "../../src/index.js";
import { isMockMode, loadEnv } from "../../src/config/env.js";
import { model, printJson } from "../../examples/lib/shared.js";

export const TRIAGE_DATASET: EvalDataset = defineDataset({
  name: "triage-behavior-v1",
  cases: [
    {
      id: "double-charge",
      input:
        "Ticket T-2001: 'Charged twice this month, want my $49 back.' Draft your triage decision (priority and action).",
      expected: "refund",
    },
    {
      id: "data-loss",
      input:
        "Ticket T-2002: 'Three days of notes lost after sync, business impact, wants $240 annual refund.' Draft your triage decision.",
      expected: "urgent",
    },
    {
      id: "how-to",
      input: "Ticket T-2003: 'Where is the export button?' Draft your triage decision.",
      expected: "low",
    },
  ],
});

async function main(): Promise<void> {
  const llm = model();
  const report = await runEval({
    dataset: TRIAGE_DATASET,
    subject: async (input) => {
      const { generateText } = await import("ai");
      return (
        await generateText({
          model: llm,
          system:
            "You are a support triage agent. State the priority (low/medium/high/urgent) and the action " +
            "(answer/close, escalate, refund-pending) for the ticket, with one sentence of rationale.",
          prompt: input,
        })
      ).text;
    },
    scorers: [
      contains(),
      llmJudge(llm, "The priority and action are appropriate for the ticket's severity and the customer's request."),
    ],
  });

  printJson("Capstone eval report", {
    dataset: report.dataset,
    passRate: `${(report.passRate * 100).toFixed(0)}%`,
    cases: report.cases.map((c) => ({
      id: c.id,
      pass: c.pass,
      evidence: c.scores.map((s) => `[${s.scorer}] ${s.evidence}`),
    })),
  });

  if (isMockMode(loadEnv())) {
    console.log("(mock mode: deterministic scorers fail against the canned answer by design — see example 18.)");
  }
}

main().catch((err: unknown) => {
  console.error("Capstone eval failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});

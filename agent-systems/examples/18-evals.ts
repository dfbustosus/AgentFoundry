/**
 * Example 18 — Evals: how do you know the agent is any good?
 *
 * Topics: evaluating agent behavior · golden datasets · deterministic
 * scorers vs. LLM judges · evidence over vibes.
 *
 * The chatbot from example 01 is evaluated against a golden dataset with two
 * scorer types: a deterministic `contains` (cheap, reproducible) and an
 * `llmJudge` for a quality determinism can't check (actionable advice).
 * Change the agent and re-run: the pass rate is the evidence.
 *
 * Run: npm run example -- examples/18-evals.ts
 * (Offline with AGENT_SYSTEMS_MOCK=1 — the mock judge always passes with a
 * recorded reason, which itself demonstrates why judge evidence is auditable.)
 */

import { z } from "zod";
import { contains, defineContractTool, defineDataset, llmJudge, runEval, runPraoLoop } from "../src/index.js";
import { main, model, printJson, printSection } from "./lib/shared.js";

await main(async () => {
  printSection("18 — Evaluating agent behavior");

  const llm = model();
  const weatherTool = defineContractTool(
    {
      name: "get_weather",
      description: "Gets current weather for a city. Only for weather questions.",
      input: z.object({ city: z.string() }),
      output: z.object({ city: z.string(), tempC: z.number(), condition: z.string() }),
      sideEffect: "read-only",
      idempotent: true,
      execute: async ({ city }) => ({ city, tempC: 8, condition: "rain" }),
    },
    { context: { agentId: "chatbot", writeScopes: [] } },
  );

  // The subject under evaluation: the same agent shape as example 01.
  const subject = async (input: string): Promise<string> => {
    const result = await runPraoLoop({
      model: llm,
      tools: { get_weather: weatherTool },
      system: "You are concise. Use tools for facts. Give practical advice.",
      goal: input,
      budgets: { maxIterations: 3, maxToolCalls: 3 },
    });
    return result.text;
  };

  const dataset = defineDataset({
    name: "weather-advice-v1",
    cases: [
      {
        id: "jacket-advice",
        input: "It's cold and wet in Bogotá today. Should I bring a jacket?",
        expected: "jacket",
        metadata: { difficulty: "easy" },
      },
      {
        id: "rain-advice",
        input: "Will I need rain gear in Medellín this evening?",
        expected: "rain",
        metadata: { difficulty: "easy" },
      },
    ],
  });

  const report = await runEval({
    dataset,
    subject,
    scorers: [
      contains(), // deterministic: expected keyword appears
      llmJudge(llm, "The output gives actionable clothing advice (what to wear or bring), not just a weather report."), // quality gate
    ],
  });

  if (process.env.AGENT_SYSTEMS_MOCK === "1") {
    console.log(
      "\n(mock mode: the canned mock answer deliberately FAILS the deterministic `contains`\n" +
        "scorer — which is the point: deterministic scorers cannot be sweet-talked. With a\n" +
        "live key the agent answers for real and the report reflects its actual quality.)",
    );
  }

  printJson("Eval report", {
    dataset: report.dataset,
    passRate: `${(report.passRate * 100).toFixed(0)}%`,
    cases: report.cases.map((c) => ({
      id: c.id,
      pass: c.pass,
      evidence: c.scores.map((s) => `[${s.scorer}] ${s.evidence}`),
      ...(c.error !== undefined ? { error: c.error } : {}),
    })),
  });

  console.log(
    "\nTests tell you the loop runs. This tells you the loop is USEFUL — and the judge's\n" +
      "reasons are recorded, so a passing score can be audited instead of trusted.",
  );
});

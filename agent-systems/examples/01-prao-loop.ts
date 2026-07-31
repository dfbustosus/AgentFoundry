/**
 * Example 01 — The PRAO loop and the agentic chatbot.
 *
 * Topics: agents/workflows/chatbots · tool use as the foundation of agency ·
 * Perception–Reasoning–Action–Observation.
 *
 * A conversational agent with one real tool, run through the explicit PRAO
 * loop. Watch the console: every iteration is a traceable cycle with a typed
 * observation and an explicit transition — not a black-box while-loop.
 *
 * Run: npm run example -- examples/01-prao-loop.ts
 */

import { runPraoLoop } from "../src/index.js";
import { defineContractTool } from "../src/index.js";
import { z } from "zod";
import { main, model, printJson, printSection } from "./lib/shared.js";

const weatherTool = defineContractTool(
  {
    name: "get_weather",
    description:
      "Gets current weather for a city. Use only when the user asks about weather; " +
      "do NOT use it for forecasts, history, or climate questions.",
    input: z.object({ city: z.string().describe("City name, e.g. 'Lisbon'") }),
    output: z.object({ city: z.string(), tempC: z.number(), condition: z.string() }),
    sideEffect: "read-only",
    idempotent: true,
    execute: async ({ city }) => {
      // Demo data source — swap for a real API; the contract does not change.
      return { city, tempC: 21, condition: "clear" };
    },
  },
  { context: { agentId: "chatbot", writeScopes: [] } },
);

await main(async () => {
  printSection("01 — PRAO loop chatbot");

  const result = await runPraoLoop({
    model: model(),
    tools: { get_weather: weatherTool },
    system:
      "You are a concise assistant. Use tools when they ground your answer in fact. " +
      "Answer in one or two sentences.",
    goal: "What's the weather like in Lisbon right now, and should I bring a jacket?",
    budgets: { maxIterations: 4, maxToolCalls: 5 },
    onObservation: (o) => {
      console.log(
        `\n[iteration ${o.iteration}] kind=${o.kind} tools=[${o.toolCalls.join(", ")}] finish=${o.finishReason}`,
      );
      console.log(`  observation: ${o.summary}`);
    },
  });

  printJson("Loop result", {
    transition: result.transition,
    reason: result.reason,
    iterations: result.iterations,
    toolCallCount: result.toolCallCount,
    usage: result.usage,
  });
  console.log(`\nFinal answer: ${result.text}`);
});

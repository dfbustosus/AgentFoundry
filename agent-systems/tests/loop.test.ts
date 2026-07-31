import { describe, expect, it } from "vitest";
import { tool } from "ai";
import { z } from "zod";
import { runPraoLoop } from "../src/core/loop/prao.js";
import { ToolError } from "../src/core/errors/taxonomy.js";
import { failingModel, scriptedModel, textResult, toolCallResult } from "./helpers.js";

const echoTool = tool({
  description: "Echoes input back.",
  inputSchema: z.object({ text: z.string() }),
  execute: async ({ text }) => ({ echoed: text }),
});

describe("runPraoLoop", () => {
  it("stops with stop-success when the model produces a final answer", async () => {
    const result = await runPraoLoop({
      model: scriptedModel([textResult("The answer is 42.")]),
      system: "You are helpful.",
      goal: "What is the answer?",
    });
    expect(result.transition).toBe("stop-success");
    expect(result.text).toBe("The answer is 42.");
    expect(result.iterations).toBe(1);
    expect(result.usage.inputTokens).toBeGreaterThan(0);
  });

  it("iterates through tool use and stops on the final answer", async () => {
    const result = await runPraoLoop({
      model: scriptedModel([toolCallResult("echo", { text: "hi" }), textResult("Echoed: hi")]),
      tools: { echo: echoTool },
      system: "Use tools.",
      goal: "Echo hi.",
    });
    expect(result.transition).toBe("stop-success");
    expect(result.toolCallCount).toBe(1);
    // v7: generateText completes the tool round-trip within one PRAO iteration,
    // so the observation is success WITH tool calls recorded.
    expect(result.observations[0]?.kind).toBe("success");
    expect(result.observations[0]?.toolCalls).toEqual(["echo"]);
  });

  it("observes 'partial' when stepsPerIteration cuts the tool loop mid-flight", async () => {
    const result = await runPraoLoop({
      model: scriptedModel([toolCallResult("echo", { text: "hi" }), textResult("Echoed: hi")]),
      tools: { echo: echoTool },
      system: "Use tools.",
      goal: "Echo hi.",
      stepsPerIteration: 1, // each PRAO iteration = exactly one model step
    });
    expect(result.transition).toBe("stop-success");
    expect(result.observations[0]?.kind).toBe("partial");
    expect(result.observations[0]?.toolCalls).toEqual(["echo"]);
    expect(result.iterations).toBe(2);
  });

  it("recovers from transient failures and stops succeeding", async () => {
    let attempt = 0;
    const { MockLanguageModelV4 } = await import("ai/test");
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        attempt += 1;
        if (attempt === 1) {
          throw new ToolError("transient", {
            retryable: true,
            sideEffect: "none",
            blastRadius: "local",
            code: "tool.timeout",
          });
        }
        return textResult("recovered");
      },
    });
    const result = await runPraoLoop({ model, system: "s", goal: "g" });
    expect(result.transition).toBe("stop-success");
    expect(result.observations[0]?.kind).toBe("failure");
    expect(result.text).toBe("recovered");
  });

  it("escalates after maxConsecutiveFailures", async () => {
    const result = await runPraoLoop({
      model: failingModel(
        () =>
          new ToolError("always fails", {
            retryable: true,
            sideEffect: "none",
            blastRadius: "local",
            code: "tool.timeout",
          }),
      ),
      system: "s",
      goal: "g",
      budgets: { maxConsecutiveFailures: 2, maxIterations: 10 },
    });
    expect(result.transition).toBe("escalate");
    expect(result.request).toBeDefined();
    expect(result.observations.filter((o) => o.kind === "failure")).toHaveLength(2);
  });

  it("stop-failure on non-retryable errors without burning the budget", async () => {
    const result = await runPraoLoop({
      model: failingModel(
        () =>
          new ToolError("bad input", {
            retryable: false,
            sideEffect: "none",
            blastRadius: "local",
            code: "tool.invalid_input",
          }),
      ),
      system: "s",
      goal: "g",
    });
    expect(result.transition).toBe("stop-failure");
    expect(result.iterations).toBe(1);
    expect(result.error?.code).toBe("tool.invalid_input");
  });

  it("detects stalls when the model repeats itself", async () => {
    const result = await runPraoLoop({
      model: scriptedModel([textResult("same answer", "tool-calls"), textResult("same answer", "tool-calls"), textResult("same answer", "tool-calls")]),
      system: "s",
      goal: "g",
      budgets: { maxIdenticalOutputs: 2, maxIterations: 10 },
    });
    expect(result.transition).toBe("stop-failure");
    expect(result.reason).toContain("Stall detected");
  });

  it("exhausts maxIterations with an explicit budget error, never a confident non-answer", async () => {
    const result = await runPraoLoop({
      model: scriptedModel([toolCallResult("echo", { text: "loop" })]),
      tools: { echo: echoTool },
      system: "s",
      goal: "g",
      budgets: { maxIterations: 2, maxToolCalls: 100 },
    });
    expect(result.transition).toBe("stop-failure");
    expect(result.error?.code).toBe("budget.exhausted");
    expect(result.error?.message).toContain("maxIterations");
  });

  it("enforces the tool-call budget before acting", async () => {
    const result = await runPraoLoop({
      model: scriptedModel([toolCallResult("echo", { text: "x" })]),
      tools: { echo: echoTool },
      system: "s",
      goal: "g",
      budgets: { maxToolCalls: 1, maxIterations: 10 },
    });
    expect(result.transition).toBe("stop-failure");
    expect(result.error?.message).toContain("maxToolCalls");
  });

  it("honors a custom decide policy (clarify)", async () => {
    const result = await runPraoLoop({
      model: scriptedModel([textResult("I need more information.")]),
      system: "s",
      goal: "g",
      decide: (obs) =>
        obs.text.includes("need more information")
          ? { transition: "clarify", reason: "Missing high-impact fact.", request: "Which environment: staging or prod?" }
          : undefined,
    });
    expect(result.transition).toBe("clarify");
    expect(result.request).toContain("staging or prod");
  });

  it("emits observations to the observer callback", async () => {
    const seen: number[] = [];
    await runPraoLoop({
      model: scriptedModel([textResult("done")]),
      system: "s",
      goal: "g",
      onObservation: (o) => seen.push(o.iteration),
    });
    expect(seen).toEqual([1]);
  });
});

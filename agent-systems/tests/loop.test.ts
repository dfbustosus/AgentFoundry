import { describe, expect, it, vi } from "vitest";
import { getEventListeners } from "node:events";
import { MockLanguageModelV4 } from "ai/test";
import { tool } from "ai";
import { z } from "zod";
import { runPraoLoop } from "../src/core/loop/prao.js";
import { EnvironmentError, ToolError } from "../src/core/errors/taxonomy.js";
import { failingModel, scriptedModel, textResult, toolCallResult } from "./helpers.js";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

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
      model: scriptedModel([
        textResult("same answer", "tool-calls"),
        textResult("same answer", "tool-calls"),
        textResult("same answer", "tool-calls"),
      ]),
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
          ? {
              transition: "clarify",
              reason: "Missing high-impact fact.",
              request: "Which environment: staging or prod?",
            }
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

describe("runPraoLoop hard deadlines and cancellation", () => {
  it.each([
    ["maxIterations zero", { maxIterations: 0 }, {}],
    ["maxIterations fractional", { maxIterations: 1.5 }, {}],
    ["maxElapsedMs zero", { maxElapsedMs: 0 }, {}],
    ["maxElapsedMs negative", { maxElapsedMs: -1 }, {}],
    ["maxElapsedMs infinite", { maxElapsedMs: Number.POSITIVE_INFINITY }, {}],
    ["maxElapsedMs above timer limit", { maxElapsedMs: 2_147_483_648 }, {}],
    ["maxToolCalls zero", { maxToolCalls: 0 }, {}],
    ["maxConsecutiveFailures zero", { maxConsecutiveFailures: 0 }, {}],
    ["maxIdenticalOutputs zero", { maxIdenticalOutputs: 0 }, {}],
    ["stepsPerIteration zero", {}, { stepsPerIteration: 0 }],
  ])("rejects an invalid budget: %s, before any model call", async (_label, budgets, extra) => {
    let modelCalls = 0;
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        modelCalls += 1;
        return textResult("unreachable");
      },
    });
    const pending = runPraoLoop({ model, system: "s", goal: "g", budgets, ...extra });
    await expect(pending).rejects.toMatchObject({
      name: "EnvironmentError",
      code: "environment.invalid_loop_budget",
      retryable: false,
    });
    await expect(pending).rejects.toBeInstanceOf(EnvironmentError);
    expect(modelCalls).toBe(0);
  });

  it("accepts the maximum timer-safe elapsed budget", async () => {
    const result = await runPraoLoop({
      model: scriptedModel([textResult("fine")]),
      system: "s",
      goal: "g",
      budgets: { maxElapsedMs: 2_147_483_647 },
    });
    expect(result.transition).toBe("stop-success");
  });

  it("a pre-aborted signal stops the loop before any model call", async () => {
    let modelCalls = 0;
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        modelCalls += 1;
        return textResult("unreachable");
      },
    });
    const result = await runPraoLoop({
      model,
      system: "s",
      goal: "g",
      signal: AbortSignal.abort("user navigated away"),
    });
    expect(modelCalls).toBe(0);
    expect(result.transition).toBe("stop-failure");
    expect(result.iterations).toBe(0);
    expect(result.error?.code).toBe("environment.loop_cancelled");
    expect(result.error?.retryable).toBe(false);
    // Nothing was in flight, so no side effect can be outstanding.
    expect(result.error?.sideEffect).toBe("none");
    expect(result.error?.cause).toBe("user navigated away");
  });

  it("cancellation mid-flight settles promptly with a typed error, not the provider's late result", async () => {
    const controller = new AbortController();
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        await sleep(5_000);
        return textResult("too late");
      },
    });
    const started = Date.now();
    const pending = runPraoLoop({ model, system: "s", goal: "g", signal: controller.signal });
    setTimeout(() => controller.abort(), 30);
    const result = await pending;
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(result.transition).toBe("stop-failure");
    expect(result.error?.code).toBe("environment.loop_cancelled");
    // The model call was still in flight, so its effect is conservatively unknown.
    expect(result.error?.sideEffect).toBe("unknown");
    expect(result.observations).toHaveLength(1);
    expect(result.observations[0]?.kind).toBe("failure");
    expect(result.observations[0]?.error?.code).toBe("environment.loop_cancelled");
    expect(result.text).toBe("");
  });

  it("the elapsed budget aborts an in-flight model call instead of waiting for it", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        await sleep(5_000);
        return textResult("too late");
      },
    });
    const started = Date.now();
    const result = await runPraoLoop({
      model,
      system: "s",
      goal: "g",
      budgets: { maxElapsedMs: 40, maxIterations: 10 },
    });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(result.transition).toBe("stop-failure");
    expect(result.error?.code).toBe("budget.exhausted");
    expect(result.error?.message).toContain("maxElapsedMs");
    // The deadline fired while the model call was in flight, so its external
    // effect (billed tokens, a mid-execution tool) cannot be ruled out.
    expect(result.error?.sideEffect).toBe("unknown");
    expect(result.observations.at(-1)?.error?.code).toBe("budget.exhausted");
  });

  it("cancellation inside the policy hook is terminal even on a success observation", async () => {
    const controller = new AbortController();
    const result = await runPraoLoop({
      model: scriptedModel([textResult("done")]),
      system: "s",
      goal: "g",
      signal: controller.signal,
      decide: () => {
        controller.abort();
        return undefined;
      },
    });
    // The model completed, but the caller had already cancelled: stop-success
    // would falsely report acceptance criteria met.
    expect(result.transition).toBe("stop-failure");
    expect(result.error?.code).toBe("environment.loop_cancelled");
    expect(result.error?.sideEffect).toBe("none");
    expect(result.text).toBe("");
  });

  it("cancellation inside the policy hook outranks a returned transition", async () => {
    const controller = new AbortController();
    const result = await runPraoLoop({
      model: scriptedModel([textResult("done")]),
      system: "s",
      goal: "g",
      signal: controller.signal,
      decide: () => {
        controller.abort();
        return { transition: "clarify", reason: "decided after cancellation", request: "ignored" };
      },
    });
    expect(result.transition).toBe("stop-failure");
    expect(result.error?.code).toBe("environment.loop_cancelled");
    expect(result.request).toBeUndefined();
  });

  it("deadline exhaustion and caller cancellation stay distinguishable", async () => {
    const hanging = () =>
      new MockLanguageModelV4({
        doGenerate: async () => {
          await sleep(5_000);
          return textResult("late");
        },
      });
    const controller = new AbortController();
    const cancelledPromise = runPraoLoop({
      model: hanging(),
      system: "s",
      goal: "g",
      signal: controller.signal,
      budgets: { maxElapsedMs: 60_000 },
    });
    setTimeout(() => controller.abort(), 30);
    const cancelled = await cancelledPromise;

    const elapsed = await runPraoLoop({
      model: hanging(),
      system: "s",
      goal: "g",
      budgets: { maxElapsedMs: 40 },
    });

    expect(cancelled.error?.code).toBe("environment.loop_cancelled");
    expect(elapsed.error?.code).toBe("budget.exhausted");
  });

  it("passes the composed abort signal into generateText and aborts it on cancellation", async () => {
    const controller = new AbortController();
    let seenSignal: AbortSignal | undefined;
    let abortObservedByModel = false;
    const model = new MockLanguageModelV4({
      doGenerate: async (options) => {
        seenSignal = options.abortSignal;
        options.abortSignal?.addEventListener("abort", () => {
          abortObservedByModel = true;
        });
        await sleep(200);
        return textResult("late");
      },
    });
    const pending = runPraoLoop({ model, system: "s", goal: "g", signal: controller.signal });
    setTimeout(() => controller.abort(), 30);
    await pending;
    expect(seenSignal).toBeInstanceOf(AbortSignal);
    expect(abortObservedByModel).toBe(true);
    // The non-cooperative late resolution is consumed quietly.
    await sleep(250);
  });

  it("consumes a late rejection from a provider that ignores the deadline", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        await sleep(80);
        throw new Error("provider exploded after the deadline");
      },
    });
    const result = await runPraoLoop({
      model,
      system: "s",
      goal: "g",
      budgets: { maxElapsedMs: 30 },
    });
    expect(result.error?.code).toBe("budget.exhausted");
    // Let the late rejection land; vitest fails the run on unhandled rejections.
    await sleep(150);
  });

  it("clears its deadline timer and listeners on success and on abort", async () => {
    vi.useFakeTimers();
    try {
      const before = vi.getTimerCount();

      // Never settles and owns no timers itself: any timer left after the
      // abort can only come from the loop.
      const hanging = new MockLanguageModelV4({
        doGenerate: () => new Promise(() => {}),
      });
      const controller = new AbortController();
      const upstreamListeners = () => getEventListeners(controller.signal, "abort").length;
      const listenersBefore = upstreamListeners();
      const aborted = runPraoLoop({
        model: hanging,
        system: "s",
        goal: "g",
        budgets: { maxElapsedMs: 100 },
        signal: controller.signal,
      });
      expect(upstreamListeners()).toBe(listenersBefore + 1);
      await vi.advanceTimersByTimeAsync(100);
      const abortedResult = await aborted;
      expect(abortedResult.error?.code).toBe("budget.exhausted");
      expect(vi.getTimerCount()).toBe(before);
      expect(upstreamListeners()).toBe(listenersBefore);

      const quick = await runPraoLoop({
        model: scriptedModel([textResult("done")]),
        system: "s",
        goal: "g",
        budgets: { maxElapsedMs: 60_000 },
      });
      expect(quick.transition).toBe("stop-success");
      expect(vi.getTimerCount()).toBe(before);
    } finally {
      vi.useRealTimers();
    }
  });

  it("enforces the elapsed budget between iterations of a cooperative model", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        await sleep(15);
        return toolCallResult("echo", { text: "loop" });
      },
    });
    const result = await runPraoLoop({
      model,
      tools: { echo: echoTool },
      system: "s",
      goal: "g",
      budgets: { maxElapsedMs: 40, maxIterations: 1_000, maxToolCalls: 1_000 },
    });
    expect(result.transition).toBe("stop-failure");
    expect(result.error?.code).toBe("budget.exhausted");
    expect(result.error?.message).toContain("maxElapsedMs");
    expect(result.iterations).toBeLessThan(1_000);
  });

  it("cancellation is terminal, never escalation fodder for the failure counter", async () => {
    const controller = new AbortController();
    let calls = 0;
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        calls += 1;
        if (calls === 1) {
          throw new ToolError("transient", {
            retryable: true,
            sideEffect: "none",
            blastRadius: "local",
            code: "tool.timeout",
          });
        }
        await sleep(5_000);
        return textResult("late");
      },
    });
    const pending = runPraoLoop({
      model,
      system: "s",
      goal: "g",
      signal: controller.signal,
      budgets: { maxConsecutiveFailures: 2 },
    });
    setTimeout(() => controller.abort(), 30);
    const result = await pending;
    // Without terminal precedence, the aborted second iteration would be the
    // 2nd consecutive failure and the loop would escalate instead of stopping.
    expect(result.transition).toBe("stop-failure");
    expect(result.error?.code).toBe("environment.loop_cancelled");
  });

  it("preserves partial observations and usage when cancelled after progress", async () => {
    const controller = new AbortController();
    let calls = 0;
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        calls += 1;
        if (calls === 1) return toolCallResult("echo", { text: "hi" });
        await sleep(5_000);
        return textResult("late");
      },
    });
    const pending = runPraoLoop({
      model,
      tools: { echo: echoTool },
      system: "s",
      goal: "g",
      signal: controller.signal,
      stepsPerIteration: 1,
    });
    setTimeout(() => controller.abort(), 30);
    const result = await pending;
    expect(result.error?.code).toBe("environment.loop_cancelled");
    expect(result.observations[0]?.kind).toBe("partial");
    expect(result.observations.at(-1)?.error?.code).toBe("environment.loop_cancelled");
    expect(result.usage.inputTokens).toBeGreaterThan(0);
    expect(result.toolCallCount).toBe(1);
  });
});

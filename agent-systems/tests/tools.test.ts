import type { Tool, ToolExecutionOptions } from "ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { defineContractTool, type ToolContext, type ToolContract } from "../src/core/tools/contract.js";
import type { TraceEvent } from "../src/core/trace/events.js";

const ctx = (overrides: Partial<ToolContext> = {}): ToolContext => ({
  agentId: "agent-1",
  writeScopes: ["tickets"],
  ...overrides,
});

type DoubleIn = { n: number };
type DoubleOut = { result: number };

function makeTool(overrides: Partial<ToolContract<DoubleIn, DoubleOut>> = {}) {
  return defineContractTool<DoubleIn, DoubleOut>(
    {
      name: "double",
      description: "Doubles a number. Do not use for anything else.",
      input: z.object({ n: z.number() }),
      output: z.object({ result: z.number() }),
      sideEffect: "read-only",
      idempotent: true,
      execute: async ({ n }) => ({ result: n * 2 }),
      ...overrides,
    },
    { context: ctx() },
  );
}

/** Execute a contract tool directly (bypasses the model, exercises the guards). */
async function exec<I, O>(tool: Tool<I, O>, input: unknown, abortSignal?: AbortSignal): Promise<unknown> {
  const execute = (
    tool as {
      execute?: (input: unknown, options: ToolExecutionOptions<unknown>) => PromiseLike<unknown> | unknown;
    }
  ).execute;
  if (execute === undefined) throw new Error("tool has no execute");
  return await execute(input, { toolCallId: "t", messages: [], abortSignal, context: undefined });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("defineContractTool", () => {
  it("executes valid input and returns contract-conformant output", async () => {
    expect(await exec(makeTool(), { n: 21 })).toEqual({ result: 42 });
  });

  it("rejects invalid input as a reasoning error before executing", async () => {
    let executed = false;
    const tool = makeTool({
      execute: async ({ n }) => {
        executed = true;
        return { result: n * 2 };
      },
    });
    await expect(exec(tool, { n: "NaN" })).rejects.toMatchObject({ code: "reasoning.tool_input_invalid" });
    expect(executed).toBe(false);
  });

  it("blocks write tools outside the agent's write scopes — in code, not by prompt", async () => {
    const tool = defineContractTool(
      {
        name: "close_ticket",
        description: "Closes a support ticket.",
        input: z.object({ id: z.string() }),
        sideEffect: "mutating",
        idempotent: true,
        writeScope: "tickets",
        execute: async ({ id }) => ({ closed: id }),
      },
      { context: ctx({ writeScopes: [] }) },
    );
    await expect(exec(tool, { id: "T-1" })).rejects.toMatchObject({
      category: "policy",
      code: "policy.write_scope_denied",
      retryable: false,
    });
  });

  it("enforces domain authorization gates", async () => {
    const tool = makeTool({
      sideEffect: "mutating",
      writeScope: "tickets",
      authorize: async () => false,
    });
    await expect(exec(tool, { n: 1 })).rejects.toMatchObject({ code: "policy.domain_authorization_denied" });
  });

  it("rejects output that violates the output schema", async () => {
    const tool = makeTool({
      // Deliberately break the contract to prove the guard works.
      execute: async () => ({ result: "not-a-number" }) as never,
    });
    await expect(exec(tool, { n: 1 })).rejects.toMatchObject({ code: "tool.output_invalid" });
  });

  it("fails the postcondition check as a reasoning error with evidence", async () => {
    const tool = makeTool({
      execute: async ({ n }) => ({ result: n * 3 }), // wrong on purpose
      postcondition: (input, output) =>
        output.result === input.n * 2 || `expected ${input.n * 2}, got ${output.result}`,
    });
    await expect(exec(tool, { n: 2 })).rejects.toMatchObject({
      code: "reasoning.postcondition_failed",
      evidence: ["expected 4, got 6"],
    });
  });

  it("keeps legacy two-argument authorization and execution callbacks assignable", async () => {
    const legacyAuthorize = (_input: DoubleIn, context: ToolContext): boolean => context.agentId === "agent-1";
    const legacyExecute = async (input: DoubleIn, _context: ToolContext): Promise<DoubleOut> => ({
      result: input.n * 2,
    });
    const contract: ToolContract<DoubleIn, DoubleOut> = {
      name: "legacy_double",
      description: "Doubles a number through legacy callbacks.",
      input: z.object({ n: z.number() }),
      output: z.object({ result: z.number() }),
      sideEffect: "read-only",
      idempotent: true,
      authorize: legacyAuthorize,
      execute: legacyExecute,
    };

    await expect(exec(defineContractTool(contract, { context: ctx() }), { n: 3 })).resolves.toEqual({ result: 6 });
  });

  it("delivers one composed signal to authorization and execution", async () => {
    const upstream = new AbortController();
    let authorizationSignal: AbortSignal | undefined;
    let executionSignal: AbortSignal | undefined;
    const tool = makeTool({
      authorize: async (_input, _context, signal) => {
        authorizationSignal = signal;
        return true;
      },
      execute: async ({ n }, _context, signal) => {
        executionSignal = signal;
        return { result: n * 2 };
      },
    });

    await expect(exec(tool, { n: 4 }, upstream.signal)).resolves.toEqual({ result: 8 });
    expect(authorizationSignal).toBeDefined();
    expect(executionSignal).toBe(authorizationSignal);
    expect(executionSignal).not.toBe(upstream.signal);
    expect(executionSignal?.aborted).toBe(false);
  });

  it("rejects a pre-aborted call before authorization or execution", async () => {
    const upstream = new AbortController();
    const authorize = vi.fn(async () => true);
    const execute = vi.fn(async ({ n }: DoubleIn) => ({ result: n * 2 }));
    upstream.abort(new Error("caller stopped"));
    const tool = makeTool({ authorize, execute });

    await expect(exec(tool, { n: 1 }, upstream.signal)).rejects.toMatchObject({
      category: "tool",
      code: "tool.aborted",
      retryable: false,
      sideEffect: "none",
    });
    expect(authorize).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cooperatively aborts execution when the contract timeout expires", async () => {
    let deliveredSignal: AbortSignal | undefined;
    const tool = makeTool({
      timeoutMs: 25,
      execute: async (_input, _context, signal) => {
        if (signal === undefined) throw new Error("missing abort signal");
        deliveredSignal = signal;
        return await new Promise<DoubleOut>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      },
    });

    const pending = exec(tool, { n: 1 });
    const rejection = expect(pending).rejects.toMatchObject({
      code: "tool.timeout",
      retryable: true,
      sideEffect: "none",
    });
    await vi.advanceTimersByTimeAsync(25);

    await rejection;
    expect(deliveredSignal?.aborted).toBe(true);
    expect(deliveredSignal?.reason).toMatchObject({ code: "tool.timeout" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    {
      label: "authorization timeout",
      phase: "authorization" as const,
      sideEffectKind: "mutating" as const,
      idempotent: false,
      retryable: true,
      sideEffectStatus: "none",
    },
    {
      label: "read-only execution timeout",
      phase: "execution" as const,
      sideEffectKind: "read-only" as const,
      idempotent: false,
      retryable: true,
      sideEffectStatus: "none",
    },
    {
      label: "idempotent write execution timeout",
      phase: "execution" as const,
      sideEffectKind: "mutating" as const,
      idempotent: true,
      retryable: true,
      sideEffectStatus: "unknown",
    },
    {
      label: "non-idempotent write execution timeout",
      phase: "execution" as const,
      sideEffectKind: "destructive" as const,
      idempotent: false,
      retryable: false,
      sideEffectStatus: "unknown",
    },
  ])("races non-cooperative work for $label with the required metadata", async (testCase) => {
    const execute = vi.fn(() => new Promise<DoubleOut>(() => {}));
    const authorize = testCase.phase === "authorization" ? vi.fn(() => new Promise<boolean>(() => {})) : undefined;
    const tool = makeTool({
      timeoutMs: 25,
      sideEffect: testCase.sideEffectKind,
      idempotent: testCase.idempotent,
      writeScope: "tickets",
      authorize,
      execute,
    });

    const pending = exec(tool, { n: 1 });
    const rejection = expect(pending).rejects.toMatchObject({
      category: "tool",
      code: "tool.timeout",
      retryable: testCase.retryable,
      sideEffect: testCase.sideEffectStatus,
    });
    await vi.advanceTimersByTimeAsync(25);

    await rejection;
    if (testCase.phase === "authorization") expect(execute).not.toHaveBeenCalled();
    else expect(execute).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears its timer and upstream listener after successful execution", async () => {
    const upstream = new AbortController();
    const addListener = vi.spyOn(upstream.signal, "addEventListener");
    const removeListener = vi.spyOn(upstream.signal, "removeEventListener");

    await expect(exec(makeTool({ timeoutMs: 100 }), { n: 2 }, upstream.signal)).resolves.toEqual({ result: 4 });

    expect(vi.getTimerCount()).toBe(0);
    expect(addListener).toHaveBeenCalledWith("abort", expect.any(Function), { once: true });
    expect(removeListener).toHaveBeenCalledWith("abort", expect.any(Function));
  });

  it.each([
    { label: "read-only execution", sideEffectKind: "read-only" as const, sideEffectStatus: "none" },
    { label: "write execution", sideEffectKind: "mutating" as const, sideEffectStatus: "unknown" },
  ])("classifies upstream abort during $label conservatively", async (testCase) => {
    const upstream = new AbortController();
    let deliveredSignal: AbortSignal | undefined;
    const execute = vi.fn(
      (_input: DoubleIn, _context: ToolContext, signal?: AbortSignal) =>
        new Promise<DoubleOut>(() => {
          deliveredSignal = signal;
        }),
    );
    const tool = makeTool({
      timeoutMs: 1_000,
      sideEffect: testCase.sideEffectKind,
      idempotent: true,
      writeScope: "tickets",
      execute,
    });

    const pending = exec(tool, { n: 1 }, upstream.signal);
    const rejection = expect(pending).rejects.toMatchObject({
      category: "tool",
      code: "tool.aborted",
      retryable: false,
      sideEffect: testCase.sideEffectStatus,
    });
    const reason = new Error("caller stopped");
    upstream.abort(reason);

    await rejection;
    expect(execute).toHaveBeenCalledOnce();
    expect(deliveredSignal?.aborted).toBe(true);
    expect(deliveredSignal?.reason).toBe(reason);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    { label: "zero", timeoutMs: 0 },
    { label: "negative", timeoutMs: -1 },
    { label: "NaN", timeoutMs: Number.NaN },
    { label: "positive infinity", timeoutMs: Number.POSITIVE_INFINITY },
    { label: "negative infinity", timeoutMs: Number.NEGATIVE_INFINITY },
    { label: "above the platform maximum", timeoutMs: 2_147_483_648 },
  ])("rejects $label timeout before any callback", ({ timeoutMs }) => {
    const authorize = vi.fn(async () => true);
    const execute = vi.fn(async ({ n }: DoubleIn) => ({ result: n * 2 }));

    expect(() => makeTool({ timeoutMs, authorize, execute })).toThrowError(RangeError);
    expect(authorize).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("consumes a callback rejection that arrives after timeout and emits one terminal trace", async () => {
    const events: TraceEvent[] = [];
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    let rejectLate: ((reason?: unknown) => void) | undefined;
    process.on("unhandledRejection", onUnhandled);

    try {
      const tool = defineContractTool<DoubleIn, DoubleOut>(
        {
          name: "late_rejection",
          description: "Waits until the contract timeout for test purposes.",
          input: z.object({ n: z.number() }),
          output: z.object({ result: z.number() }),
          sideEffect: "read-only",
          idempotent: true,
          timeoutMs: 25,
          execute: () =>
            new Promise<DoubleOut>((_resolve, reject) => {
              rejectLate = reject;
            }),
        },
        { context: ctx(), tracer: { emit: (event) => events.push(event) } },
      );

      const pending = exec(tool, { n: 1 });
      const rejection = expect(pending).rejects.toMatchObject({ code: "tool.timeout" });
      await vi.advanceTimersByTimeAsync(25);
      await rejection;

      expect(rejectLate).toBeDefined();
      rejectLate?.(new Error("late failure"));
      await Promise.resolve();
      vi.runAllTicks();
      await vi.advanceTimersByTimeAsync(0);

      expect(unhandled).toEqual([]);
      expect(events.map((event) => event.type)).toEqual(["tool.call", "tool.error"]);
      expect(events.filter((event) => event.type === "tool.result" || event.type === "tool.error")).toHaveLength(1);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});

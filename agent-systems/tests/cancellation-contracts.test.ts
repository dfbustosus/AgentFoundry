import type { Tool, ToolExecutionOptions } from "ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { ToolError } from "../src/core/errors/taxonomy.js";
import {
  RetryAbortedError,
  type RetryContext,
  RetryExhaustedError,
  type RetryPolicy,
  withRetry,
} from "../src/core/reliability/retry.js";
import {
  contractSummary,
  defineContractTool,
  type SideEffectKind,
  type ToolContext,
  type ToolContract,
} from "../src/core/tools/contract.js";
import type { TraceEvent } from "../src/core/trace/events.js";
import type { Tracer } from "../src/core/trace/tracer.js";

const MAX_TIMER_DURATION_MS = 2_147_483_647;

const retryPolicy = {
  maxAttempts: 2,
  baseDelayMs: 20,
  maxDelayMs: 20,
  sideEffectSafe: true,
} as const satisfies RetryPolicy;

function transient(message = "dependency unavailable"): ToolError {
  return new ToolError(message, {
    retryable: true,
    sideEffect: "none",
    blastRadius: "local",
    code: "tool.transient",
  });
}

function requireSignal(signal: AbortSignal | undefined): AbortSignal {
  if (signal === undefined) throw new Error("expected a composed AbortSignal");
  return signal;
}

type DoubleInput = { n: number };
type DoubleOutput = { result: number };

const toolContext: ToolContext = {
  agentId: "contract-test-agent",
  writeScopes: ["records"],
};

function collectTracer(): { tracer: Tracer; events: TraceEvent[] } {
  const events: TraceEvent[] = [];
  return { tracer: { emit: (event) => events.push(event) }, events };
}

function makeTool(
  overrides: Partial<ToolContract<DoubleInput, DoubleOutput>> = {},
  trace: { tracer?: Tracer; traceId?: string } = {},
): Tool<DoubleInput, DoubleOutput> {
  return defineContractTool<DoubleInput, DoubleOutput>(
    {
      name: "double_contract",
      description: "Doubles one number under a deterministic contract.",
      input: z.object({ n: z.number() }),
      output: z.object({ result: z.number() }),
      sideEffect: "read-only",
      idempotent: true,
      execute: async ({ n }) => ({ result: n * 2 }),
      ...overrides,
    },
    { context: toolContext, ...trace },
  );
}

async function executeTool<I, O>(tool: Tool<I, O>, input: unknown, abortSignal?: AbortSignal): Promise<unknown> {
  const execute = (
    tool as {
      execute?: (input: unknown, options: ToolExecutionOptions<unknown>) => PromiseLike<unknown> | unknown;
    }
  ).execute;
  if (execute === undefined) throw new Error("tool has no executable contract");
  return await execute(input, {
    toolCallId: "cancellation-contract",
    messages: [],
    abortSignal,
    context: undefined,
  });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("retry cancellation contracts", () => {
  it.each([
    { kind: "cancelled" as const, attemptsStarted: 0, expectedCode: "environment.retry_cancelled" },
    { kind: "elapsed" as const, attemptsStarted: 0, expectedCode: "environment.retry_deadline_exceeded" },
    { kind: "cancelled" as const, attemptsStarted: 2, expectedCode: "environment.retry_cancelled" },
    { kind: "elapsed" as const, attemptsStarted: 2, expectedCode: "environment.retry_deadline_exceeded" },
  ])("retains structured $kind metadata after $attemptsStarted started attempts", (testCase) => {
    const priorFailures = testCase.attemptsStarted === 0 ? [] : [transient("first attempt failed")];
    const cause = new Error(`${testCase.kind} trigger`);
    const error = new RetryAbortedError(
      "metadata-operation",
      testCase.kind,
      testCase.attemptsStarted,
      priorFailures,
      cause,
    );

    expect(error).toMatchObject({
      name: "RetryAbortedError",
      category: "environment",
      retryable: false,
      sideEffect: testCase.attemptsStarted === 0 ? "none" : "unknown",
      blastRadius: "workflow",
      code: testCase.expectedCode,
      kind: testCase.kind,
      cause,
    });
    expect(error.evidence.slice(0, 2)).toStrictEqual([
      `termination=${testCase.kind}`,
      `attemptsStarted=${testCase.attemptsStarted}`,
    ]);
    expect(error.message).toContain("metadata-operation");
    expect(error.message).toContain(`${testCase.attemptsStarted} started attempt(s)`);
    expect(error.message).toContain(
      testCase.kind === "elapsed" ? "elapsed-time budget reached" : "cancelled by upstream",
    );
    expect(error.attempts).toStrictEqual(priorFailures);
    expect(error.attempts).not.toBe(priorFailures);
    if (priorFailures.length > 0) {
      expect(error.evidence[2]).toContain("attempt 1");
      expect(error.evidence[2]).toContain("[tool.transient]");
    }
  });

  it("preserves cumulative side-effect evidence across exhaustion, backoff, and in-flight cancellation", () => {
    const occurred = new ToolError("write completed before failure", {
      retryable: true,
      sideEffect: "occurred",
      blastRadius: "local",
      code: "tool.write_completed",
    });
    const none = transient("side-effect-free failure");
    const unknown = new ToolError("effect could not be reconciled", {
      retryable: true,
      sideEffect: "unknown",
      blastRadius: "local",
      code: "tool.effect_unknown",
    });

    expect(new RetryExhaustedError("exhausted-write", [occurred, none]).sideEffect).toBe("occurred");
    expect(new RetryExhaustedError("side-effect-free-exhaustion", [none]).sideEffect).toBe("none");
    expect(new RetryExhaustedError("uncertain-exhaustion", [none, unknown]).sideEffect).toBe("unknown");
    expect(new RetryExhaustedError("defensive-empty-exhaustion", []).sideEffect).toBe("unknown");
    expect(new RetryAbortedError("cancelled-backoff", "cancelled", 1, [none]).sideEffect).toBe("none");
    expect(new RetryAbortedError("cancelled-uncertain-backoff", "cancelled", 2, [none, unknown]).sideEffect).toBe(
      "unknown",
    );
    expect(new RetryAbortedError("cancelled-after-effect", "cancelled", 2, [occurred, none]).sideEffect).toBe(
      "occurred",
    );
    expect(new RetryAbortedError("cancelled-in-flight", "cancelled", 2, [none]).sideEffect).toBe("unknown");
  });

  it("labels retry exhaustion with its operation, attempt count, and concrete error type", () => {
    const failures = [transient("first"), transient("second")];
    const error = new RetryExhaustedError("inventory-read", failures);

    expect(error.name).toBe("RetryExhaustedError");
    expect(error.message).toContain("inventory-read");
    expect(error.message).toContain("2 attempt(s)");
    expect(error).toMatchObject({ code: "environment.retry_exhausted", attempts: failures });
  });

  it.each([
    {
      label: "attempt count",
      policy: { ...retryPolicy, maxAttempts: 0 },
      requirement: "maxAttempts",
    },
    {
      label: "base delay",
      policy: { ...retryPolicy, baseDelayMs: -1 },
      requirement: "baseDelayMs",
    },
    {
      label: "maximum delay",
      policy: { ...retryPolicy, maxDelayMs: -1 },
      requirement: "maxDelayMs",
    },
    {
      label: "maximum delay above the timer limit",
      policy: { ...retryPolicy, maxDelayMs: MAX_TIMER_DURATION_MS + 1 },
      requirement: "maxDelayMs",
    },
    {
      label: "elapsed budget",
      policy: { ...retryPolicy, maxElapsedMs: 0 },
      requirement: "maxElapsedMs",
    },
  ])("identifies the invalid $label requirement without invoking work", async (testCase) => {
    const operation = vi.fn(async () => "unexpected");

    const error = await withRetry("invalid-contract", operation, testCase.policy).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: "environment.invalid_retry_policy", sideEffect: "none" });
    expect((error as Error).message).toContain("invalid-contract");
    expect((error as Error).message).toContain(testCase.requirement);
    expect(operation).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("explains the idempotency requirement when an unsafe retry policy is refused", async () => {
    const operation = vi.fn(async () => "unexpected");

    const error = await withRetry("unsafe-write", operation, {
      maxAttempts: 2,
      baseDelayMs: 1,
      maxDelayMs: 2,
    }).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: "environment.unsafe_retry_policy", sideEffect: "none" });
    expect((error as Error).message).toContain("unsafe-write");
    expect((error as Error).message).toContain("idempotencyKey");
    expect((error as Error).message).toContain("sideEffectSafe");
    expect(operation).not.toHaveBeenCalled();
  });

  it("rejects a pre-aborted upstream before starting an operation or timer", async () => {
    const upstream = new AbortController();
    const reason = new Error("request was already cancelled");
    const operation = vi.fn(async () => "unexpected");
    upstream.abort(reason);

    const error = await withRetry("pre-aborted", operation, { ...retryPolicy, signal: upstream.signal }).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(RetryAbortedError);
    expect(error).toMatchObject({
      kind: "cancelled",
      code: "environment.retry_cancelled",
      sideEffect: "none",
      cause: reason,
      evidence: ["termination=cancelled", "attemptsStarted=0"],
      attempts: [],
    });
    expect(operation).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("settles the real default sleep normally and removes its abort listener", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const firstFailure = transient();
    let observedSignal: AbortSignal | undefined;
    const operation = vi.fn(async (context: RetryContext) => {
      observedSignal = context.signal;
      if (context.attempt === 1) throw firstFailure;
      return "recovered";
    });

    const pending = withRetry("real-sleep-success", operation, retryPolicy);
    const signal = requireSignal(observedSignal);
    const addListener = vi.spyOn(signal, "addEventListener");
    const removeListener = vi.spyOn(signal, "removeEventListener");
    await vi.advanceTimersByTimeAsync(0);

    expect(operation).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(9);
    expect(operation).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);

    await expect(pending).resolves.toStrictEqual({ value: "recovered", attempts: 2, errors: [firstFailure] });
    const abortListenerAdds = addListener.mock.calls.filter(([event]) => event === "abort");
    expect(abortListenerAdds.length).toBeGreaterThanOrEqual(2);
    expect(
      abortListenerAdds.every(
        ([, , options]) => options === true || (typeof options === "object" && options.once === true),
      ),
    ).toBe(true);
    expect(removeListener).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(signal.aborted).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("aborts the real default sleep, clears its timer, and retains prior-attempt evidence", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const upstream = new AbortController();
    const addUpstreamListener = vi.spyOn(upstream.signal, "addEventListener");
    const removeUpstreamListener = vi.spyOn(upstream.signal, "removeEventListener");
    const firstFailure = transient("retryable first failure");
    let observedSignal: AbortSignal | undefined;
    const operation = vi.fn(async (context: RetryContext) => {
      observedSignal = context.signal;
      throw firstFailure;
    });
    const pending = withRetry("real-sleep-abort", operation, { ...retryPolicy, signal: upstream.signal });
    const errorPromise = pending.catch((caught: unknown) => caught);

    await vi.advanceTimersByTimeAsync(0);
    expect(operation).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(1);
    const signal = requireSignal(observedSignal);
    const removeListener = vi.spyOn(signal, "removeEventListener");
    const reason = new Error("caller no longer needs the retry");
    upstream.abort(reason);

    const error = await errorPromise;
    expect(error).toMatchObject({
      kind: "cancelled",
      code: "environment.retry_cancelled",
      sideEffect: "none",
      cause: reason,
      attempts: [firstFailure],
    });
    expect((error as RetryAbortedError).evidence).toEqual(
      expect.arrayContaining(["termination=cancelled", "attemptsStarted=1", expect.stringContaining("attempt 1")]),
    );
    expect(removeListener).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(addUpstreamListener).toHaveBeenCalledWith("abort", expect.any(Function), { once: true });
    expect(removeUpstreamListener).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(signal.aborted).toBe(true);
    expect(operation).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("normalizes a synchronous operation throw into the ordinary retry path", async () => {
    const firstFailure = transient("synchronous transient failure");
    const sleep = vi.fn(async () => undefined);
    const operation = vi.fn((context: RetryContext): Promise<string> => {
      if (context.attempt === 1) throw firstFailure;
      return Promise.resolve("recovered");
    });

    await expect(withRetry("sync-operation", operation, retryPolicy, sleep)).resolves.toStrictEqual({
      value: "recovered",
      attempts: 2,
      errors: [firstFailure],
    });
    expect(operation).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledOnce();
  });

  it("propagates a synchronous sleep throw without starting another attempt", async () => {
    const sleepFailure = new Error("sleep adapter failed synchronously");
    const operation = vi.fn(async () => {
      throw transient();
    });
    const sleep = vi.fn((_ms: number, _signal?: AbortSignal): Promise<void> => {
      throw sleepFailure;
    });

    await expect(withRetry("sync-sleep", operation, retryPolicy, sleep)).rejects.toBe(sleepFailure);
    expect(operation).toHaveBeenCalledOnce();
    expect(sleep).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("accepts zero delay bounds and passes an exact zero to the sleep adapter", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.75);
    const firstFailure = transient();
    const delays: number[] = [];
    const operation = vi.fn(async (context: RetryContext) => {
      if (context.attempt === 1) throw firstFailure;
      return "done";
    });

    const outcome = await withRetry(
      "zero-delay",
      operation,
      { ...retryPolicy, baseDelayMs: 0, maxDelayMs: 0 },
      async (delay) => {
        delays.push(delay);
      },
    );

    expect(outcome).toStrictEqual({ value: "done", attempts: 2, errors: [firstFailure] });
    expect(delays).toStrictEqual([0]);
  });

  it("accepts the exact maximum elapsed timer boundary and cleans the timer after success", async () => {
    const operation = vi.fn(async () => "within-boundary");

    await expect(
      withRetry("max-elapsed", operation, { ...retryPolicy, maxElapsedMs: MAX_TIMER_DURATION_MS }),
    ).resolves.toMatchObject({ value: "within-boundary", attempts: 1 });

    expect(operation).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("accepts the exact maximum backoff timer boundary", async () => {
    const operation = vi.fn(async () => "within-boundary");

    await expect(
      withRetry("max-backoff", operation, { ...retryPolicy, maxDelayMs: MAX_TIMER_DURATION_MS }),
    ).resolves.toMatchObject({ value: "within-boundary", attempts: 1 });

    expect(operation).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("treats completion at the exact elapsed deadline as elapsed rather than success", async () => {
    const operation = vi.fn(
      async () => await new Promise<string>((resolve) => setTimeout(() => resolve("too late"), 25)),
    );
    const pending = withRetry("deadline-equality", operation, { ...retryPolicy, maxElapsedMs: 25 });
    let settled = false;
    void pending.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    const errorPromise = pending.catch((caught: unknown) => caught);

    await vi.advanceTimersByTimeAsync(24);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    await expect(errorPromise).resolves.toMatchObject({
      kind: "elapsed",
      code: "environment.retry_deadline_exceeded",
      sideEffect: "unknown",
      evidence: ["termination=elapsed", "attemptsStarted=1"],
    });
    expect(operation).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects a backoff exactly equal to the remaining elapsed budget without sleeping", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    await vi.advanceTimersByTimeAsync(100);
    const firstFailure = transient();
    const sleep = vi.fn(async () => undefined);
    let observedSignal: AbortSignal | undefined;

    const error = await withRetry(
      "backoff-equality",
      async (context) => {
        observedSignal = context.signal;
        throw firstFailure;
      },
      {
        maxAttempts: 2,
        baseDelayMs: 100,
        maxDelayMs: 100,
        maxElapsedMs: 50,
        sideEffectSafe: true,
      },
      sleep,
    ).catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      kind: "elapsed",
      code: "environment.retry_deadline_exceeded",
      attempts: [firstFailure],
      evidence: ["termination=elapsed", "attemptsStarted=1", expect.stringContaining("attempt 1")],
    });
    expect(sleep).not.toHaveBeenCalled();
    expect(observedSignal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("allows a backoff one millisecond below the remaining elapsed budget", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.49);
    const sleep = vi.fn(async () => undefined);
    const operation = vi.fn(async (context: RetryContext) => {
      if (context.attempt === 1) throw transient();
      return "recovered";
    });

    await expect(
      withRetry(
        "backoff-before-boundary",
        operation,
        {
          maxAttempts: 2,
          baseDelayMs: 100,
          maxDelayMs: 100,
          maxElapsedMs: 50,
          sideEffectSafe: true,
        },
        sleep,
      ),
    ).resolves.toMatchObject({ value: "recovered", attempts: 2 });

    expect(sleep).toHaveBeenCalledWith(49, expect.any(AbortSignal));
    expect(operation).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("consumes a custom sleep rejection after the elapsed deadline and balances its abort listener", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);

    try {
      let rejectLate: ((reason?: unknown) => void) | undefined;
      let addListener: ReturnType<typeof vi.spyOn> | undefined;
      let removeListener: ReturnType<typeof vi.spyOn> | undefined;
      const operation = vi.fn(async () => {
        throw transient();
      });
      const sleep = vi.fn(
        (_ms: number, signal?: AbortSignal) =>
          new Promise<void>((_resolve, reject) => {
            const composed = requireSignal(signal);
            addListener = vi.spyOn(composed, "addEventListener");
            removeListener = vi.spyOn(composed, "removeEventListener");
            rejectLate = reject;
          }),
      );
      const pending = withRetry("late-sleep-rejection", operation, { ...retryPolicy, maxElapsedMs: 50 }, sleep);
      const errorPromise = pending.catch((caught: unknown) => caught);

      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(50);
      await expect(errorPromise).resolves.toMatchObject({ code: "environment.retry_deadline_exceeded" });

      rejectLate?.(new Error("late custom sleep failure"));
      await Promise.resolve();
      vi.runAllTicks();
      await vi.advanceTimersByTimeAsync(0);

      expect(unhandled).toStrictEqual([]);
      expect(addListener).toHaveBeenCalledWith("abort", expect.any(Function), { once: true });
      expect(removeListener).toHaveBeenCalledWith("abort", expect.any(Function));
      expect(operation).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("fires an elapsed deadline relative to a non-zero clock origin", async () => {
    await vi.advanceTimersByTimeAsync(100);
    let observedSignal: AbortSignal | undefined;
    const operation = vi.fn(
      async (context: RetryContext) =>
        await new Promise<string>(() => {
          observedSignal = context.signal;
        }),
    );
    const pending = withRetry("relative-deadline", operation, { ...retryPolicy, maxElapsedMs: 25 });
    const errorPromise = pending.catch((caught: unknown) => caught);

    await vi.advanceTimersByTimeAsync(24);
    expect(observedSignal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    const error = await errorPromise;
    expect(error).toMatchObject({ kind: "elapsed", code: "environment.retry_deadline_exceeded" });
    expect(requireSignal(observedSignal).reason).toBe(error);
    expect(operation).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("detects exact deadline equality when settled work is inspected", async () => {
    let reads = 0;
    vi.spyOn(performance, "now").mockImplementation(() => {
      reads += 1;
      return reads <= 5 ? 0 : 10;
    });
    let observedSignal: AbortSignal | undefined;
    const operation = vi.fn(async (context: RetryContext) => {
      observedSignal = context.signal;
      return "completed-at-deadline";
    });

    const error = await withRetry("settlement-equality", operation, {
      ...retryPolicy,
      maxElapsedMs: 10,
    }).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ kind: "elapsed", code: "environment.retry_deadline_exceeded" });
    expect(requireSignal(observedSignal).reason).toBe(error);
    expect(operation).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("falls back to polling the upstream signal when its abort notification is missed", async () => {
    const upstream = new AbortController();
    const reason = new Error("abort event transport failed");
    vi.spyOn(upstream.signal, "addEventListener").mockImplementation(() => undefined);
    const operation = vi.fn((_context: RetryContext): Promise<string> => {
      upstream.abort(reason);
      return new Promise<string>(() => {});
    });

    const error = await withRetry("missed-abort-event", operation, {
      ...retryPolicy,
      signal: upstream.signal,
    }).catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      kind: "cancelled",
      code: "environment.retry_cancelled",
      cause: reason,
      evidence: ["termination=cancelled", "attemptsStarted=1"],
    });
    expect(operation).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("settles immediately when an operation cancels before returning non-cooperative work", async () => {
    const upstream = new AbortController();
    const reason = new Error("operation cancelled before yielding");
    const operation = vi.fn((_context: RetryContext): Promise<string> => {
      upstream.abort(reason);
      return new Promise<string>(() => {});
    });

    const error = await withRetry("already-terminal-wait", operation, {
      ...retryPolicy,
      signal: upstream.signal,
    }).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ kind: "cancelled", code: "environment.retry_cancelled", cause: reason });
    expect(operation).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("omits the idempotency key property when safety is declared without a key", async () => {
    let observedContext: RetryContext | undefined;

    await expect(
      withRetry(
        "safe-without-key",
        async (context) => {
          observedContext = context;
          return "ok";
        },
        retryPolicy,
      ),
    ).resolves.toMatchObject({ value: "ok" });

    expect(observedContext).toBeDefined();
    expect(Object.hasOwn(observedContext as object, "idempotencyKey")).toBe(false);
  });

  it("does not continue retry classification when retryIf cancels upstream", async () => {
    const upstream = new AbortController();
    const reason = new Error("retry decision cancelled");
    const random = vi.spyOn(Math, "random");
    const sleep = vi.fn(async () => undefined);
    const retryIf = vi.fn(() => {
      upstream.abort(reason);
      return true;
    });

    const error = await withRetry(
      "cancelled-retry-gate",
      async () => {
        throw transient();
      },
      { ...retryPolicy, signal: upstream.signal, retryIf },
      sleep,
    ).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ kind: "cancelled", code: "environment.retry_cancelled", cause: reason });
    expect(retryIf).toHaveBeenCalledOnce();
    expect(random).not.toHaveBeenCalled();
    expect(sleep).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("consumes an operation rejection when cancellation occurs synchronously in-flight", async () => {
    const upstream = new AbortController();
    const reason = new Error("operation observed cancellation");
    const lateFailure = new Error("operation rejected after cancellation won");
    const operation = vi.fn((_context: RetryContext): Promise<string> => {
      upstream.abort(reason);
      return Promise.reject(lateFailure);
    });

    const error = await withRetry("sync-in-flight-abort", operation, {
      ...retryPolicy,
      signal: upstream.signal,
    }).catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      kind: "cancelled",
      code: "environment.retry_cancelled",
      sideEffect: "unknown",
      cause: reason,
      evidence: ["termination=cancelled", "attemptsStarted=1"],
    });
    await Promise.resolve();
    expect(operation).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("tool timeout and retry integration", () => {
  it("never retries a timed-out non-idempotent write with an uncertain external effect", async () => {
    let externalEffects = 0;
    const execute = vi.fn(
      async () =>
        await new Promise<DoubleOutput>(() => {
          externalEffects += 1;
        }),
    );
    const tool = makeTool({
      sideEffect: "mutating",
      idempotent: false,
      writeScope: "records",
      timeoutMs: 10,
      execute,
    });
    const sleep = vi.fn(async () => undefined);
    const operation = vi.fn(async () => await executeTool(tool, { n: 2 }));
    const pending = withRetry(
      "non-idempotent-write",
      operation,
      { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 10, sideEffectSafe: true },
      sleep,
    );
    const errorPromise = pending.catch((caught: unknown) => caught);

    await vi.advanceTimersByTimeAsync(10);

    await expect(errorPromise).resolves.toMatchObject({
      code: "tool.timeout",
      retryable: false,
      sideEffect: "unknown",
    });
    expect(operation).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledOnce();
    expect(externalEffects).toBe(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retries an idempotent timed-out write with the same input and idempotency key", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    let executions = 0;
    const inputs: DoubleInput[] = [];
    const keys: (string | undefined)[] = [];
    const execute = vi.fn(
      async (input: DoubleInput) =>
        await new Promise<DoubleOutput>((resolve) => {
          executions += 1;
          inputs.push(input);
          if (executions > 1) resolve({ result: input.n * 2 });
        }),
    );
    const tool = makeTool({
      sideEffect: "mutating",
      idempotent: true,
      writeScope: "records",
      timeoutMs: 10,
      execute,
    });
    const input = Object.freeze({ n: 2 });
    const operation = vi.fn(async (context: RetryContext) => {
      keys.push(context.idempotencyKey);
      return await executeTool(tool, input);
    });
    const sleep = vi.fn(async () => undefined);
    const pending = withRetry(
      "idempotent-write",
      operation,
      {
        maxAttempts: 2,
        baseDelayMs: 0,
        maxDelayMs: 0,
        maxElapsedMs: 100,
        idempotencyKey: "write-key-1",
      },
      sleep,
    );

    await vi.advanceTimersByTimeAsync(10);

    await expect(pending).resolves.toMatchObject({ value: { result: 4 }, attempts: 2 });
    expect(operation).toHaveBeenCalledTimes(2);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(inputs).toStrictEqual([input, input]);
    expect(keys).toStrictEqual(["write-key-1", "write-key-1"]);
    expect(sleep).toHaveBeenCalledWith(0, expect.any(AbortSignal));
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("tool cancellation and timeout contracts", () => {
  it("aborts a mutating tool during authorization with no execution side effect and one terminal trace", async () => {
    const upstream = new AbortController();
    const removeUpstreamListener = vi.spyOn(upstream.signal, "removeEventListener");
    const { tracer, events } = collectTracer();
    let authorizationSignal: AbortSignal | undefined;
    const authorize = vi.fn(
      (_input: DoubleInput, _context: ToolContext, signal?: AbortSignal) =>
        new Promise<boolean>(() => {
          authorizationSignal = signal;
        }),
    );
    const execute = vi.fn(async ({ n }: DoubleInput) => ({ result: n * 2 }));
    const tool = makeTool(
      {
        sideEffect: "mutating",
        idempotent: false,
        writeScope: "records",
        timeoutMs: 100,
        authorize,
        execute,
      },
      { tracer, traceId: "trace-authorization-abort" },
    );
    const pending = executeTool(tool, { n: 2 }, upstream.signal);
    const errorPromise = pending.catch((caught: unknown) => caught);

    await vi.advanceTimersByTimeAsync(0);
    expect(authorize).toHaveBeenCalledOnce();
    const reason = new Error("authorization request withdrawn");
    upstream.abort(reason);

    const error = await errorPromise;
    expect(error).toMatchObject({
      category: "tool",
      code: "tool.aborted",
      retryable: false,
      sideEffect: "none",
      blastRadius: "local",
      cause: reason,
    });
    expect((error as Error).message).toContain("double_contract");
    expect((error as Error).message).toContain("aborted");
    expect(execute).not.toHaveBeenCalled();
    expect(authorizationSignal?.aborted).toBe(true);
    expect(authorizationSignal?.reason).toBe(reason);
    expect(removeUpstreamListener).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(events.map((event) => event.type)).toStrictEqual(["tool.call", "tool.error"]);
    expect(events.filter((event) => event.type === "tool.result" || event.type === "tool.error")).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("fails closed when upstream aborts at the trust-boundary-to-authorization handoff", async () => {
    const upstream = new AbortController();
    const reason = new Error("cancelled while validating input");
    const input = z.object({ n: z.number() }).transform((value) => {
      upstream.abort(reason);
      return value;
    });
    const execute = vi.fn(async ({ n }: DoubleInput) => ({ result: n * 2 }));
    const { tracer, events } = collectTracer();
    const tool = defineContractTool<DoubleInput, DoubleOutput>(
      {
        name: "boundary_abort",
        description: "Exercises cancellation at the validation and authorization handoff.",
        input,
        output: z.object({ result: z.number() }),
        sideEffect: "mutating",
        idempotent: false,
        writeScope: "records",
        timeoutMs: 100,
        execute,
      },
      { context: toolContext, tracer, traceId: "trace-boundary-abort" },
    );

    const error = await executeTool(tool, { n: 2 }, upstream.signal).catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      code: "tool.aborted",
      retryable: false,
      sideEffect: "none",
      blastRadius: "local",
      cause: reason,
    });
    expect((error as Error).message).toContain("boundary_abort");
    expect((error as Error).message).toContain("aborted");
    expect(execute).not.toHaveBeenCalled();
    expect(events.map((event) => event.type)).toStrictEqual(["tool.call", "tool.error"]);
    expect(events.filter((event) => event.type === "tool.result" || event.type === "tool.error")).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("classifies a synchronous authorization throw, skips execution, and cleans its timer", async () => {
    const callbackFailure = new Error("authorization callback failed synchronously");
    const authorize = vi.fn((): boolean => {
      throw callbackFailure;
    });
    const execute = vi.fn(async ({ n }: DoubleInput) => ({ result: n * 2 }));
    const { tracer, events } = collectTracer();
    const tool = makeTool({ timeoutMs: 100, authorize, execute }, { tracer, traceId: "trace-sync-authorize" });

    await expect(executeTool(tool, { n: 2 })).rejects.toMatchObject({
      category: "reasoning",
      code: "reasoning.unclassified",
      retryable: false,
      cause: callbackFailure,
    });
    expect(authorize).toHaveBeenCalledOnce();
    expect(execute).not.toHaveBeenCalled();
    expect(events.map((event) => event.type)).toStrictEqual(["tool.call", "tool.error"]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("classifies a synchronous execution throw and emits only an error terminal trace", async () => {
    const callbackFailure = new Error("execution callback failed synchronously");
    const execute = vi.fn((): Promise<DoubleOutput> => {
      throw callbackFailure;
    });
    const { tracer, events } = collectTracer();
    const tool = makeTool({ timeoutMs: 100, execute }, { tracer, traceId: "trace-sync-execute" });

    await expect(executeTool(tool, { n: 2 })).rejects.toMatchObject({
      category: "reasoning",
      code: "reasoning.unclassified",
      retryable: false,
      cause: callbackFailure,
    });
    expect(execute).toHaveBeenCalledOnce();
    expect(events.map((event) => event.type)).toStrictEqual(["tool.call", "tool.error"]);
    expect(events.filter((event) => event.type === "tool.result" || event.type === "tool.error")).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("accepts the exact maximum tool timeout and removes its timer after success", async () => {
    const execute = vi.fn(async ({ n }: DoubleInput) => ({ result: n * 2 }));
    const tool = makeTool({ timeoutMs: MAX_TIMER_DURATION_MS, execute });

    await expect(executeTool(tool, { n: 3 })).resolves.toStrictEqual({ result: 6 });
    expect(execute).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("uses one-shot abort listeners for authorization and execution and removes them after settlement", async () => {
    let composedSignal: AbortSignal | undefined;
    const authorize = vi.fn(async (_input: DoubleInput, _context: ToolContext, signal?: AbortSignal) => {
      composedSignal = signal;
      return true;
    });
    const execute = vi.fn(async ({ n }: DoubleInput) => ({ result: n * 2 }));
    const pending = executeTool(makeTool({ authorize, execute }), { n: 3 });
    const signal = requireSignal(composedSignal);
    const addListener = vi.spyOn(signal, "addEventListener");
    const removeListener = vi.spyOn(signal, "removeEventListener");

    await expect(pending).resolves.toStrictEqual({ result: 6 });

    expect(addListener).toHaveBeenCalledWith("abort", expect.any(Function), { once: true });
    expect(removeListener).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(signal.aborted).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("classifies a domain authorization denial as side-effect free and locally contained", async () => {
    const execute = vi.fn(async ({ n }: DoubleInput) => ({ result: n * 2 }));
    const tool = makeTool({
      sideEffect: "mutating",
      idempotent: false,
      writeScope: "records",
      authorize: () => false,
      execute,
    });

    const error = await executeTool(tool, { n: 2 }).catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      category: "policy",
      code: "policy.domain_authorization_denied",
      retryable: false,
      sideEffect: "none",
      blastRadius: "local",
    });
    expect((error as Error).message).toContain("double_contract");
    expect((error as Error).message).toContain(toolContext.agentId);
    expect(execute).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("uses the tool name as the implicit write scope and retains authorization evidence", async () => {
    const execute = vi.fn(async ({ n }: DoubleInput) => ({ result: n * 2 }));
    const tool = defineContractTool<DoubleInput, DoubleOutput>(
      {
        name: "implicit_record_scope",
        description: "Requires its own name as the default write scope.",
        input: z.object({ n: z.number() }),
        sideEffect: "mutating",
        idempotent: false,
        execute,
      },
      { context: { agentId: "scope-limited-agent", writeScopes: [] } },
    );

    const error = await executeTool(tool, { n: 2 }).catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      code: "policy.write_scope_denied",
      sideEffect: "none",
      blastRadius: "local",
      evidence: ["agentScopes=[]", "requiredScope=implicit_record_scope"],
    });
    expect((error as Error).message).toContain("scope-limited-agent");
    expect((error as Error).message).toContain("implicit_record_scope");
    expect(execute).not.toHaveBeenCalled();
  });

  it("retains field evidence and tool identity for invalid input and output", async () => {
    const invalidInput = await executeTool(makeTool(), { n: "two" }).catch((caught: unknown) => caught);
    expect(invalidInput).toMatchObject({
      code: "reasoning.tool_input_invalid",
      evidence: [expect.stringContaining("n")],
    });
    expect((invalidInput as Error).message).toContain("double_contract");
    expect((invalidInput as Error).message).toContain("invalid input");

    const invalidOutput = await executeTool(makeTool({ execute: async () => ({ result: "invalid" }) as never }), {
      n: 2,
    }).catch((caught: unknown) => caught);
    expect(invalidOutput).toMatchObject({
      code: "tool.output_invalid",
      evidence: [expect.stringContaining("result")],
    });
    expect((invalidOutput as Error).message).toContain("double_contract");
    expect((invalidOutput as Error).message).toContain("violating its contract");
  });

  it("retains the failed postcondition verdict in both message and evidence", async () => {
    const verdict = "independent read did not contain the expected result";
    const error = await executeTool(makeTool({ postcondition: () => verdict }), { n: 2 }).catch(
      (caught: unknown) => caught,
    );

    expect(error).toMatchObject({ code: "reasoning.postcondition_failed", evidence: [verdict] });
    expect((error as Error).message).toContain("double_contract");
    expect((error as Error).message).toContain(verdict);
  });

  it("summarizes idempotency with a stable human-readable delimiter", () => {
    const summary = contractSummary({
      name: "safe_read",
      description: "Reads a record without mutation.",
      input: z.object({ n: z.number() }),
      sideEffect: "read-only",
      idempotent: true,
      execute: async ({ n }) => ({ result: n * 2 }),
    });

    expect(summary).toContain("safe_read [read-only, idempotent]");
    expect(summary).toContain(" — Reads a record without mutation.");
  });

  it.each([
    {
      label: "authorization",
      phase: "authorization" as const,
      sideEffect: "mutating" as const,
      idempotent: false,
      expectedRetryable: true,
      expectedSideEffect: "none",
    },
    {
      label: "read-only execution",
      phase: "execution" as const,
      sideEffect: "read-only" as const,
      idempotent: false,
      expectedRetryable: true,
      expectedSideEffect: "none",
    },
    {
      label: "idempotent mutating execution",
      phase: "execution" as const,
      sideEffect: "mutating" as const,
      idempotent: true,
      expectedRetryable: true,
      expectedSideEffect: "unknown",
    },
    {
      label: "non-idempotent destructive execution",
      phase: "execution" as const,
      sideEffect: "destructive" as const,
      idempotent: false,
      expectedRetryable: false,
      expectedSideEffect: "unknown",
    },
  ])("preserves the timeout metadata matrix and one terminal trace for $label", async (testCase) => {
    let finishAuthorization: ((value: boolean) => void) | undefined;
    let finishExecution: ((value: DoubleOutput) => void) | undefined;
    let callbackSignal: AbortSignal | undefined;
    const authorize =
      testCase.phase === "authorization"
        ? vi.fn(
            (_input: DoubleInput, _context: ToolContext, signal?: AbortSignal) =>
              new Promise<boolean>((resolve) => {
                callbackSignal = signal;
                finishAuthorization = resolve;
              }),
          )
        : undefined;
    const execute = vi.fn(
      (_input: DoubleInput, _context: ToolContext, signal?: AbortSignal) =>
        new Promise<DoubleOutput>((resolve) => {
          callbackSignal = signal;
          finishExecution = resolve;
        }),
    );
    const { tracer, events } = collectTracer();
    const tool = makeTool(
      {
        timeoutMs: 17,
        sideEffect: testCase.sideEffect satisfies SideEffectKind,
        idempotent: testCase.idempotent,
        writeScope: "records",
        authorize,
        execute,
      },
      { tracer, traceId: `trace-timeout-${testCase.phase}` },
    );
    const pending = executeTool(tool, { n: 2 });
    let settled = false;
    void pending.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    const errorPromise = pending.catch((caught: unknown) => caught);

    await vi.advanceTimersByTimeAsync(0);
    const removeAbortListener = vi.spyOn(requireSignal(callbackSignal), "removeEventListener");
    await vi.advanceTimersByTimeAsync(16);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    const error = await errorPromise;
    expect(error).toMatchObject({
      category: "tool",
      code: "tool.timeout",
      retryable: testCase.expectedRetryable,
      sideEffect: testCase.expectedSideEffect,
      blastRadius: "local",
    });
    expect(error).toBeInstanceOf(ToolError);
    expect((error as Error).message).toContain("17ms");
    expect((error as Error).message).toContain(
      testCase.phase === "authorization"
        ? 'Tool "double_contract" authorization exceeded'
        : 'Tool "double_contract" exceeded',
    );
    if (testCase.phase === "authorization") expect(execute).not.toHaveBeenCalled();
    else expect(execute).toHaveBeenCalledOnce();
    expect(events.map((event) => event.type)).toStrictEqual(["tool.call", "tool.error"]);
    expect(events[1]).toMatchObject({
      type: "tool.error",
      code: "tool.timeout",
      retryable: testCase.expectedRetryable,
    });
    expect(events.filter((event) => event.type === "tool.result" || event.type === "tool.error")).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);

    finishAuthorization?.(true);
    finishExecution?.({ result: 4 });
    await Promise.resolve();
    await Promise.resolve();
    expect(removeAbortListener).toHaveBeenCalledTimes(1);
    expect(removeAbortListener).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(events.filter((event) => event.type === "tool.result" || event.type === "tool.error")).toHaveLength(1);
  });
});

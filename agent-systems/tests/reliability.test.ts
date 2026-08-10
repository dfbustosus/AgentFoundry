import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EnvironmentError, ToolError } from "../src/core/errors/taxonomy.js";
import { withFallback } from "../src/core/reliability/fallback.js";
import { computeDelayMs, RetryAbortedError, RetryExhaustedError, withRetry } from "../src/core/reliability/retry.js";
import { DegradedError } from "../src/core/errors/taxonomy.js";

const noSleep = async () => {};

function requireSignal(signal: AbortSignal | undefined): AbortSignal {
  if (signal === undefined) throw new Error("withRetry did not provide its composed AbortSignal");
  return signal;
}

const transient = () =>
  new ToolError("timeout", {
    retryable: true,
    sideEffect: "none",
    blastRadius: "local",
    code: "tool.timeout",
  });

const permanent = () =>
  new ToolError("invalid input", {
    retryable: false,
    sideEffect: "none",
    blastRadius: "local",
    code: "tool.invalid_input",
  });

describe("withRetry", () => {
  it("returns on first success without sleeping", async () => {
    let calls = 0;
    const outcome = await withRetry(
      "op",
      async () => {
        calls += 1;
        return 42;
      },
      { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 100, sideEffectSafe: true },
      noSleep,
    );
    expect(outcome.value).toBe(42);
    expect(outcome.attempts).toBe(1);
    expect(calls).toBe(1);
  });

  it("retries transient failures and reports total attempts", async () => {
    let calls = 0;
    const outcome = await withRetry(
      "op",
      async () => {
        calls += 1;
        if (calls < 3) throw transient();
        return "ok";
      },
      { maxAttempts: 5, baseDelayMs: 10, maxDelayMs: 100, sideEffectSafe: true },
      noSleep,
    );
    expect(outcome.value).toBe("ok");
    expect(outcome.attempts).toBe(3);
    expect(outcome.errors).toHaveLength(2);
  });

  it("fails fast on non-retryable errors without exhausting the budget", async () => {
    let calls = 0;
    await expect(
      withRetry(
        "op",
        async () => {
          calls += 1;
          throw permanent();
        },
        { maxAttempts: 5, baseDelayMs: 10, maxDelayMs: 100, sideEffectSafe: true },
        noSleep,
      ),
    ).rejects.toMatchObject({ code: "tool.invalid_input" });
    expect(calls).toBe(1);
  });

  it("throws RetryExhaustedError with attempt evidence when the budget runs out", async () => {
    await expect(
      withRetry(
        "op",
        async () => {
          throw transient();
        },
        { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 100, sideEffectSafe: true },
        noSleep,
      ),
    ).rejects.toSatisfy((e: unknown) => e instanceof RetryExhaustedError && e.attempts.length === 3);
  });

  it("refuses to configure a retry without idempotency protection", async () => {
    await expect(
      withRetry("op", async () => 1, { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 2 }, noSleep),
    ).rejects.toMatchObject({ code: "environment.unsafe_retry_policy" });
  });

  it("passes the idempotency key to every attempt", async () => {
    const keys: (string | undefined)[] = [];
    await withRetry(
      "op",
      async (ctx) => {
        keys.push(ctx.idempotencyKey);
        if (keys.length === 1) throw transient();
        return "done";
      },
      { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 2, idempotencyKey: "key-123" },
      noSleep,
    );
    expect(keys).toEqual(["key-123", "key-123"]);
  });

  it("honors the retryIf gate", async () => {
    let calls = 0;
    await expect(
      withRetry(
        "op",
        async () => {
          calls += 1;
          throw transient();
        },
        {
          maxAttempts: 5,
          baseDelayMs: 1,
          maxDelayMs: 2,
          sideEffectSafe: true,
          retryIf: (_e, attempt) => attempt < 2,
        },
        noSleep,
      ),
    ).rejects.toBeInstanceOf(ToolError);
    expect(calls).toBe(2);
  });
});

describe("withRetry cancellation and elapsed-time budgets", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  const validPolicy = { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 2, sideEffectSafe: true } as const;
  const invalidPolicies = [
    ["zero attempts", { ...validPolicy, maxAttempts: 0 }],
    ["fractional attempts", { ...validPolicy, maxAttempts: 1.5 }],
    ["unsafe attempt count", { ...validPolicy, maxAttempts: Number.MAX_SAFE_INTEGER + 1 }],
    ["negative base delay", { ...validPolicy, baseDelayMs: -1 }],
    ["non-finite base delay", { ...validPolicy, baseDelayMs: Number.POSITIVE_INFINITY }],
    ["NaN base delay", { ...validPolicy, baseDelayMs: Number.NaN }],
    ["negative maximum delay", { ...validPolicy, maxDelayMs: -1 }],
    ["non-finite maximum delay", { ...validPolicy, maxDelayMs: Number.POSITIVE_INFINITY }],
    ["NaN maximum delay", { ...validPolicy, maxDelayMs: Number.NaN }],
    ["zero elapsed budget", { ...validPolicy, maxElapsedMs: 0 }],
    ["negative elapsed budget", { ...validPolicy, maxElapsedMs: -1 }],
    ["non-finite elapsed budget", { ...validPolicy, maxElapsedMs: Number.POSITIVE_INFINITY }],
    ["NaN elapsed budget", { ...validPolicy, maxElapsedMs: Number.NaN }],
    ["elapsed budget above timer limit", { ...validPolicy, maxElapsedMs: 2_147_483_648 }],
  ] as const;

  it.each(invalidPolicies)("rejects %s before operation, sleep, timers, or signal listeners", async (_name, policy) => {
    const operation = vi.fn(async () => 1);
    const sleep = vi.fn(async (_ms: number) => undefined);
    const upstream = new AbortController();
    const addListener = vi.spyOn(upstream.signal, "addEventListener");

    await expect(withRetry("invalid", operation, { ...policy, signal: upstream.signal }, sleep)).rejects.toMatchObject({
      code: "environment.invalid_retry_policy",
      sideEffect: "none",
    });
    expect(operation).not.toHaveBeenCalled();
    expect(sleep).not.toHaveBeenCalled();
    expect(addListener).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("returns a success that arrives before the deadline and clears its deadline timer", async () => {
    let observedSignal: AbortSignal | undefined;
    const pending = withRetry(
      "quick",
      async (ctx) => {
        observedSignal = ctx.signal;
        return await new Promise<number>((resolve) => setTimeout(() => resolve(42), 49));
      },
      { ...validPolicy, maxElapsedMs: 50 },
    );

    await vi.advanceTimersByTimeAsync(49);
    await expect(pending).resolves.toMatchObject({ value: 42, attempts: 1 });
    expect(observedSignal?.aborted).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("aborts a non-cooperative hanging attempt at the exact deadline and consumes its late rejection", async () => {
    let observedSignal: AbortSignal | undefined;
    let rejectLate: ((reason?: unknown) => void) | undefined;
    const pending = withRetry(
      "hanging",
      async (ctx) => {
        observedSignal = ctx.signal;
        return await new Promise<number>((_resolve, reject) => {
          rejectLate = reject;
        });
      },
      { ...validPolicy, maxElapsedMs: 50 },
    );
    let settled = false;
    void pending.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    const errorPromise = pending.catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(49);
    expect(settled).toBe(false);
    expect(observedSignal?.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    const error = await errorPromise;
    expect(error).toBeInstanceOf(RetryAbortedError);
    expect(error).toMatchObject({
      kind: "elapsed",
      code: "environment.retry_deadline_exceeded",
      retryable: false,
      sideEffect: "unknown",
    });
    expect(settled).toBe(true);
    expect(observedSignal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);

    rejectLate?.(new Error("late attempt failure"));
    await Promise.resolve();
  });

  it("races a slow custom sleep against the deadline and passes it the composed signal", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    let attemptSignal: AbortSignal | undefined;
    let sleepSignal: AbortSignal | undefined;
    const slowSleep = vi.fn(
      async (_ms: number, signal?: AbortSignal) =>
        await new Promise<void>((resolve) => {
          sleepSignal = signal;
          const timer = setTimeout(resolve, 1_000);
          signal?.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              resolve();
            },
            { once: true },
          );
        }),
    );
    const operation = vi.fn(async (ctx: { signal?: AbortSignal }) => {
      attemptSignal = requireSignal(ctx.signal);
      throw transient();
    });
    const pending = withRetry("slow-sleep", operation, { ...validPolicy, maxElapsedMs: 50 }, slowSleep);
    const errorPromise = pending.catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(0);
    expect(slowSleep).toHaveBeenCalledTimes(1);
    expect(sleepSignal).toBe(attemptSignal);

    await vi.advanceTimersByTimeAsync(50);
    await expect(errorPromise).resolves.toMatchObject({
      kind: "elapsed",
      code: "environment.retry_deadline_exceeded",
    });
    expect(operation).toHaveBeenCalledTimes(1);
    expect(sleepSignal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops immediately without sleeping when the backoff cannot fit the remaining budget", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.9);
    let observedSignal: AbortSignal | undefined;
    const sleep = vi.fn(async (_ms: number) => undefined);

    const error = await withRetry(
      "oversized-backoff",
      async (ctx) => {
        observedSignal = ctx.signal;
        throw transient();
      },
      { maxAttempts: 2, baseDelayMs: 100, maxDelayMs: 100, maxElapsedMs: 50, sideEffectSafe: true },
      sleep,
    ).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ kind: "elapsed", code: "environment.retry_deadline_exceeded" });
    expect(sleep).not.toHaveBeenCalled();
    expect(observedSignal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("treats upstream abort during an attempt as terminal and does not retry", async () => {
    const upstream = new AbortController();
    let observedSignal: AbortSignal | undefined;
    const operation = vi.fn(
      async (ctx: { signal?: AbortSignal }) =>
        await new Promise<number>(() => {
          observedSignal = requireSignal(ctx.signal);
        }),
    );
    const pending = withRetry("cancel-attempt", operation, { ...validPolicy, signal: upstream.signal });
    const errorPromise = pending.catch((error: unknown) => error);

    upstream.abort(new Error("caller stopped"));
    const error = await errorPromise;
    expect(error).toBeInstanceOf(RetryAbortedError);
    expect(error).toMatchObject({
      kind: "cancelled",
      code: "environment.retry_cancelled",
      retryable: false,
      sideEffect: "unknown",
    });
    expect(operation).toHaveBeenCalledTimes(1);
    expect(observedSignal?.aborted).toBe(true);
    expect(observedSignal?.reason).toBe(upstream.signal.reason);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("treats upstream abort during backoff as terminal and does not start another attempt", async () => {
    const upstream = new AbortController();
    let sleepSignal: AbortSignal | undefined;
    const operation = vi.fn(async () => {
      throw transient();
    });
    const hangingSleep = vi.fn(
      async (_ms: number, signal?: AbortSignal) =>
        await new Promise<void>(() => {
          sleepSignal = signal;
        }),
    );
    const pending = withRetry("cancel-backoff", operation, { ...validPolicy, signal: upstream.signal }, hangingSleep);
    const errorPromise = pending.catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(0);
    expect(hangingSleep).toHaveBeenCalledTimes(1);
    upstream.abort("stop");

    await expect(errorPromise).resolves.toMatchObject({
      kind: "cancelled",
      code: "environment.retry_cancelled",
    });
    expect(operation).toHaveBeenCalledTimes(1);
    expect(sleepSignal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears the deadline timer and upstream listener after early success", async () => {
    const upstream = new AbortController();
    const removeListener = vi.spyOn(upstream.signal, "removeEventListener");

    await expect(
      withRetry("cleanup", async () => "ok", {
        ...validPolicy,
        maxElapsedMs: 10_000,
        signal: upstream.signal,
      }),
    ).resolves.toMatchObject({ value: "ok" });

    expect(removeListener).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("preserves the legacy no-budget path and one-argument sleep functions", async () => {
    const signals: AbortSignal[] = [];
    const legacySleep = vi.fn(async (_ms: number) => undefined);
    const outcome = await withRetry(
      "legacy",
      async (ctx) => {
        signals.push(requireSignal(ctx.signal));
        if (signals.length === 1) throw transient();
        return "ok";
      },
      validPolicy,
      legacySleep,
    );

    expect(outcome).toMatchObject({ value: "ok", attempts: 2 });
    expect(legacySleep).toHaveBeenCalledTimes(1);
    expect(signals).toHaveLength(2);
    expect(signals[0]).toBe(signals[1]);
    expect(signals[0]?.aborted).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("computeDelayMs", () => {
  it("stays within the exponential ceiling", () => {
    const policy = { baseDelayMs: 100, maxDelayMs: 1_000 };
    for (let attempt = 1; attempt <= 6; attempt++) {
      const ceiling = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (attempt - 1));
      for (let i = 0; i < 50; i++) {
        const delay = computeDelayMs(attempt, policy);
        expect(delay).toBeGreaterThanOrEqual(0);
        expect(delay).toBeLessThanOrEqual(ceiling);
      }
    }
  });
});

describe("withFallback", () => {
  it("serves from the primary step with no degradation", async () => {
    const outcome = await withFallback("op", [
      { name: "primary", run: async () => "fresh", degrades: [] },
      { name: "cache", run: async () => "stale", degrades: ["freshness"] },
    ]);
    expect(outcome.servedBy).toBe("primary");
    expect(outcome.degradedGuarantees).toEqual([]);
    expect(outcome.priorFailures).toEqual([]);
  });

  it("labels degradation when a later step serves", async () => {
    const seen: string[] = [];
    const outcome = await withFallback(
      "op",
      [
        {
          name: "primary",
          run: async () => {
            throw transient();
          },
          degrades: [],
        },
        { name: "cache", run: async () => "stale-but-valid", degrades: ["freshness"] },
      ],
      (o) => seen.push(o.servedBy),
    );
    expect(outcome.servedBy).toBe("cache");
    expect(outcome.degradedGuarantees).toEqual(["freshness"]);
    expect(outcome.priorFailures).toHaveLength(1);
    expect(seen).toEqual(["cache"]);
  });

  it("fails closed with DegradedError listing all failures when exhausted", async () => {
    await expect(
      withFallback("op", [
        {
          name: "a",
          run: async () => {
            throw transient();
          },
          degrades: [],
        },
        {
          name: "b",
          run: async () => {
            throw new EnvironmentError("down", {
              retryable: false,
              sideEffect: "none",
              blastRadius: "workflow",
              code: "environment.down",
            });
          },
          degrades: ["accuracy"],
        },
      ]),
    ).rejects.toSatisfy(
      (e: unknown) => e instanceof DegradedError && e.failures.length === 2 && e.droppedGuarantees.includes("accuracy"),
    );
  });
});

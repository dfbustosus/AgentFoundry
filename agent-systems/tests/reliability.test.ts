import { describe, expect, it } from "vitest";
import { EnvironmentError, ToolError } from "../src/core/errors/taxonomy.js";
import { withFallback } from "../src/core/reliability/fallback.js";
import { computeDelayMs, RetryExhaustedError, withRetry } from "../src/core/reliability/retry.js";
import { DegradedError } from "../src/core/errors/taxonomy.js";

const noSleep = async () => {};

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

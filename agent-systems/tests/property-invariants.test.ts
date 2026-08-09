import * as fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import { CostTracker, estimateCostUsd } from "../src/core/cost/tracker.js";
import { TaskGraph, type TaskNode } from "../src/core/decomposition/graph.js";
import { ReasoningError, ToolError } from "../src/core/errors/taxonomy.js";
import { createEnvelope, validateEnvelope } from "../src/core/handoff/envelope.js";
import { InMemoryBus, receiveHandoff, replyTo } from "../src/core/handoff/protocol.js";
import { RetryExhaustedError, withRetry } from "../src/core/reliability/retry.js";
import { InMemoryStore } from "../src/core/state/memory.js";
import { CheckpointStore, reconcile, type Checkpoint, type TaskLedgerEntry } from "../src/core/state/session.js";

const PROPERTY_RUNS = 64;
const PROPERTY_SEEDS = {
  dag: 0x0da6_0001,
  cycle: 0x0da6_0002,
  retry: 0x0da6_0003,
  cost: 0x0da6_0004,
  checkpoint: 0x0da6_0005,
  handoff: 0x0da6_0006,
} as const;

function propertyParameters(seed: number) {
  return { seed, numRuns: PROPERTY_RUNS, verbose: true } as const;
}

function taskId(index: number): string {
  return `task-${String(index)}`;
}

function taskNode(id: string, dependsOn: readonly string[]): TaskNode {
  return {
    id,
    objective: `Complete ${id}`,
    dependsOn,
    run: async () => id,
  };
}

interface DagCase {
  readonly dependencies: Readonly<Record<string, readonly string[]>>;
  readonly insertionOrder: readonly string[];
}

const dagCaseArbitrary: fc.Arbitrary<DagCase> = fc.integer({ min: 1, max: 10 }).chain((size) => {
  const ids = Array.from({ length: size }, (_, index) => taskId(index));
  const edgeCount = (size * (size - 1)) / 2;

  return fc
    .tuple(
      fc.array(fc.boolean(), { minLength: edgeCount, maxLength: edgeCount }),
      fc.shuffledSubarray(ids, { minLength: size, maxLength: size }),
    )
    .map(([edgeFlags, insertionOrder]) => {
      const dependencies: Record<string, string[]> = {};
      let edgeIndex = 0;
      for (let nodeIndex = 0; nodeIndex < size; nodeIndex += 1) {
        const id = taskId(nodeIndex);
        dependencies[id] = [];
        for (let dependencyIndex = 0; dependencyIndex < nodeIndex; dependencyIndex += 1) {
          if (edgeFlags[edgeIndex] === true) dependencies[id].push(taskId(dependencyIndex));
          edgeIndex += 1;
        }
      }
      return { dependencies, insertionOrder };
    });
});

const cycleArbitrary = fc.integer({ min: 1, max: 10 }).chain((size) => {
  const ids = Array.from({ length: size }, (_, index) => taskId(index));
  return fc.shuffledSubarray(ids, { minLength: size, maxLength: size }).map((insertionOrder) => ({
    ids,
    insertionOrder,
  }));
});

describe("property invariants: task graphs", () => {
  it("places every dependency in an earlier topological layer for arbitrary DAGs", () => {
    fc.assert(
      fc.property(dagCaseArbitrary, ({ dependencies, insertionOrder }) => {
        const graph = new TaskGraph();
        for (const id of insertionOrder) {
          const nodeDependencies = dependencies[id];
          if (nodeDependencies === undefined) throw new Error(`Generator omitted dependencies for ${id}`);
          graph.add(taskNode(id, nodeDependencies));
        }

        const layers = graph.layers();
        const flattened = layers.flat();
        const expectedIds = Object.keys(dependencies);
        expect(flattened).toHaveLength(expectedIds.length);
        expect(new Set(flattened)).toEqual(new Set(expectedIds));

        const layerById = new Map<string, number>();
        for (const [layerIndex, layer] of layers.entries()) {
          for (const id of layer) layerById.set(id, layerIndex);
        }
        for (const [id, nodeDependencies] of Object.entries(dependencies)) {
          const nodeLayer = layerById.get(id);
          if (nodeLayer === undefined) throw new Error(`Topological layers omitted ${id}`);
          for (const dependency of nodeDependencies) {
            const dependencyLayer = layerById.get(dependency);
            if (dependencyLayer === undefined) throw new Error(`Topological layers omitted ${dependency}`);
            expect(dependencyLayer).toBeLessThan(nodeLayer);
          }
        }
      }),
      propertyParameters(PROPERTY_SEEDS.dag),
    );
  });

  it("rejects every generated directed cycle as a non-retryable reasoning error", () => {
    fc.assert(
      fc.property(cycleArbitrary, ({ ids, insertionOrder }) => {
        const graph = new TaskGraph();
        for (const id of insertionOrder) {
          const index = Number(id.slice("task-".length));
          const predecessor = taskId((index - 1 + ids.length) % ids.length);
          graph.add(taskNode(id, [predecessor]));
        }

        let caught: unknown;
        try {
          graph.layers();
        } catch (error) {
          caught = error;
        }

        expect(caught).toBeInstanceOf(ReasoningError);
        if (!(caught instanceof ReasoningError)) throw new Error("TaskGraph accepted a generated cycle");
        expect(caught).toMatchObject({
          code: "reasoning.invalid_task_graph",
          retryable: false,
          sideEffect: "none",
        });
        expect(caught.message).toContain("cycle");
        expect(new Set(caught.evidence)).toEqual(new Set(ids));
      }),
      propertyParameters(PROPERTY_SEEDS.cycle),
    );
  });
});

function transientFailure(): ToolError {
  return new ToolError("transient property failure", {
    retryable: true,
    sideEffect: "none",
    blastRadius: "local",
    code: "tool.property_transient",
  });
}

const retryCaseArbitrary = fc.record({
  maxAttempts: fc.integer({ min: 1, max: 8 }),
  failuresBeforeSuccess: fc.integer({ min: 0, max: 12 }),
  baseDelayMs: fc.integer({ min: 0, max: 100 }),
  maxDelayMs: fc.integer({ min: 0, max: 1_000 }),
});

describe("property invariants: retry budgets", () => {
  it("never exceeds the attempt budget and recovers exactly when success is in budget", async () => {
    const random = vi.spyOn(Math, "random").mockReturnValue(0.5);
    try {
      await fc.assert(
        fc.asyncProperty(
          retryCaseArbitrary,
          async ({ maxAttempts, failuresBeforeSuccess, baseDelayMs, maxDelayMs }) => {
            const attemptsSeen: number[] = [];
            const idempotencyKeys: (string | undefined)[] = [];
            const delays: number[] = [];
            const idempotencyKey = "property-retry-key";

            const operation = withRetry(
              "property operation",
              async (context) => {
                attemptsSeen.push(context.attempt);
                idempotencyKeys.push(context.idempotencyKey);
                if (context.attempt <= failuresBeforeSuccess) throw transientFailure();
                return context.attempt;
              },
              { maxAttempts, baseDelayMs, maxDelayMs, idempotencyKey },
              async (delay) => {
                delays.push(delay);
              },
            );

            const succeedsInBudget = failuresBeforeSuccess < maxAttempts;
            const expectedAttempts = succeedsInBudget ? failuresBeforeSuccess + 1 : maxAttempts;
            if (succeedsInBudget) {
              const outcome = await operation;
              expect(outcome.value).toBe(expectedAttempts);
              expect(outcome.attempts).toBe(expectedAttempts);
              expect(outcome.errors).toHaveLength(failuresBeforeSuccess);
            } else {
              let caught: unknown;
              try {
                await operation;
              } catch (error) {
                caught = error;
              }
              expect(caught).toBeInstanceOf(RetryExhaustedError);
              if (!(caught instanceof RetryExhaustedError)) {
                throw new Error("Retry operation did not report budget exhaustion");
              }
              expect(caught.attempts).toHaveLength(maxAttempts);
              expect(caught.attempts.every((error) => error.retryable)).toBe(true);
            }

            expect(attemptsSeen).toEqual(Array.from({ length: expectedAttempts }, (_, index) => index + 1));
            expect(idempotencyKeys).toEqual(Array.from({ length: expectedAttempts }, () => idempotencyKey));
            expect(delays).toHaveLength(expectedAttempts - 1);
            for (const [index, delay] of delays.entries()) {
              const attempt = index + 1;
              const ceiling = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
              expect(delay).toBe(Math.floor(ceiling * 0.5));
            }
          },
        ),
        propertyParameters(PROPERTY_SEEDS.retry),
      );
    } finally {
      random.mockRestore();
    }
  });
});

const PRICED_MODELS = ["gpt-4o-mini", "gpt-4o", "gpt-4.1-mini", "gpt-4.1"] as const;
type PricedModel = (typeof PRICED_MODELS)[number];

interface UsageEvent {
  readonly agentId: string;
  readonly model: PricedModel;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

interface AggregatedUsage extends UsageEvent {
  readonly calls: number;
}

const usageEventArbitrary: fc.Arbitrary<UsageEvent> = fc.record({
  agentId: fc.integer({ min: 0, max: 4 }).map((index) => `agent-${String(index)}`),
  model: fc.constantFrom(...PRICED_MODELS),
  inputTokens: fc.integer({ min: 0, max: 2_000_000 }),
  outputTokens: fc.integer({ min: 0, max: 2_000_000 }),
});

function costFor(usage: Pick<UsageEvent, "model" | "inputTokens" | "outputTokens">): number {
  const cost = estimateCostUsd(usage.model, usage);
  if (cost === undefined) throw new Error(`Missing price for generated model ${usage.model}`);
  return cost;
}

describe("property invariants: cost accounting", () => {
  it("aggregates token usage exactly and keeps priced cost monotonic", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-08T12:00:00Z"));
    try {
      fc.assert(
        fc.property(fc.array(usageEventArbitrary, { maxLength: 24 }), (events) => {
          const tracker = new CostTracker();
          const expectedByKey = new Map<string, AggregatedUsage>();
          let expectedTotalTokens = 0;
          let previousCost = 0;

          for (const event of events) {
            const key = `${event.agentId}:${event.model}`;
            const previous = expectedByKey.get(key);
            expectedByKey.set(key, {
              ...event,
              inputTokens: (previous?.inputTokens ?? 0) + event.inputTokens,
              outputTokens: (previous?.outputTokens ?? 0) + event.outputTokens,
              calls: (previous?.calls ?? 0) + 1,
            });
            expectedTotalTokens += event.inputTokens + event.outputTokens;

            tracker.record(event.agentId, event.model, event);
            const report = tracker.report();
            expect(report.totalTokens).toBe(expectedTotalTokens);
            expect(report.hasUnpricedModels).toBe(false);
            if (report.totalCostUsd === undefined) throw new Error("Priced usage produced an unpriced total");
            expect(report.totalCostUsd).toBeGreaterThanOrEqual(previousCost);
            previousCost = report.totalCostUsd;
          }

          const report = tracker.report();
          expect(report.perAgent).toHaveLength(expectedByKey.size);
          for (const expected of expectedByKey.values()) {
            const actual = report.perAgent.find(
              (record) => record.agentId === expected.agentId && record.model === expected.model,
            );
            expect(actual).toMatchObject({
              inputTokens: expected.inputTokens,
              outputTokens: expected.outputTokens,
              calls: expected.calls,
            });
            expect(actual?.costUsd).toBeCloseTo(costFor(expected), 12);
          }

          const expectedTotalCost = [...expectedByKey.values()].reduce((total, usage) => total + costFor(usage), 0);
          expect(report.totalCostUsd).toBeCloseTo(expectedTotalCost, 12);
        }),
        propertyParameters(PROPERTY_SEEDS.cost),
      );
    } finally {
      vi.useRealTimers();
    }
  });
});

const SHORT_ISO = "2026-08-08T12:00:00Z";
const shortStringArbitrary = fc.string({ maxLength: 24 });
const nonEmptyStringArbitrary = fc.string({ minLength: 1, maxLength: 24 });
const TASK_STATUSES = ["pending", "ready", "in_progress", "blocked", "completed", "failed", "superseded"] as const;

const ledgerEntryArbitrary: fc.Arbitrary<TaskLedgerEntry> = fc.record({
  task_id: nonEmptyStringArbitrary,
  status: fc.constantFrom(...TASK_STATUSES),
  owner: shortStringArbitrary,
  attempt: fc.integer({ min: 0, max: 20 }),
});

const ledgerArbitrary = fc.uniqueArray(ledgerEntryArbitrary, {
  selector: (entry) => entry.task_id,
  maxLength: 12,
});

const checkpointArbitrary: fc.Arbitrary<Checkpoint> = fc
  .record({
    session_id: nonEmptyStringArbitrary,
    version: fc.integer({ min: 1, max: 1_000 }),
    correlation_id: nonEmptyStringArbitrary,
    goal: shortStringArbitrary,
    ledger: ledgerArbitrary,
    decisions: fc.array(
      fc.record({
        decision: shortStringArbitrary,
        rationale: shortStringArbitrary,
        reversible: fc.boolean(),
      }),
      { maxLength: 6 },
    ),
    assumptions: fc.array(fc.record({ assumption: shortStringArbitrary, impactIfWrong: shortStringArbitrary }), {
      maxLength: 6,
    }),
    nextAction: shortStringArbitrary,
    savedAt: fc.constant(SHORT_ISO),
  })
  .chain((base) => {
    const inProgressIds = base.ledger.filter((entry) => entry.status === "in_progress").map((entry) => entry.task_id);
    return fc.shuffledSubarray(inProgressIds).map((completedIds) => ({
      ...base,
      completedEffects: completedIds.map((key) => ({
        key,
        effect: `effect for ${key}`,
        completedAt: SHORT_ISO,
      })),
    }));
  });

describe("property invariants: checkpoints", () => {
  it("round-trips valid checkpoints and never makes completed in-flight effects resumable", async () => {
    await fc.assert(
      fc.asyncProperty(checkpointArbitrary, async (checkpoint) => {
        const store = new CheckpointStore(new InMemoryStore());
        await store.save(checkpoint);
        const loaded = await store.load(checkpoint.session_id);
        expect(loaded).toEqual(checkpoint);
        if (loaded === undefined) throw new Error("Saved checkpoint was not loadable");

        const plan = reconcile(loaded);
        expect(plan.checkpoint).toEqual(loaded);
        expect(plan.doNotReplay).toEqual(checkpoint.completedEffects.map((effect) => effect.key));

        const doNotReplay = new Set(plan.doNotReplay);
        const resumableById = new Map(plan.resumable.map((entry) => [entry.task_id, entry] as const));
        const staleById = new Map(plan.stale.map((entry) => [entry.task_id, entry] as const));
        for (const key of doNotReplay) expect(resumableById.has(key)).toBe(false);

        for (const entry of checkpoint.ledger) {
          const resumable = resumableById.get(entry.task_id);
          const stale = staleById.get(entry.task_id);
          if (entry.status === "in_progress" && doNotReplay.has(entry.task_id)) {
            expect(resumable).toBeUndefined();
            expect(stale).toEqual({ ...entry, status: "completed" });
          } else if (entry.status === "in_progress") {
            expect(resumable).toEqual({ ...entry, status: "ready", attempt: entry.attempt + 1 });
            expect(stale).toBeUndefined();
          } else if (entry.status === "ready" || entry.status === "pending") {
            expect(resumable).toEqual(entry);
            expect(stale).toBeUndefined();
          } else if (entry.status === "superseded") {
            expect(resumable).toBeUndefined();
            expect(stale).toEqual(entry);
          } else {
            expect(resumable).toBeUndefined();
            expect(stale).toBeUndefined();
          }
        }
      }),
      propertyParameters(PROPERTY_SEEDS.checkpoint),
    );
  });
});

type ReplyStatus = "partial" | "blocked" | "completed" | "failed";

interface HandoffCase {
  readonly messageId: string;
  readonly correlationId: string;
  readonly taskId: string;
  readonly objective: string;
  readonly authority: "read-only" | "propose" | "modify" | "execute";
  readonly facts: readonly string[];
  readonly assumptions: readonly string[];
  readonly artifactRefs: readonly string[];
  readonly constraints: readonly string[];
  readonly acceptanceChecks: readonly string[];
  readonly replyStatus: ReplyStatus;
  readonly summary: string;
  readonly evidence: readonly string[];
  readonly verification: readonly string[];
  readonly risks: readonly string[];
  readonly openQuestions: readonly string[];
  readonly nextAction: string;
}

const handoffCaseArbitrary: fc.Arbitrary<HandoffCase> = fc.record({
  messageId: nonEmptyStringArbitrary,
  correlationId: nonEmptyStringArbitrary,
  taskId: nonEmptyStringArbitrary,
  objective: nonEmptyStringArbitrary,
  authority: fc.constantFrom("read-only", "propose", "modify", "execute"),
  facts: fc.array(shortStringArbitrary, { maxLength: 5 }),
  assumptions: fc.array(shortStringArbitrary, { maxLength: 5 }),
  artifactRefs: fc.array(shortStringArbitrary, { maxLength: 5 }),
  constraints: fc.array(shortStringArbitrary, { maxLength: 5 }),
  acceptanceChecks: fc.array(shortStringArbitrary, { maxLength: 5 }),
  replyStatus: fc.constantFrom("partial", "blocked", "completed", "failed"),
  summary: shortStringArbitrary,
  evidence: fc.array(shortStringArbitrary, { maxLength: 5 }),
  verification: fc.array(shortStringArbitrary, { maxLength: 5 }),
  risks: fc.array(shortStringArbitrary, { maxLength: 5 }),
  openQuestions: fc.array(shortStringArbitrary, { maxLength: 5 }),
  nextAction: shortStringArbitrary,
});

describe("property invariants: handoff protocol", () => {
  it("round-trips delegations and linked replies while rejecting delegation replay", () => {
    fc.assert(
      fc.property(handoffCaseArbitrary, (generated) => {
        const sender = "property-orchestrator";
        const recipient = "property-worker";
        const delegation = createEnvelope({
          message_id: generated.messageId,
          correlation_id: generated.correlationId,
          causation_id: null,
          task_id: generated.taskId,
          sender,
          recipient,
          intent: "delegate",
          objective: generated.objective,
          status: "ready",
          authority: generated.authority,
          inputs: {
            facts: [...generated.facts],
            assumptions: [...generated.assumptions],
            artifact_refs: [...generated.artifactRefs],
          },
          constraints: generated.constraints,
          acceptance_checks: generated.acceptanceChecks,
          recommended_next_action: generated.nextAction,
          expires_at: null,
        });
        const rawDelegation: unknown = JSON.parse(JSON.stringify(delegation));
        const validatedDelegation = validateEnvelope(rawDelegation);
        expect(validatedDelegation.ok).toBe(true);
        if (!validatedDelegation.ok) throw new Error(validatedDelegation.issues.join("; "));
        expect(validatedDelegation.envelope).toEqual(delegation);

        const bus = new InMemoryBus();
        const accepted = receiveHandoff(bus, recipient, rawDelegation);
        expect(accepted.accepted).toBe(true);
        if (!accepted.accepted) throw new Error(accepted.reasons.join("; "));

        const replay = receiveHandoff(bus, recipient, rawDelegation);
        expect(replay.accepted).toBe(false);
        if (replay.accepted) throw new Error("Handoff replay was accepted");
        expect(replay.reasons.some((reason) => reason.includes("replay"))).toBe(true);
        expect(bus.peek(recipient)).toHaveLength(1);

        const received = bus.drain(recipient)[0];
        expect(received).toEqual(delegation);
        if (received === undefined) throw new Error("Accepted delegation was not delivered");

        const reply = replyTo(received, {
          message_id: `reply:${generated.messageId}`,
          status: generated.replyStatus,
          summary: generated.summary,
          evidence: generated.evidence,
          artifact_refs: generated.artifactRefs,
          verification: generated.verification,
          risks: generated.risks,
          open_questions: generated.openQuestions,
          recommended_next_action: generated.nextAction,
        });
        expect(reply.causation_id).toBe(delegation.message_id);
        expect(reply.correlation_id).toBe(delegation.correlation_id);
        expect(reply.task_id).toBe(delegation.task_id);
        expect(reply.sender).toBe(recipient);
        expect(reply.recipient).toBe(sender);
        expect(reply.intent).toBe(generated.replyStatus === "blocked" ? "escalation" : "result");

        const rawReply: unknown = JSON.parse(JSON.stringify(reply));
        const validatedReply = validateEnvelope(rawReply);
        expect(validatedReply.ok).toBe(true);
        if (!validatedReply.ok) throw new Error(validatedReply.issues.join("; "));
        expect(validatedReply.envelope).toEqual(reply);

        const replyAck = receiveHandoff(bus, sender, rawReply);
        expect(replyAck.accepted).toBe(true);
        if (!replyAck.accepted) throw new Error(replyAck.reasons.join("; "));
        expect(bus.drain(sender)).toEqual([reply]);
      }),
      propertyParameters(PROPERTY_SEEDS.handoff),
    );
  });
});

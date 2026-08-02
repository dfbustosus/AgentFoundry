/**
 * The PRAO loop: Perception → Reasoning → Action → Observation, with explicit
 * loop control.
 *
 * Why not just let the SDK's internal step loop run? Because loop control —
 * stopping, iterating, recovering, clarifying, escalating — is a first-class
 * design concern. Here every iteration produces a typed Observation, every
 * transition is an explicit decision with a recorded reason, and every budget
 * is a hard bound enforced in code.
 *
 * One PRAO iteration = one `generateText` call (which may itself take several
 * internal SDK steps: reason → call tools → observe results). The transition
 * policy then decides what happens next.
 */

import {
  generateText,
  stepCountIs,
  type LanguageModel,
  type LanguageModelUsage,
  type ModelMessage,
  type ToolSet,
} from "ai";
import { classifyError } from "../errors/classify.js";
import { BudgetExhaustedError, type AgentError } from "../errors/taxonomy.js";
import { newSpanId, newTraceId, nowIso, type Tracer } from "../trace/tracer.js";

export type LoopTransition =
  | "stop-success" // acceptance criteria have evidence
  | "iterate" // a bounded next action is useful
  | "recover" // classified failure with a safe retry path
  | "clarify" // one high-impact fact is missing and cannot be inferred safely
  | "escalate" // authority, risk, or expertise exceeded
  | "stop-failure"; // no safe path remains, or a budget is exhausted

export interface LoopBudgets {
  readonly maxIterations: number;
  readonly maxElapsedMs: number;
  readonly maxToolCalls: number;
  /** Consecutive failed iterations before mandatory escalation. */
  readonly maxConsecutiveFailures: number;
  /** Repeated identical assistant outputs before declaring a stall. */
  readonly maxIdenticalOutputs: number;
}

export const DEFAULT_BUDGETS: LoopBudgets = {
  maxIterations: 8,
  maxElapsedMs: 120_000,
  maxToolCalls: 25,
  maxConsecutiveFailures: 3,
  maxIdenticalOutputs: 2,
} as const;

export type ObservationKind = "success" | "partial" | "uncertain" | "failure";

export interface Observation {
  readonly iteration: number;
  readonly kind: ObservationKind;
  /** What was observed, independently of what was requested. */
  readonly summary: string;
  readonly text: string;
  readonly toolCalls: readonly string[];
  readonly finishReason: string;
  readonly usage: LanguageModelUsage | undefined;
  readonly error?: AgentError;
}

export interface LoopState {
  readonly iteration: number;
  readonly toolCallCount: number;
  readonly consecutiveFailures: number;
  readonly identicalOutputCount: number;
  readonly elapsedMs: number;
  readonly observations: readonly Observation[];
}

export interface TransitionDecision {
  readonly transition: LoopTransition;
  readonly reason: string;
  /** Payload for "clarify"/"escalate": exactly what is needed and from whom. */
  readonly request?: string;
}

export interface PraoLoopOptions<TOOLS extends ToolSet> {
  readonly model: LanguageModel;
  readonly tools?: TOOLS;
  readonly system: string;
  /** The goal, stated as observable outcomes, not activities. */
  readonly goal: string;
  /** Prior conversation, when resuming a session. */
  readonly initialMessages?: readonly ModelMessage[];
  readonly budgets?: Partial<LoopBudgets>;
  /**
   * Internal SDK steps allowed per PRAO iteration. One iteration may need
   * several model↔tool round-trips; this bounds them.
   */
  readonly stepsPerIteration?: number;
  /**
   * Custom transition policy. Receives the fresh observation and full state
   * AFTER the default checks (budgets, stall) have passed. Return undefined
   * to accept the default decision for this observation.
   */
  readonly decide?: (observation: Observation, state: LoopState) => TransitionDecision | undefined;
  readonly onObservation?: (observation: Observation, state: LoopState) => void;
  /**
   * Optional trace sink. When present, every iteration and the final
   * transition are emitted as typed spans correlated by `traceId`.
   */
  readonly tracer?: Tracer;
  /** Correlate this run with an outer workflow; generated when omitted. */
  readonly traceId?: string;
  /** Actor label stamped on spans. Defaults to "prao-loop". */
  readonly actor?: string;
}

export interface LoopResult {
  readonly transition: LoopTransition;
  readonly reason: string;
  readonly request?: string;
  readonly text: string;
  /** Correlates every span this run emitted; pass it to nested runs. */
  readonly traceId: string;
  readonly messages: readonly ModelMessage[];
  readonly observations: readonly Observation[];
  readonly iterations: number;
  readonly toolCallCount: number;
  /** Total tokens consumed across all iterations — feeds cost accounting. */
  readonly usage: { inputTokens: number; outputTokens: number };
  /** Present iff the loop ended in stop-failure or escalate due to an error/budget. */
  readonly error?: AgentError;
}

function zeroUsage(): { input: number; output: number } {
  return { input: 0, output: 0 };
}

function addUsage(acc: { input: number; output: number }, usage: LanguageModelUsage | undefined): void {
  acc.input += usage?.inputTokens ?? 0;
  acc.output += usage?.outputTokens ?? 0;
}

export async function runPraoLoop<TOOLS extends ToolSet>(options: PraoLoopOptions<TOOLS>): Promise<LoopResult> {
  const result = await execute(options);
  // Durability of spans is explicit: tracing must never change loop behavior,
  // but a caller that awaited the loop gets a durable trace.
  await options.tracer?.flush?.();
  return result;
}

async function execute<TOOLS extends ToolSet>(options: PraoLoopOptions<TOOLS>): Promise<LoopResult> {
  const budgets: LoopBudgets = { ...DEFAULT_BUDGETS, ...options.budgets };
  const stepsPerIteration = options.stepsPerIteration ?? 4;
  const startedAt = Date.now();
  const tracer = options.tracer;
  const traceId = options.traceId ?? newTraceId();
  const rootSpanId = newSpanId();
  const actor = options.actor ?? "prao-loop";

  const messages: ModelMessage[] = [...(options.initialMessages ?? []), { role: "user", content: options.goal }];
  const observations: Observation[] = [];
  const usageTotals = zeroUsage();

  let toolCallCount = 0;
  let consecutiveFailures = 0;
  let lastText = "";
  let identicalOutputCount = 0;

  const buildState = (iteration: number): LoopState => ({
    iteration,
    toolCallCount,
    consecutiveFailures,
    identicalOutputCount,
    elapsedMs: Date.now() - startedAt,
    observations,
  });

  const finish = (decision: TransitionDecision, extras: { text?: string; error?: AgentError }): LoopResult => {
    tracer?.emit({
      trace_id: traceId,
      span_id: rootSpanId,
      parent_span_id: null,
      timestamp: nowIso(),
      actor,
      type: "loop.transition",
      transition: decision.transition,
      reason: decision.reason,
      iterations: observations.length,
      toolCallCount,
    });
    return {
      transition: decision.transition,
      reason: decision.reason,
      ...(decision.request !== undefined ? { request: decision.request } : {}),
      text: extras.text ?? "",
      traceId,
      messages,
      observations,
      iterations: observations.length,
      toolCallCount,
      usage: { inputTokens: usageTotals.input, outputTokens: usageTotals.output },
      ...(extras.error !== undefined ? { error: extras.error } : {}),
    };
  };

  for (let iteration = 1; iteration <= budgets.maxIterations; iteration++) {
    // ---- Perceive ------------------------------------------------------
    // State is the accumulated message history plus prior observations.
    // Budgets are checked BEFORE acting, never after the fact.
    const elapsed = Date.now() - startedAt;
    if (elapsed >= budgets.maxElapsedMs) {
      const error = new BudgetExhaustedError(
        "maxElapsedMs",
        `${elapsed}ms`,
        observations.map((o) => o.summary),
      );
      return finish({ transition: "stop-failure", reason: error.message }, { error });
    }
    if (toolCallCount >= budgets.maxToolCalls) {
      const error = new BudgetExhaustedError("maxToolCalls", `${toolCallCount}`, []);
      return finish({ transition: "stop-failure", reason: error.message }, { error });
    }

    // ---- Reason + Act ---------------------------------------------------
    let observation: Observation;
    try {
      const result = await generateText({
        model: options.model,
        ...(options.tools !== undefined ? { tools: options.tools } : {}),
        system: options.system,
        messages,
        stopWhen: stepCountIs(stepsPerIteration),
        maxRetries: 0, // retries are OUR decision, classified and bounded — not the SDK's hidden default
      });

      const calls = result.toolCalls.map((c) => c.toolName);
      toolCallCount += calls.length;
      addUsage(usageTotals, result.totalUsage);
      messages.push(...result.response.messages);

      const kind: ObservationKind =
        result.finishReason === "stop" ? "success" : result.finishReason === "tool-calls" ? "partial" : "uncertain";
      observation = {
        iteration,
        kind,
        summary:
          kind === "success"
            ? "Model produced a final answer with no pending tool calls."
            : `Model requested further work (finishReason=${result.finishReason}, tools=[${calls.join(", ")}]).`,
        text: result.text,
        toolCalls: calls,
        finishReason: String(result.finishReason),
        usage: result.totalUsage,
      };
      consecutiveFailures = 0;
    } catch (raw) {
      const error = classifyError(raw);
      consecutiveFailures += 1;
      observation = {
        iteration,
        kind: "failure",
        summary: `Iteration failed: [${error.code}] ${error.message}`,
        text: "",
        toolCalls: [],
        finishReason: "error",
        usage: undefined,
        error,
      };
    }

    // ---- Observe ---------------------------------------------------------
    observations.push(observation);
    tracer?.emit({
      trace_id: traceId,
      span_id: newSpanId(),
      parent_span_id: rootSpanId,
      timestamp: nowIso(),
      actor,
      type: "loop.iteration",
      iteration: observation.iteration,
      kind: observation.kind,
      toolCalls: [...observation.toolCalls],
      finishReason: observation.finishReason,
    });

    // Stall detection: identical assistant output repeated means the loop is
    // cycling, not progressing. This is a reasoning signal, not a budget.
    if (observation.text.length > 0 && observation.text === lastText) {
      identicalOutputCount += 1;
    } else if (observation.text.length > 0) {
      identicalOutputCount = 1;
      lastText = observation.text;
    }

    const state = buildState(iteration);
    options.onObservation?.(observation, state);

    // ---- Transition (exactly one) ---------------------------------------
    if (observation.kind === "failure") {
      const error = observation.error;
      if (consecutiveFailures >= budgets.maxConsecutiveFailures) {
        return finish(
          {
            transition: "escalate",
            reason: `${consecutiveFailures} consecutive failures; last: ${error?.code ?? "unknown"}`,
            request: "Human or higher-authority agent must reclassify and redirect.",
          },
          { ...(error !== undefined ? { error } : {}) },
        );
      }
      if (error?.retryable === true) {
        options.decide?.(observation, state); // allow observers/policies to record; recovery is still forced safe
        continue; // recover: classified, transient, bounded — try again
      }
      return finish(
        {
          transition: "stop-failure",
          reason: `Non-retryable failure: [${error?.code ?? "unknown"}] ${error?.message ?? ""}`,
        },
        { ...(error !== undefined ? { error } : {}) },
      );
    }

    if (identicalOutputCount > budgets.maxIdenticalOutputs) {
      const error = new BudgetExhaustedError("stall detection", `${identicalOutputCount} identical outputs`, [
        `Repeated output: ${observation.text.slice(0, 120)}`,
      ]);
      return finish(
        {
          transition: "stop-failure",
          reason: `Stall detected: the agent repeated itself ${identicalOutputCount} times without new evidence.`,
        },
        { error, text: observation.text },
      );
    }

    // Custom policy gets the decisive word on success/clarify/escalate —
    // real acceptance criteria live with the caller, not in heuristics.
    const custom = options.decide?.(observation, state);
    if (custom !== undefined) {
      if (custom.transition === "iterate") continue;
      return finish(custom, { text: observation.text });
    }

    if (observation.kind === "success") {
      return finish(
        { transition: "stop-success", reason: "Model completed with a final answer and no pending tool calls." },
        { text: observation.text },
      );
    }
    // kind partial/uncertain with no custom verdict: keep iterating within budget.
  }

  const error = new BudgetExhaustedError(
    "maxIterations",
    `${budgets.maxIterations}`,
    observations.map((o) => o.summary),
  );
  return finish(
    { transition: "stop-failure", reason: error.message },
    { error, text: observations.at(-1)?.text ?? "" },
  );
}

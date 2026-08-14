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
 *
 * The elapsed budget is a real deadline, not a pre-flight check: one monotonic
 * timer spans the whole run and aborts the in-flight model call when it fires.
 * Callers may also pass an AbortSignal; cancellation is terminal, classified
 * separately from deadline exhaustion, and is never retried.
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
import { BudgetExhaustedError, EnvironmentError, type AgentError } from "../errors/taxonomy.js";
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
  /** Hard wall-clock budget for the whole run, enforced before AND during model calls. */
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
   * Optional caller cancellation. The composed signal reaches every
   * `generateText` call (and therefore every tool execution). Cancellation
   * is terminal: the loop ends with `environment.loop_cancelled`, never
   * retries, and never counts the abort as a model failure.
   */
  readonly signal?: AbortSignal;
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

const MAX_TIMER_DURATION_MS = 2_147_483_647;

function invalidBudget(requirement: string): EnvironmentError {
  return new EnvironmentError(`Invalid PRAO loop budget: ${requirement}.`, {
    retryable: false,
    sideEffect: "none",
    blastRadius: "local",
    code: "environment.invalid_loop_budget",
  });
}

/**
 * Budgets are enforcement machinery, so malformed budgets fail fast at call
 * time instead of degrading into surprising loop behavior mid-run.
 */
function validateLoopBudgets(budgets: LoopBudgets, stepsPerIteration: number): void {
  if (!Number.isSafeInteger(budgets.maxIterations) || budgets.maxIterations < 1) {
    throw invalidBudget("maxIterations must be a safe integer >= 1");
  }
  if (
    !Number.isFinite(budgets.maxElapsedMs) ||
    budgets.maxElapsedMs <= 0 ||
    budgets.maxElapsedMs > MAX_TIMER_DURATION_MS
  ) {
    throw invalidBudget(`maxElapsedMs must be finite, > 0, and <= ${MAX_TIMER_DURATION_MS}`);
  }
  if (!Number.isSafeInteger(budgets.maxToolCalls) || budgets.maxToolCalls < 1) {
    throw invalidBudget("maxToolCalls must be a safe integer >= 1");
  }
  if (!Number.isSafeInteger(budgets.maxConsecutiveFailures) || budgets.maxConsecutiveFailures < 1) {
    throw invalidBudget("maxConsecutiveFailures must be a safe integer >= 1");
  }
  if (!Number.isSafeInteger(budgets.maxIdenticalOutputs) || budgets.maxIdenticalOutputs < 1) {
    throw invalidBudget("maxIdenticalOutputs must be a safe integer >= 1");
  }
  if (!Number.isSafeInteger(stepsPerIteration) || stepsPerIteration < 1) {
    throw invalidBudget("stepsPerIteration must be a safe integer >= 1");
  }
}

type LoopAbortKind = "elapsed" | "cancelled";

interface LoopAbortScope {
  readonly signal: AbortSignal;
  /** The classified terminal error once the loop has been aborted. */
  readonly terminalError: () => AgentError | undefined;
  readonly dispose: () => void;
}

function loopCancelledError(inFlight: boolean, cause?: unknown): EnvironmentError {
  return new EnvironmentError("PRAO loop cancelled by its caller.", {
    retryable: false,
    // A non-cooperative in-flight model call may still complete externally.
    sideEffect: inFlight ? "unknown" : "none",
    blastRadius: "workflow",
    code: "environment.loop_cancelled",
    cause,
  });
}

/**
 * One controller per run, fed by the elapsed-budget timer and the optional
 * upstream signal. The first abort wins, so deadline exhaustion and caller
 * cancellation stay distinguishable.
 */
function createLoopAbortScope(
  maxElapsedMs: number,
  startedAt: number,
  upstream: AbortSignal | undefined,
  isInFlight: () => boolean,
  getEvidence: () => readonly string[],
): LoopAbortScope {
  const controller = new AbortController();
  let terminal: AgentError | undefined;

  const abortWith = (kind: LoopAbortKind, cause?: unknown): void => {
    if (terminal !== undefined) return;
    terminal =
      kind === "elapsed"
        ? // The transition section is fully synchronous, so the deadline timer
          // can only fire while a model call is in flight; a non-cooperative
          // call may still complete externally, hence sideEffect "unknown".
          new BudgetExhaustedError("maxElapsedMs", `${Date.now() - startedAt}ms`, getEvidence(), {
            sideEffect: "unknown",
          })
        : loopCancelledError(isInFlight(), cause);
    if (!controller.signal.aborted) controller.abort(terminal);
  };

  const onUpstreamAbort = (): void => abortWith("cancelled", upstream?.reason);
  if (upstream !== undefined) {
    upstream.addEventListener("abort", onUpstreamAbort, { once: true });
    if (upstream.aborted) onUpstreamAbort();
  }

  const timer = setTimeout(() => abortWith("elapsed"), Math.max(0, maxElapsedMs - (Date.now() - startedAt)));

  return {
    signal: controller.signal,
    terminalError: () => terminal,
    dispose: () => {
      clearTimeout(timer);
      upstream?.removeEventListener("abort", onUpstreamAbort);
    },
  };
}

/**
 * Settle on abort even when the provider ignores the signal. The rejection
 * handler stays attached after an abort wins, so a late rejection from
 * non-cooperative work is consumed rather than becoming unhandled.
 *
 * Invariant: the loop checks terminalError() immediately before entering, with
 * no await between, so the signal cannot already be aborted here and the
 * listener cannot miss an abort.
 */
function raceWithLoopAbort<T>(operation: () => Promise<T>, scope: LoopAbortScope): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;

    const finish = (settle: () => void): void => {
      if (settled) return;
      settled = true;
      scope.signal.removeEventListener("abort", onAbort);
      settle();
    };
    const onAbort = (): void => finish(() => reject(scope.terminalError()));

    scope.signal.addEventListener("abort", onAbort, { once: true });
    const work = operation();
    work.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    );
  });
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
  validateLoopBudgets(budgets, stepsPerIteration);
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
  let iterationInFlight = false;
  const abortScope = createLoopAbortScope(
    budgets.maxElapsedMs,
    startedAt,
    options.signal,
    () => iterationInFlight,
    () => observations.map((o) => o.summary),
  );

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

  try {
    for (let iteration = 1; iteration <= budgets.maxIterations; iteration++) {
      // ---- Perceive ------------------------------------------------------
      // State is the accumulated message history plus prior observations.
      // Budgets are checked BEFORE acting, never after the fact.
      const terminalBefore = abortScope.terminalError();
      if (terminalBefore !== undefined) {
        return finish({ transition: "stop-failure", reason: terminalBefore.message }, { error: terminalBefore });
      }
      if (toolCallCount >= budgets.maxToolCalls) {
        const error = new BudgetExhaustedError("maxToolCalls", `${toolCallCount}`, []);
        return finish({ transition: "stop-failure", reason: error.message }, { error });
      }

      // ---- Reason + Act ---------------------------------------------------
      let observation: Observation;
      try {
        iterationInFlight = true;
        const result = await raceWithLoopAbort(
          () =>
            generateText({
              model: options.model,
              ...(options.tools !== undefined ? { tools: options.tools } : {}),
              system: options.system,
              messages,
              stopWhen: stepCountIs(stepsPerIteration),
              maxRetries: 0, // retries are OUR decision, classified and bounded — not the SDK's hidden default
              abortSignal: abortScope.signal,
            }),
          abortScope,
        );
        iterationInFlight = false;

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
        iterationInFlight = false;
        // A terminal abort (deadline or caller cancellation) outranks whatever
        // the provider happened to throw while the signal landed.
        const error = abortScope.terminalError() ?? classifyError(raw);
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
      // Terminal aborts end the loop as stop-failure with their typed error —
      // they are never escalation fodder and never recovered silently.
      const terminalAfter = abortScope.terminalError();
      if (terminalAfter !== undefined) {
        return finish({ transition: "stop-failure", reason: terminalAfter.message }, { error: terminalAfter });
      }

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
      // Cancellation stays terminal even when it lands inside the policy
      // hook: never honor a decision made after the caller aborted.
      const terminalAfterDecide = abortScope.terminalError();
      if (terminalAfterDecide !== undefined) {
        return finish(
          { transition: "stop-failure", reason: terminalAfterDecide.message },
          { error: terminalAfterDecide },
        );
      }
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
  } finally {
    abortScope.dispose();
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

/**
 * Tool contracts: the foundation of agency.
 *
 * A tool is not a function with a description. It is a contract with:
 * - typed input/output schemas (validated at the trust boundary, in code);
 * - declared side-effect and idempotency properties (drive retry policy);
 * - an optional authorization gate (enforced in code, not in the prompt);
 * - an optional postcondition the caller verifies after execution;
 * - a timeout, because unbounded tool calls break loop budgets.
 *
 * `defineContractTool` wraps all of this around an AI SDK `tool()` so the
 * enforcement travels with the tool wherever it is used.
 */

import { tool, type Tool } from "ai";
import { z } from "zod";
import { classifyError } from "../errors/classify.js";
import { PolicyError, ReasoningError, ToolError } from "../errors/taxonomy.js";
import { newSpanId, newTraceId, nowIso, type Tracer } from "../trace/tracer.js";

export type SideEffectKind = "read-only" | "mutating" | "destructive";

export interface ToolContext {
  /** Identity of the agent invoking the tool, for authorization decisions. */
  readonly agentId: string;
  /** Scopes the agent is allowed to affect, e.g. ["tickets", "reports"]. */
  readonly writeScopes: readonly string[];
}

export interface ToolContract<I, O> {
  readonly name: string;
  /** Concrete, non-overlapping description: what it does AND when not to use it. */
  readonly description: string;
  readonly input: z.ZodType<I>;
  /** Optional output schema; when present, every result is validated before returning. */
  readonly output?: z.ZodType<O>;
  readonly sideEffect: SideEffectKind;
  /** True only if calling twice with the same input has the same effect as calling once. */
  readonly idempotent: boolean;
  /** Scope this tool writes to, when sideEffect !== "read-only". Checked against ToolContext. */
  readonly writeScope?: string;
  /** Additional domain-specific authorization, enforced in code. */
  readonly authorize?: (input: I, ctx: ToolContext) => boolean | Promise<boolean>;
  /**
   * Verifiable condition on (input, output). Return true, or a string
   * explaining the violation. A failed postcondition means the tool reported
   * success but the world does not match — treated as a reasoning error.
   */
  readonly postcondition?: (input: I, output: O) => true | string;
  readonly timeoutMs?: number;
  readonly execute: (input: I, ctx: ToolContext) => Promise<O>;
}

const DEFAULT_TIMEOUT_MS = 30_000;

function withTimeout<T>(promise: Promise<T>, ms: number, name: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new ToolError(`Tool "${name}" exceeded its ${ms}ms timeout.`, {
          retryable: true,
          sideEffect: "unknown",
          blastRadius: "local",
          code: "tool.timeout",
        }),
      );
    }, ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

export interface ContractToolOptions {
  readonly context: ToolContext;
  /** Optional trace sink; tool.call / tool.result / tool.error spans are emitted around execution. */
  readonly tracer?: Tracer;
  /** Correlate tool spans with an outer run; generated per call when omitted. */
  readonly traceId?: string;
}

/**
 * Build an AI SDK tool with the full contract enforced around `execute`.
 * The returned tool can be passed to `generateText` / `ToolLoopAgent` directly.
 */
export function defineContractTool<I, O>(
  contract: ToolContract<I, O>,
  options: ContractToolOptions,
): Tool<I, O> {
  const { context } = options;
  const timeoutMs = contract.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const guarded = async (rawInput: I): Promise<O> => {
    const traceId = options.traceId ?? newTraceId();
    const span = {
      trace_id: traceId,
      span_id: newSpanId(),
      parent_span_id: null,
      actor: context.agentId,
    };
    options.tracer?.emit({ ...span, timestamp: nowIso(), type: "tool.call", tool: contract.name, input: rawInput });
    const started = Date.now();

    // 1. Schema validation at the trust boundary. The AI SDK validates model
    //    output against inputSchema already; validating again here also covers
    //    direct programmatic calls that bypass the model.
    const parsed = contract.input.safeParse(rawInput);
    if (!parsed.success) {
      throw new ReasoningError(`Tool "${contract.name}" received invalid input.`, {
        retryable: false,
        sideEffect: "none",
        blastRadius: "local",
        code: "reasoning.tool_input_invalid",
        evidence: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
      });
    }
    const input = parsed.data;

    try {
      // 2. Authorization, in code. A prompt cannot enforce this.
      if (contract.sideEffect !== "read-only") {
        const scope = contract.writeScope ?? contract.name;
        if (!context.writeScopes.includes(scope)) {
          throw new PolicyError(
            `Agent "${context.agentId}" is not authorized for write scope "${scope}" required by tool "${contract.name}".`,
            {
              sideEffect: "none",
              blastRadius: "local",
              code: "policy.write_scope_denied",
              evidence: [`agentScopes=[${context.writeScopes.join(", ")}]`, `requiredScope=${scope}`],
            },
          );
        }
      }
      if (contract.authorize !== undefined && !(await contract.authorize(input, context))) {
        throw new PolicyError(`Authorization denied for tool "${contract.name}" by agent "${context.agentId}".`, {
          sideEffect: "none",
          blastRadius: "local",
          code: "policy.domain_authorization_denied",
        });
      }

      // 3. Execute with a hard timeout.
      const output = await withTimeout(contract.execute(input, context), timeoutMs, contract.name);

      // 4. Output schema validation: the tool must return what it promised.
      if (contract.output !== undefined) {
        const out = contract.output.safeParse(output);
        if (!out.success) {
          throw new ToolError(`Tool "${contract.name}" returned output violating its contract.`, {
            retryable: false,
            sideEffect: "unknown",
            blastRadius: "local",
            code: "tool.output_invalid",
            evidence: out.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
          });
        }
      }

      // 5. Postcondition: a successful transport response is not proof of effect.
      if (contract.postcondition !== undefined) {
        const verdict = contract.postcondition(input, output);
        if (verdict !== true) {
          throw new ReasoningError(`Tool "${contract.name}" postcondition failed: ${verdict}`, {
            retryable: false,
            sideEffect: "unknown",
            blastRadius: "workflow",
            code: "reasoning.postcondition_failed",
            evidence: [verdict],
          });
        }
      }

      options.tracer?.emit({ ...span, timestamp: nowIso(), type: "tool.result", tool: contract.name, durationMs: Date.now() - started });
      return output;
    } catch (raw) {
      const error = classifyError(raw);
      options.tracer?.emit({
        ...span,
        timestamp: nowIso(),
        type: "tool.error",
        tool: contract.name,
        code: error.code,
        category: error.category,
        retryable: error.retryable,
        durationMs: Date.now() - started,
      });
      throw error;
    }
  };

  // Type erasure at the SDK boundary: the AI SDK's Tool type uses conditional
  // types over INPUT/OUTPUT that cannot resolve against an open generic. We
  // build the tool with concrete `unknown` and restore the contract's types
  // on return. Runtime safety is unaffected — the guarded executor validates
  // input and output against the Zod schemas above.
  const defined = tool({
    description: contract.description,
    inputSchema: contract.input as z.ZodType<unknown>,
    execute: async (input: unknown): Promise<unknown> => guarded(input as I),
  });
  return defined as unknown as Tool<I, O>;
}

/** Readiness metadata a caller can inspect without executing the tool. */
export function contractSummary<I, O>(contract: ToolContract<I, O>): string {
  return [
    `${contract.name} [${contract.sideEffect}${contract.idempotent ? ", idempotent" : ", NOT idempotent"}]`,
    contract.description,
  ].join(" — ");
}

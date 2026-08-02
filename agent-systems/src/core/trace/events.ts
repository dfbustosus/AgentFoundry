/**
 * Trace events: the audit artifact for agentic runs.
 *
 * The architecture promises "every iteration is traceable" — this module makes
 * that literal. Every meaningful step (loop iteration, transition, tool call,
 * handoff, delegation, cost record) is emitted as a typed, schema-validated
 * span with correlation ids:
 *
 * - trace_id:        one per run/workflow (correlates every span);
 * - span_id:         unique per event;
 * - parent_span_id:  loop iterations hang under the run's root span.
 *
 * Spans are data, not vendor lock-in: a JSONL file per run is the default
 * sink, and the Tracer interface accepts any backend.
 */

import { z } from "zod";

const spanBase = {
  trace_id: z.string().min(1),
  span_id: z.string().min(1),
  parent_span_id: z.string().min(1).nullable(),
  /** ISO-8601 timestamp. */
  timestamp: z.iso.datetime(),
  /** Who emitted the span, e.g. "prao-loop", "researcher", "orchestrator". */
  actor: z.string().min(1),
};

export const traceEventSchema = z.discriminatedUnion("type", [
  z.object({
    ...spanBase,
    type: z.literal("loop.iteration"),
    iteration: z.number().int().positive(),
    kind: z.enum(["success", "partial", "uncertain", "failure"]),
    toolCalls: z.array(z.string()),
    finishReason: z.string(),
  }),
  z.object({
    ...spanBase,
    type: z.literal("loop.transition"),
    transition: z.enum(["stop-success", "iterate", "recover", "clarify", "escalate", "stop-failure"]),
    reason: z.string(),
    iterations: z.number().int().nonnegative(),
    toolCallCount: z.number().int().nonnegative(),
  }),
  z.object({
    ...spanBase,
    type: z.literal("tool.call"),
    tool: z.string(),
    /** Tool input as invoked. Sinks decide retention; do not log secrets here. */
    input: z.unknown(),
  }),
  z.object({
    ...spanBase,
    type: z.literal("tool.result"),
    tool: z.string(),
    durationMs: z.number().nonnegative(),
  }),
  z.object({
    ...spanBase,
    type: z.literal("tool.error"),
    tool: z.string(),
    code: z.string(),
    category: z.enum(["tool", "reasoning", "environment", "policy"]),
    retryable: z.boolean(),
    durationMs: z.number().nonnegative(),
  }),
  z.object({
    ...spanBase,
    type: z.literal("handoff.sent"),
    message_id: z.string(),
    intent: z.enum(["delegate", "result", "question", "escalation", "cancellation"]),
    recipient: z.string(),
    task_id: z.string(),
  }),
  z.object({
    ...spanBase,
    type: z.literal("handoff.received"),
    message_id: z.string(),
    accepted: z.boolean(),
  }),
  z.object({
    ...spanBase,
    type: z.literal("orchestrator.delegate"),
    agent: z.string(),
    task_id: z.string(),
    authority: z.enum(["read-only", "propose", "modify", "execute"]),
  }),
  z.object({
    ...spanBase,
    type: z.literal("cost.record"),
    agentId: z.string(),
    model: z.string(),
    inputTokens: z.number().nonnegative(),
    outputTokens: z.number().nonnegative(),
  }),
]);

export type TraceEvent = z.infer<typeof traceEventSchema>;

/** Validate an untrusted line (e.g. read back from a JSONL sink). */
export function parseTraceEvent(raw: unknown): TraceEvent {
  return traceEventSchema.parse(raw);
}

/**
 * Typed agent-to-agent handoff envelope.
 *
 * Free-form narrative is supporting context, never authoritative state.
 * Every message between agents is validated against this schema — a malformed
 * envelope is rejected, and ownership or authority is NEVER inferred from
 * silence.
 *
 * Identity model for continuity across agents and failures:
 * - message_id:     unique per message (dedup key);
 * - correlation_id: the workflow this message belongs to;
 * - causation_id:   the message that caused this one (audit chain);
 * - task_id:        stable id of the task contract being worked.
 */

import { z } from "zod";

export const HANDOFF_SCHEMA_VERSION = "1.0" as const;

export const handoffIntentSchema = z.enum(["delegate", "result", "question", "escalation", "cancellation"]);
export type HandoffIntent = z.infer<typeof handoffIntentSchema>;

export const handoffStatusSchema = z.enum(["ready", "partial", "blocked", "completed", "failed"]);
export type HandoffStatus = z.infer<typeof handoffStatusSchema>;

export const authoritySchema = z.enum(["read-only", "propose", "modify", "execute"]);
export type Authority = z.infer<typeof authoritySchema>;

export const handoffEnvelopeSchema = z
  .object({
    schema_version: z.literal(HANDOFF_SCHEMA_VERSION),
    message_id: z.string().min(1),
    correlation_id: z.string().min(1),
    causation_id: z.string().min(1).nullable(),
    task_id: z.string().min(1),
    sender: z.string().min(1),
    recipient: z.string().min(1),
    intent: handoffIntentSchema,
    objective: z.string().min(1),
    status: handoffStatusSchema,
    authority: authoritySchema,
    inputs: z.object({
      facts: z.array(z.string()),
      assumptions: z.array(z.string()),
      artifact_refs: z.array(z.string()),
    }),
    constraints: z.array(z.string()),
    acceptance_checks: z.array(z.string()),
    result: z
      .object({
        summary: z.string(),
        evidence: z.array(z.string()),
        artifact_refs: z.array(z.string()),
        verification: z.array(z.string()),
      })
      .nullable(),
    risks: z.array(z.string()),
    open_questions: z.array(z.string()),
    recommended_next_action: z.string(),
    expires_at: z.iso.datetime().nullable(),
  })
  .strict();

export type HandoffEnvelope = z.infer<typeof handoffEnvelopeSchema>;

export interface EnvelopeParts {
  readonly message_id: string;
  readonly correlation_id: string;
  readonly causation_id: string | null;
  readonly task_id: string;
  readonly sender: string;
  readonly recipient: string;
  readonly intent: HandoffIntent;
  readonly objective: string;
  readonly status: HandoffStatus;
  readonly authority: Authority;
  readonly inputs?: Partial<HandoffEnvelope["inputs"]>;
  readonly constraints?: readonly string[];
  readonly acceptance_checks?: readonly string[];
  readonly result?: HandoffEnvelope["result"];
  readonly risks?: readonly string[];
  readonly open_questions?: readonly string[];
  readonly recommended_next_action?: string;
  readonly expires_at?: string | null;
}

/** Construct an envelope with safe defaults, validated before returning. */
export function createEnvelope(parts: EnvelopeParts): HandoffEnvelope {
  return handoffEnvelopeSchema.parse({
    schema_version: HANDOFF_SCHEMA_VERSION,
    message_id: parts.message_id,
    correlation_id: parts.correlation_id,
    causation_id: parts.causation_id,
    task_id: parts.task_id,
    sender: parts.sender,
    recipient: parts.recipient,
    intent: parts.intent,
    objective: parts.objective,
    status: parts.status,
    authority: parts.authority,
    inputs: {
      facts: parts.inputs?.facts ?? [],
      assumptions: parts.inputs?.assumptions ?? [],
      artifact_refs: parts.inputs?.artifact_refs ?? [],
    },
    constraints: parts.constraints ?? [],
    acceptance_checks: parts.acceptance_checks ?? [],
    result: parts.result ?? null,
    risks: parts.risks ?? [],
    open_questions: parts.open_questions ?? [],
    recommended_next_action: parts.recommended_next_action ?? "",
    expires_at: parts.expires_at ?? null,
  });
}

/** Validate an untrusted value as an envelope. Returns issues instead of throwing. */
export function validateEnvelope(raw: unknown):
  | { ok: true; envelope: HandoffEnvelope }
  | { ok: false; issues: readonly string[] } {
  const parsed = handoffEnvelopeSchema.safeParse(raw);
  if (parsed.success) return { ok: true, envelope: parsed.data };
  return { ok: false, issues: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) };
}

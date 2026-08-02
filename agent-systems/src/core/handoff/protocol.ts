/**
 * Handoff protocol over a message bus.
 *
 * The sequence that preserves continuity and authority:
 * 1. sender freezes/versions the artifact and sends a validated envelope;
 * 2. recipient validates schema, freshness (expires_at), and dedup (message_id);
 * 3. recipient explicitly accepts or rejects with the specific mismatch —
 *    silence is never acceptance;
 * 4. recipient works idempotently and replies with a "result" envelope whose
 *    causation_id points at the delegation message;
 * 5. sender/orchestrator verifies evidence and closes, reworks, or escalates.
 *
 * The bus is in-memory by design (single-process orchestration, spec A4).
 * The interface is small enough to swap for a durable transport.
 */

import { ReasoningError } from "../errors/taxonomy.js";
import { validateEnvelope, type HandoffEnvelope } from "./envelope.js";

export type Ack =
  | { readonly accepted: true; readonly envelope: HandoffEnvelope }
  | { readonly accepted: false; readonly reasons: readonly string[] };

export interface MessageBus {
  send(envelope: HandoffEnvelope): void;
  /** Drain messages addressed to `recipient`, oldest first. */
  drain(recipient: string): HandoffEnvelope[];
  /** Peek without consuming (for orchestrator inspection). */
  peek(recipient: string): readonly HandoffEnvelope[];
  /** True if a message with this id was already sent (dedup). */
  seen(messageId: string): boolean;
}

export class InMemoryBus implements MessageBus {
  private readonly queue = new Map<string, HandoffEnvelope[]>();
  private readonly ids = new Set<string>();

  send(envelope: HandoffEnvelope): void {
    if (this.ids.has(envelope.message_id)) {
      throw new ReasoningError(`Duplicate message_id "${envelope.message_id}" rejected.`, {
        retryable: false,
        sideEffect: "none",
        blastRadius: "local",
        code: "reasoning.duplicate_message",
        evidence: ["Message ids are dedup keys; resend with a new id and the same causation_id."],
      });
    }
    this.ids.add(envelope.message_id);
    const pending = this.queue.get(envelope.recipient) ?? [];
    pending.push(envelope);
    this.queue.set(envelope.recipient, pending);
  }

  drain(recipient: string): HandoffEnvelope[] {
    const pending = this.queue.get(recipient) ?? [];
    this.queue.set(recipient, []);
    return pending;
  }

  peek(recipient: string): readonly HandoffEnvelope[] {
    return this.queue.get(recipient) ?? [];
  }

  seen(messageId: string): boolean {
    return this.ids.has(messageId);
  }
}

/**
 * Receive-side validation. Checks, in order:
 * schema → addressing → freshness → dedup → delegation shape.
 */
export function receiveHandoff(bus: MessageBus, recipient: string, raw: unknown): Ack {
  const parsed = validateEnvelope(raw);
  if (!parsed.ok) return { accepted: false, reasons: parsed.issues };
  const envelope = parsed.envelope;

  const reasons: string[] = [];
  if (envelope.recipient !== recipient) {
    reasons.push(`addressed to "${envelope.recipient}", not "${recipient}"`);
  }
  if (envelope.expires_at !== null && Date.parse(envelope.expires_at) <= Date.now()) {
    reasons.push(`expired at ${envelope.expires_at}`);
  }
  if (bus.seen(envelope.message_id)) {
    reasons.push(`message_id "${envelope.message_id}" already processed (replay rejected)`);
  }
  if (envelope.intent === "delegate" && envelope.authority === "read-only" && envelope.status === "ready") {
    // legal, but worth no-op guarding: a ready delegation with read-only authority
    // can only inspect — callers usually mean "propose".
  }
  if (reasons.length > 0) return { accepted: false, reasons };

  bus.send(envelope);
  return { accepted: true, envelope };
}

/**
 * Build the reply envelope that closes a handoff. causation_id links the
 * result to the delegation, giving the orchestrator a complete audit chain.
 */
export function replyTo(
  delegation: HandoffEnvelope,
  parts: {
    message_id: string;
    status: HandoffEnvelope["status"];
    summary: string;
    evidence: readonly string[];
    artifact_refs?: readonly string[];
    verification?: readonly string[];
    risks?: readonly string[];
    open_questions?: readonly string[];
    recommended_next_action: string;
  },
): HandoffEnvelope {
  return {
    ...delegation,
    message_id: parts.message_id,
    causation_id: delegation.message_id,
    sender: delegation.recipient,
    recipient: delegation.sender,
    intent: parts.status === "blocked" ? "escalation" : "result",
    status: parts.status,
    result: {
      summary: parts.summary,
      evidence: [...parts.evidence],
      artifact_refs: [...(parts.artifact_refs ?? [])],
      verification: [...(parts.verification ?? [])],
    },
    risks: [...(parts.risks ?? [])],
    open_questions: [...(parts.open_questions ?? [])],
    recommended_next_action: parts.recommended_next_action,
    expires_at: null,
  };
}

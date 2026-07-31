import { describe, expect, it } from "vitest";
import { createEnvelope, validateEnvelope } from "../src/core/handoff/envelope.js";
import { InMemoryBus, receiveHandoff, replyTo } from "../src/core/handoff/protocol.js";

function makeEnvelope(overrides: Partial<Parameters<typeof createEnvelope>[0]> = {}) {
  return createEnvelope({
    message_id: "m-1",
    correlation_id: "wf-1",
    causation_id: null,
    task_id: "task-1",
    sender: "orchestrator",
    recipient: "researcher",
    intent: "delegate",
    objective: "Find the answer.",
    status: "ready",
    authority: "propose",
    ...overrides,
  });
}

describe("handoff envelope", () => {
  it("round-trips a valid envelope through schema validation", () => {
    const envelope = makeEnvelope();
    const result = validateEnvelope(JSON.parse(JSON.stringify(envelope)));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.envelope.message_id).toBe("m-1");
  });

  it("rejects malformed envelopes with precise issues", () => {
    const bad = { ...makeEnvelope(), correlation_id: "", intent: "teleport" };
    const result = validateEnvelope(bad);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((i) => i.includes("correlation_id"))).toBe(true);
      expect(result.issues.some((i) => i.includes("intent"))).toBe(true);
    }
  });

  it("rejects unknown fields (strict schema)", () => {
    const result = validateEnvelope({ ...makeEnvelope(), smuggled: true });
    expect(result.ok).toBe(false);
  });
});

describe("handoff protocol", () => {
  it("accepts a valid, fresh, correctly-addressed envelope", () => {
    const bus = new InMemoryBus();
    const ack = receiveHandoff(bus, "researcher", makeEnvelope());
    expect(ack.accepted).toBe(true);
    expect(bus.drain("researcher")).toHaveLength(1);
  });

  it("rejects misaddressed envelopes", () => {
    const bus = new InMemoryBus();
    const ack = receiveHandoff(bus, "someone-else", makeEnvelope());
    expect(ack.accepted).toBe(false);
    if (!ack.accepted) expect(ack.reasons[0]).toContain("someone-else");
  });

  it("rejects expired envelopes", () => {
    const bus = new InMemoryBus();
    const ack = receiveHandoff(bus, "researcher", makeEnvelope({ expires_at: "2000-01-01T00:00:00Z" }));
    expect(ack.accepted).toBe(false);
    if (!ack.accepted) expect(ack.reasons.some((r) => r.includes("expired"))).toBe(true);
  });

  it("rejects replayed message ids — silence is never acceptance", () => {
    const bus = new InMemoryBus();
    const envelope = makeEnvelope();
    bus.send(envelope);
    const ack = receiveHandoff(bus, "researcher", envelope);
    expect(ack.accepted).toBe(false);
    if (!ack.accepted) expect(ack.reasons.some((r) => r.includes("replay"))).toBe(true);
  });

  it("replyTo builds a result envelope linked by causation_id", () => {
    const delegation = makeEnvelope();
    const reply = replyTo(delegation, {
      message_id: "m-2",
      status: "completed",
      summary: "Found it.",
      evidence: ["source A", "test run green"],
      recommended_next_action: "Close the task.",
    });
    expect(reply.causation_id).toBe("m-1");
    expect(reply.sender).toBe("researcher");
    expect(reply.recipient).toBe("orchestrator");
    expect(reply.intent).toBe("result");
    expect(validateEnvelope(reply).ok).toBe(true);
  });

  it("blocked replies become escalations", () => {
    const reply = replyTo(makeEnvelope(), {
      message_id: "m-3",
      status: "blocked",
      summary: "Cannot proceed.",
      evidence: [],
      recommended_next_action: "Escalate to a human.",
    });
    expect(reply.intent).toBe("escalation");
  });
});

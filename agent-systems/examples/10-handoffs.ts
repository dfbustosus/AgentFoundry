/**
 * Example 10 — Agent-to-agent message schemas and handoff protocols.
 *
 * Topics: message schemas · handoff protocols · continuity across agents.
 *
 * A full delegation→result cycle over a bus, with the failure modes that make
 * handoffs unsafe when messages are free-form text: malformed envelopes,
 * replays, expiry. Continuity lives in correlation_id/causation_id chains.
 *
 * Run: npm run example -- examples/10-handoffs.ts  (no API key needed)
 */

import { randomUUID } from "node:crypto";
import { createEnvelope, InMemoryBus, receiveHandoff, replyTo, validateEnvelope } from "../src/index.js";
import { main, printJson, printSection } from "./lib/shared.js";

await main(async () => {
  printSection("10 — Typed handoffs with continuity guarantees");
  const bus = new InMemoryBus();

  // 1. Orchestrator delegates with a validated envelope.
  const delegation = createEnvelope({
    message_id: randomUUID(),
    correlation_id: "wf-demo",
    causation_id: null,
    task_id: "task-research",
    sender: "orchestrator",
    recipient: "researcher",
    intent: "delegate",
    objective: "Summarize retry best practices",
    status: "ready",
    authority: "propose",
    inputs: { facts: ["Audience: backend engineers"], assumptions: [], artifact_refs: [] },
    constraints: ["Max 200 words"],
    acceptance_checks: ["Covers backoff", "Covers idempotency"],
    recommended_next_action: "Execute and return a result envelope.",
  });
  console.log(`\nDelegation accepted: ${receiveHandoff(bus, "researcher", delegation).accepted}`);

  // 2. Researcher replies; causation_id links back to the delegation.
  const reply = replyTo(delegation, {
    message_id: randomUUID(),
    status: "completed",
    summary: "Retries need classification, backoff with jitter, idempotency keys, and hard budgets.",
    evidence: ["retry.ts implementation", "reliability tests: 12 green"],
    verification: ["Covers backoff: yes", "Covers idempotency: yes"],
    recommended_next_action: "Orchestrator verifies evidence and closes the task.",
  });
  console.log(`Reply accepted: ${receiveHandoff(bus, "orchestrator", reply).accepted}`);

  // 3. The failure modes, demonstrated:
  console.log("\nMalformed envelope rejected:");
  const bad = validateEnvelope({ sender: "x", intent: "trust-me" });
  if (!bad.ok) console.log(`  ${bad.issues.length} schema issues, e.g. "${bad.issues[0]}"`);

  console.log("\nReplay rejected (silence is never acceptance):");
  const replay = receiveHandoff(bus, "researcher", delegation);
  if (!replay.accepted) console.log(`  blocked: ${replay.reasons[0]}`);

  printJson("Audit chain", {
    delegation: { message_id: delegation.message_id.slice(0, 8), causation_id: delegation.causation_id },
    reply: { message_id: reply.message_id.slice(0, 8), causation_id: reply.causation_id?.slice(0, 8) },
  });
});

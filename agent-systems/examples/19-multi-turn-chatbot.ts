/**
 * Example 19 — Multi-turn chatbot: session continuity across turns.
 *
 * Topics: agents/workflows/chatbots · in-context state vs. external memory ·
 * session continuity across turns (complementing example 11, which covered
 * continuity across FAILURES).
 *
 * The pattern being taught:
 * - the message history is the IN-CONTEXT working state — bounded, per turn;
 * - the MemoryStore is the EXTERNAL session record — durable across turns
 *   and processes;
 * - a turn = load history → run one PRAO loop → persist the new history.
 *   "Resume" is then free: any process can continue the conversation.
 *
 * Run: npm run example -- examples/19-multi-turn-chatbot.ts
 * (Works offline with AGENT_SYSTEMS_MOCK=1.)
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelMessage } from "ai";
import { z } from "zod";
import { defineContractTool, FileStore, runPraoLoop } from "../src/index.js";
import { main, model, printSection } from "./lib/shared.js";

const SESSION_KEY = "chat-history";

async function runChatTurn(options: {
  store: FileStore;
  sessionId: string;
  userUtterance: string;
  tools: Parameters<typeof runPraoLoop>[0]["tools"];
}): Promise<{ answer: string; history: readonly ModelMessage[] }> {
  // 1. Load the external session record (empty on the first turn).
  const history = (await options.store.get<ModelMessage[]>("sessions", `${options.sessionId}:${SESSION_KEY}`)) ?? [];

  // 2. Run one bounded PRAO turn with the history as in-context state.
  const result = await runPraoLoop({
    model: model(),
    tools: options.tools,
    system: "You are a concise travel assistant. Remember what the user told you earlier in this conversation.",
    goal: options.userUtterance,
    initialMessages: history,
    budgets: { maxIterations: 3, maxToolCalls: 3 },
  });

  // 3. Persist the new history — the durable record the next turn resumes from.
  await options.store.set("sessions", `${options.sessionId}:${SESSION_KEY}`, result.messages);
  return { answer: result.text, history: result.messages };
}

await main(async () => {
  printSection("19 — Multi-turn chatbot with a durable session record");
  const dir = await mkdtemp(join(tmpdir(), "agent-chat-"));

  try {
    const store = new FileStore(dir);
    const timezoneTool = defineContractTool(
      {
        name: "get_timezone",
        description: "Gets the current UTC offset for a city. Only for timezone questions.",
        input: z.object({ city: z.string() }),
        output: z.object({ city: z.string(), utcOffset: z.string() }),
        sideEffect: "read-only",
        idempotent: true,
        execute: async ({ city }) => ({ city, utcOffset: "UTC-5" }),
      },
      { context: { agentId: "chatbot", writeScopes: [] } },
    );

    const sessionId = "user-123";
    const turns = [
      "Hi! I'm flying to Bogotá next week.",
      "What's the UTC offset there?",
      "Based on what I told you, which city am I visiting?",
    ];

    for (const [index, utterance] of turns.entries()) {
      const { answer, history } = await runChatTurn({
        store,
        sessionId,
        userUtterance: utterance,
        tools: { get_timezone: timezoneTool },
      });
      console.log(`\nTurn ${index + 1}`);
      console.log(`  user:  ${utterance}`);
      console.log(`  agent: ${answer.slice(0, 120)}`);
      console.log(`  [state] history now ${history.length} messages (persisted to FileStore)`);
    }

    // Resume proof: a brand-new reader of the same store sees the full conversation.
    const resumed = await new FileStore(dir).get<ModelMessage[]>("sessions", `${sessionId}:${SESSION_KEY}`);
    console.log(`\nResume proof: a fresh process loads ${resumed?.length ?? 0} messages of context —`);
    console.log("turn 3's answer depends on turn 1, and no process had to stay alive for it.");
    console.log(
      "\nThe split that matters: the history is the working state (bounded, in-context);\n" +
        "the FileStore is the session record (durable). Conversation history is context,\n" +
        "not a database — but it IS checkpointed like one.",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

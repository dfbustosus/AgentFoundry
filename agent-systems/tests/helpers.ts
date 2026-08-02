/**
 * Test helpers: mocked language models. No API key, no network — the whole
 * suite runs offline against deterministic model behavior.
 */

import { MockLanguageModelV4 } from "ai/test";
import type { LanguageModelV4GenerateResult } from "@ai-sdk/provider";

export function textResult(
  text: string,
  finish: "stop" | "tool-calls" | "length" = "stop",
): LanguageModelV4GenerateResult {
  return {
    content: [{ type: "text", text }],
    finishReason: { unified: finish, raw: finish },
    usage: {
      inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: 5, text: 5, reasoning: undefined },
    },
    warnings: [],
  };
}

export function toolCallResult(toolName: string, input: unknown): LanguageModelV4GenerateResult {
  return {
    content: [{ type: "tool-call", toolCallId: `call-${toolName}-1`, toolName, input: JSON.stringify(input) }],
    finishReason: { unified: "tool-calls", raw: "tool-calls" },
    usage: {
      inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: 5, text: 5, reasoning: undefined },
    },
    warnings: [],
  };
}

/** A model that returns each queued result in order, then repeats the last. */
export function scriptedModel(results: LanguageModelV4GenerateResult[]): MockLanguageModelV4 {
  let index = 0;
  return new MockLanguageModelV4({
    doGenerate: async () => {
      const result = results[Math.min(index, results.length - 1)];
      index += 1;
      if (result === undefined) throw new Error("scriptedModel: no results queued");
      return result;
    },
  });
}

/** A model that always throws the given error. */
export function failingModel(error: () => unknown): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doGenerate: async () => {
      throw error();
    },
  });
}

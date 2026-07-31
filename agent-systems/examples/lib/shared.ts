/**
 * Shared helpers for the runnable examples.
 *
 * Examples default to a live provider key (spec C3). For offline verification
 * and CI, set AGENT_SYSTEMS_MOCK=1 to substitute a deterministic mock model —
 * the same machinery runs, no network or key required. This is how the
 * example smoke tests (tests/examples-smoke.test.ts) close residual risk R3.
 */

import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import type { LanguageModelV4CallOptions, LanguageModelV4GenerateResult } from "@ai-sdk/provider";

export function requireApiKey(): void {
  if (process.env["OPENAI_API_KEY"] === undefined || process.env["OPENAI_API_KEY"] === "") {
    console.error(
      "This example needs a live model. Set OPENAI_API_KEY (see .env.example), " +
        "or run offline with AGENT_SYSTEMS_MOCK=1.\n" +
        "The test suite (npm test) runs fully offline with a mocked model.",
    );
    process.exit(1);
  }
}

/** Minimal JSON-Schema instantiator: produces a structurally valid value for object generation. */
function instantiateSchema(schema: unknown): unknown {
  if (typeof schema !== "object" || schema === null) return null;
  const s = schema as Record<string, unknown>;
  if (Array.isArray(s["enum"])) return (s["enum"] as unknown[])[0];
  if ("const" in s) return s["const"];
  if (Array.isArray(s["anyOf"])) return instantiateSchema((s["anyOf"] as unknown[])[0]);
  if (Array.isArray(s["oneOf"])) return instantiateSchema((s["oneOf"] as unknown[])[0]);
  switch (s["type"]) {
    case "string":
      return "mock";
    case "number":
    case "integer":
      return 1;
    case "boolean":
      return true;
    case "array": {
      const items = s["items"] as Record<string, unknown> | undefined;
      // Object arrays get one instantiated item (schemas like `subtasks` often
      // have min(1)); primitive arrays stay empty — filling e.g. `dependsOn`
      // with placeholder strings can create self-referential, invalid graphs.
      const isObjectItems = items?.["type"] === "object" || Array.isArray(items?.["anyOf"]) || Array.isArray(items?.["oneOf"]);
      return isObjectItems ? [instantiateSchema(items)] : [];
    }
    case "object": {
      const properties = (s["properties"] as Record<string, unknown> | undefined) ?? {};
      const required = new Set((s["required"] as string[] | undefined) ?? Object.keys(properties));
      const out: Record<string, unknown> = {};
      for (const key of required) {
        if (key in properties) out[key] = instantiateSchema(properties[key]);
      }
      return out;
    }
    default:
      return null;
  }
}

function mockResult(options: LanguageModelV4CallOptions): LanguageModelV4GenerateResult {
  const responseFormat = (options as { responseFormat?: { type?: string; schema?: unknown } }).responseFormat;
  const text =
    responseFormat?.type === "json" && responseFormat.schema !== undefined
      ? JSON.stringify(instantiateSchema(responseFormat.schema))
      : "Mock answer (offline demonstration).";
  return {
    content: [{ type: "text", text }],
    finishReason: { unified: "stop", raw: "stop" },
    usage: {
      inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: 5, text: 5, reasoning: undefined },
    },
    warnings: [],
  };
}

export function model(): LanguageModel {
  if (process.env["AGENT_SYSTEMS_MOCK"] === "1") {
    return new MockLanguageModelV4({ doGenerate: async (options) => mockResult(options) });
  }
  requireApiKey();
  const openai = createOpenAI({ apiKey: process.env["OPENAI_API_KEY"] });
  return openai(process.env["AGENT_SYSTEMS_MODEL"] ?? "gpt-4o-mini");
}

export function printSection(title: string): void {
  console.log(`\n${"=".repeat(64)}\n${title}\n${"=".repeat(64)}`);
}

export function printJson(label: string, value: unknown): void {
  console.log(`\n--- ${label} ---`);
  console.log(JSON.stringify(value, null, 2));
}

export async function main(run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch (err) {
    console.error("\nExample failed:");
    console.error(err instanceof Error ? `${err.name}: ${err.message}` : err);
    process.exit(1);
  }
}

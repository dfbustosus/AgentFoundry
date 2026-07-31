import { describe, expect, it } from "vitest";
import type { Tool } from "ai";
import { z } from "zod";
import { defineContractTool, type ToolContext, type ToolContract } from "../src/core/tools/contract.js";

const ctx = (overrides: Partial<ToolContext> = {}): ToolContext => ({
  agentId: "agent-1",
  writeScopes: ["tickets"],
  ...overrides,
});

type DoubleIn = { n: number };
type DoubleOut = { result: number };

function makeTool(overrides: Partial<ToolContract<DoubleIn, DoubleOut>> = {}) {
  return defineContractTool<DoubleIn, DoubleOut>(
    {
      name: "double",
      description: "Doubles a number. Do not use for anything else.",
      input: z.object({ n: z.number() }),
      output: z.object({ result: z.number() }),
      sideEffect: "read-only",
      idempotent: true,
      execute: async ({ n }) => ({ result: n * 2 }),
      ...overrides,
    },
    { context: ctx() },
  );
}

/** Execute a contract tool directly (bypasses the model, exercises the guards). */
async function exec<I, O>(tool: Tool<I, O>, input: unknown): Promise<unknown> {
  const execute = (tool as { execute?: (input: unknown, options: unknown) => Promise<unknown> }).execute;
  if (execute === undefined) throw new Error("tool has no execute");
  return execute(input, { toolCallId: "t", messages: [] });
}

describe("defineContractTool", () => {
  it("executes valid input and returns contract-conformant output", async () => {
    expect(await exec(makeTool(), { n: 21 })).toEqual({ result: 42 });
  });

  it("rejects invalid input as a reasoning error before executing", async () => {
    let executed = false;
    const tool = makeTool({
      execute: async ({ n }) => {
        executed = true;
        return { result: n * 2 };
      },
    });
    await expect(exec(tool, { n: "NaN" })).rejects.toMatchObject({ code: "reasoning.tool_input_invalid" });
    expect(executed).toBe(false);
  });

  it("blocks write tools outside the agent's write scopes — in code, not by prompt", async () => {
    const tool = defineContractTool(
      {
        name: "close_ticket",
        description: "Closes a support ticket.",
        input: z.object({ id: z.string() }),
        sideEffect: "mutating",
        idempotent: true,
        writeScope: "tickets",
        execute: async ({ id }) => ({ closed: id }),
      },
      { context: ctx({ writeScopes: [] }) },
    );
    await expect(exec(tool, { id: "T-1" })).rejects.toMatchObject({
      category: "policy",
      code: "policy.write_scope_denied",
      retryable: false,
    });
  });

  it("enforces domain authorization gates", async () => {
    const tool = makeTool({
      sideEffect: "mutating",
      writeScope: "tickets",
      authorize: async () => false,
    });
    await expect(exec(tool, { n: 1 })).rejects.toMatchObject({ code: "policy.domain_authorization_denied" });
  });

  it("rejects output that violates the output schema", async () => {
    const tool = makeTool({
      // Deliberately break the contract to prove the guard works.
      execute: async () => ({ result: "not-a-number" }) as never,
    });
    await expect(exec(tool, { n: 1 })).rejects.toMatchObject({ code: "tool.output_invalid" });
  });

  it("fails the postcondition check as a reasoning error with evidence", async () => {
    const tool = makeTool({
      execute: async ({ n }) => ({ result: n * 3 }), // wrong on purpose
      postcondition: (input, output) => output.result === input.n * 2 || `expected ${input.n * 2}, got ${output.result}`,
    });
    await expect(exec(tool, { n: 2 })).rejects.toMatchObject({
      code: "reasoning.postcondition_failed",
      evidence: ["expected 4, got 6"],
    });
  });

  it("times out unbounded tool executions", async () => {
    const tool = makeTool({
      timeoutMs: 25,
      execute: async () => {
        await new Promise((r) => setTimeout(r, 500));
        return { result: 0 };
      },
    });
    await expect(exec(tool, { n: 1 })).rejects.toMatchObject({ code: "tool.timeout", retryable: true });
  }, 5_000);
});

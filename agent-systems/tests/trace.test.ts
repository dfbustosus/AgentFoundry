import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { runPraoLoop } from "../src/core/loop/prao.js";
import { defineContractTool } from "../src/core/tools/contract.js";
import { parseTraceEvent, type TraceEvent } from "../src/core/trace/events.js";
import { ConsoleTracer, JsonlTracer, NoopTracer } from "../src/core/trace/tracer.js";
import { scriptedModel, textResult } from "./helpers.js";

function collectTracer(): { tracer: { emit(e: TraceEvent): void }; events: TraceEvent[] } {
  const events: TraceEvent[] = [];
  return { tracer: { emit: (e) => events.push(e) }, events };
}

describe("trace events", () => {
  it("validates a well-formed event and rejects malformed ones", () => {
    const good: TraceEvent = {
      trace_id: "t-1",
      span_id: "s-1",
      parent_span_id: null,
      timestamp: new Date().toISOString(),
      actor: "tester",
      type: "loop.transition",
      transition: "stop-success",
      reason: "done",
      iterations: 1,
      toolCallCount: 0,
    };
    expect(parseTraceEvent(JSON.parse(JSON.stringify(good)))).toMatchObject({ type: "loop.transition" });
    expect(() => parseTraceEvent({ type: "loop.transition" })).toThrowError();
    expect(() => parseTraceEvent({ ...good, type: "unknown.type" })).toThrowError();
  });
});

describe("JsonlTracer", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "trace-test-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("round-trips spans through a JSONL file with schema validation", async () => {
    const path = join(dir, "run.jsonl");
    const tracer = new JsonlTracer(path);
    tracer.emit({
      trace_id: "t-1",
      span_id: "s-1",
      parent_span_id: null,
      timestamp: new Date().toISOString(),
      actor: "tester",
      type: "cost.record",
      agentId: "a",
      model: "m",
      inputTokens: 1,
      outputTokens: 2,
    });
    await tracer.flush();
    const spans = await JsonlTracer.readAll(path);
    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({ type: "cost.record", outputTokens: 2 });
  });

  it("fails loudly on corrupt lines instead of skipping them", async () => {
    const path = join(dir, "corrupt.jsonl");
    await writeFile(path, '{"not":"a span"}\n', "utf8");
    await expect(JsonlTracer.readAll(path)).rejects.toThrowError();
  });
});

describe("runPraoLoop tracing", () => {
  it("emits iteration spans under a root transition span, all sharing one trace_id", async () => {
    const { tracer, events } = collectTracer();
    const result = await runPraoLoop({
      model: scriptedModel([textResult("traced answer")]),
      system: "s",
      goal: "g",
      tracer,
    });
    const kinds = events.map((e) => e.type);
    expect(kinds).toEqual(["loop.iteration", "loop.transition"]);
    expect(new Set(events.map((e) => e.trace_id)).size).toBe(1);
    expect(events[0]?.trace_id).toBe(result.traceId);
    const transition = events.find((e) => e.type === "loop.transition");
    expect(transition).toMatchObject({ transition: "stop-success", iterations: 1 });
    // iteration span hangs under the transition's root span
    const iteration = events.find((e) => e.type === "loop.iteration");
    expect(iteration?.parent_span_id).toBe(transition?.span_id);
  });

  it("emits nothing extra when no tracer is provided (noop path stays clean)", async () => {
    const result = await runPraoLoop({
      model: scriptedModel([textResult("plain")]),
      system: "s",
      goal: "g",
    });
    expect(result.traceId.length).toBeGreaterThan(0);
  });

  it("NoopTracer and ConsoleTracer are valid sinks", () => {
    const noop = new NoopTracer();
    expect(() =>
      noop.emit({
        trace_id: "t",
        span_id: "s",
        parent_span_id: null,
        timestamp: new Date().toISOString(),
        actor: "a",
        type: "cost.record",
        agentId: "a",
        model: "m",
        inputTokens: 0,
        outputTokens: 0,
      }),
    ).not.toThrow();
    const lines: string[] = [];
    const cons = new ConsoleTracer((l) => lines.push(l));
    cons.emit({
      trace_id: "t",
      span_id: "s",
      parent_span_id: null,
      timestamp: new Date().toISOString(),
      actor: "a",
      type: "cost.record",
      agentId: "a",
      model: "m",
      inputTokens: 0,
      outputTokens: 0,
    });
    expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({ type: "cost.record" });
  });
});

describe("tool contract tracing", () => {
  const makeTool = (tracer: { emit(e: TraceEvent): void }, shouldFail = false) =>
    defineContractTool(
      {
        name: "probe",
        description: "test tool",
        input: z.object({ n: z.number() }),
        sideEffect: "read-only",
        idempotent: true,
        execute: async ({ n }) => {
          if (shouldFail) throw new Error("kaboom");
          return { n };
        },
      },
      { context: { agentId: "agent-1", writeScopes: [] }, tracer },
    );

  const exec = async (tool: unknown, input: unknown): Promise<unknown> => {
    const execute = (tool as { execute?: (i: unknown, o: unknown) => Promise<unknown> }).execute;
    if (execute === undefined) throw new Error("no execute");
    return execute(input, { toolCallId: "t", messages: [] });
  };

  it("emits tool.call then tool.result on success", async () => {
    const { tracer, events } = collectTracer();
    await exec(makeTool(tracer), { n: 1 });
    expect(events.map((e) => e.type)).toEqual(["tool.call", "tool.result"]);
    expect(events[1]).toMatchObject({ tool: "probe" });
  });

  it("emits tool.call then tool.error with the classified code on failure", async () => {
    const { tracer, events } = collectTracer();
    await expect(exec(makeTool(tracer, true), { n: 1 })).rejects.toThrowError();
    expect(events.map((e) => e.type)).toEqual(["tool.call", "tool.error"]);
    const error = events.find((e) => e.type === "tool.error");
    expect(error).toMatchObject({ tool: "probe", category: "reasoning", retryable: false });
  });
});

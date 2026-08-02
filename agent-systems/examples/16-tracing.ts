/**
 * Example 16 — Observability: the trace as the audit artifact.
 *
 * Topics: traceable PRAO cycles · audit trails · span correlation.
 *
 * The architecture claims every step is traceable; this example proves it.
 * A small loop runs with one tool, every span lands in a JSONL file, and we
 * read the file back — the trace is data you can query, not console scroll.
 *
 * Run: npm run example -- examples/16-tracing.ts  (works offline with AGENT_SYSTEMS_MOCK=1)
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { defineContractTool, JsonlTracer, runPraoLoop } from "../src/index.js";
import { main, model, printSection } from "./lib/shared.js";

await main(async () => {
  printSection("16 — Tracing: the audit artifact");
  const dir = await mkdtemp(join(tmpdir(), "agent-trace-"));
  const traceFile = join(dir, "run.jsonl");

  try {
    const tracer = new JsonlTracer(traceFile);
    const lookup = defineContractTool(
      {
        name: "lookup_price",
        description: "Looks up a product price. Only for listed catalog products.",
        input: z.object({ product: z.string() }),
        output: z.object({ product: z.string(), usd: z.number() }),
        sideEffect: "read-only",
        idempotent: true,
        execute: async ({ product }) => ({ product, usd: 42 }),
      },
      { context: { agentId: "shop-agent", writeScopes: [] }, tracer },
    );

    const result = await runPraoLoop({
      model: model(),
      tools: { lookup_price: lookup },
      system: "You are concise. Use tools for facts.",
      goal: "How much does the starter plan cost?",
      tracer,
    });

    console.log(`\nLoop finished: ${result.transition} (trace_id=${result.traceId})`);

    // The audit artifact: read the trace back as data.
    const spans = await JsonlTracer.readAll(traceFile);
    console.log(`\n${spans.length} spans recorded:`);
    for (const span of spans) {
      const detail =
        span.type === "loop.iteration"
          ? `kind=${span.kind} tools=[${span.toolCalls.join(",")}]`
          : span.type === "loop.transition"
            ? `${span.transition}: ${span.reason.slice(0, 60)}`
            : span.type === "tool.call" || span.type === "tool.result" || span.type === "tool.error"
              ? `tool=${span.tool}`
              : "";
      console.log(`  ${span.timestamp.slice(11, 23)} ${span.type.padEnd(17)} ${detail}`);
    }

    const correlated = spans.every((s) => s.trace_id === result.traceId);
    console.log(`\nAll spans correlated under one trace_id: ${correlated}`);
    console.log(
      "This file is the difference between 'trust me, the agent behaved' and " +
        "'here is every step, with evidence'.",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

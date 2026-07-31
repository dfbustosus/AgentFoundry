/**
 * Example 05 — Sequential pipelines: design and trade-offs.
 *
 * Topics: sequential pipelines · schema-validated boundaries.
 *
 * Draft → Critique → Polish, where each stage's artifact is validated at the
 * boundary. Trade-offs, stated honestly: additive latency, error propagation —
 * accepted because each stage genuinely depends on the previous artifact.
 *
 * Run: npm run example -- examples/05-pipelines.ts
 */

import { generateText } from "ai";
import { z } from "zod";
import { runPipeline, type PipelineStage } from "../src/index.js";
import { main, model, printJson, printSection } from "./lib/shared.js";

const draftSchema = z.object({ draft: z.string() });
const critiqueSchema = z.object({ draft: z.string(), issues: z.array(z.string()) });
const finalSchema = z.object({ final: z.string(), issuesAddressed: z.number() });

await main(async () => {
  printSection("05 — Sequential pipeline with validated boundaries");

  const llm = model();
  const stages: PipelineStage<never, unknown>[] = [
    {
      id: "draft",
      objective: "Draft a product tagline",
      outputSchema: draftSchema,
      run: async () => {
        const r = await generateText({
          model: llm,
          system: "Write exactly one short tagline.",
          prompt: "Tagline for a privacy-first notes app.",
        });
        return { draft: r.text };
      },
    },
    {
      id: "critique",
      objective: "Critique the draft",
      outputSchema: critiqueSchema,
      run: async (input) => {
        const { draft } = draftSchema.parse(input);
        const r = await generateText({
          model: llm,
          system: "List up to 3 concrete weaknesses, one per line, no preamble.",
          prompt: `Tagline: ${draft}`,
        });
        return { draft, issues: r.text.split("\n").filter((l) => l.trim().length > 0).slice(0, 3) };
      },
    },
    {
      id: "polish",
      objective: "Polish using the critique",
      outputSchema: finalSchema,
      run: async (input) => {
        const { draft, issues } = critiqueSchema.parse(input);
        const r = await generateText({
          model: llm,
          system: "Rewrite the tagline addressing every issue. Output only the new tagline.",
          prompt: `Tagline: ${draft}\nIssues:\n${issues.join("\n")}`,
        });
        return { final: r.text, issuesAddressed: issues.length };
      },
    },
  ];

  const result = await runPipeline(stages, undefined);
  printJson("Pipeline records", result.records);
  console.log(`\nFinal artifact: ${JSON.stringify(result.output)}`);
  console.log(
    "\nIf the critique stage had returned the wrong shape, the pipeline would have " +
      "stopped THERE — not three stages later with a silently corrupted artifact.",
  );
});

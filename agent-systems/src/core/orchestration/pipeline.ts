/**
 * Sequential pipeline with schema-validated boundaries.
 *
 * Each stage transforms a stable artifact for the next. The artifact is
 * validated against the next stage's input schema AT THE BOUNDARY — an
 * error is caught where it is produced, not three stages later.
 *
 * Trade-offs (documented because they are the exam question):
 * - latency is additive; there is no parallelism to hide it;
 * - errors propagate: a bad stage-2 artifact dooms stage 3;
 * - in exchange you get the simplest possible reasoning about state.
 */

import type { z } from "zod";
import { ReasoningError } from "../errors/taxonomy.js";

export interface PipelineStage<I, O> {
  readonly id: string;
  readonly objective: string;
  /** Schema the stage's OUTPUT must satisfy before the next stage sees it. */
  readonly outputSchema: z.ZodType<O>;
  readonly run: (input: I) => Promise<O>;
}

export interface PipelineRecord {
  readonly stageId: string;
  readonly durationMs: number;
  readonly status: "completed" | "failed";
  readonly error?: string;
}

export interface PipelineResult<O> {
  readonly output?: O;
  readonly records: readonly PipelineRecord[];
  readonly ok: boolean;
  /** Stage where the pipeline stopped, if it stopped early. */
  readonly failedAt?: string;
}

export async function runPipeline(
  stages: readonly PipelineStage<never, unknown>[],
  initialInput: unknown,
): Promise<PipelineResult<unknown>> {
  const records: PipelineRecord[] = [];
  let artifact = initialInput;

  for (const stage of stages) {
    const started = Date.now();
    try {
      const raw = await stage.run(artifact as never);
      const parsed = stage.outputSchema.safeParse(raw);
      if (!parsed.success) {
        const error = new ReasoningError(
          `Pipeline stage "${stage.id}" produced an artifact violating its output schema.`,
          {
            retryable: false,
            sideEffect: "none",
            blastRadius: "workflow",
            code: "reasoning.pipeline_boundary_violation",
            evidence: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
          },
        );
        records.push({ stageId: stage.id, durationMs: Date.now() - started, status: "failed", error: error.message });
        return { records, ok: false, failedAt: stage.id };
      }
      artifact = parsed.data;
      records.push({ stageId: stage.id, durationMs: Date.now() - started, status: "completed" });
    } catch (rawErr) {
      const message = rawErr instanceof Error ? rawErr.message : String(rawErr);
      records.push({ stageId: stage.id, durationMs: Date.now() - started, status: "failed", error: message });
      return { records, ok: false, failedAt: stage.id };
    }
  }

  return { output: artifact, records, ok: true };
}

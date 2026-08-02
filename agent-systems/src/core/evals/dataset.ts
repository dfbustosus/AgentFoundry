/**
 * Evaluation datasets: golden cases that define expected agent behavior.
 *
 * Tests verify the machinery; evals verify BEHAVIOR. A dataset is the
 * contract: given this input, the agent should produce something like this
 * output. Datasets are validated at the boundary like everything else.
 */

import { z } from "zod";

export const evalCaseSchema = z
  .object({
    id: z.string().min(1),
    /** The goal/prompt handed to the subject under evaluation. */
    input: z.string().min(1),
    /** Reference output for text scorers (exact, contains). Optional: some scorers (schema, judge) don't need it. */
    expected: z.string().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
export type EvalCase = z.infer<typeof evalCaseSchema>;

export const evalDatasetSchema = z
  .object({
    name: z.string().min(1),
    cases: z.array(evalCaseSchema).min(1),
  })
  .strict();
export type EvalDataset = z.infer<typeof evalDatasetSchema>;

/** Load and validate an untrusted dataset definition. */
export function parseDataset(raw: unknown): EvalDataset {
  return evalDatasetSchema.parse(raw);
}

/** Convenience constructor for inline datasets. */
export function defineDataset(dataset: EvalDataset): EvalDataset {
  return evalDatasetSchema.parse(dataset);
}

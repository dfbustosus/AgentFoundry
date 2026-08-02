/**
 * Eval scorers: deterministic first, judge last.
 *
 * Every scorer returns a score in [0, 1], a pass/fail verdict, and EVIDENCE —
 * a number without a reason is not a result. Deterministic scorers (exact,
 * contains, regex, schema) are preferred: they are cheap, reproducible, and
 * cannot be sweet-talked. The LLM judge exists for qualities determinism
 * can't reach (tone, completeness), and its verdicts carry the judge's own
 * stated reason so they can be audited rather than trusted.
 */

import { generateObject, type LanguageModel } from "ai";
import { z } from "zod";
import type { EvalCase } from "./dataset.js";

export interface ScoreResult {
  readonly scorer: string;
  readonly pass: boolean;
  /** 0..1 */
  readonly score: number;
  readonly evidence: string;
}

export type Scorer = (evalCase: EvalCase, output: string) => Promise<ScoreResult> | ScoreResult;

const normalize = (s: string): string => s.trim().toLowerCase().replace(/\s+/g, " ");

/** Exact match after normalization (trim, case-fold, whitespace collapse). */
export function exactMatch(): Scorer {
  return (c, output) => {
    if (c.expected === undefined) throw new Error(`case ${c.id}: exactMatch requires 'expected'`);
    const pass = normalize(output) === normalize(c.expected);
    return {
      scorer: "exactMatch",
      pass,
      score: pass ? 1 : 0,
      evidence: pass
        ? "normalized outputs match"
        : `expected "${normalize(c.expected).slice(0, 80)}", got "${normalize(output).slice(0, 80)}"`,
    };
  };
}

/** Output contains the expected substring (case-insensitive). */
export function contains(): Scorer {
  return (c, output) => {
    if (c.expected === undefined) throw new Error(`case ${c.id}: contains requires 'expected'`);
    const pass = output.toLowerCase().includes(c.expected.toLowerCase());
    return {
      scorer: "contains",
      pass,
      score: pass ? 1 : 0,
      evidence: pass ? `output contains "${c.expected}"` : `"${c.expected}" not found in output`,
    };
  };
}

/** Output matches a regular expression. */
export function matchesPattern(pattern: RegExp): Scorer {
  return (_c, output) => {
    const pass = pattern.test(output);
    return {
      scorer: "matchesPattern",
      pass,
      score: pass ? 1 : 0,
      evidence: pass ? `matches ${pattern.source}` : `does not match ${pattern.source}`,
    };
  };
}

/** Output parses as JSON and validates against a schema (structured-output agents). */
export function jsonSchemaOutput(schema: z.ZodType<unknown>): Scorer {
  return (_c, output) => {
    try {
      const parsed = schema.safeParse(JSON.parse(output));
      return {
        scorer: "jsonSchemaOutput",
        pass: parsed.success,
        score: parsed.success ? 1 : 0,
        evidence: parsed.success
          ? "valid JSON matching schema"
          : parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
      };
    } catch {
      return { scorer: "jsonSchemaOutput", pass: false, score: 0, evidence: "output is not valid JSON" };
    }
  };
}

const judgeVerdictSchema = z.object({
  pass: z.boolean().describe("Whether the output satisfies the rubric"),
  reason: z.string().describe("One sentence justifying the verdict"),
});

/**
 * LLM-as-judge for qualities deterministic scorers can't reach. The rubric
 * must be concrete and checkable ("mentions a budget", not "is good").
 * The judge's reason is recorded as evidence — audit it, don't trust it.
 */
export function llmJudge(model: LanguageModel, rubric: string): Scorer {
  return async (c, output) => {
    const result = await generateObject({
      model,
      schema: judgeVerdictSchema,
      system:
        "You are a strict evaluator. Apply the rubric literally. " +
        "Pass only when the output clearly satisfies it; otherwise fail.",
      prompt:
        `Rubric: ${rubric}\n\nInput given to the agent: ${c.input}\n\n` +
        (c.expected !== undefined ? `Reference answer: ${c.expected}\n\n` : "") +
        `Agent output: ${output}`,
    });
    return {
      scorer: "llmJudge",
      pass: result.object.pass,
      score: result.object.pass ? 1 : 0,
      evidence: `judge: ${result.object.reason}`,
    };
  };
}

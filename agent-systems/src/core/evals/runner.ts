/**
 * Eval runner: executes a subject against a dataset and reports pass rates.
 *
 * Design rules:
 * - A case passes only when EVERY scorer passes (conjunctive, strict).
 * - A subject that throws does not abort the run — the case fails with the
 *   error as evidence, because an eval's job is a complete picture, not a
 *   stack trace on case three.
 * - Bounded concurrency (default 2): evals are model-call heavy.
 */

import { pooled } from "../decomposition/graph.js";
import type { EvalDataset } from "./dataset.js";
import type { ScoreResult, Scorer } from "./scorers.js";

export interface EvalCaseResult {
  readonly id: string;
  readonly pass: boolean;
  readonly output: string;
  readonly scores: readonly ScoreResult[];
  /** Present when the subject threw — the case fails, the run continues. */
  readonly error?: string;
  readonly durationMs: number;
}

export interface EvalReport {
  readonly dataset: string;
  readonly totalCases: number;
  readonly passedCases: number;
  /** passedCases / totalCases, 0..1 */
  readonly passRate: number;
  readonly cases: readonly EvalCaseResult[];
  readonly durationMs: number;
}

export interface RunEvalOptions {
  readonly dataset: EvalDataset;
  /** The thing being evaluated: input in, final answer out. */
  readonly subject: (input: string) => Promise<string>;
  readonly scorers: readonly Scorer[];
  readonly concurrency?: number;
}

export async function runEval(options: RunEvalOptions): Promise<EvalReport> {
  const started = Date.now();
  const concurrency = Math.max(1, options.concurrency ?? 2);

  const cases = await pooled(options.dataset.cases, concurrency, async (evalCase): Promise<EvalCaseResult> => {
    const caseStart = Date.now();
    let output: string;
    try {
      output = await options.subject(evalCase.input);
    } catch (err) {
      return {
        id: evalCase.id,
        pass: false,
        output: "",
        scores: [],
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - caseStart,
      };
    }
    const scores: ScoreResult[] = [];
    for (const scorer of options.scorers) {
      scores.push(await scorer(evalCase, output));
    }
    return {
      id: evalCase.id,
      pass: scores.every((s) => s.pass),
      output,
      scores,
      durationMs: Date.now() - caseStart,
    };
  });

  const passed = cases.filter((c) => c.pass).length;
  return {
    dataset: options.dataset.name,
    totalCases: cases.length,
    passedCases: passed,
    passRate: cases.length === 0 ? 0 : passed / cases.length,
    cases,
    durationMs: Date.now() - started,
  };
}

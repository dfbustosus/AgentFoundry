import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineDataset, parseDataset, type EvalCase } from "../src/core/evals/dataset.js";
import { runEval } from "../src/core/evals/runner.js";
import { contains, exactMatch, jsonSchemaOutput, llmJudge, matchesPattern } from "../src/core/evals/scorers.js";
import { scriptedModel, textResult } from "./helpers.js";

const c = (overrides: Partial<EvalCase> = {}): EvalCase => ({
  id: "case-1",
  input: "what is 2+2?",
  expected: "4",
  ...overrides,
});

describe("eval datasets", () => {
  it("validates a well-formed dataset and rejects malformed ones", () => {
    const ds = defineDataset({ name: "math", cases: [c()] });
    expect(ds.cases).toHaveLength(1);
    expect(() => parseDataset({ name: "bad", cases: [{ input: "no id" }] })).toThrowError();
    expect(() => parseDataset({ name: "empty", cases: [] })).toThrowError();
  });
});

describe("deterministic scorers", () => {
  it("exactMatch normalizes case and whitespace", async () => {
    expect((await exactMatch()(c(), "  4  ")).pass).toBe(true);
    const fail = await exactMatch()(c(), "four");
    expect(fail.pass).toBe(false);
    expect(fail.evidence).toContain('expected "4"');
  });

  it("contains checks substring case-insensitively", async () => {
    expect((await contains()(c({ expected: "JACKET" }), "bring a jacket")).pass).toBe(true);
    expect((await contains()(c({ expected: "umbrella" }), "bring a jacket")).pass).toBe(false);
  });

  it("matchesPattern applies the regex and reports it as evidence", async () => {
    expect((await matchesPattern(/\$\d+/)(c(), "costs $42")).pass).toBe(true);
    const fail = await matchesPattern(/\$\d+/)(c(), "free");
    expect(fail.pass).toBe(false);
    expect(fail.evidence).toContain("\\$\\d+");
  });

  it("jsonSchemaOutput validates structured output and rejects non-JSON", async () => {
    const schema = z.object({ usd: z.number() });
    expect((await jsonSchemaOutput(schema)(c(), '{"usd": 42}')).pass).toBe(true);
    expect((await jsonSchemaOutput(schema)(c(), '{"usd": "a lot"}')).pass).toBe(false);
    expect((await jsonSchemaOutput(schema)(c(), "not json")).pass).toBe(false);
  });

  it("exactMatch/contains fail loudly when the case lacks 'expected'", () => {
    expect(() => exactMatch()(c({ expected: undefined }), "x")).toThrowError(/requires 'expected'/);
    expect(() => contains()(c({ expected: undefined }), "x")).toThrowError(/requires 'expected'/);
  });
});

describe("llmJudge", () => {
  it("records the judge's verdict and reason as auditable evidence", async () => {
    const judge = llmJudge(
      scriptedModel([textResult('{"pass": true, "reason": "mentions a budget"}')]),
      "mentions a budget",
    );
    const result = await judge(c(), "every loop needs a budget");
    expect(result.pass).toBe(true);
    expect(result.evidence).toBe("judge: mentions a budget");
  });
});

describe("runEval", () => {
  const dataset = defineDataset({
    name: "arithmetic",
    cases: [
      c({ id: "a", input: "what is 2+2?", expected: "4" }),
      c({ id: "b", input: "what is 6*7?", expected: "42" }),
      c({ id: "c", input: "what is 3+4?", expected: "7" }),
    ],
  });

  it("reports pass rate with per-case evidence", async () => {
    const report = await runEval({
      dataset,
      subject: async (input) => (input.includes("2+2") ? "4" : input.includes("6*7") ? "42" : "wrong"),
      scorers: [exactMatch()],
    });
    expect(report.totalCases).toBe(3);
    expect(report.passedCases).toBe(2);
    expect(report.passRate).toBeCloseTo(2 / 3);
    expect(report.cases.find((x) => x.id === "a")?.pass).toBe(true);
    expect(report.cases.find((x) => x.id === "c")?.scores[0]?.evidence).toContain('expected "7"');
  });

  it("a failing subject fails the case, not the run", async () => {
    const report = await runEval({
      dataset,
      subject: async (input) => {
        if (input.includes("2+2")) return "4";
        throw new Error("model exploded");
      },
      scorers: [exactMatch()],
    });
    expect(report.passedCases).toBe(1);
    const failed = report.cases.find((x) => x.id === "b");
    expect(failed?.pass).toBe(false);
    expect(failed?.error).toBe("model exploded");
  });

  it("a case passes only when ALL scorers pass (conjunctive)", async () => {
    const report = await runEval({
      dataset: defineDataset({ name: "one", cases: [c({ id: "x", expected: "4" })] }),
      subject: async () => "4",
      scorers: [exactMatch(), contains(), matchesPattern(/^\d$/)],
    });
    expect(report.passRate).toBe(1);

    const mixed = await runEval({
      dataset: defineDataset({ name: "one", cases: [c({ id: "x", expected: "4" })] }),
      subject: async () => "the answer is 4, obviously",
      scorers: [exactMatch(), contains()],
    });
    expect(mixed.passRate).toBe(0); // contains passes, exactMatch fails → case fails
  });
});

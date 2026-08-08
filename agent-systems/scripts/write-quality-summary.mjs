// @ts-check

import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const mode = process.argv[2];

if (mode !== "coverage" && mode !== "mutation") {
  throw new Error('Usage: node scripts/write-quality-summary.mjs <"coverage" | "mutation">');
}

/** @param {unknown} value */
function record(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Quality report did not contain the expected object shape");
  }
  return value;
}

/** @param {unknown} value */
function finiteNumber(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Quality report contained an invalid numeric value: ${String(value)}`);
  }
  return value;
}

/** @param {number} value */
function percentage(value) {
  return `${value.toFixed(2)}%`;
}

async function coverageSummary() {
  const source = join(packageRoot, "coverage", "coverage-summary.json");
  const report = record(JSON.parse(await readFile(source, "utf8")));
  const total = record(report.total);
  const metrics = ["statements", "branches", "functions", "lines"];
  const rows = metrics.map((metric) => {
    const values = record(total[metric]);
    return `| ${metric} | ${String(values.covered)} | ${String(values.total)} | ${percentage(finiteNumber(values.pct))} |`;
  });
  return {
    destination: join(packageRoot, "coverage", "summary.md"),
    markdown: [
      "## Coverage summary",
      "",
      "| Metric | Covered | Total | Percentage |",
      "| --- | ---: | ---: | ---: |",
      ...rows,
      "",
    ].join("\n"),
  };
}

async function mutationSummary() {
  const source = join(packageRoot, "reports", "mutation", "mutation.json");
  const report = record(JSON.parse(await readFile(source, "utf8")));
  const files = record(report.files);
  /** @type {Record<string, number>} */
  const statuses = {};

  for (const file of Object.values(files)) {
    const mutants = record(file).mutants;
    if (!Array.isArray(mutants)) throw new Error("Mutation report file entry did not contain a mutants array");
    for (const mutant of mutants) {
      const status = record(mutant).status;
      if (typeof status !== "string") throw new Error("Mutation report contained a mutant without a status");
      statuses[status] = (statuses[status] ?? 0) + 1;
    }
  }

  const killed = statuses.Killed ?? 0;
  const timedOut = statuses.Timeout ?? 0;
  const survived = statuses.Survived ?? 0;
  const noCoverage = statuses.NoCoverage ?? 0;
  const errors = (statuses.CompileError ?? 0) + (statuses.RuntimeError ?? 0);
  const scored = killed + timedOut + survived + noCoverage + errors;
  const covered = scored - noCoverage;
  if (scored === 0 || covered === 0) throw new Error("Mutation report contained no scored mutants");

  const detected = killed + timedOut;
  const mutationScore = (detected / scored) * 100;
  const coveredScore = (detected / covered) * 100;
  const { default: strykerConfig } = await import("../stryker.config.mjs");
  const breakThreshold = strykerConfig.thresholds?.break;

  return {
    destination: join(packageRoot, "reports", "mutation", "summary.md"),
    markdown: [
      "## Mutation testing summary",
      "",
      "| Measure | Value |",
      "| --- | ---: |",
      `| Mutation score | ${percentage(mutationScore)} |`,
      `| Covered mutation score | ${percentage(coveredScore)} |`,
      `| Enforced threshold | ${typeof breakThreshold === "number" ? percentage(breakThreshold) : "not configured"} |`,
      "",
      "| Status | Mutants |",
      "| --- | ---: |",
      `| Killed | ${String(killed)} |`,
      `| Timed out | ${String(timedOut)} |`,
      `| Survived | ${String(survived)} |`,
      `| No coverage | ${String(noCoverage)} |`,
      `| Errors | ${String(errors)} |`,
      `| Total | ${String(scored)} |`,
      "",
    ].join("\n"),
  };
}

const summary = mode === "coverage" ? await coverageSummary() : await mutationSummary();
await mkdir(dirname(summary.destination), { recursive: true });
await writeFile(summary.destination, summary.markdown);

if (process.env.GITHUB_STEP_SUMMARY !== undefined) {
  await appendFile(process.env.GITHUB_STEP_SUMMARY, summary.markdown);
}

console.log(summary.markdown);

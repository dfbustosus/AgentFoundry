/**
 * Example 15 — Selecting the right topology, and multi-agent cost vs. fit.
 *
 * Topics: hub-and-spoke / pipeline / peer-to-peer · topology selection ·
 * multi-agent cost and fit.
 *
 * Walks four problem shapes through the decision rule, explains the
 * deliberate rejection of peer-to-peer for most problems, and prices a
 * coordination decision with numbers instead of enthusiasm.
 *
 * Run: npm run example -- examples/15-topology-selection.ts  (no API key needed)
 */

import { multiAgentFit, selectTopology, type ProblemShape } from "../src/index.js";
import { main, printJson, printSection } from "./lib/shared.js";

const base: ProblemShape = {
  partitionable: false,
  stagedTransform: false,
  needsCanonicalOwner: false,
  needsSpecialization: false,
  sharedNegotiation: false,
  coordinationBudget: "low",
};

await main(async () => {
  printSection("15 — Topology selection and cost/fit");

  const shapes: Record<string, ProblemShape> = {
    "summarize one document": base,
    "research → draft → polish a report": { ...base, stagedTransform: true, needsSpecialization: true },
    "review 40 independent pull requests": { ...base, partitionable: true, needsSpecialization: true },
    "customer-facing support with compliance audit": {
      ...base,
      partitionable: true,
      needsCanonicalOwner: true,
      coordinationBudget: "medium",
    },
    "two departments negotiate a shared budget": { ...base, sharedNegotiation: true, coordinationBudget: "high" },
  };

  for (const [problem, shape] of Object.entries(shapes)) {
    const verdict = selectTopology(shape);
    console.log(`\n"${problem}"`);
    console.log(`  → ${verdict.topology}: ${verdict.rationale}`);
    console.log(`    trade-off: ${verdict.mainTradeOff}`);
  }

  console.log("\nWhy peer-to-peer is usually rejected:");
  console.log(
    "  Coordination, deadlock, and state-consistency costs are high. It is justified ONLY\n" +
      "  for genuinely shared negotiation with a defined protocol, ownership rule, convergence\n" +
      "  mechanism, and deadlock timeout — which is why this library documents it but does not\n" +
      "  implement unconstrained P2P.",
  );

  printJson(
    "Cost/fit: is a second agent worth it?",
    multiAgentFit({
      singleAgentCostUsd: 0.012,
      multiAgentCostUsd: 0.047,
      humanHoursSaved: 1.5,
      humanHourValueUsd: 80,
    }),
  );
  printJson(
    "Same numbers without quantified benefit",
    multiAgentFit({ singleAgentCostUsd: 0.012, multiAgentCostUsd: 0.047 }),
  );
});

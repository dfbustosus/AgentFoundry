/**
 * Topology selection: choosing the right coordination structure for the problem.
 *
 * The table below is data, not documentation-as-comment — `selectTopology`
 * evaluates it, so the decision rule and its rationale stay in one place.
 *
 * Peer-to-peer is included as an evaluated-and-rejected option for most
 * cases: coordination, deadlock, and state-consistency costs are high, and
 * it is only justified for genuinely shared negotiation problems with a
 * defined protocol, ownership rule, convergence mechanism, and timeout.
 * This library deliberately does not implement unconstrained P2P (spec D5).
 */

export type Topology = "single-agent" | "hub-and-spoke" | "pipeline" | "fan-out-fan-in" | "peer-to-peer" | "hybrid-dag";

export interface ProblemShape {
  /** Can the work be partitioned into independent chunks? */
  readonly partitionable: boolean;
  /** Does each stage transform one artifact for the next (real data dependency)? */
  readonly stagedTransform: boolean;
  /** Must one owner preserve intent, authority, and final consistency? */
  readonly needsCanonicalOwner: boolean;
  /** Do specialized contexts/tools justify separate agents? */
  readonly needsSpecialization: boolean;
  /** Is the problem a genuine shared negotiation between peers? */
  readonly sharedNegotiation: boolean;
  /** Rough coordination budget: how much merge/sync overhead is acceptable? */
  readonly coordinationBudget: "low" | "medium" | "high";
}

export interface TopologyVerdict {
  readonly topology: Topology;
  readonly rationale: string;
  readonly mainTradeOff: string;
  /** Estimated coordination cost drivers for the chosen topology. */
  readonly costDrivers: readonly string[];
}

const TRADE_OFFS: Record<Topology, string> = {
  "single-agent": "No coordination cost, but one context must hold everything.",
  "hub-and-spoke": "The hub can become a bottleneck and a coordination single point of failure.",
  pipeline: "Latency is additive and errors propagate downstream.",
  "fan-out-fan-in": "Integration, conflict resolution, and partial-failure policy are explicit work.",
  "peer-to-peer": "Deadlock, divergence, and state-consistency costs are high; needs a strict protocol.",
  "hybrid-dag": "Most flexible, most control logic and observability required.",
};

/**
 * Decision rule, in order. The first match wins; each branch states why.
 * When in doubt, choose the SIMPLER topology — multi-agent designs whose
 * coordination cost exceeds their benefit are rejected by construction.
 */
export function selectTopology(shape: ProblemShape): TopologyVerdict {
  const pick = (topology: Topology, rationale: string, costDrivers: readonly string[]): TopologyVerdict => ({
    topology,
    rationale,
    mainTradeOff: TRADE_OFFS[topology],
    costDrivers,
  });

  if (shape.sharedNegotiation) {
    return pick(
      "peer-to-peer",
      "Genuinely shared negotiation. Justified ONLY with a defined protocol, ownership rule, convergence mechanism, and deadlock timeout — otherwise reject in favor of hub-and-spoke.",
      ["negotiation rounds", "convergence checks", "deadlock detection", "consistency reconciliation"],
    );
  }
  if (!shape.needsSpecialization && !shape.partitionable) {
    return pick(
      "single-agent",
      "Small, tightly coupled work depending on one evolving context is cheaper done by one agent than coordinated.",
      ["none — coordination avoided entirely"],
    );
  }
  if (shape.stagedTransform && !shape.partitionable) {
    return pick(
      "pipeline",
      "Each stage transforms a stable artifact for the next; a real data dependency forbids parallelism.",
      ["boundary validation per stage", "additive latency"],
    );
  }
  if (shape.partitionable && !shape.needsCanonicalOwner) {
    return pick(
      "fan-out-fan-in",
      "Independent partitions can run concurrently behind one synchronization barrier.",
      ["bounded concurrency", "merge/conflict policy", "partial-failure handling"],
    );
  }
  if (shape.needsCanonicalOwner) {
    return pick(
      "hub-and-spoke",
      "One owner must preserve intent, authority, and final consistency. Default for user-facing work.",
      ["context transfer per delegation", "hub verification of every reply", "hub bottleneck"],
    );
  }
  return pick(
    "hybrid-dag",
    "The problem mixes staging and parallelism; model it as a DAG with explicit barriers.",
    ["graph validation", "barrier synchronization", "cross-cutting integration checks"],
  );
}

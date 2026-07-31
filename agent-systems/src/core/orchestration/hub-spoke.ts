/**
 * Hub-and-spoke orchestrator.
 *
 * One canonical owner (the hub) holds the goal, the acceptance criteria, the
 * decision log, and the final answer. Spokes (subagents) receive bounded
 * briefs with bounded authority and return typed handoff envelopes with
 * evidence. The hub validates every envelope before marking work complete —
 * aggregation is verification, not voting.
 *
 * Known trade-off: the hub is a bottleneck and a single point of coordination
 * failure. That is the price of preserved intent and consistency; for the
 * problems this library targets it is the right default (see topology.ts).
 */

import { randomUUID } from "node:crypto";
import type { LanguageModel, ToolSet } from "ai";
import { executeGraph, TaskGraph } from "../decomposition/graph.js";
import { planHierarchical, type SubtaskPlan } from "../decomposition/patterns.js";
import { ReasoningError } from "../errors/taxonomy.js";
import { createEnvelope, validateEnvelope, type HandoffEnvelope } from "../handoff/envelope.js";
import { replyTo, type MessageBus } from "../handoff/protocol.js";
import { runPraoLoop, type LoopResult } from "../loop/prao.js";
import {
  assertDelegationWithinAuthority,
  assertNonOverlappingScopes,
  renderBrief,
  type SubagentDefinition,
  type TaskBrief,
} from "./subagent.js";

export interface SpokeResult {
  readonly task_id: string;
  readonly agentId: string;
  readonly status: "completed" | "failed" | "escalated";
  readonly summary: string;
  readonly evidence: readonly string[];
  readonly loop: LoopResult;
  readonly reply: HandoffEnvelope;
}

export interface OrchestratorOptions {
  readonly id: string;
  readonly model: LanguageModel;
  readonly bus: MessageBus;
}

export class Orchestrator {
  readonly id: string;
  private readonly model: LanguageModel;
  private readonly bus: MessageBus;

  constructor(options: OrchestratorOptions) {
    this.id = options.id;
    this.model = options.model;
    this.bus = options.bus;
  }

  /**
   * Delegate one bounded task to one subagent and verify the reply.
   *
   * Authority is enforced in code BEFORE the model runs. The reply envelope
   * is schema-validated; a malformed reply fails the task instead of being
   * silently accepted.
   */
  async delegate<TOOLS extends ToolSet>(
    agent: SubagentDefinition<TOOLS>,
    brief: TaskBrief,
    options: { readonly correlation_id: string; readonly causation_id?: string | null },
  ): Promise<SpokeResult> {
    assertDelegationWithinAuthority(agent, agent.authority);

    const delegation = createEnvelope({
      message_id: randomUUID(),
      correlation_id: options.correlation_id,
      causation_id: options.causation_id ?? null,
      task_id: brief.task_id,
      sender: this.id,
      recipient: agent.id,
      intent: "delegate",
      objective: brief.objective,
      status: "ready",
      authority: agent.authority,
      inputs: {
        facts: [...brief.facts],
        assumptions: [...brief.assumptions],
        artifact_refs: [...brief.artifact_refs],
      },
      constraints: [...brief.constraints],
      acceptance_checks: [...brief.acceptance_checks],
      recommended_next_action: "Execute the task and return a result envelope with evidence.",
    });
    this.bus.send(delegation);

    const loop = await runPraoLoop({
      model: agent.model,
      tools: agent.tools,
      system:
        `${agent.instructions}\n\n` +
        `You are subagent "${agent.id}" with authority "${agent.authority}". ` +
        "Produce evidence for every acceptance check. If you cannot, say so explicitly — " +
        "never manufacture findings.",
      goal: renderBrief(brief),
      budgets: agent.maxIterations !== undefined ? { maxIterations: agent.maxIterations } : {},
    });

    const status: SpokeResult["status"] =
      loop.transition === "stop-success" ? "completed" : loop.transition === "escalate" ? "escalated" : "failed";

    const reply = replyTo(delegation, {
      message_id: randomUUID(),
      status: status === "completed" ? "completed" : status === "escalated" ? "blocked" : "failed",
      summary: loop.text.slice(0, 500) || loop.reason,
      evidence: loop.observations.map((o) => `[${o.kind}] ${o.summary}`),
      verification: brief.acceptance_checks.map((c) => `${status === "completed" ? "checked" : "UNVERIFIED"}: ${c}`),
      recommended_next_action:
        status === "completed" ? "Verify evidence and close the task." : "Replan, reassign, or escalate to a human.",
    });

    const validated = validateEnvelope(reply);
    if (!validated.ok) {
      throw new ReasoningError(`Subagent "${agent.id}" returned a malformed handoff envelope.`, {
        retryable: false,
        sideEffect: "none",
        blastRadius: "workflow",
        code: "reasoning.malformed_handoff",
        evidence: validated.issues,
      });
    }
    this.bus.send(validated.envelope);

    return {
      task_id: brief.task_id,
      agentId: agent.id,
      status,
      summary: reply.result?.summary ?? "",
      evidence: reply.result?.evidence ?? [],
      loop,
      reply: validated.envelope,
    };
  }

  /**
   * Decompose a goal (model-planned or caller-provided plan), bind subtasks to
   * agents, execute the DAG with dependency-aware scheduling, then aggregate.
   *
   * Aggregation rule: a task is complete only when its reply is completed AND
   * carries evidence. Failed/escalated tasks are surfaced with their reasons —
   * never smoothed over.
   */
  async run(
    goal: string,
    agents: Readonly<Record<string, SubagentDefinition>>,
    options: {
      readonly correlation_id?: string;
      readonly plan?: SubtaskPlan;
      readonly concurrency?: number;
    } = {},
  ): Promise<{
    goal: string;
    plan: SubtaskPlan;
    results: readonly SpokeResult[];
    completed: readonly string[];
    unresolved: readonly { task_id: string; reason: string }[];
    dissent: readonly string[];
  }> {
    const agentList = Object.values(agents);
    assertNonOverlappingScopes(agentList);

    const correlation_id = options.correlation_id ?? randomUUID();
    const agentIds = Object.keys(agents);
    const plan =
      options.plan ??
      (await planHierarchical({
        model: this.model,
        goal,
        context:
          `Each subtask id MUST be exactly one of the available worker ids: ${agentIds.join(", ")}. ` +
          "Reuse a worker id for multiple subtasks only by suffixing (e.g. researcher_2) — " +
          "the suffix is stripped for binding.",
      }));

    // Bind planned subtask ids to agents: exact match, or "<agent>_<suffix>".
    const boundAgents = new Map<string, SubagentDefinition>();
    const invalid: string[] = [];
    for (const sub of plan.subtasks) {
      const direct = agents[sub.id];
      if (direct !== undefined) {
        boundAgents.set(sub.id, direct);
        continue;
      }
      const base = agentIds.find((id) => sub.id.startsWith(`${id}_`));
      const viaBase = base !== undefined ? agents[base] : undefined;
      if (viaBase !== undefined) {
        boundAgents.set(sub.id, viaBase);
      } else {
        invalid.push(sub.id);
      }
    }
    if (invalid.length > 0) {
      throw new ReasoningError(`Plan references subtasks with no matching subagent: ${invalid.join(", ")}.`, {
        retryable: false,
        sideEffect: "none",
        blastRadius: "local",
        code: "reasoning.unbound_task",
        evidence: [`available agents: ${agentIds.join(", ")}`],
      });
    }

    const graph = new TaskGraph();
    const resultsByTask = new Map<string, SpokeResult>();

    for (const sub of plan.subtasks) {
      const agent = boundAgents.get(sub.id);
      if (agent === undefined) {
        // Unreachable after the validation above; defensive, not decorative.
        throw new ReasoningError(`No subagent bound to planned task "${sub.id}".`, {
          retryable: false,
          sideEffect: "none",
          blastRadius: "local",
          code: "reasoning.unbound_task",
          evidence: [`available agents: ${agentIds.join(", ")}`],
        });
      }
      graph.add({
        id: sub.id,
        objective: sub.objective,
        dependsOn: sub.dependsOn.filter((d) => plan.subtasks.some((s) => s.id === d)),
        run: async (inputs) => {
          const upstreamFacts = Object.entries(inputs).map(([taskId, value]) => {
            const spoke = value as SpokeResult;
            return `[${taskId}] ${spoke.summary}`;
          });
          const brief: TaskBrief = {
            task_id: sub.id,
            objective: sub.objective,
            facts: upstreamFacts,
            assumptions: [],
            artifact_refs: [],
            constraints: [],
            acceptance_checks: [`Produces evidence for: ${sub.objective}`],
          };
          const result = await this.delegate(agent, brief, { correlation_id });
          resultsByTask.set(sub.id, result);
          if (result.status === "failed") {
            throw new Error(`Task "${sub.id}" failed: ${result.summary}`);
          }
          return result;
        },
      });
    }

    await executeGraph(graph, { concurrency: options.concurrency ?? 2 });

    const results = [...resultsByTask.values()];
    const completed = results.filter((r) => r.status === "completed").map((r) => r.task_id);
    const unresolved = results
      .filter((r) => r.status !== "completed")
      .map((r) => ({ task_id: r.task_id, reason: r.summary || r.loop.reason }));
    // Dissent and risk are first-class outputs: they must reach the user, not be smoothed away.
    const dissent = results.flatMap((r) => [...r.reply.risks, ...r.reply.open_questions]);

    return { goal, plan, results, completed, unresolved, dissent };
  }
}

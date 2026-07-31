/**
 * Agent Systems Foundry — public API.
 *
 * Layered architecture (each layer depends only on layers below it):
 *
 *   errors        → taxonomy + classification (everything else builds on this)
 *   reliability   → retry + fallback (uses errors)
 *   tools         → contracts (uses errors)
 *   loop          → PRAO loop (uses errors, AI SDK)
 *   decomposition → task DAG + patterns (uses errors, AI SDK)
 *   handoff       → envelopes + protocol (uses errors)
 *   state         → memory + checkpoints (uses errors)
 *   orchestration → subagents, hub-spoke, pipeline, fanout, topology (uses all above)
 *   validation    → enforcement layers (uses errors)
 *   cost          → usage accounting (uses AI SDK types)
 *   mcp           → MCP client wiring (uses AI SDK + MCP SDK)
 */

// errors
export {
  AgentError,
  BudgetExhaustedError,
  DegradedError,
  EnvironmentError,
  PolicyError,
  ReasoningError,
  ToolError,
  type AgentErrorDetails,
  type BlastRadius,
  type ErrorCategory,
  type SideEffectStatus,
} from "./core/errors/taxonomy.js";
export { classifyError, isCategory } from "./core/errors/classify.js";

// reliability
export { computeDelayMs, RetryExhaustedError, withRetry, type RetryContext, type RetryOutcome, type RetryPolicy } from "./core/reliability/retry.js";
export { withFallback, type FallbackOutcome, type FallbackStep } from "./core/reliability/fallback.js";

// tools
export { contractSummary, defineContractTool, type SideEffectKind, type ToolContext, type ToolContract } from "./core/tools/contract.js";

// loop
export {
  DEFAULT_BUDGETS,
  runPraoLoop,
  type LoopBudgets,
  type LoopResult,
  type LoopState,
  type LoopTransition,
  type Observation,
  type ObservationKind,
  type PraoLoopOptions,
  type TransitionDecision,
} from "./core/loop/prao.js";

// decomposition
export { executeGraph, pooled, TaskGraph, type ExecuteOptions, type GraphResult, type TaskNode, type TaskRecord, type TaskStatus } from "./core/decomposition/graph.js";
export { bindPlan, parallel, planHierarchical, sequential, subtaskPlanSchema, type Branch, type Stage, type SubtaskPlan } from "./core/decomposition/patterns.js";

// handoff
export {
  authoritySchema,
  createEnvelope,
  HANDOFF_SCHEMA_VERSION,
  handoffEnvelopeSchema,
  validateEnvelope,
  type Authority,
  type HandoffEnvelope,
  type HandoffIntent,
  type HandoffStatus,
} from "./core/handoff/envelope.js";
export { InMemoryBus, receiveHandoff, replyTo, type Ack, type MessageBus } from "./core/handoff/protocol.js";

// state
export { FileStore, InMemoryStore, type MemoryStore } from "./core/state/memory.js";
export {
  CheckpointStore,
  checkpointSchema,
  reconcile,
  type Checkpoint,
  type EffectRecord,
  type ResumePlan,
  type TaskLedgerEntry,
} from "./core/state/session.js";

// orchestration
export {
  assertDelegationWithinAuthority,
  assertNonOverlappingScopes,
  authorityAllows,
  renderBrief,
  type SubagentDefinition,
  type TaskBrief,
} from "./core/orchestration/subagent.js";
export { Orchestrator, type OrchestratorOptions, type SpokeResult } from "./core/orchestration/hub-spoke.js";
export { runPipeline, type PipelineRecord, type PipelineResult, type PipelineStage } from "./core/orchestration/pipeline.js";
export { fanIn, fanOut, type BranchOutcome, type Conflict, type FanInOptions, type FanInResult, type FanOutBranch } from "./core/orchestration/fanout.js";
export { selectTopology, type ProblemShape, type Topology, type TopologyVerdict } from "./core/orchestration/topology.js";

// validation
export {
  authorizationLayer,
  budgetLayer,
  enforce,
  enforceOrThrow,
  schemaLayer,
  verifyPostcondition,
  type ActionProposal,
  type EnforcementDecision,
  type EnforcementLayer,
} from "./core/validation/enforcement.js";

// cost
export { CostTracker, estimateCostUsd, multiAgentFit, PRICE_STALENESS_DAYS, PRICE_TABLE, stalePriceModels, type CostReport, type ModelPrice } from "./core/cost/tracker.js";

// mcp
export { connectMcpServer, type ConnectOptions, type McpServerHandle } from "./core/mcp/client.js";

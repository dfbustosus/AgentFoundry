# Spec-Driven Development Plan — Agent Systems Foundry

**Status:** v1.0 (locked after clarification, 2026-07-30)
**Stack (user-specified):** TypeScript on Node.js ≥ 20, Vercel AI SDK Core (`ai`), Zod for schemas, Vitest for tests, `@modelcontextprotocol/sdk` for MCP.

---

## 1. Outcomes

The successful end-state is a repository that a competent engineer can clone, install, and use to **learn and reuse production-grade agentic architecture patterns** in TypeScript:

1. A small, typed **core library** (`src/core/`) implementing the foundational layers: PRAO agent loop, tool contracts, error taxonomy, retry/fallback reliability, goal decomposition, multi-agent orchestration topologies, typed handoffs, state/memory with session checkpoints, validation/enforcement layers, and cost tracking.
2. A set of **runnable examples** (`examples/`), each demonstrating one or more topics from the topic list against a live LLM, with an explicit topic → example map.
3. A **test suite** (`tests/`) that verifies core behavior with a mocked language model — no API key required for `npm test`.
4. Documentation (`README.md`) that explains the architecture, the design trade-offs, and why each layer exists.
5. `npm run typecheck` and `npm test` pass cleanly from a fresh install.

The project teaches by *showing the machinery*: orchestration, loop control, and reliability are implemented explicitly in this repo rather than delegated to a heavy framework, because making the patterns visible is the point of the project.

## 2. Scope Boundaries

### IN-SCOPE

- PRAO (Perception–Reasoning–Action–Observation) loop with explicit budgets and stop/iterate/recover/clarify/escalate transitions.
- Tool contracts: typed input/output schemas, side-effect classification, postconditions, machine-readable errors.
- Error taxonomy (tool / reasoning / environment / policy) with classification, retryability, and blast-radius metadata.
- Retry with bounded attempts, exponential backoff + jitter, idempotency keys; fallback chains with labeled degradation.
- Goal decomposition: hierarchical, sequential, parallel patterns over a typed task graph (DAG) with topological execution.
- Orchestration: hub-and-spoke orchestrator, sequential pipeline, fan-out/fan-in with synchronization barrier; a topology-selection decision table. Peer-to-peer is documented and deliberately **not** implemented beyond a constrained negotiation protocol description (see Constraints).
- Subagent definition: bounded authority, isolated write scopes, typed task contracts.
- Typed agent-to-agent handoff envelope (Zod schema) with delegate/result/question/escalation/cancellation intents, acknowledgement, and continuity IDs (correlation/causation).
- State separation: in-context working state vs. external memory store interface; file-backed session checkpoints enabling resume after interruption.
- Validation/enforcement layers demonstrating why prompts are insufficient for high-stakes paths (authorization, schema validation, deterministic limits enforced in code).
- Multi-agent cost accounting (token/cost tracking per agent) and a cost-vs-fit decision helper.
- MCP: client wiring that exposes MCP server tools to an agent, with least-privilege guidance.
- Examples for every topic above, runnable with a live provider key.

### STRICTLY OUT-OF-SCOPE

- Production deployment, hosting, CI/CD pipelines, Docker, observability backends (traces/metrics are emitted as typed events, not shipped to a vendor).
- A full peer-to-peer negotiation implementation (documented decision + protocol sketch only — the coordination cost is rarely justified; the codebase demonstrates why).
- UI/frontends, chat frontends, streaming UIs.
- Vector stores, RAG pipelines, fine-tuning, evaluation harnesses (evals), and model benchmarking.
- Persistent databases beyond a file-backed checkpoint store (the memory interface allows swapping one in).
- Authentication, multi-tenancy, network services — this is a library + examples, not a service.
- Provider-specific features beyond what the AI SDK abstracts; examples default to OpenAI via env var but remain provider-agnostic.

## 3. Constraints & Assumptions

**Constraints**

- C1. Language/runtime: TypeScript, Node.js ≥ 20, ESM, strict mode (`"strict": true`, no `any` leaks at public boundaries).
- C2. No Python anywhere in the deliverable (explicit user requirement overriding the original pydantic-ai preference).
- C3. Examples require a live API key (`OPENAI_API_KEY` by default); **tests must not** — tests use the AI SDK's mock language model so CI runs offline.
- C4. Zero placeholders: every committed file compiles and runs; anything not implementable in scope is listed as residual work, not stubbed.
- C5. Dependencies kept minimal: `ai`, `@ai-sdk/openai`, `zod`, `@modelcontextprotocol/sdk` (runtime); `typescript`, `vitest`, `tsx`, type packages (dev).
- C6. The AI SDK v7 API surface must be verified against installed type definitions before use (assumption A2 below).

**Assumptions (register)**

| ID | Assumption | Impact if wrong | Validation |
|---|---|---|---|
| A1 | Users have or can obtain an OpenAI (or other AI SDK provider) API key | Examples don't run; tests still pass | Documented in README + `.env.example` |
| A2 | AI SDK v7 retains `generateText`, `tool`, `stopWhen`/`stepCountIs`, and a mock model for tests | Core loop must be adapted to actual v7 surface | Read `node_modules/ai` type definitions after install; compiler verification |
| A3 | File-backed checkpoints (JSONL/JSON) are sufficient for teaching session continuity | Swap to DB later; interface already abstracts storage | Interface-based design, one file store implementation |
| A4 | Single-process orchestration is acceptable (no distributed task queues) | Would need queue infra; out of scope per boundary | Stated constraint; orchestrator is in-process async |
| A5 | Cost tracking uses provider-reported token usage with a static price table | Prices drift; table is data, easily updated | Prices isolated in one data file with a date stamp |

**Performance/logical constraints**

- P1. Fan-out concurrency must be bounded (default limit, configurable) to respect rate limits and cost budgets.
- P2. Every loop and retry has a hard budget (iterations, elapsed time, attempts); nothing runs unbounded.
- P3. All mutating tool paths must be idempotent or explicitly marked non-idempotent and non-retryable.

## 4. Prior Decisions (locked)

| # | Decision | Rationale | Revisit condition |
|---|---|---|---|
| D1 | TypeScript/Node, not Python/pydantic-ai | Explicit user requirement | Never (user mandate) |
| D2 | Vercel AI SDK Core as the LLM/tool primitive | Closest TS analog to pydantic-ai (Zod ≈ Pydantic, type-safe tools, provider-agnostic); user-confirmed | AI SDK abandonment or breaking v8 migration cost |
| D3 | Orchestration, decomposition, loop control, reliability built **explicitly in-repo** rather than via Mastra/LangGraph | The repo's purpose is to teach the patterns; frameworks would hide them | Project pivots from learning-reference to pure production library |
| D4 | Zod schemas at every trust boundary (tool I/O, handoff envelopes, checkpoints) | Runtime validation is the enforcement layer prompts can't provide | — |
| D5 | Hub-and-spoke as default topology; peer-to-peer documented but not implemented | Coordination cost of P2P exceeds benefit for the target use cases; the decision itself is teaching material | A genuine shared-negotiation use case appears |
| D6 | Location: `agent-systems/` subdirectory of the AgentFoundry workspace | User-confirmed; keeps the OpenCode config repo and the TS project cleanly separated | User moves it to its own repo |
| D7 | Examples use live keys; tests use mocked models | User-confirmed; keeps CI deterministic and free | — |

## 5. Task Breakdown

Workstreams (hierarchical decomposition; each leaf independently verifiable):

- **WS0 — Foundations**: project config, dependency install, AI SDK v7 API verification against installed types.
- **WS1 — Errors & reliability** (`core/errors`, `core/reliability`): taxonomy, classification, retry w/ backoff+jitter+idempotency, fallback chain with degradation labels.
- **WS2 — Loop & tools** (`core/loop`, `core/tools`): PRAO loop runner with budgets and transition policy; tool contract wrapper with schema validation, side-effect metadata, postcondition checks.
- **WS3 — Decomposition** (`core/decomposition`): typed task DAG, hierarchical/sequential/parallel constructors, topological executor with bounded concurrency.
- **WS4 — Orchestration & handoffs** (`core/orchestration`, `core/handoff`): hub-and-spoke orchestrator, pipeline, fan-out/fan-in with barrier, subagent contracts with authority/write-scope isolation, topology decision table; handoff envelope schema + send/ack/resume protocol.
- **WS5 — State & memory** (`core/state`): state-lifetime separation, `MemoryStore` interface + in-memory and file-backed implementations, session checkpoints with reconcile-on-resume.
- **WS6 — Validation & cost** (`core/validation`, `core/cost`): enforcement-layer pipeline (schema → policy → budget → postcondition), per-agent token/cost accounting, cost-vs-fit helper.
- **WS7 — MCP** (`core/mcp`): MCP client wiring exposing server tools as agent tools with permission scoping.
- **WS8 — Examples** (`examples/`, 15 files): one runnable demo per topic cluster, each with a header comment mapping it to the topic list.
- **WS9 — Tests** (`tests/`): unit tests per core module with mocked model; integration test of orchestrator + handoffs + checkpoints.
- **WS10 — Docs & verification**: README with topic map and trade-off discussions; `npm run typecheck` + `npm test` green.

Critical path: WS0 → WS1/WS2 → WS3 → WS4 → WS8/WS9 → WS10. WS5–WS7 fan out after WS2.

## 6. Verification Criteria

**Acceptance criteria**

- V1. `npm run typecheck` passes with zero errors under strict TypeScript.
- V2. `npm test` passes with **no network access and no API key** (mocked model), covering: error classification, retry budgets (incl. non-retryable refusal), fallback degradation order, loop stop/iterate/escalate transitions, tool postcondition rejection, DAG topological execution with a failing branch, fan-in conflict resolution, handoff envelope round-trip + schema rejection of malformed envelopes, checkpoint save/resume with stale-message detection, enforcement layer blocking an unauthorized action, cost accumulation.
- V3. Every topic in the user's list maps to at least one example file **and** one core module, verified by the topic map in `README.md`.
- V4. No file contains placeholder markers; every example has a complete `main()` and runs via `npm run example -- <name>` given a valid key.
- V5. Each retry/loop/fan-out path demonstrates a hard bound (attempt/iteration/concurrency limit) in code and in tests.

**Edge cases to test**

- E1. Tool throws after a side effect → classified non-retryable unless idempotency key present.
- E2. Identical failure repeated → stall detection stops the loop before iteration budget exhaustion.
- E3. Fallback chain exhausts → fails closed with a typed `DegradedError`, never silently returns weaker data unlabeled.
- E4. Parallel branch fails mid-fan-out → barrier records partial results; fan-in policy decides proceed/abort explicitly.
- E5. Malformed handoff envelope (missing `correlation_id`, wrong intent) → rejected by schema, ownership never inferred from silence.
- E6. Resume after crash → checkpoint reconciles recorded vs. actual state; completed effects are not replayed.
- E7. Policy violation (e.g., tool outside an agent's authority) → blocked by enforcement layer in code, not by prompt text.
- E8. Iteration/cost budget exhaustion → explicit stop-failure with evidence, never hidden behind a confident answer.

**Residual risks**

- R1. ~~AI SDK v7 API drift~~ **RESOLVED**: runtime and dev dependencies are pinned to exact versions (no semver ranges); the API surface was verified against installed type definitions at build time. Upgrades are now explicit, reviewable events.
- R2. ~~Static price table drift~~ **RESOLVED**: `stalePriceModels()` flags any price entry older than `PRICE_STALENESS_DAYS` (90) in every `CostReport`, so stale costs are labeled estimates instead of silently trusted. Updating `PRICE_TABLE` remains a manual, dated edit.
- R3. ~~Examples unverified without a live key~~ **RESOLVED**: examples support `AGENT_SYSTEMS_MOCK=1` (deterministic mock model, including JSON-schema instantiation for object generation), and `tests/examples-smoke.test.ts` executes every offline-capable example end-to-end in CI. Live-key execution is still recommended for real-model behavior, but wiring is fully verified.
- R4. Example 14 (MCP) is excluded from offline smoke tests because it spawns an external MCP server package via `npx`, which requires network access and a directory argument. It is type-checked; run it manually per its header instructions.

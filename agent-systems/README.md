# Agent Systems Foundry

A reference architecture for building reliable agentic systems in **TypeScript**, built on **Vercel AI SDK Core** + **Zod**. It is both a small library (`src/core/`) and a set of runnable examples (`examples/`) that teach the patterns by showing the machinery: orchestration, loop control, and reliability are implemented explicitly here instead of being hidden inside a framework.

The full spec-driven development plan (outcomes, scope, constraints, decisions, tasks, verification) is in [`SPEC.md`](./SPEC.md).

## Why this design

Three commitments drive everything:

1. **Enforcement lives in code, not prompts.** A prompt can guide a probabilistic model; it cannot enforce authorization, budgets, schema validity, or idempotency. Every high-stakes control in this repo is deterministic code (see `src/core/validation/`, `src/core/tools/`).
2. **Failures are classified before they are handled.** Every error becomes a typed `AgentError` with a category (tool / reasoning / environment / policy), a retryable flag, a side-effect status, and evidence. Unclassified failures are never retried (see `src/core/errors/`).
3. **Loops and plans are explicit state machines.** Stopping, iterating, recovering, clarifying, and escalating are typed transitions with recorded reasons and hard budgets — not emergent while-loop behavior (see `src/core/loop/`).

## Architecture

```
src/
├── index.ts                    Public API (layered re-exports)
└── core/
    ├── errors/                 Taxonomy + classification — everything builds on this
    ├── reliability/            Bounded retry (backoff+jitter, idempotency), fallback chains
    ├── tools/                  Tool contracts: schemas, side effects, authorization, postconditions
    ├── loop/                   PRAO loop: budgets, observations, stop/iterate/recover/clarify/escalate
    ├── decomposition/          Typed task DAG + sequential / parallel / hierarchical patterns
    ├── orchestration/          Subagents (authority, write scopes), hub-and-spoke, pipeline,
    │                           fan-out/fan-in with conflict policy, topology selection
    ├── handoff/                Typed envelope (Zod) + bus protocol with ack/dedup/expiry
    ├── state/                  Memory stores (in-memory, atomic file) + checkpoints + reconcile-on-resume
    ├── validation/             Enforcement layers: schema → authorization → budget → postcondition
    ├── cost/                   Per-agent token/USD accounting, multi-agent fit
    ├── trace/                  Typed span events + JSONL/console sinks — the audit artifact
    ├── evals/                  Golden datasets, deterministic scorers, LLM judge, pass-rate reports
    └── mcp/                    MCP client wiring with least-privilege tool allowlists
```

Layer rule: each module depends only on modules listed above it. There are no cycles; `errors/` depends on nothing internal.

## Topic map

Every topic this project set out to cover, and where it lives:

| Topic | Example | Core module |
|---|---|---|
| Agent workflows & chatbots | `01-prao-loop.ts` | `core/loop/` |
| Tool use as the foundation of agency | `01`, `02` | `core/tools/` |
| Perception–Reasoning–Action–Observation | `01` | `core/loop/prao.ts` |
| Loop control: stopping, iterating, escalating | `03` | `core/loop/prao.ts` |
| Breaking complex goals into subtasks | `04` | `core/decomposition/` |
| Decomposition: hierarchical, sequential, parallel | `04`, `05`, `06` | `core/decomposition/patterns.ts` |
| Sequential pipelines: design & trade-offs | `05` | `core/orchestration/pipeline.ts` |
| Parallel execution, fan-out/fan-in, synchronization | `06` | `core/orchestration/fanout.ts` |
| Adaptive planning: updating the plan mid-execution | `07` | `core/decomposition/graph.ts` |
| Ambiguity & incomplete specification | `08` | — (pattern + `decide` policy) |
| Orchestrator: directing, delegating, aggregating | `09` | `core/orchestration/hub-spoke.ts` |
| Subagent design, authority, isolation | `09` | `core/orchestration/subagent.ts` |
| Hub-and-spoke, pipeline, peer-to-peer | `09`, `05`, `15` | `core/orchestration/topology.ts` |
| Selecting the right topology | `15` | `core/orchestration/topology.ts` |
| Agent-to-agent message schemas | `10` | `core/handoff/envelope.ts` |
| Handoff protocols & continuity across agents | `10` | `core/handoff/protocol.ts` |
| In-context state vs. external memory | `11` | `core/state/memory.ts` |
| Session continuity across turns and failures | `11` | `core/state/session.ts` |
| Multi-agent cost and fit | `15` | `core/cost/tracker.ts` |
| Tool / reasoning / environment errors | `12` | `core/errors/taxonomy.ts` |
| Error detection | `12`, `13` | `core/errors/classify.ts`, `core/validation/` |
| Retry logic | `12` | `core/reliability/retry.ts` |
| Fallback chains & graceful degradation | `12` | `core/reliability/fallback.ts` |
| Why prompts are not sufficient (high-stakes paths) | `13` | `core/validation/enforcement.ts` |
| Validation & enforcement layers | `13` | `core/validation/enforcement.ts` |
| Human-in-the-loop approval gates | `17` | `core/validation/approval.ts` |
| Tools | `02`, `14` | `core/tools/contract.ts` |
| MCPs | `14` | `core/mcp/client.ts` |
| Observability & audit trails | `16` | `core/trace/` |
| Evaluating agent behavior (golden datasets, judges) | `18` | `core/evals/` |

## Quick start

```bash
npm install
cp .env.example .env      # add your OPENAI_API_KEY
npm test                  # 138 tests, fully offline (mocked model)
npm run typecheck
npm run example -- examples/01-prao-loop.ts
```

Examples `10`, `11`, and `15` need no API key — start there if you just want to see the mechanics. Example `14` additionally needs `npx` (it spawns the MCP filesystem server).

## Key patterns in one minute

**The PRAO loop** (`core/loop/prao.ts`): each iteration is one bounded `generateText` call; the result becomes a typed `Observation`; exactly one transition is chosen (`stop-success | iterate | recover | clarify | escalate | stop-failure`); budgets (iterations, elapsed time, tool calls, consecutive failures, identical outputs) are checked in code before acting. Budget exhaustion is a typed error with evidence — never a confident non-answer.

**Tool contracts** (`core/tools/contract.ts`): input schema → authorization (write scopes + domain gate) → bounded execution → output schema → postcondition. A write-scope denial is a `PolicyError` thrown by code; no prompt can talk its way past it.

**Reliability** (`core/reliability/`): retry only what classification marks transient, with an idempotency key or a declared side-effect safety proof, exponential backoff with full jitter, and a hard attempt budget. Fallback chains label exactly which guarantees each degraded step drops, and fail closed with a `DegradedError` when exhausted.

**Orchestration** (`core/orchestration/`): hub-and-spoke is the default; the hub validates every reply envelope before closing a task. Fan-in resolves conflicts by authority, then recency — never by vote. `selectTopology()` encodes the decision rule as data; peer-to-peer is documented and deliberately not implemented (coordination cost rarely justifies it — see SPEC decision D5).

**Continuity** (`core/handoff/`, `core/state/`): typed envelopes with `correlation_id`/`causation_id` audit chains, dedup, expiry, and explicit accept/reject (silence is never acceptance). Checkpoints record completed side effects so `reconcile()` on resume never replays them.

## Verification status

- `npm run typecheck` — clean under strict TypeScript, with exact-pinned dependencies.
- `npm test` — **138/138 green**, no network, no API key. This includes `tests/examples-smoke.test.ts`, which executes every offline-capable example end-to-end with `AGENT_SYSTEMS_MOCK=1` (a deterministic mock model that also instantiates JSON schemas for structured-output calls).
- Examples 10, 11, and 15 also run with no key and no mock flag.
- Example 14 (MCP) is type-checked but not smoke-tested: it spawns an external MCP server via `npx`, which needs network and a directory argument. Run it manually per its header (risk register R4 in `SPEC.md`).

**Try an example offline right now:**

```bash
AGENT_SYSTEMS_MOCK=1 npm run example -- examples/09-hub-and-spoke.ts
```

## Deliberate non-goals

Production deployment, streaming UIs, RAG, evals harnesses, distributed task queues, and unconstrained peer-to-peer negotiation — see Scope Boundaries in `SPEC.md`.

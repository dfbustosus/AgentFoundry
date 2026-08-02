# AgentFoundry

A reference architecture for building **reliable agentic systems in TypeScript** — a small typed library plus a runnable curriculum of examples, built on Vercel AI SDK Core and Zod.

Orchestration, loop control, and reliability are implemented explicitly in this repo rather than delegated to a heavy framework: the machinery is the lesson.

## Repository layout

```text
.
├── agent-systems/                    The project: library, examples, tests, spec
│   ├── SPEC.md                       Spec-driven development plan (outcomes, scope, risks)
│   ├── src/core/                     Library: loops, tools, orchestration, handoffs, state,
│   │                                 reliability, enforcement, cost, MCP
│   ├── examples/                     16 runnable examples (topic → example map in its README)
│   └── tests/                        115 tests, fully offline (mocked model)
├── scripts/validate-opencode.rb      Validator for the local dev tooling (gitignored config)
└── LICENSE
```

## What the library covers

**Core** (`agent-systems/src/core/`):

- **PRAO agent loops** — Perception–Reasoning–Action–Observation with typed observations, explicit stop/iterate/recover/clarify/escalate transitions, and hard budgets enforced in code.
- **Tool contracts** — typed input/output schemas, side-effect and idempotency declarations, authorization gates, timeouts, and postconditions. A tool is a contract, not a function with a description.
- **Error taxonomy & reliability** — every failure classified (tool / reasoning / environment / policy) before recovery; bounded retry with backoff, jitter, and idempotency guards; fallback chains with labeled graceful degradation.
- **Decomposition** — complex goals into a validated task DAG; sequential, parallel (fan-out/fan-in), and hierarchical patterns with bounded concurrency.
- **Orchestration** — hub-and-spoke orchestrator with verified delegation, schema-validated pipelines, deterministic fan-in conflict resolution, and a topology-selection decision rule.
- **Handoffs & state** — typed agent-to-agent envelopes (Zod) with audit chains, dedup, and expiry; session checkpoints with reconcile-on-resume so completed side effects are never replayed.
- **Enforcement layers** — schema → authorization → budget → postcondition, in deterministic code. Prompts guide; code decides.
- **Cost accounting** — per-agent token/USD tracking with price-staleness flags and a multi-agent cost-vs-fit check.
- **Tracing** — typed span events (loop iterations, transitions, tool calls, handoffs, delegations, cost) to JSONL or console sinks, correlated by trace id. The audit trail is data, not console scroll.
- **MCP** — client wiring with least-privilege tool allowlists.

## Quick start

```bash
cd agent-systems
npm install
npm test                                   # 115 tests, no network or API key
npm run example -- examples/01-prao-loop.ts
```

No API key? Run any example offline with the deterministic mock model:

```bash
AGENT_SYSTEMS_MOCK=1 npm run example -- examples/09-hub-and-spoke.ts
```

## Documentation

- [`agent-systems/README.md`](./agent-systems/README.md) — architecture, design rationale, and the full topic → example map.
- [`agent-systems/SPEC.md`](./agent-systems/SPEC.md) — the spec-driven development plan: outcomes, scope boundaries, constraints, decisions, task breakdown, verification criteria, and risk register.

## License

See [LICENSE](./LICENSE).

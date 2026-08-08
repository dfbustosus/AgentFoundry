# AgentFoundry

[![CI](https://github.com/dfbustosus/AgentFoundry/actions/workflows/ci.yml/badge.svg)](https://github.com/dfbustosus/AgentFoundry/actions/workflows/ci.yml)
[![GitHub Release](https://img.shields.io/github/v/release/dfbustosus/AgentFoundry?include_prereleases)](https://github.com/dfbustosus/AgentFoundry/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Node.js ≥ 20](https://img.shields.io/badge/Node.js-%E2%89%A5%2020-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![TypeScript strict](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![Code style: Biome](https://img.shields.io/badge/code_style-Biome-60A5FA?logo=biome&logoColor=white)](https://biomejs.dev)
[![Tests: offline](https://img.shields.io/badge/tests-offline%2C%20no%20API%20key-brightgreen)](#verification)

A reference architecture for building **reliable agentic systems in TypeScript** — a small typed library, a runnable curriculum of examples, and a working capstone application, built on Vercel AI SDK Core and Zod.

Orchestration, loop control, and reliability are implemented explicitly in this repo rather than delegated to a heavy framework: **the machinery is the lesson.**

## Contents

- [Features](#features)
- [Repository layout](#repository-layout)
- [Quick start](#quick-start)
- [Environments](#environments)
- [Documentation](#documentation)
- [Package support](#package-support)
- [Verification](#verification)
- [Contributing](#contributing)
- [Security](#security)
- [License](#license)

## Features

- **PRAO agent loops** — Perception–Reasoning–Action–Observation with typed observations, explicit stop/iterate/recover/clarify/escalate transitions, and hard budgets enforced in code.
- **Tool contracts** — typed input/output schemas, side-effect and idempotency declarations, authorization gates, timeouts, and postconditions.
- **Error taxonomy & reliability** — every failure classified (tool / reasoning / environment / policy) before recovery; bounded retry with backoff, jitter, and idempotency guards; fallback chains with labeled graceful degradation.
- **Decomposition & orchestration** — validated task DAGs (hierarchical, sequential, parallel), hub-and-spoke orchestrator with verified delegation, schema-validated pipelines, deterministic fan-in conflict resolution, topology selection.
- **Handoffs & state** — typed agent-to-agent envelopes (Zod) with audit chains, dedup, and expiry; crash-safe session checkpoints with reconcile-on-resume.
- **Enforcement layers** — schema → authorization → budget → human approval → postcondition, in deterministic code. High-stakes actions stop and wait for a real human decision, failing closed when none arrives.
- **Cost accounting** — per-agent token/USD tracking with price-staleness flags and a multi-agent cost-vs-fit check.
- **Tracing** — typed span events to JSONL or console sinks, correlated by trace id. The audit trail is data, not console scroll.
- **Evals** — golden datasets, deterministic scorers (exact/contains/regex/schema), and an LLM judge whose reasons are recorded as auditable evidence. Tests verify the machinery; evals verify behavior.
- **MCP** — client wiring with least-privilege tool allowlists.

## Repository layout

```text
.
├── agent-systems/                    The project: library, examples, capstone, tests, spec
│   ├── SPEC.md                       Spec-driven development plan (outcomes, scope, risks)
│   ├── src/core/                     Env-free core library (12 modules)
│   ├── src/config/                   Application-layer environment validation (Zod)
│   ├── examples/                     19 runnable examples (topic → example map in its README)
│   ├── capstone/                     Dogfood app: support-ticket triage agent on the public API
│   └── tests/                        160 tests, fully offline (mocked model)
├── .github/
│   ├── workflows/                    CI package gate + tag-triggered releases
│   ├── ISSUE_TEMPLATE/               Bug report and feature request templates
│   └── PULL_REQUEST_TEMPLATE.md
├── CONTRIBUTING.md                   Dev setup, verification, commit conventions
├── SECURITY.md                       Vulnerability reporting and trust model
├── CHANGELOG.md                      Keep-a-Changelog release notes
├── scripts/validate-opencode.rb      Validator for the local dev tooling (gitignored config)
└── LICENSE                           MIT
```

## Quick start

```bash
cd agent-systems
npm install
npm test                                   # 160 tests, no network or API key
npm run example -- examples/01-prao-loop.ts
```

No API key? Everything except the MCP example runs offline with the deterministic mock model:

```bash
AGENT_SYSTEMS_MOCK=1 npm run example -- examples/09-hub-and-spoke.ts
AGENT_SYSTEMS_MOCK=1 npm run capstone
```

## Environments

Runtime configuration is **typed and validated at load** (`agent-systems/src/config/env.ts`) — a misconfigured environment fails at startup with an actionable message, not mid-agent-loop. The core library itself is env-free; configuration lives at the edges.

| Variable | Values | Purpose |
|---|---|---|
| `NODE_ENV` | `development` (default) · `test` · `production` | Runtime environment |
| `OPENAI_API_KEY` | `sk-…` | Required for live model runs (not for tests or mock mode) |
| `AGENT_SYSTEMS_MODEL` | e.g. `gpt-4o-mini` (default) | Model for examples and capstone |
| `AGENT_SYSTEMS_MOCK` | `0` (default) · `1` | Offline deterministic mock; **forbidden in production** |

Copy [`agent-systems/.env.example`](./agent-systems/.env.example) to `agent-systems/.env` (or the repository root `.env`) for local development — the file is loaded automatically; shell variables always take precedence. Deployment environments (GitHub Environments with protection rules) become relevant only when a release/deploy workflow exists — the config layer already enforces the development/test/production distinction in code.

## Documentation

| Document | What it covers |
|---|---|
| [`agent-systems/README.md`](./agent-systems/README.md) | Architecture, design rationale, full topic → example map |
| [`agent-systems/SPEC.md`](./agent-systems/SPEC.md) | SDD plan: outcomes, scope, constraints, decisions, verification, risk register |
| [`agent-systems/capstone/README.md`](./agent-systems/capstone/README.md) | The dogfood app and its findings |
| [`CHANGELOG.md`](./CHANGELOG.md) | Release notes |
| [`CONTRIBUTING.md`](./CONTRIBUTING.md) | Dev setup, verification, commit conventions |
| [`SECURITY.md`](./SECURITY.md) | Vulnerability reporting and trust model |
| [`RELEASING.md`](./RELEASING.md) | SemVer, API compatibility, trusted publishing, rollback |

## Package support

- Package: `agent-systems-foundry` (ESM-only)
- Runtime: Node.js 20 and 22 are CI-tested; `engines` requires Node.js 20+
- TypeScript: strict declarations generated with TypeScript 5.9
- Current registry state: publication pending the one-time npm owner/trusted-publisher bootstrap
- Pre-releases use npm dist-tag `next`; stable releases use `latest`

## Verification

- `npm run typecheck` — strict TypeScript, exact-pinned dependencies.
- `npm run lint` — Biome lint + format.
- `npm test` — **160/160**, no network, no API key; includes end-to-end example smoke tests and capstone integration tests.
- `npm run package:verify` — `publint`, AreTheTypesWrong, and a clean consumer-project install/typecheck/runtime gate.
- CI enforces lint, typecheck, tests, package build, and consumer verification on every push and PR.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md). Conventional commits, one logical change per commit, and the verification suite must pass before pushing — CI will check anyway.

## Security

See [SECURITY.md](./SECURITY.md) for vulnerability reporting. Never commit `.env` or API keys; MCP servers and tool output are treated as untrusted data by design.

## License

[MIT](./LICENSE) © 2026 David Bustos Usta

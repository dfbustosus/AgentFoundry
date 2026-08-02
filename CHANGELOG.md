# Changelog

All notable changes to this project are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this project is pre-1.0 and uses semantic versioning once published.

## [Unreleased]

### Added

- **Typed environment layer** (`agent-systems/src/config/env.ts`): Zod-validated `loadEnv()` with development/test/production distinction, actionable startup errors, and a hard rule that mock mode is forbidden in production. Examples and capstone now read configuration exclusively through it.
- **Professional repo setup**: `CONTRIBUTING.md`, `SECURITY.md`, `.editorconfig`, `.gitattributes`, `CODEOWNERS`, issue templates (bug/feature), and a PR template with a verification checklist.
- **README badges and structure**: CI, MIT license, Node ≥ 20, TypeScript strict, Biome, offline-tests badges; table of contents; environments table; documentation index.
- **Capstone dogfood app** (`agent-systems/capstone/`): support-ticket triage agent built entirely on the public library API — contract tools with refund authorization and postconditions, PRAO triage loop, human approval gate on refunds > $100, JSONL tracing, and a behavioral eval suite (`npm run capstone`, `npm run capstone:eval`, both offline-capable).
- **Multi-turn chatbot example** (19): session continuity across turns with FileStore-backed history.
- **Biome lint/format** with a dedicated CI job; CI status badge in the README.

### Fixed

- Public API now re-exports the `Tool` type so consumers never import from SDK internals (dogfood finding from the capstone).

## [0.1.0] - 2026-08-02

Initial public state of the Agent Systems Foundry.

### Added

- **Core library** (`agent-systems/src/core/`): PRAO agent loop with hard budgets and explicit transitions; tool contracts with schemas, authorization, and postconditions; error taxonomy and classification; bounded retry and fallback chains; task-DAG decomposition (hierarchical, sequential, parallel); hub-and-spoke orchestrator, pipelines, fan-out/fan-in, topology selection; typed handoff envelopes and protocol; memory stores and crash-safe session checkpoints; enforcement layers; cost accounting with price-staleness detection; MCP client wiring with least-privilege allowlists.
- **Tracing**: typed span events (loop, tool, handoff, delegation, approval, cost) with JSONL and console sinks, correlated by trace id.
- **Human-in-the-loop approval gates**: fail-closed `ApprovalGate` slotted into the enforcement pipeline.
- **Evals**: golden datasets, deterministic scorers (exact/contains/regex/schema), auditable LLM judge, bounded runner with pass-rate reports.
- **Examples**: 19 runnable examples covering the full topic map; all but the MCP example run offline via `AGENT_SYSTEMS_MOCK=1`.
- **Tests**: 139 tests, fully offline (mocked model), including end-to-end example smoke tests.
- **CI**: GitHub Actions workflow — typecheck, tests, and Biome lint/format gate on Node 20 and 22; SHA-pinned actions, read-only permissions.
- **Docs**: root README, `agent-systems/README.md` with topic map, and `SPEC.md` with the full SDD plan and risk register.

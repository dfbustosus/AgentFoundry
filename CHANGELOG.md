# Changelog

All notable changes to this project are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this project is pre-1.0 and uses semantic versioning once published.

## [Unreleased]

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

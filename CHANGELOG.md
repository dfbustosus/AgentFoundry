# Changelog

All notable changes to this project are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this project is pre-1.0 and uses semantic versioning once published.

[Unreleased]: https://github.com/dfbustosus/AgentFoundry/compare/v0.3.0-rc.2...HEAD
[0.3.0-rc.2]: https://github.com/dfbustosus/AgentFoundry/compare/v0.3.0-rc.1...v0.3.0-rc.2
[0.3.0-rc.1]: https://github.com/dfbustosus/AgentFoundry/compare/v0.2.0...v0.3.0-rc.1
[0.2.0]: https://github.com/dfbustosus/AgentFoundry/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/dfbustosus/AgentFoundry/releases/tag/v0.1.0

## [Unreleased]

### Added

- **Cancellation-safe tool contracts**: authorization and execution callbacks receive a composed `AbortSignal`; contract deadlines and upstream cancellation settle non-cooperative work promptly, consume late rejections, clean up timers/listeners, and classify timeout retryability from the tool's side-effect and idempotency declarations.
- **Elapsed retry budgets**: `RetryPolicy.maxElapsedMs` and upstream `signal` bound attempts and backoffs under one monotonic deadline. `RetryAbortedError` distinguishes elapsed-budget exhaustion from caller cancellation, and every attempt receives the same cooperative signal.
- **Hard PRAO loop deadlines**: `maxElapsedMs` is now a monotonic deadline enforced before AND during each `generateText` call. The loop aborts in-flight model work at the deadline, settles promptly when a provider ignores the signal, consumes late rejections, and cleans up its timer and listeners on every exit path.
- **Caller cancellation for loops**: `PraoLoopOptions.signal` composes with the deadline into one `AbortSignal` that reaches every model call (and every tool execution). Cancellation is terminal, ends the loop as `stop-failure` with `environment.loop_cancelled` (distinct from `budget.exhausted` deadline exhaustion), and preserves partial observations, usage, and traces.
- **Loop budget validation**: malformed budgets (`maxIterations`, `maxElapsedMs`, `maxToolCalls`, `maxConsecutiveFailures`, `maxIdenticalOutputs`, `stepsPerIteration`) fail fast with `environment.invalid_loop_budget` before any model call.
- **Mutation gate now covers the PRAO loop**: `src/core/loop/prao.ts` joined the Stryker scope; 1,280 mutants at a 91.02% score (90% floor), up from 916 mutants.

### Changed

- Cancellation landing inside the loop's `decide` policy hook is still terminal: the loop never honors a decision (or a success observation) produced after the caller aborted.
- `BudgetExhaustedError` accepts an optional `sideEffect` override; loop deadline aborts report `unknown` (the in-flight model call may still complete externally) while between-iteration budgets remain `none`.
- The retry/fallback example now demonstrates both attempt and elapsed-time budgets. Cancellation bounds caller latency but cannot undo an external side effect from non-cooperative work; timed-out writes therefore retain conservative `unknown` side-effect metadata.

### Fixed

- Retry exhaustion and cancellation now aggregate side-effect evidence monotonically: any known occurrence remains `occurred`, an uncertain or in-flight attempt remains `unknown`, and cancellation during a fully side-effect-free backoff remains `none`.
- Retry policies reject `maxDelayMs` values above Node.js's maximum timer delay instead of allowing the runtime to collapse an oversized backoff to 1ms.
- Example 03 declared `maxToolCalls: 0` on a tool-less run, which exhausted the budget before acting instead of demonstrating a bounded success; the tool budget is now simply omitted there.

## [0.3.0-rc.2] - 2026-08-08

### Added

- **Public API compatibility gate**: API Extractor generates a committed contract report; CI fails on accidental export/type changes.
- **Governed npm publication workflow**: GitHub Release events publish prereleases under `next` and stable versions under `latest` using OIDC, provenance, tag/version validation, a protected `npm-production` approval environment, and registry read-back verification. No npm token is stored.
- **Release policy** (`RELEASING.md`): SemVer expectations, API-change review, one-time npm bootstrap, trusted-publisher configuration, and rollback procedure.
- **Coverage gate**: V8 coverage now fails below 90% statements, 78% branches, 90% functions, or 90% lines. HTML, LCOV, and JSON reports are retained as CI artifacts and summarized in the job report.
- **Property-based verification**: six seeded, bounded `fast-check` properties exercise DAG ordering and cycle rejection, retry budgets, cost aggregation, checkpoint replay safety, and handoff round-trips.
- **Mutation gate**: Stryker mutates 457 cases across reliability, session recovery, tool contracts, approvals, and deterministic enforcement. Twenty-five focused contract tests lifted the score from 65.21% to 91.68%; CI enforces a 90% floor and retains HTML/JSON reports.
- **Consumer compatibility matrix**: the packed ESM artifact is installed, typechecked, and executed across Node.js 22 and 24 with TypeScript 5.8.3 and 5.9.3.
- **Dependency audit gate**: CI fails on moderate-or-higher npm advisories.

### Changed

- **Approval gates enforce a real deadline**: `ApprovalGate` now races the handler against an actual timer, aborts cooperative handlers via `AbortSignal`, runtime-validates decisions with Zod, rejects late arrivals even with backdated timestamps, and requires every `ApprovalDecision` to carry the originating `requestId`. **Migration**: handlers must return `requestId: request.id` in each decision and may accept the new second `AbortSignal` parameter; older one-argument handlers remain assignable but decisions without a matching `requestId` fail closed.
- **Runtime floor raised to Node.js 22**: the pinned AI SDK packages require Node ≥ 22, so the previous `>=20` engine claim was unverifiable. CI now tests Node 22 and 24.
- **Publication workflow re-runs every gate**: `npm-publish.yml` now enforces audit, coverage, mutation, and minimum-TypeScript consumer compatibility before publishing, matching `RELEASING.md`.

### Fixed

- Release automation now marks hyphenated versions (`-rc`, `-beta`, `-alpha`) as GitHub pre-releases instead of normal releases.
- Patched Stryker's dev-only transitive `qs` advisory with a bounded `6.15.3` override; `npm audit` reports zero vulnerabilities.
- Strict consumers no longer need a synthetic `@types/json-schema` install: it is now a declared runtime dependency because `@ai-sdk/provider`'s published declarations import it.
- Mutation job summaries now compute scores with Stryker's valid-mutant formula instead of diverging when invalid mutants occur.

## [0.3.0-rc.1] - 2026-08-08

### Added

- **npm packaging**: `tsconfig.build.json` compiles `src/` to NodeNext ESM with declarations; `exports` map, `files` whitelist, `sideEffects: false`, `publishConfig` with provenance; `npm run build` / `prepack` verified with a dry-run tarball and a plain-Node import smoke test. CI now verifies package emit on every push.
- **Package consumer contract gate**: `npm pack` installs into a clean temporary TypeScript/Node project, typechecks public exports (including an intentional `@ts-expect-error` negative contract), and executes the compiled consumer. `publint --strict` and AreTheTypesWrong's ESM profile gate package metadata and declarations.
- **Dependabot**: weekly grouped update PRs for npm (`/agent-systems`) and GitHub Actions, gated by CI.
- **Release workflow**: pushing a `v*` tag creates the GitHub Release from the matching CHANGELOG section automatically.

### Fixed

- `.env` files are now actually loaded: `loadDotEnv()` searches the project dir then the repo root, never overrides shell variables, and `loadEnv()` hydrates from it before validation. Previously, running examples with only a `.env` file failed validation despite a correct key. Verified with a live end-to-end run of example 01 against the real provider.
- Cleared three dependency advisories (`fast-uri`, `hono`, `nanoid`) with bounded transitive updates; `npm audit` now reports zero production and development vulnerabilities.

## [0.2.0] - 2026-08-02

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

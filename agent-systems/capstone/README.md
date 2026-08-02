# Capstone — Support-Ticket Triage Agent

A small, real application built **entirely on the public library API** (`src/index.js`). It exists to prove the API is sufficient for a production-shaped use case — and to surface honest requirements from real usage (dogfooding).

## What it does

Triages the open support-ticket queue end to end:

1. **Reads** every open ticket (never judges from the subject alone);
2. **Prioritizes** it (data loss / money = high/urgent; how-to = low/medium);
3. **Handles refunds**: marks refund-pending, then issues the refund — but refunds above **$100** stop for **human approval** (fail-closed if no human answers);
4. **Closes** fully resolved tickets;
5. **Traces everything** to a JSONL file: every tool call, approval decision, and loop transition.

## Architecture (all library modules, no framework)

```text
capstone/
├── src/
│   ├── store.ts     Ticket system of record (FileStore-backed persistence)
│   ├── tools.ts     Six contract tools — the ONLY way the agent touches the store.
│   │                Refunds: write scope + domain authorization + approval gate + postcondition
│   ├── agent.ts     Triage agent: one PRAO loop with budgets, wired to the approval gate
│   └── run.ts       Entry point: seed → triage → report → trace
└── evals/
    └── run-evals.ts Behavioral acceptance test: golden triage scenarios + scorers
```

Library modules consumed: `tools`, `loop`, `validation/approval`, `state/memory`, `trace`, `evals`, `errors`.

## Run it

```bash
# Offline (mock model + scripted approver: ≤$50 approved, larger denied)
AGENT_SYSTEMS_MOCK=1 npm run capstone

# Live (real model + real terminal approval prompt)
npm run capstone

# Behavioral eval suite
npm run capstone:eval
AGENT_SYSTEMS_MOCK=1 npm run capstone:eval
```

Live runs persist data in `.capstone-data/` and traces in `traces/` (both gitignored).

## What it demonstrates that the examples don't

- The library modules **composed into one workflow** under one trace id, not isolated demos.
- A refund path where **three independent controls** must all pass: domain authorization (ticket must be refund-pending), the deterministic threshold check (refund ≤ requested), and human approval (refund > $100). The agent cannot talk its way past any of them — they are code.
- Behavioral acceptance via the evals module: `triage-behavior-v1` scores whether the agent's triage decisions are appropriate, with judge reasons recorded.

## Dogfood findings (and their resolution)

- The `Tool` type was not exported from the public API — the capstone originally imported it from `ai` directly. **Fixed**: the public API now re-exports `Tool`, so consumers never touch SDK internals.
- Declaring a tool-set interface sometimes needs explicit generics on `defineContractTool<I, O>` when a tool's inferred return type is a union (see `getTicket` in `src/tools.ts`) — documented pattern, acceptable for 0.x.

Everything else composed without touching library internals: store, tools, loop, approval gate, tracer, evals — one workflow under one trace id.

## Test coverage

`tests/capstone.test.ts` (offline, mock model): store seeding/idempotency/persistence, refund authorization refusal, over-request rejection, approval denial leaving the ticket refund-pending, approved refund + postcondition, full loop wiring.

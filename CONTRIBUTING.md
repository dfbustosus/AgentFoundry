# Contributing

Thanks for improving AgentFoundry. This document is the whole process — if anything here is unclear, open an issue instead of guessing.

## Dev setup

```bash
git clone https://github.com/dfbustosus/AgentFoundry.git
cd AgentFoundry/agent-systems
npm install
```

Node.js ≥ 20 is required (see `engines` in `agent-systems/package.json`).

## Before you push (all three are enforced by CI)

```bash
npm run typecheck   # strict TypeScript, zero errors
npm run lint        # Biome lint + format
npm test            # 160+ tests, fully offline — no API key needed
npm run package:verify # publishable package + clean-consumer contract
```

To run examples or the capstone offline: `AGENT_SYSTEMS_MOCK=1 npm run example -- examples/<file>`.

## Rules that keep this repo professional

1. **No placeholders.** If you cannot implement something completely, don't ship it — say so in the PR instead. `TODO`/`FIXME` markers do not merge.
2. **No secrets.** `.env` is gitignored; never commit keys. `.env.example` documents every variable.
3. **Conventional commits** — `feat|fix|docs|style|refactor|test|chore|ci|build(agent-systems): <imperative summary>`. One logical change per commit; mass formatting is always its own `style:` commit, never mixed with semantic changes.
4. **Evidence over confidence.** PRs state what was verified and how (tests added, commands run). If you couldn't verify something, say so explicitly.
5. **Core stays env-free.** `src/core/` receives everything through options; environment access belongs to the application layer (`src/config/`, examples, capstone).
6. **Prompts are not enforcement.** Authorization, budgets, schemas, and approvals belong in code (see `src/core/validation/`).

## Pull requests

- Fill in the PR template; link the issue it closes.
- Keep diffs reviewable: < ~400 lines of semantic change is a good ceiling.
- Update `CHANGELOG.md` under `[Unreleased]` and any README counts/tables your change affects.
- Public API changes must include the reviewed report from `npm run api:update`; see `RELEASING.md`.
- Expect review against, in order: correctness → security → failure handling → compatibility → performance → maintainability → style.

# Security Policy

## Reporting a vulnerability

Please **do not** open a public issue for security problems. Report privately via GitHub's "Report a vulnerability" (private security advisory) on this repository, or by contacting the maintainer listed on their GitHub profile.

You can expect an acknowledgement within 72 hours and an honest assessment — including "not a vulnerability, and here's why" when that's the case.

## Trust model (read this before running anything)

- **Secrets**: this repo never ships credentials. `OPENAI_API_KEY` is read from your environment and never logged. `.env` is gitignored; `.env.example` contains no real values.
- **Dependencies**: pinned to exact versions (`agent-systems/package-lock.json`); CI installs with `npm ci`. Review dependency diffs in PRs like code.
- **MCP servers**: example 14 connects to external MCP servers. MCP tool output is **untrusted data** — the library's enforcement layers, not the model, decide what actions may run. Enable only the servers you need, with least-privilege tool allowlists.
- **LLM output**: treated as untrusted throughout. High-stakes paths are guarded by deterministic enforcement layers and human approval gates — by design, not by prompt.
- **CI**: workflows run with read-only repository permissions, SHA-pinned actions, and no secrets.
- **Publishing**: npm publication uses GitHub OIDC trusted publishing from a protected environment; no long-lived npm write token is stored. Registry artifacts carry provenance.

## Scope notes

The library and examples are a reference architecture, not a managed service. The static price table in `src/core/cost/tracker.ts` is dated data, not a billing system. Validate your own threat model before deploying anything built on this code.

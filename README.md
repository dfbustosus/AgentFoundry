# AgentFoundry

Agent systems, end to end: a **TypeScript reference architecture** for building reliable agentic applications, plus a **project-local OpenCode team** for professional agentic, backend, AI, and quality engineering work.

## What's in this repository

```text
.
├── agent-systems/                    TypeScript reference architecture for agentic systems
│   ├── SPEC.md                       Spec-driven development plan (outcomes, scope, risks)
│   ├── src/core/                     Library: loops, tools, orchestration, handoffs, state,
│   │                                 reliability, enforcement, cost, MCP
│   ├── examples/                     15 runnable examples (topic → example map in its README)
│   └── tests/                        106 tests, fully offline (mocked model)
│
├── AGENTS.md                         Project-wide rules for the OpenCode team
├── opencode.json                     Default agent, permissions, context, and safety
├── .opencode/
│   ├── agents/                       18 Markdown agent definitions
│   ├── commands/                     7 reusable slash commands
│   ├── instructions/                 Team operations and quality policy
│   └── skills/<name>/SKILL.md        19 on-demand domain workflows
├── scripts/validate-opencode.rb      Validator for the OpenCode package
└── LICENSE
```

The two parts are complementary: `agent-systems/` teaches and implements the patterns; `.opencode/` operationalizes them as an AI engineering team you run from this repo.

## Part 1 — Agent Systems Foundry (`agent-systems/`)

A library + curriculum for building reliable agentic systems in TypeScript on Vercel AI SDK Core and Zod. Orchestration, loop control, and reliability are implemented explicitly — the machinery is the lesson.

- **Core library** (`src/core/`): PRAO agent loops with hard budgets, tool contracts with authorization and postconditions, error taxonomy, bounded retry and fallback chains, goal decomposition over a typed task DAG, hub-and-spoke orchestration, pipelines, fan-out/fan-in, typed handoff envelopes, session checkpoints with crash-safe resume, enforcement layers for high-stakes paths, cost accounting, and MCP client wiring.
- **Examples** (`examples/`): 15 runnable demos covering PRAO loops, decomposition, topologies, handoffs, memory, retries, enforcement, and MCP.
- **Tests** (`tests/`): 106 tests, no network or API key required.

```bash
cd agent-systems
npm install
npm test                                   # offline, 106 tests
npm run example -- examples/01-prao-loop.ts
AGENT_SYSTEMS_MOCK=1 npm run example -- examples/09-hub-and-spoke.ts   # no key needed
```

Full documentation: [`agent-systems/README.md`](./agent-systems/README.md) · Spec: [`agent-systems/SPEC.md`](./agent-systems/SPEC.md)

## Part 2 — OpenCode team (`.opencode/`)

A project-local OpenCode team: 18 specialized agents, 19 on-demand skills, shared operating rules, least-privilege permissions, typed handoffs, and ready-to-use commands. OpenCode discovers these files directly from the repository — no global installation or hard-coded model provider required.

### Agent team

| Agent | Mode | Primary responsibility |
|---|---|---|
| `agent-orchestrator` | Primary | Goal ownership, topology, delegation, fan-in, continuity |
| `node-backend-engineer` | Subagent | Hands-on Node.js/TypeScript services and runtime behavior |
| `senior-typescript-backend` | Subagent | Domain types, contracts, data consistency, migrations |
| `technical-lead` | Subagent | 30+ year veteran delivery and design judgment |
| `ai-researcher` | Subagent | Hypotheses, primary evidence, experiments, ablations |
| `github-actions-engineer` | Subagent | Secure GitHub Actions CI/CD |
| `node-code-quality-expert` | Subagent | Read-only DRY/SOLID/KISS/YAGNI/SRP review |
| `software-architect` | Subagent | Read-only architecture and ADR decisions |
| `mcp-engineer` | Subagent | MCP servers, tools, resources, prompts, and security |
| `mlops-engineer` | Subagent | Reproducible production ML lifecycle |
| `software-patterns-engineer` | Subagent | Pragmatic patterns and evolutionary refactoring |
| `qa-engineer` | Subagent | Risk-based test design and automation |
| `senior-qa-reviewer` | Subagent | Independent release gate and residual-risk review |
| `llm-engineer` | Subagent | Production LLM systems and evaluations |
| `foundation-model-researcher` | Subagent | Foundation model evidence and adaptation |
| `rag-engineer` | Subagent | Retrieval, grounding, citations, and RAG evaluation |
| `graph-engineer` | Subagent | Graph data, knowledge graphs, algorithms, GraphRAG |
| `semantic-nlp-engineer` | Subagent | Semantic/NLP pipelines, embeddings, multilingual evaluation |

The orchestrator is the only agent allowed to invoke subagents. Specialists cannot create nested agent trees, which keeps authority, cost, and continuity under one owner.

### Core skills

The workflow skills cover:

- perception–reasoning–action–observation loops and tool contracts;
- stopping, iteration, retry, fallback, degradation, and escalation;
- hierarchical, sequential, parallel, and hybrid decomposition;
- hub-and-spoke, pipeline, fan-out/fan-in, peer-to-peer, and topology selection;
- ambiguity, assumptions, adaptive replanning, and decision records;
- typed agent messages, handoffs, external state, checkpoints, and recovery;
- deterministic validation and enforcement for high-stakes paths.

Domain skills cover Node.js/TypeScript, code quality, architecture, GitHub Actions, MCP, MLOps, QA, AI research, LLMs, foundation models, RAG, graphs, and semantic NLP. Skills load on demand; each agent sees only the skills assigned to its role.

### Use

Start OpenCode from this repository:

```bash
opencode
```

`agent-orchestrator` is the configured default. You can also mention a specialist directly:

```text
@software-architect review the boundaries in this service design
@senior-qa-reviewer assess the release evidence for this change
```

Useful commands:

```text
/orchestrate <complex goal>
/backend-build <backend task>
/architecture-review <system or proposal>
/qa-gate <change or release>
/ai-research <research question>
/mcp-design <MCP requirement>
/rag-review <RAG system or issue>
```

Validate the complete package after any change:

```bash
ruby scripts/validate-opencode.rb
opencode debug config
```

### Safety model

The global policy allows repository reads and requires approval for edits, shell commands, web access, and unknown tools. Destructive Git and shell operations are denied. Access outside the worktree and environment-secret reads are denied.

Implementation specialists may edit project files within their bounded role. Review agents are read-only. MCP and web access remain subject to explicit agent policy.

Review `opencode.json` before using auto-approval. Auto mode does not broaden explicit denials, but it can approve actions otherwise configured as `ask`.

### Models

No model IDs are pinned. The primary agent uses your configured OpenCode model; subagents inherit the invoking primary agent's model. Add a `model: provider/model-id` field to an agent only when you have evaluated that exact model for the role.

### Add MCP servers

No live MCP server is enabled because no endpoint, command, authentication method, or trust policy was provided. Add only the servers the team needs; every enabled server increases context and attack surface.

Example remote server:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "example": {
      "type": "remote",
      "url": "https://mcp.example.com/mcp",
      "enabled": true,
      "headers": {
        "Authorization": "Bearer {env:EXAMPLE_MCP_TOKEN}"
      },
      "oauth": false
    }
  },
  "permission": {
    "example_*": "ask"
  }
}
```

Prefer OAuth for supported protected remote servers, use least-privilege scopes, and never commit credentials. MCP tools are prefixed with the configured server name, so target their permissions with `<server>_*`.

### Customize safely

- Change global approval behavior in `opencode.json`.
- Add exact provider model IDs only after evaluation.
- Extend an agent's `permission.skill` allowlist when its mandate genuinely expands.
- Add a specialist to the orchestrator's `permission.task` allowlist.
- Keep one canonical owner for the user goal.
- Preserve the handoff schema in `.opencode/instructions/team-operations.md`.
- Validate every new `SKILL.md` name against its directory name.

## Official references

- [OpenCode agents](https://opencode.ai/docs/agents)
- [OpenCode agent skills](https://opencode.ai/docs/skills)
- [OpenCode rules](https://opencode.ai/docs/rules/)
- [OpenCode permissions](https://opencode.ai/docs/permissions)
- [OpenCode commands](https://opencode.ai/docs/commands/)
- [OpenCode MCP servers](https://opencode.ai/docs/mcp-servers/)
- [Model Context Protocol specification](https://modelcontextprotocol.io/specification)
- [Vercel AI SDK](https://ai-sdk.dev/docs)
- [GitHub Actions secure use](https://docs.github.com/en/actions/reference/security/secure-use)

## License

See [LICENSE](./LICENSE).

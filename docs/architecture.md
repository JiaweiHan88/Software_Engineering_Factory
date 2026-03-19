# BMAD Copilot Factory — Architecture

## System Overview

```
┌─────────────────────────────────────────────────────┐
│                    Paperclip                         │
│  (Orchestration: org chart, goals, heartbeats)      │
│                                                      │
│  CEO ─── PM ─── Architect                           │
│           │                                          │
│          PO ─── Developer ─── Code Reviewer          │
└──────────────────────┬──────────────────────────────┘
                       │ Heartbeat (JSON)
                       ▼
┌─────────────────────────────────────────────────────┐
│              Heartbeat Adapter                        │
│  src/adapter/heartbeat-handler.ts                    │
│  Translates Paperclip heartbeats → SDK sessions      │
└──────────────────────┬──────────────────────────────┘
                       │ JSON-RPC
                       ▼
┌─────────────────────────────────────────────────────┐
│              GitHub Copilot SDK                       │
│  customAgents → BMAD personas (PM, Arch, Dev, etc.) │
│  defineTool()  → BMAD tools (create-story, etc.)    │
│  skills        → methodology & quality gate prompts  │
│  hooks         → intercept tool calls for logging    │
│  MCP           → external tool servers               │
└──────────────────────┬──────────────────────────────┘
                       │ JSON-RPC
                       ▼
┌─────────────────────────────────────────────────────┐
│              Copilot CLI (headless)                   │
│  copilot --headless --port 4321                      │
│  Model: Claude Sonnet 4.5 (default)                  │
│  Auto-compaction at 95% token limit                  │
└─────────────────────────────────────────────────────┘
```

## Data Flow

### 1. Paperclip Heartbeat → Agent Action

```
Paperclip sends heartbeat → {role: "engineer", goal: "implement STORY-003"}
  ↓
Heartbeat Adapter receives JSON
  ↓
Maps role → BmadAgent (e.g., "engineer" → bmad-developer)
  ↓
Creates Copilot SDK session with agent persona + tools
  ↓
Sends goal as prompt to agent session
  ↓
Agent uses tools (read files, write code, run tests)
  ↓
Adapter returns result to Paperclip
```

### 2. Story Lifecycle Flow

```
PM Agent                    PO Agent
  │                           │
  ├─ create-story tool        ├─ sprint-status tool
  │  └─ writes story.md      │  └─ prioritize backlog
  │  └─ status: backlog      │  └─ status: ready-for-dev
  │                           │
  ▼                           ▼
Dev Agent                   Review Agent
  │                           │
  ├─ dev-story tool           ├─ code-review tool
  │  └─ implements code       │  └─ adversarial review
  │  └─ status: review        │  └─ pass → done
  │                           │  └─ fail → fix-in-place
  │                           │  └─ 3 fails → escalate
```

## Directory Structure

```
src/
├── agents/          # BMAD agent persona definitions
│   ├── types.ts     # BmadAgent interface
│   ├── *.ts         # One file per role (PM, Arch, Dev, CR, PO)
│   ├── registry.ts  # Agent lookup
│   └── index.ts     # Barrel exports
│
├── tools/           # Copilot SDK tool definitions (defineTool)
│   ├── types.ts     # BmadToolDefinition interface
│   ├── *.ts         # One file per tool
│   └── index.ts     # Barrel exports
│
├── adapter/         # Paperclip ↔ Copilot SDK bridge
│   └── heartbeat-handler.ts
│
├── skills/          # Copilot skills (prompt modules)
│   ├── bmad-methodology/skill.md
│   └── quality-gates/skill.md
│
├── mcp/             # MCP server definitions (Phase 5)
│
├── config/          # Runtime configuration
│
└── sandbox/         # Smoke-test scripts
    ├── hello-copilot.ts
    └── test-agent.ts
```

## Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| Copilot SDK over raw LLM calls | Built-in tools, MCP, session management, auto-compaction |
| Paperclip over custom orchestrator | Production-grade org charts, budgets, governance |
| Skills over inline prompts | Reusable, versionable methodology as directory modules |
| Adversarial code review | BMAD's quality-gated loop prevents regressions |
| TypeScript throughout | Type safety for agent/tool interfaces, SDK is TS-first |
| ESM modules | Modern module system, tree-shakeable, SDK compatible |

## Security Considerations

- **No secrets in code** — use environment variables and `.env` files
- **Copilot CLI auth** — uses `gh auth` token (never stored in repo)
- **BYOK optional** — can bring own API keys for alternative models
- **Docker isolation** — Paperclip runs in containers, not on host
- **Tool sandboxing** — Copilot CLI `--disallowed-tools` for production

## Scaling Path

1. **Phase 1-3**: Single Copilot CLI instance, one agent at a time
2. **Phase 4**: Multiple CLI instances per Paperclip role (parallel agents)
3. **Phase 5**: MCP servers for external tool integration
4. **Phase 6**: Full autonomous loop with Paperclip governance
5. **Phase 7**: Multi-project support, Clipper preset distribution

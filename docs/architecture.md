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

### 1. Paperclip Issue Assignment → Agent Action (Push Model)

```
Paperclip server invokes heartbeat on agent
  ↓
Agent receives assigned issue via inbox or webhook callback
  (GET /api/agents/me/inbox-lite  or  POST webhook)
  ↓
Heartbeat Handler converts PaperclipIssue → HeartbeatContext
  ↓
Maps assignee → BmadAgent (e.g., "engineer" → bmad-developer)
  ↓
Creates Copilot SDK session with agent persona + tools
  ↓
Sends goal as prompt to agent session
  ↓
Agent uses tools (read files, write code, run tests)
  ↓
Result posted back as issue comment (POST /api/issues/:id/comments)
```

**Integration modes:**
- **Inbox-polling bridge** (dev): Periodically checks `GET /api/agents/me/inbox-lite`
- **Webhook server** (prod): Paperclip calls `POST /api/agents/:id/heartbeat/invoke` → BMAD webhook

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
├── mcp/             # MCP server definitions
│   ├── index.ts     # Barrel exports
│   └── bmad-sprint-server/
│       ├── index.ts # stdio MCP server entry point
│       └── tools.ts # 5 tool handlers (sprint, stories, arch docs)
│
├── observability/   # Production observability stack
│   ├── index.ts     # Barrel exports
│   ├── logger.ts    # Structured JSON/human-readable logger
│   ├── tracing.ts   # OpenTelemetry distributed tracing
│   ├── metrics.ts   # OTel counters, histograms, gauges
│   └── stall-detector.ts  # Stuck story detection & alerting
│
├── quality-gates/   # BMAD adversarial review system
│   ├── types.ts     # Severity, findings, verdicts
│   ├── engine.ts    # Pure gate evaluation logic
│   ├── review-orchestrator.ts  # Multi-pass review loop
│   └── tool.ts      # Copilot SDK quality_gate_evaluate tool
│
├── config/          # Runtime configuration
│   ├── config.ts    # BmadConfig with env loading
│   └── model-strategy.ts  # Complexity→model tier routing
│
└── sandbox/         # Smoke-test scripts
    ├── hello-copilot.ts
    └── test-agent.ts
```

## Observability Architecture (Phase 7)

### Structured Logging

All modules use `Logger.child("component-name")` for structured output:
- **JSON mode** (`LOG_FORMAT=json`) — one JSON object per line, for Grafana Loki / log aggregators
- **Human mode** (`LOG_FORMAT=human`) — colored, timestamped, for local development

### Distributed Tracing (OpenTelemetry)

When `OTEL_ENABLED=true`, spans are exported via OTLP to Jaeger/Grafana Tempo:
```
sprint.cycle (root)
  ├── story.process (per story)
  │   └── agent.dispatch (per phase)
  └── quality_gate.evaluate (per review pass)
```

### Metrics (OpenTelemetry)

| Metric | Type | Description |
|--------|------|-------------|
| `bmad.stories.processed` | Counter | Stories processed by phase |
| `bmad.stories.done` | Counter | Stories reaching done |
| `bmad.agent.dispatch_duration` | Histogram | Agent dispatch latency (ms) |
| `bmad.review.passes` | Counter | Review passes executed |
| `bmad.gate.verdicts` | Counter | Gate verdicts by outcome |
| `bmad.sessions.active` | UpDownCounter | Active Copilot SDK sessions |
| `bmad.stall.detections` | Counter | Stalled stories detected |
| `bmad.sprint.cycles` | Counter | Sprint cycles executed |

### Stall Detection

Monitors stories stuck in a phase beyond configurable thresholds:
- `ready-for-dev`: 30 min (default)
- `in-progress`: 60 min (default)
- `review`: 30 min (default)

### Model Strategy (BYOK Cost Routing)

Complexity-based model selection with 3 tiers:
| Tier | Copilot Model | BYOK Anthropic | BYOK OpenAI | Used For |
|------|--------------|----------------|-------------|----------|
| fast | gpt-4o-mini | claude-haiku-3.5 | gpt-4o-mini | Status checks, simple queries |
| standard | claude-sonnet-4.5 | claude-sonnet-4.5 | gpt-4o | Code generation, normal dev |
| powerful | claude-sonnet-4.5 | claude-opus-4 | o3 | Architecture, security audit |

## Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| Copilot SDK over raw LLM calls | Built-in tools, MCP, session management, auto-compaction |
| Paperclip over custom orchestrator | Production-grade org charts, budgets, governance. Push model: Paperclip invokes heartbeats on agents. Company-scoped data model. Issues (not tickets). Results via issue comments. |
| Skills over inline prompts | Reusable, versionable methodology as directory modules |
| Adversarial code review | BMAD's quality-gated loop prevents regressions |
| TypeScript throughout | Type safety for agent/tool interfaces, SDK is TS-first |
| ESM modules | Modern module system, tree-shakeable, SDK compatible |
| OpenTelemetry for observability | Vendor-neutral, exports to Jaeger/Grafana/Prometheus |
| Structured logging over console.log | Machine-parseable JSON for production, human-readable for dev |
| Complexity-based model routing | Optimizes cost: fast tier for simple tasks, powerful for complex |
| BYOK cost routing | Preserves Copilot quota for interactive work, routes batch to BYOK |
| Stall detection | Prevents stories stuck in a phase indefinitely; auto-escalation |

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

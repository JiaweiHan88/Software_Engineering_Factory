# BMAD Copilot Factory

> Autonomous Software Building Factory — Paperclip orchestration + GitHub Copilot SDK agents + BMAD Method

[![Tests](https://img.shields.io/badge/tests-160%20passing-brightgreen)]()
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7%2B-blue)]()
[![Node](https://img.shields.io/badge/Node.js-20%2B-green)]()
[![Copilot SDK](https://img.shields.io/badge/Copilot%20SDK-0.1.32-purple)]()

## What is this?

A 3-layer autonomous software development system:

| Layer | Tool | Role |
|-------|------|------|
| **Orchestration** | [Paperclip](https://github.com/paperclipai/paperclip) | Org charts, goals, budgets, governance, heartbeats |
| **Methodology** | [BMAD Method](https://github.com/bmad-code-org/BMAD-METHOD) | Sprint lifecycle, story creation, adversarial code review, quality gates |
| **Execution** | [Copilot SDK](https://github.com/github/copilot-sdk) | Programmable agent runtime: custom agents, tools, MCP, skills |

The factory reads a `sprint-status.yaml`, dispatches stories to specialized AI agents (PM, Architect, Developer, QA, Scrum Master), enforces quality gates with severity-scored adversarial review, and advances stories through the BMAD lifecycle — all autonomously.

## Architecture

```
┌──────────────────────────────────────────────────┐
│              PAPERCLIP SERVER                     │
│   Org chart · Goals · Budgets · Governance        │
│   CEO → PM → Architect → Dev → QA → PO            │
│                  ▼ heartbeats                     │
├──────────────────────────────────────────────────┤
│           COPILOT SDK ADAPTER                     │
│   9 BMAD Agents · 6 Tools · MCP Server · Skills   │
│   Quality Gates · Model Strategy · Stall Detector  │
│                  ▼ JSON-RPC                       │
├──────────────────────────────────────────────────┤
│           COPILOT CLI (headless)                  │
│   File ops · Git ops · Shell · MCP servers         │
│                  ▼ LLM calls                      │
├──────────────────────────────────────────────────┤
│   Claude Sonnet 4.5 · GPT-4o · Claude Opus 4      │
│   (tier-based routing: fast / standard / powerful) │
└──────────────────────────────────────────────────┘
```

## Quick Start

### Prerequisites

- **Node.js** 20+ (tested on 25.8.1)
- **pnpm** 10+
- **GitHub Copilot CLI** (`gh copilot --version`)
- **GitHub Copilot subscription**
- **Docker** (optional — for Paperclip and observability stack)

### Install

```bash
pnpm install
```

### Run (dry-run — no SDK calls)

```bash
pnpm start:dry-run
```

### Run (live — requires Copilot CLI)

```bash
pnpm start                              # Process all actionable stories
pnpm start -- --story STORY-001         # Process a single story
pnpm start -- --dispatch dev-story S-1  # Run one phase for one story
pnpm start -- --status                  # Health check + sprint summary
```

### Run with observability

```bash
pnpm observability:up                   # Start Jaeger + Prometheus + Grafana
pnpm start:otel                         # Run factory with telemetry export
open http://localhost:3000              # Grafana dashboards (admin/bmad)
open http://localhost:16686             # Jaeger trace explorer
```

### Run with Paperclip

```bash
docker compose up -d                    # Start Paperclip + PostgreSQL
pnpm start:paperclip                    # Run heartbeat-driven loop
```

### Run tests

```bash
pnpm test                               # 160 tests, ~660ms
pnpm test:watch                         # Watch mode
pnpm typecheck                          # TypeScript strict check
```

## CLI Modes

| Mode | Command | Description |
|------|---------|-------------|
| Sprint cycle | `pnpm start` | Process all actionable stories in one cycle |
| Single story | `pnpm start -- --story STORY-001` | Process one story only |
| Single dispatch | `pnpm start -- --dispatch dev-story S-001` | Run one phase for one story |
| Dry run | `pnpm start:dry-run` | Full pipeline, no SDK calls |
| Status | `pnpm start:status` | Health check + sprint summary |
| Paperclip | `pnpm start:paperclip` | Heartbeat-driven loop |
| With OTel | `pnpm start:otel` | Sprint cycle with telemetry export |
| MCP server | `pnpm mcp:sprint` | Expose sprint data via MCP |

## Project Structure

```
src/
├── agents/              # 9 BMAD agent persona definitions
│   ├── types.ts         # BmadAgent interface
│   ├── registry.ts      # Agent lookup + allAgents array
│   ├── developer.ts     # bmad-dev
│   ├── product-manager.ts # bmad-pm
│   ├── architect.ts     # bmad-architect
│   ├── qa-engineer.ts   # bmad-qa
│   ├── scrum-master.ts  # bmad-sm
│   └── ...              # analyst, tech-writer, ux-designer, quick-flow
│
├── tools/               # Copilot SDK defineTool() implementations
│   ├── create-story.ts  # Story creation from backlog
│   ├── dev-story.ts     # Story implementation
│   ├── code-review.ts   # Adversarial code review
│   ├── sprint-status.ts # Sprint YAML read/write
│   └── types.ts         # Tool type definitions
│
├── adapter/             # Orchestration engine
│   ├── session-manager.ts    # CopilotClient wrapper with session lifecycle
│   ├── agent-dispatcher.ts   # Phase → agent routing with model selection
│   ├── sprint-runner.ts      # Story lifecycle engine
│   ├── health-check.ts       # 5-probe system readiness check
│   ├── paperclip-client.ts   # Paperclip REST API client
│   ├── paperclip-loop.ts     # Heartbeat-driven integration loop
│   ├── heartbeat-handler.ts  # Paperclip → BMAD bridge
│   └── reporter.ts           # Status reporting to Paperclip
│
├── quality-gates/       # BMAD adversarial review system
│   ├── types.ts         # Severity, findings, verdicts
│   ├── engine.ts        # Pure gate evaluation logic
│   ├── review-orchestrator.ts  # Multi-pass review loop
│   └── tool.ts          # quality_gate_evaluate tool
│
├── observability/       # Production observability stack
│   ├── logger.ts        # Structured JSON/human-readable logger
│   ├── tracing.ts       # OpenTelemetry distributed tracing
│   ├── metrics.ts       # OTel counters, histograms, gauges
│   └── stall-detector.ts # Stuck story detection + alerting
│
├── config/              # Runtime configuration
│   ├── config.ts        # BmadConfig with env var loading
│   └── model-strategy.ts # Complexity → model tier routing
│
├── mcp/                 # MCP server (VS Code integration)
│   └── bmad-sprint-server/
│       ├── index.ts     # Stdio MCP server entry
│       └── tools.ts     # 5 tool handlers
│
├── skills/              # Copilot SDK skill prompts
│   ├── bmad-methodology/
│   └── quality-gates/
│
└── index.ts             # Main entry point + CLI parsing

test/                    # 160 tests across 10 files
observability/           # Docker observability stack configs
templates/               # Paperclip role templates + Clipper presets
_bmad-output/            # Sprint artifacts (stories, reviews, status)
docs/                    # Architecture, PRD, research
```

## BMAD Agents

| Agent | Name | Role |
|-------|------|------|
| Product Manager | `bmad-pm` | Writes PRDs, defines stories, prioritizes backlog |
| Architect | `bmad-architect` | System design, tech stack decisions, data models |
| Developer | `bmad-dev` | Implements stories, writes code and tests |
| QA Engineer | `bmad-qa` | Adversarial code review with severity scoring |
| Scrum Master | `bmad-sm` | Sprint planning, status tracking |
| Analyst | `bmad-analyst` | Requirements analysis, research |
| UX Designer | `bmad-ux` | UI/UX design guidance |
| Tech Writer | `bmad-tech-writer` | Documentation |
| Quick-Flow Solo Dev | `bmad-quick-flow` | Combined dev+review for simple tasks |

## Story Lifecycle

```
backlog → ready-for-dev → in-progress → review → done
                                          │
                                          ├─ PASS → done ✅
                                          ├─ FAIL → fix → re-review (max 3) ↩
                                          └─ ESCALATE → human intervention ⚠️
```

## Quality Gates

Adversarial code review with weighted severity scoring:

| Severity | Weight | Blocks Merge |
|----------|--------|-------------|
| LOW | 1 | No |
| MEDIUM | 3 | No |
| HIGH | 7 | **Yes** |
| CRITICAL | 15 | **Yes** |

Categories: correctness, security, performance, error-handling, type-safety, maintainability, testing, documentation, style.

## Model Strategy

Complexity-based model tier routing to optimize cost:

| Tier | Used For | Copilot Default | BYOK Anthropic | BYOK OpenAI |
|------|----------|-----------------|----------------|-------------|
| fast | sprint-status | gpt-4o-mini | claude-haiku-3.5 | gpt-4o-mini |
| standard | create-story, dev-story | claude-sonnet-4.6 | claude-sonnet-4.5 | gpt-4o |
| powerful | code-review, architecture | claude-opus-4.6 | claude-opus-4 | o3 |

## Observability

When `OTEL_ENABLED=true`, the factory exports traces and metrics via OTLP:

```
Factory → OTel Collector → Jaeger (traces) + Prometheus (metrics) → Grafana
```

Pre-built Grafana dashboard includes:
- Stories processed / done counters
- Agent dispatch latency (p50/p95/p99)
- Quality gate verdicts (pie chart)
- Active sessions gauge
- Stall detections counter
- Review passes timeline

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `COPILOT_MODEL` | `claude-sonnet-4.6` | Default LLM model |
| `LOG_LEVEL` | `info` | Log level: debug, info, warn, error |
| `LOG_FORMAT` | `human` | Output format: json, human |
| `OTEL_ENABLED` | `false` | Enable OpenTelemetry export |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `http://localhost:4317` | OTLP endpoint |
| `PAPERCLIP_ENABLED` | `false` | Enable Paperclip integration |
| `PAPERCLIP_URL` | `http://localhost:3100` | Paperclip server URL |
| `MODEL_PREFER_BYOK` | `false` | Prefer BYOK over Copilot quota |
| `STALL_AUTO_ESCALATE` | `false` | Auto-escalate stalled stories |

See [PRD](./docs/PRD.md) for the full environment variable reference (22 variables).

## Test Suite

160 tests across 10 files, running in ~660ms:

```
 ✓ test/quality-gate-engine.test.ts    (24 tests)
 ✓ test/model-strategy.test.ts         (22 tests)
 ✓ test/paperclip-client.test.ts       (21 tests)
 ✓ test/health-check.test.ts           (19 tests)
 ✓ test/session-manager.test.ts        (19 tests)
 ✓ test/agent-dispatcher.test.ts       (17 tests)
 ✓ test/stall-detector.test.ts         (12 tests)
 ✓ test/logger.test.ts                  (9 tests)
 ✓ test/review-orchestrator.test.ts     (9 tests)
 ✓ test/sprint-runner.test.ts           (8 tests)

 Test Files  10 passed (10)
      Tests  160 passed (160)
```

## Documentation

| Doc | Description |
|-----|-------------|
| [PRD](./docs/PRD.md) | Product Requirements Document — all functional & non-functional requirements |
| [Architecture](./docs/architecture.md) | System design, data flow, observability, design decisions |
| [Implementation Plan](./IMPLEMENTATION-PLAN.md) | Phased build plan with delivery summaries per phase |
| [Research](./research-autonomous-sw-factory.md) | Technical research on autonomous software building systems |

## Project Status

**✅ All 8 implementation phases complete.**

| Phase | What |
|-------|------|
| Phase 0 | Project scaffolding, TypeScript config, docs |
| Phase 1 | Copilot SDK connectivity verified |
| Phase 2 | BMAD tools wired to `defineTool()` |
| Phase 3 | Orchestrator engine (SessionManager + AgentDispatcher + SprintRunner) |
| Phase 4 | Paperclip integration (REST client, heartbeat loop, Docker) |
| Phase 5 | MCP server (5 tools for VS Code) |
| Phase 6 | Quality gates (adversarial review loop, severity scoring) |
| Phase 7 | Production hardening (observability, model strategy, stall detection, 160 tests) |

## License

© BMW AG

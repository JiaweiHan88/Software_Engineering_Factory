# BMAD Copilot Factory — Source Tree Analysis

> Generated: 2026-03-26 | Scan Level: Exhaustive | Source: Direct code analysis

## Root Structure

```
BMAD_Copilot_RT/
├── src/                              # Application source code
│   ├── index.ts                      # ★ Main CLI entry — sprint orchestration, --story, --dispatch, --status
│   ├── heartbeat-entrypoint.ts       # ★ Paperclip process adapter — 10-step pipeline per heartbeat
│   ├── webhook-server.ts             # ★ HTTP webhook listener — push-model callbacks on :3200
│   ├── health.ts                     # Health check HTTP handler (/health)
│   │
│   ├── agents/                       # BMAD Agent Persona Definitions (9 agents)
│   │   ├── types.ts                  #   BmadAgent interface {name, displayName, description, prompt}
│   │   ├── registry.ts              #   Agent lookup: allAgents[], getAgent(name)
│   │   ├── product-manager.ts       #   "John" — bmad-pm — PRD creation, requirements
│   │   ├── architect.ts             #   "Winston" — bmad-architect — system design, tech stack
│   │   ├── developer.ts             #   "Amelia" — bmad-dev — story implementation, TDD
│   │   ├── qa-engineer.ts           #   "Quinn" — bmad-qa — adversarial code review
│   │   ├── scrum-master.ts          #   "Bob" — bmad-sm — sprint planning, story prep
│   │   ├── analyst.ts               #   "Mary" — bmad-analyst — business analysis, research
│   │   ├── ux-designer.ts           #   "Sally" — bmad-ux — UX design, user research
│   │   ├── tech-writer.ts           #   "Paige" — bmad-tech-writer — documentation
│   │   └── quick-flow-solo-dev.ts   #   "Barry" — bmad-quick-flow — rapid full-stack dev
│   │
│   ├── adapter/                      # Paperclip ↔ Copilot SDK Bridge Layer
│   │   ├── session-manager.ts        #   CopilotClient lifecycle, session create/resume/persist
│   │   ├── agent-dispatcher.ts       #   Phase → agent routing, model selection, prompt building
│   │   ├── ceo-orchestrator.ts       #   CEO delegation plans, sub-issue creation, re-evaluation
│   │   ├── lifecycle.ts              #   ★ Single source of truth for issue state transitions
│   │   ├── issue-reassignment.ts     #   SM→Dev→QA handoff protocol, checkout release
│   │   ├── paperclip-client.ts       #   HTTP client for Paperclip REST API (~20 endpoints)
│   │   ├── paperclip-loop.ts         #   Inbox-polling integration loop (dev mode)
│   │   ├── heartbeat-handler.ts      #   Issue → dispatcher bridge, context enrichment
│   │   ├── health-check.ts           #   5-probe system readiness validation
│   │   ├── reporter.ts              #   Results → Paperclip issue comments
│   │   ├── retry.ts                 #   Exponential backoff with jitter
│   │   ├── sprint-runner.ts          #   [DEPRECATED] old YAML-based lifecycle engine
│   │   └── index.ts                 #   Barrel exports
│   │
│   ├── tools/                        # Copilot SDK Tool Definitions (defineTool)
│   │   ├── types.ts                  #   Tool type re-exports from Copilot SDK
│   │   ├── tool-context.ts           #   Thread-safe workspace + story context injection
│   │   ├── create-story.ts           #   create_story — markdown + Paperclip issue creation
│   │   ├── code-review.ts            #   code_review + code_review_result — adversarial review
│   │   ├── issue-status.ts           #   issue_status — read/update/reassign Paperclip issues
│   │   ├── sprint-status.ts          #   [DEPRECATED] sprint-status.yaml CRUD
│   │   └── index.ts                 #   Tool registry: allTools[]
│   │
│   ├── quality-gates/                # Adversarial Review System
│   │   ├── types.ts                  #   Severity, FindingCategory, ReviewFinding, GateResult
│   │   ├── engine.ts                 #   Pure gate logic: scoring, verdicts (PASS/FAIL/ESCALATE)
│   │   ├── review-orchestrator.ts    #   Multi-pass review loop with fix cycles
│   │   ├── tool.ts                   #   quality_gate_evaluate — structured findings evaluation
│   │   └── index.ts                 #   Barrel exports
│   │
│   ├── config/                       # Runtime Configuration
│   │   ├── config.ts                 #   loadConfig() — 30+ env vars → BmadConfig
│   │   ├── model-strategy.ts         #   Complexity → model tier routing (fast/standard/powerful)
│   │   ├── role-mapping.ts           #   Paperclip agent → BMAD persona + skills mapping
│   │   └── index.ts                 #   Barrel exports
│   │
│   ├── observability/                # Production Monitoring Stack
│   │   ├── logger.ts                 #   Structured logger (JSON/human format, level filtering)
│   │   ├── tracing.ts                #   OpenTelemetry distributed tracing to Jaeger
│   │   ├── metrics.ts                #   OTel metrics: 8 key instruments (counters, histograms)
│   │   ├── cost-tracker.ts           #   Token estimation, 34 model pricing, budget tracking
│   │   ├── stall-detector.ts         #   Activity monitoring per phase with escalation
│   │   └── index.ts                 #   Barrel exports
│   │
│   ├── mcp/                          # Model Context Protocol Servers
│   │   └── bmad-sprint-server/
│   │       ├── index.ts              #   MCP server factory (Stdio transport)
│   │       └── tools.ts              #   5 MCP tools: sprint status, next story, update, arch docs, details
│   │
│   ├── utils/                        # Shared Utilities
│   │   └── comment-format.ts         #   Markdown linkification for Paperclip issue URLs
│   │
│   └── sandbox/                      # Development/Testing Scripts
│       ├── hello-copilot.ts          #   Basic SDK connectivity test
│       ├── test-agent.ts             #   Agent session test
│       ├── test-tools.ts             #   Tool invocation test
│       └── test-orchestrator.ts      #   Orchestrator integration test
│
├── test/                             # Test Suite (333+ tests, 16+ files)
│   ├── adapter/
│   │   ├── session-manager.test.ts   #   19 tests — session create/resume/persist
│   │   ├── agent-dispatcher.test.ts  #   17+ tests — phase routing, cost tracking
│   │   ├── paperclip-client.test.ts  #   21 tests — API wrapping, error handling
│   │   ├── ceo-orchestrator.test.ts  #   53 tests — delegation, parsing, agent resolution
│   │   ├── heartbeat-handler.test.ts #   36 tests — phase resolution, context enrichment
│   │   └── retry.test.ts            #   30 tests — backoff, jitter, retryability
│   ├── quality-gate-engine.test.ts   #   24 tests — severity scoring, blocking rules
│   ├── review-orchestrator.test.ts   #   9 tests — multi-pass review loop
│   ├── model-strategy.test.ts        #   22 tests — complexity classification, BYOK
│   ├── cost-tracker.test.ts          #   20 tests — token math, pricing lookup
│   ├── health-check.test.ts          #   19 tests — 5-probe validation
│   ├── stall-detector.test.ts        #   12 tests — activity monitoring
│   ├── logger.test.ts                #   9 tests — formatting, levels
│   ├── sprint-runner.test.ts         #   8 tests — legacy lifecycle engine
│   ├── hello-bmad.test.ts            #   3 tests — basic smoke
│   └── health.test.ts               #   2 tests — endpoint validation
│
├── scripts/                          # Operational Scripts
│   ├── e2e-test.ts                   #   E2E pipeline test (smoke/full/autonomous modes)
│   ├── e2e-helpers.ts                #   Paperclip API helpers, heartbeat polling, log streaming
│   ├── setup-paperclip-company.ts    #   Initialize company, 10 agents, org chart in Paperclip
│   ├── convert-bmad-agents.ts        #   BMAD YAML templates → TypeScript agent files
│   ├── update-model-pricing.ts       #   LLM pricing management (--show, --apply, --json)
│   ├── test-streaming.ts             #   Streaming output test utility
│   └── start-paperclip.sh            #   Docker Compose wrapper for Paperclip
│
├── observability/                    # Docker Observability Stack Configs
│   ├── otel-collector-config.yaml    #   OTLP receiver → Jaeger + Prometheus exporters
│   ├── prometheus.yml                #   Scrape config for OTel collector metrics
│   └── grafana/                      #   Dashboard provisioning + data sources
│       ├── provisioning/
│       └── dashboards/
│
├── bmad_res/                         # BMAD Method Resources (READ-ONLY reference)
│   ├── agents/                       #   Agent YAML configurations (CEO, PM, Architect, etc.)
│   ├── skills/                       #   BMAD skill definitions (prompts + methodology)
│   ├── bmm/                          #   BMAD Method templates
│   └── core/                         #   Core methodology files
│
├── _bmad-output/                     # Runtime Work Output Directory
│   ├── implementation-artifacts/     #   Generated story markdown files
│   ├── planning-artifacts/           #   Sprint planning outputs
│   └── test-artifacts/               #   Review history YAML files
│
├── templates/                        # Paperclip Role Templates + Clipper Presets
├── docs/                             # Project Documentation (this folder)
│
├── docker-compose.yml                # Paperclip + PostgreSQL + BMAD factory
├── docker-compose.observability.yml  # Jaeger + Prometheus + Grafana + OTel Collector
├── Dockerfile                        # Multi-stage: deps → build → runtime
│
├── package.json                      # Dependencies, scripts, metadata
├── tsconfig.json                     # TypeScript strict config + path aliases
├── vitest.config.ts                  # Test config + aliases + v8 coverage
├── eslint.config.js                  # ESLint + TypeScript rules
└── orchestrator.md                   # CEO "Claw Loop" orchestrator prompt
```

## Critical Directories

| Directory | Purpose | Criticality |
|-----------|---------|-------------|
| `src/adapter/` | Core orchestration bridge — all Paperclip ↔ SDK integration | **Critical** |
| `src/agents/` | Agent persona definitions — identity and prompts | **Critical** |
| `src/tools/` | Copilot SDK tool implementations — agent capabilities | **Critical** |
| `src/quality-gates/` | Adversarial review engine — code quality enforcement | **Critical** |
| `src/config/` | Configuration loading, model strategy, role mapping | **Critical** |
| `src/observability/` | Logging, tracing, metrics, cost tracking, stall detection | **High** |
| `src/mcp/` | MCP server for VS Code integration | **Medium** |
| `test/` | Test coverage (333+ tests) | **High** |
| `scripts/` | Operational tooling (setup, E2E, pricing) | **Medium** |
| `observability/` | Docker stack configs (Jaeger, Prometheus, Grafana) | **Medium** |

## Key Integration Points

```
Paperclip Server (:3100)
    ↕ REST API (20+ endpoints)
BMAD Factory (src/adapter/paperclip-client.ts)
    ↕ CopilotClient (JSON-RPC)
GitHub Copilot / Anthropic / OpenAI (LLM providers)
    ↕ OTLP (gRPC :4317)
OTel Collector → Jaeger (:16686) + Prometheus (:9090) → Grafana (:3000)
```

# BMAD Copilot Factory — Product Requirements Document

**Project:** Autonomous Software Building Factory  
**Version:** 0.1.0  
**Date:** March 19, 2026  
**Status:** All core requirements implemented (Phases 0–7 complete)

---

## 1. Product Overview

### 1.1 Vision

An autonomous software development factory that combines:
- **Paperclip** for organizational orchestration (org charts, goals, governance, heartbeats)
- **GitHub Copilot SDK** for programmable agent runtime (custom agents, tools, MCP, skills)
- **BMAD Method** for agile methodology (story lifecycle, adversarial code review, quality gates)

### 1.2 Problem Statement

Building software with AI agents today is ad-hoc: one-shot prompts, no lifecycle management, no quality assurance, no organizational structure. There is no production-grade system that combines orchestration, methodology, and execution into a single autonomous factory.

### 1.3 Target Users

| User | Description |
|------|-------------|
| **Factory Operator** | Starts the factory, writes sprint stories, monitors dashboards |
| **Human Escalation Point** | Reviews stories that fail quality gates after max retries |
| **External Consumer** | Uses the MCP server to interact with sprint data from VS Code |

---

## 2. Functional Requirements

### FR-1: BMAD Agent System

| ID | Requirement | Status | Implemented In |
|----|------------|--------|----------------|
| FR-1.1 | System shall define BMAD agents as Copilot SDK `customAgents` with persona prompts | ✅ Done | `src/agents/` |
| FR-1.2 | At least 5 core agents: Product Manager, Architect, Developer, QA Engineer, Scrum Master | ✅ Done (9 agents) | `src/agents/registry.ts` |
| FR-1.3 | Each agent shall have a `name`, `displayName`, `description`, and `prompt` | ✅ Done | `src/agents/types.ts` |
| FR-1.4 | Agents shall be able to @mention each other within sessions | ✅ Done | `session-manager.ts` passes `allAgents` as `customAgents` |
| FR-1.5 | Agent registry shall support lookup by canonical name | ✅ Done | `getAgent()` in `registry.ts` |

### FR-2: BMAD Tool System

| ID | Requirement | Status | Implemented In |
|----|------------|--------|----------------|
| FR-2.1 | Tools defined via Copilot SDK `defineTool()` with Zod parameter schemas | ✅ Done | `src/tools/` |
| FR-2.2 | `create_story` — generates story files from backlog items | ✅ Done | `src/tools/create-story.ts` |
| FR-2.3 | `dev_story` — implements story code, tests, and artifacts | ✅ Done | `src/tools/dev-story.ts` |
| FR-2.4 | `code_review` — initiates adversarial code review | ✅ Done | `src/tools/code-review.ts` |
| FR-2.5 | `code_review_result` — records structured review findings | ✅ Done | `src/tools/code-review.ts` |
| FR-2.6 | `sprint_status` — reads/writes `sprint-status.yaml` | ✅ Done | `src/tools/sprint-status.ts` |
| FR-2.7 | `quality_gate_evaluate` — evaluates findings against gate criteria | ✅ Done | `src/quality-gates/tool.ts` |

### FR-3: Orchestrator Engine

| ID | Requirement | Status | Implemented In |
|----|------------|--------|----------------|
| FR-3.1 | `SessionManager` wraps CopilotClient with BMAD-aware session lifecycle | ✅ Done | `src/adapter/session-manager.ts` |
| FR-3.2 | `AgentDispatcher` routes work items to the correct agent based on phase | ✅ Done | `src/adapter/agent-dispatcher.ts` |
| FR-3.3 | `SprintRunner` reads `sprint-status.yaml` and advances stories through the lifecycle | ✅ Done | `src/adapter/sprint-runner.ts` |
| FR-3.4 | Story lifecycle: `backlog → ready-for-dev → in-progress → review → done` | ✅ Done | `sprint-runner.ts` + `sprint-status.ts` |
| FR-3.5 | Phase-to-agent routing table: create-story→PM, dev-story→Dev, code-review→QA, sprint-*→SM | ✅ Done | `agent-dispatcher.ts` `getPhaseConfig()` |
| FR-3.6 | Dry-run mode (`--dry-run`) processes stories without SDK calls | ✅ Done | `sprint-runner.ts` + `index.ts` |
| FR-3.7 | Single-story mode (`--story STORY-ID`) processes only one story | ✅ Done | `index.ts` CLI parsing |
| FR-3.8 | Dispatch mode (`--dispatch <phase> <storyId>`) runs a single phase for a story | ✅ Done | `index.ts` CLI parsing |
| FR-3.9 | Status mode (`--status`) prints health check + sprint summary | ✅ Done | `index.ts` CLI parsing |

### FR-4: Paperclip Integration

| ID | Requirement | Status | Implemented In |
|----|------------|--------|----------------|
| FR-4.1 | HTTP client for Paperclip REST API (agents, tickets, heartbeats, reports) | ✅ Done | `src/adapter/paperclip-client.ts` |
| FR-4.2 | Heartbeat-driven loop: poll → dispatch → report | ✅ Done | `src/adapter/paperclip-loop.ts` |
| FR-4.3 | Heartbeat handler bridges Paperclip roles to BMAD agents | ✅ Done | `src/adapter/heartbeat-handler.ts` |
| FR-4.4 | Structured status reporting back to Paperclip with audit history | ✅ Done | `src/adapter/reporter.ts` |
| FR-4.5 | Docker Compose with Paperclip + PostgreSQL + BMAD factory service | ✅ Done | `docker-compose.yml` + `Dockerfile` |
| FR-4.6 | `--paperclip` CLI mode with graceful SIGINT/SIGTERM shutdown | ✅ Done | `src/index.ts` |
| FR-4.7 | Paperclip can be disabled via `PAPERCLIP_ENABLED=false` | ✅ Done | `src/config/config.ts` |

### FR-5: MCP Server

| ID | Requirement | Status | Implemented In |
|----|------------|--------|----------------|
| FR-5.1 | Stdio-based MCP server exposing BMAD sprint data | ✅ Done | `src/mcp/bmad-sprint-server/` |
| FR-5.2 | `get_sprint_status` tool — returns sprint state | ✅ Done | `tools.ts` |
| FR-5.3 | `get_next_story` tool — finds first `ready-for-dev` story | ✅ Done | `tools.ts` |
| FR-5.4 | `update_story_status` tool — moves story through lifecycle with validation | ✅ Done | `tools.ts` |
| FR-5.5 | `get_architecture_docs` tool — reads architecture.md | ✅ Done | `tools.ts` |
| FR-5.6 | `get_story_details` tool — full story markdown + sprint metadata | ✅ Done | `tools.ts` |
| FR-5.7 | VS Code MCP discovery via `.vscode/mcp.json` | ✅ Done | `.vscode/mcp.json` |

### FR-6: Quality Gates

| ID | Requirement | Status | Implemented In |
|----|------------|--------|----------------|
| FR-6.1 | Severity levels: LOW (1), MEDIUM (3), HIGH (7), CRITICAL (15) | ✅ Done | `src/quality-gates/types.ts` |
| FR-6.2 | HIGH/CRITICAL findings block merge | ✅ Done | `src/quality-gates/engine.ts` |
| FR-6.3 | Multi-pass review loop: review → fix → re-review (max 3 passes) | ✅ Done | `src/quality-gates/review-orchestrator.ts` |
| FR-6.4 | Gate verdicts: PASS, FAIL, ESCALATE | ✅ Done | `engine.ts` |
| FR-6.5 | Escalation to human after max review passes | ✅ Done | `review-orchestrator.ts` |
| FR-6.6 | Review history persisted to `_bmad-output/review-history/` as YAML | ✅ Done | `review-orchestrator.ts` |
| FR-6.7 | Finding categories: correctness, security, performance, error-handling, type-safety, maintainability, testing, documentation, style | ✅ Done | `types.ts` |
| FR-6.8 | Review orchestrator emits typed events for UI/logging | ✅ Done | `review-orchestrator.ts` |

### FR-7: Health Check

| ID | Requirement | Status | Implemented In |
|----|------------|--------|----------------|
| FR-7.1 | Config probe — validates required fields | ✅ Done | `src/adapter/health-check.ts` |
| FR-7.2 | Agents probe — at least one agent registered | ✅ Done | `health-check.ts` |
| FR-7.3 | Tools probe — all required tools present | ✅ Done | `health-check.ts` |
| FR-7.4 | Sprint-file probe (non-critical) — sprint-status.yaml readable | ✅ Done | `health-check.ts` |
| FR-7.5 | Paperclip probe — pings Paperclip if enabled | ✅ Done | `health-check.ts` |
| FR-7.6 | Aggregated status: healthy / degraded / unhealthy | ✅ Done | `health-check.ts` |
| FR-7.7 | Formatted console output with icons | ✅ Done | `formatHealthResult()` |

---

## 3. Non-Functional Requirements

### NFR-1: Observability

| ID | Requirement | Status | Implemented In |
|----|------------|--------|----------------|
| NFR-1.1 | Structured JSON logging with component context and levels | ✅ Done | `src/observability/logger.ts` |
| NFR-1.2 | Human-readable log format for local development | ✅ Done | `LOG_FORMAT=human` |
| NFR-1.3 | OpenTelemetry distributed tracing (sprint cycles → stories → dispatches → reviews) | ✅ Done | `src/observability/tracing.ts` |
| NFR-1.4 | OpenTelemetry metrics: counters, histograms, gauges | ✅ Done | `src/observability/metrics.ts` |
| NFR-1.5 | OTLP export to Jaeger (traces) and Prometheus (metrics) | ✅ Done | OTel Collector config |
| NFR-1.6 | Pre-built Grafana dashboard with factory metrics | ✅ Done | `observability/grafana/dashboards/` |
| NFR-1.7 | Docker Compose observability stack (OTel Collector + Jaeger + Prometheus + Grafana) | ✅ Done | `docker-compose.observability.yml` |
| NFR-1.8 | OTel disabled by default, enabled via `OTEL_ENABLED=true` | ✅ Done | `config.ts` |

### NFR-2: Stall Detection

| ID | Requirement | Status | Implemented In |
|----|------------|--------|----------------|
| NFR-2.1 | Detect stories stuck in a phase beyond configurable thresholds | ✅ Done | `src/observability/stall-detector.ts` |
| NFR-2.2 | Default thresholds: ready-for-dev 30min, in-progress 60min, review 30min | ✅ Done | `stall-detector.ts` |
| NFR-2.3 | Repeat stall detection (same story re-stalling) | ✅ Done | `stall-detector.ts` |
| NFR-2.4 | Optional auto-escalation via `STALL_AUTO_ESCALATE=true` | ✅ Done | `stall-detector.ts` |
| NFR-2.5 | Stall detector wired into SprintRunner lifecycle | ✅ Done | `sprint-runner.ts` |

### NFR-3: Cost Optimization

| ID | Requirement | Status | Implemented In |
|----|------------|--------|----------------|
| NFR-3.1 | Complexity-based model tier routing (fast / standard / powerful) | ✅ Done | `src/config/model-strategy.ts` |
| NFR-3.2 | Phase→tier mapping: sprint-status→fast, dev-story→standard, code-review→powerful | ✅ Done | `model-strategy.ts` |
| NFR-3.3 | BYOK provider support (Anthropic, OpenAI) alongside Copilot quota | ✅ Done | `model-strategy.ts` |
| NFR-3.4 | Model selection wired into AgentDispatcher per dispatch | ✅ Done | `agent-dispatcher.ts` |
| NFR-3.5 | All tier/provider/model overridable via environment variables | ✅ Done | `config.ts` |

### NFR-4: Testing

| ID | Requirement | Status | Implemented In |
|----|------------|--------|----------------|
| NFR-4.1 | Vitest test framework with v8 coverage | ✅ Done | `vitest.config.ts` |
| NFR-4.2 | Copilot SDK mocked in all tests (avoids CLI dependency) | ✅ Done | `vi.mock("@github/copilot-sdk")` |
| NFR-4.3 | ≥100 unit/integration tests passing | ✅ Done (160) | `test/` |
| NFR-4.4 | Test coverage: quality gates, model strategy, stall detector, logger, sprint runner, review orchestrator, health check, session manager, agent dispatcher, paperclip client | ✅ Done | 10 test files |

### NFR-5: Developer Experience

| ID | Requirement | Status | Implemented In |
|----|------------|--------|----------------|
| NFR-5.1 | TypeScript strict mode with ESM modules | ✅ Done | `tsconfig.json` |
| NFR-5.2 | No `any` types without explicit justification | ✅ Done | Coding standard |
| NFR-5.3 | JSDoc on all exported functions and types | ✅ Done | All modules |
| NFR-5.4 | One file per agent, tool, and module | ✅ Done | File organization |
| NFR-5.5 | Barrel exports (`index.ts`) per module | ✅ Done | All modules |
| NFR-5.6 | `pnpm start:dry-run` for safe local testing | ✅ Done | `package.json` |

### NFR-6: Configuration

| ID | Requirement | Status | Implemented In |
|----|------------|--------|----------------|
| NFR-6.1 | All configuration via environment variables (no hardcoded secrets) | ✅ Done | `src/config/config.ts` |
| NFR-6.2 | Sensible defaults for all settings | ✅ Done | `loadConfig()` |
| NFR-6.3 | Centralized `BmadConfig` type with sub-configs (paperclip, observability) | ✅ Done | `config.ts` |

---

## 4. System Interfaces

### 4.1 CLI Modes

| Mode | Command | Description |
|------|---------|-------------|
| Sprint cycle | `pnpm start` | Process all actionable stories in one cycle |
| Single story | `pnpm start -- --story STORY-001` | Process one story only |
| Single dispatch | `pnpm start -- --dispatch dev-story S-001` | Run one phase for one story |
| Dry run | `pnpm start -- --dry-run` | Full pipeline, no SDK calls |
| Status | `pnpm start -- --status` | Health check + sprint summary |
| Paperclip | `pnpm start -- --paperclip` | Heartbeat-driven loop |
| OTel enabled | `pnpm start:otel` | Sprint cycle with telemetry export |

### 4.2 MCP Interface

Stdio-based MCP server (`pnpm mcp:sprint`) exposing 5 tools for VS Code Copilot Chat integration.

### 4.3 Docker Compose Stacks

| Stack | Command | Services |
|-------|---------|----------|
| Paperclip | `docker compose up -d` | Paperclip + PostgreSQL |
| Factory | `docker compose --profile factory up` | Paperclip + PostgreSQL + BMAD factory |
| Observability | `pnpm observability:up` | OTel Collector + Jaeger + Prometheus + Grafana |

---

## 5. Data Model

### 5.1 Sprint Status (`sprint-status.yaml`)

```yaml
sprint:
  number: 1
  goal: "Sprint goal description"
  stories:
    - id: STORY-001
      title: "Story title"
      status: ready-for-dev    # backlog | ready-for-dev | in-progress | review | done
      assigned: bmad-developer
      review_pass: 0
```

### 5.2 Story File (`_bmad-output/stories/STORY-001.md`)

Markdown with acceptance criteria, tasks, and developer notes.

### 5.3 Review History (`_bmad-output/review-history/STORY-001.review.yaml`)

YAML audit trail of review passes, findings, verdicts, and fix actions.

---

## 6. Environment Variables

| Variable | Default | Category |
|----------|---------|----------|
| `COPILOT_MODEL` | `claude-sonnet-4.6` | Core |
| `COPILOT_LOG_LEVEL` | `warning` | Core |
| `COPILOT_GHE_HOST` | *(none)* | Core (GHE only) |
| `PAPERCLIP_ENABLED` | `false` | Paperclip |
| `PAPERCLIP_URL` | `http://localhost:3100` | Paperclip |
| `PAPERCLIP_API_KEY` | *(none)* | Paperclip |
| `PAPERCLIP_ORG_ID` | `bmad-factory` | Paperclip |
| `PAPERCLIP_POLL_INTERVAL_MS` | `5000` | Paperclip |
| `LOG_LEVEL` | `info` | Observability |
| `LOG_FORMAT` | `human` | Observability |
| `OTEL_ENABLED` | `false` | Observability |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `http://localhost:4317` | Observability |
| `OTEL_SERVICE_NAME` | `bmad-copilot-factory` | Observability |
| `STALL_CHECK_INTERVAL_MS` | `60000` | Stall Detection |
| `STALL_AUTO_ESCALATE` | `false` | Stall Detection |
| `MODEL_DEFAULT_TIER` | `standard` | Model Strategy |
| `MODEL_PREFER_BYOK` | `false` | Model Strategy |
| `ANTHROPIC_API_KEY` | *(none)* | BYOK |
| `OPENAI_API_KEY` | *(none)* | BYOK |
| `MODEL_TIER_FAST` | `gpt-4o-mini` | Model Strategy |
| `MODEL_TIER_STANDARD` | `claude-sonnet-4.6` | Model Strategy |
| `MODEL_TIER_POWERFUL` | `claude-opus-4.6` | Model Strategy |

---

## 7. Acceptance Criteria (System-Level)

| # | Criteria | Status |
|---|---------|--------|
| AC-1 | Factory bootstraps, runs health check, reads sprint status | ✅ Verified |
| AC-2 | Dry-run mode processes all actionable stories without SDK calls | ✅ Verified |
| AC-3 | Phase routing dispatches to correct agent with correct tools | ✅ Verified (17 tests) |
| AC-4 | Quality gate blocks stories with HIGH/CRITICAL findings | ✅ Verified (24 tests) |
| AC-5 | Model strategy selects correct tier per phase | ✅ Verified (22 tests) |
| AC-6 | Stall detector fires for stories exceeding threshold | ✅ Verified (12 tests) |
| AC-7 | MCP server responds to all 5 tool calls with correct data | ✅ Verified |
| AC-8 | OTel traces and metrics export to collector | ✅ Wired (needs live run) |
| AC-9 | Paperclip client sends/receives all API operations | ✅ Verified (21 tests) |
| AC-10 | 160 tests pass in < 1 second | ✅ Verified (~660ms) |
| AC-11 | Live end-to-end sprint cycle with Copilot CLI | ⏳ Blocked on first live run |

---

## 8. Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|-----------|
| Copilot SDK is Technical Preview (v0.1.32) | API may change | Pin version, abstract behind SessionManager |
| Paperclip not yet runtime-tested | Integration may have issues | Full HTTP client with error handling, Docker Compose ready |
| Agent prompts may produce poor output | Stories/reviews may be low quality | Adversarial review loop + human escalation after 3 passes |
| Cost overrun from LLM calls | Unexpected bills | BYOK routing, model tier strategy, fast tier for simple ops |
| Stories stuck indefinitely | Factory hangs | Stall detector with configurable thresholds + auto-escalation |

---

## 9. Future Requirements (Not Yet Implemented)

| ID | Requirement | Priority |
|----|------------|----------|
| FR-FUTURE-1 | GitHub Actions CI pipeline (typecheck + test on push) | High |
| FR-FUTURE-2 | ESLint configuration | Medium |
| FR-FUTURE-3 | Multi-project support (factory manages multiple repos) | Low |
| FR-FUTURE-4 | Clipper preset distribution for sharing factory configs | Low |
| FR-FUTURE-5 | Web dashboard for sprint monitoring (beyond Grafana) | Low |
| FR-FUTURE-6 | Slack/Teams notifications on story completion or escalation | Medium |
| FR-FUTURE-7 | Session resume after crash (restore in-progress story state) | Medium |

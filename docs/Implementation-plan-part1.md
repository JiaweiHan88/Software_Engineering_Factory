# BMAD Copilot Factory — Implementation Plan

**Project:** Autonomous Software Building Factory  
**Stack:** Paperclip (orchestration) + Copilot SDK (agent runtime) + BMAD Method (methodology)  
**Date:** March 19, 2026  
**Last Updated:** March 19, 2026

---

## Progress Summary

| Phase | Commit | Status |
|-------|--------|--------|
| **Phase 0** — Scaffolding | `845fc88` | ✅ Complete |
| **Phase 1** — SDK Connectivity | `66e3bd8` | ✅ Complete |
| **Phase 2** — BMAD Tools | `281c74c` | ✅ Complete |
| **BMAD V6 Agents** | `31f85a9` | ✅ Complete (9 authentic agents) |
| **Phase 3** — Orchestrator Engine | `5d8d4b8` | ✅ Complete |
| **Phase 4** — Paperclip Integration | — | ✅ Complete |
| **Phase 5** — MCP Server | — | ✅ Complete |
| **Phase 6** — Quality Gates | — | ✅ Complete |
| **Phase 7** — Production Hardening | — | ✅ Complete |

---

## Current State

| Item | Status |
|------|--------|
| Workspace | `/Users/Q543651/repos/AI Repo/BMAD_Copilot_RT` — git repo, 10 commits, ~1313 tracked files |
| Node.js | ✅ 25.8.1 |
| pnpm | ✅ 10.32.1 |
| Homebrew | ✅ 5.1.0 |
| GitHub CLI (`gh`) | ✅ Installed (`/opt/homebrew/bin/gh`) |
| Copilot CLI (`copilot`) | ✅ 1.0.9 (`gh copilot --version`) |
| Git | ✅ 2.50.1 |
| Docker | ✅ 29.2.1 |
| Python | ⚠️ 3.9.6 (system) |
| TypeScript | ✅ 5.7+ (strict mode, ESM) |
| Test Suite | ✅ 160 tests passing across 10 files (vitest 3.2.4) |
| OpenTelemetry | ✅ Wired (traces + metrics, OTLP export) |
| Observability Stack | ✅ Docker Compose with OTel Collector → Jaeger + Prometheus + Grafana |

---

## 🔴 Remaining Blockers

| # | Action | How | Why |
|---|--------|-----|-----|
| **Y8** | **(Optional) Provide BYOK API keys** | Export `ANTHROPIC_API_KEY` and/or `OPENAI_API_KEY` | Cost control — avoids using Copilot premium request quota |
| **Y9** | **Verify Paperclip runs** | `docker compose --profile factory up` | Paperclip integration (Phase 4 runtime) |

---

## 🟢 Completed Gates

- **GATE 0** — Foundation Tools: ✅ Homebrew, Node.js 25, pnpm 10, GitHub CLI all installed
- **GATE 1** — Accounts & Credentials: ✅ GitHub repo created and pushed
- **GATE 2** — Paperclip Setup: ⏳ Docker Compose scaffolded, not yet runtime-tested
- **Y5** — Copilot CLI: ✅ Version 1.0.9 installed

---

## Implementation Phases

### Phase 0 — Project Scaffolding *(I can start now)*

**Goal:** Working repo structure, TypeScript project, docs.

**What I build:**
```
BMAD_Copilot_RT/
├── README.md                          # Project overview
├── package.json                       # Root workspace
├── tsconfig.json                      # TypeScript config
├── .gitignore
├── .github/
│   └── copilot-instructions.md        # Custom Copilot instructions for this repo
├── docs/
│   ├── research-autonomous-sw-factory.md  # (existing, moved)
│   └── architecture.md                # Architecture decisions
├── src/
│   ├── agents/                        # BMAD agent definitions
│   │   ├── index.ts                   # Agent registry
│   │   ├── product-manager.ts         # BMAD PM persona
│   │   ├── architect.ts               # BMAD Architect persona
│   │   ├── developer.ts               # BMAD Developer persona
│   │   ├── code-reviewer.ts           # BMAD Code Reviewer persona
│   │   └── product-owner.ts           # BMAD PO persona
│   ├── tools/                         # BMAD tools (Copilot SDK defineTool)
│   │   ├── index.ts                   # Tool registry
│   │   ├── create-story.ts            # Story creation tool
│   │   ├── dev-story.ts               # Story implementation tool
│   │   ├── code-review.ts             # Code review tool
│   │   └── sprint-status.ts           # Sprint status tool
│   ├── skills/                        # Copilot SDK skills (prompt modules)
│   │   ├── bmad-methodology/          # BMAD process knowledge
│   │   ├── quality-gates/             # Review standards
│   │   └── architecture-patterns/     # Arch decision templates
│   ├── adapter/                       # Paperclip ↔ Copilot SDK bridge
│   │   ├── heartbeat-handler.ts       # Translates heartbeats → SDK sessions
│   │   ├── session-manager.ts         # Session lifecycle + persistence
│   │   └── reporter.ts               # Reports back to Paperclip
│   ├── mcp/                           # Custom MCP servers
│   │   └── bmad-sprint-server/        # Sprint status, story queue MCP
│   ├── config/                        # Configuration
│   │   ├── model-strategy.ts          # Complexity → model tier mapping
│   │   └── paperclip.ts              # Paperclip connection config
│   └── index.ts                       # Main entry point
├── templates/                         # Clipper BMAD preset
│   ├── presets/
│   │   └── bmad-factory/
│   │       └── preset.meta.json
│   ├── roles/                         # Paperclip role templates
│   │   ├── bmad-pm/
│   │   ├── bmad-architect/
│   │   ├── bmad-developer/
│   │   ├── bmad-code-reviewer/
│   │   └── bmad-product-owner/
│   └── modules/                       # Paperclip module templates
│       ├── bmad-sprint/
│       ├── bmad-quality-gates/
│       └── bmad-story-lifecycle/
├── docker-compose.yml                 # Paperclip + PostgreSQL
└── orchestrator.md                    # (existing — Claw Loop reference)
```

**Blocked by:** Nothing — I can create the structure now  
**Your action needed:** None yet

---

### Phase 1 — Copilot SDK Hello World *(needs GATE 0)*

**Goal:** Prove the Copilot SDK works, send a message, define a custom tool, verify JSON-RPC to CLI.

**What I build:**
- `src/sandbox/hello-copilot.ts` — minimal SDK client + session + tool
- `src/sandbox/test-agent.ts` — custom agent with BMAD-style prompt
- Test scripts in `package.json`

**Key validation:**
```typescript
import { CopilotClient, defineTool } from "@github/copilot-sdk";
const client = new CopilotClient();
const session = await client.createSession({
  customAgents: [{
    name: "bmad-dev",
    prompt: "You are a senior developer following the BMAD Method..."
  }],
  tools: [myTool],
});
const response = await session.sendAndWait({ prompt: "Create a hello world Express app" });
```

**Blocked by:** Y1-Y5 (Node.js, Copilot CLI)  
**Your action needed:** Confirm tools installed, run `npm test`

---

### Phase 2 — BMAD Agent Definitions *(needs Phase 1 working)*

**Goal:** All 5 BMAD roles defined as Copilot SDK custom agents with full persona prompts.

**What I build:**
- Each agent file exports a `customAgent` config object:
  - **Product Manager** — writes PRDs, defines user stories, prioritizes backlog
  - **Architect** — designs system architecture, tech stack decisions, data models
  - **Developer** — implements stories, writes code, runs tests
  - **Code Reviewer** — adversarial review, finds bugs, security issues
  - **Product Owner** — sprint planning, acceptance criteria, stakeholder voice

- Each agent includes:
  - `name` / `displayName` / `description`
  - `prompt` — full BMAD persona (adapted from BMAD Method templates)
  - Scoped tool access (e.g., Dev gets `dev-story`, Reviewer gets `code-review`)

**Blocked by:** Phase 1 verified  
**Your action needed:** Review agent persona prompts (optional)

---

### Phase 3 — BMAD Tools *(needs Phase 2)*

**Goal:** BMAD workflow steps as callable Copilot SDK tools.

**What I build:**

| Tool | SDK Definition | What It Does |
|------|---------------|--------------|
| `create_story` | `defineTool("create_story", ...)` | Generates story file with ACs, tasks, subtasks from backlog |
| `dev_story` | `defineTool("dev_story", ...)` | Implements a story: code, tests, migrations |
| `code_review` | `defineTool("code_review", ...)` | Adversarial review with severity ratings |
| `sprint_status` | `defineTool("sprint_status", ...)` | Reads/updates sprint-status.yaml |
| `advance_story` | `defineTool("advance_story", ...)` | Moves story through lifecycle states |
| `model_select` | `defineTool("model_select", ...)` | Picks model tier based on complexity |

Each tool:
- Has a JSON schema for parameters
- Has a handler function that executes the BMAD logic
- Returns structured results the agent can interpret

**Blocked by:** Phase 2  
**Your action needed:** None

---

### Phase 4 — Paperclip Integration *(needs GATE 2)*

**Goal:** Paperclip running locally, BMAD roles registered as agents, heartbeats trigger Copilot SDK sessions.

**What I build:**
- `docker-compose.yml` with Paperclip + PostgreSQL
- Clipper preset `bmad-factory` with all BMAD roles and modules
- `src/adapter/heartbeat-handler.ts`:
  ```
  Paperclip heartbeat fires
    → Read assigned ticket from Paperclip API
    → Determine which BMAD agent should handle it
    → Create/resume Copilot SDK session with that agent
    → Send prompt with ticket context
    → Stream results back to Paperclip ticket
  ```
- `src/adapter/session-manager.ts` — session persistence across heartbeats
- `src/adapter/reporter.ts` — structured status reports to Paperclip

**Blocked by:** Y9 (Docker + Paperclip running)  
**Your action needed:** Run `docker compose up`, confirm Paperclip UI loads

#### Phase 4 — Delivery Summary

> **⚠️ Refactored (2026-03-19):** Phase 4 was rebuilt to align with the real Paperclip API.
> See `docs/paperclip-refactoring-plan.md` for the full audit.

**Delivered modules:**
- `src/adapter/paperclip-client.ts` — Full HTTP client for real Paperclip REST API (agents, issues, issue comments, org tree, goals, heartbeat runs). Uses `/api` prefix (no version), company-scoped model, push architecture.
- `src/adapter/reporter.ts` — Reports results back to Paperclip via issue comments (`POST /api/issues/:id/comments`), replaces removed `/reports` endpoint
- `src/adapter/paperclip-loop.ts` — Issue-driven integration loop: inbox-polling bridge (dev) or webhook receiver (prod). No more heartbeat polling.
- `src/adapter/heartbeat-handler.ts` — Upgraded with `handlePaperclipIssue()` bridging Paperclip issues → BMAD dispatch
- `src/adapter/health-check.ts` — Added Paperclip connectivity probe (Probe 5)
- `src/config/config.ts` — Extended with `PaperclipConfig` (URL, agent API key, company ID, inbox check interval, mode: webhook/inbox-polling)
- `src/index.ts` — Added `--paperclip` CLI mode with SIGINT/SIGTERM graceful shutdown
- `docker-compose.yml` — Enhanced with BMAD factory service, health checks, `factory` profile
- `Dockerfile` — Multi-stage build for containerized deployment
- `templates/presets/bmad-factory/preset.meta.json` — Enhanced with org chart, modules, Paperclip settings

**CLI usage:**
```
pnpm start:paperclip                    # Run Paperclip integration loop
PAPERCLIP_ENABLED=true pnpm start -- --paperclip   # Same, explicit
docker compose --profile factory up      # Run everything in Docker
```

**Environment variables:**
| Variable | Default | Description |
|----------|---------|-------------|
| `PAPERCLIP_ENABLED` | `false` | Enable Paperclip integration |
| `PAPERCLIP_URL` | `http://localhost:3100` | Paperclip server URL |
| `PAPERCLIP_API_KEY` | *(none)* | API key (optional in local_trusted mode) |
| `PAPERCLIP_ORG_ID` | `bmad-factory` | Organization ID |
| `PAPERCLIP_POLL_INTERVAL_MS` | `5000` | Heartbeat poll interval (ms) |
| `PAPERCLIP_TIMEOUT_MS` | `10000` | API request timeout (ms) |

---

### Phase 5 — BMAD MCP Server *(needs Phase 3)*

**Goal:** Custom MCP server that exposes BMAD sprint data as tools for Copilot.

**What I build:**
- `src/mcp/bmad-sprint-server/` — TypeScript MCP server
- MCP tools exposed:
  - `get_sprint_status` — current sprint state
  - `get_next_story` — next story in queue
  - `update_story_status` — move story through lifecycle
  - `get_architecture_docs` — project architecture context
  - `get_story_details` — full story with ACs and tasks

**Blocked by:** Phase 3  
**Your action needed:** None

#### Phase 5 — Delivery Summary

**Delivered modules:**
- `src/mcp/bmad-sprint-server/index.ts` — MCP server entry point with stdio transport, protocol handshake, tool registration
- `src/mcp/bmad-sprint-server/tools.ts` — 5 MCP tool handler implementations reusing existing sprint-status utilities
- `src/mcp/index.ts` — Barrel exports for MCP module
- `.vscode/mcp.json` — VS Code / Copilot MCP server discovery configuration

**Dependencies added:**
- `@modelcontextprotocol/sdk` ^1.27.1

**MCP tools registered:**

| Tool | Parameters | Description |
|------|-----------|-------------|
| `get_sprint_status` | *(none)* | Returns sprint number, goal, all stories with status counts |
| `get_next_story` | *(none)* | Finds first `ready-for-dev` story, includes full markdown |
| `update_story_status` | `story_id`, `new_status`, `assigned?`, `increment_review_pass?` | Moves story through lifecycle with transition validation |
| `get_architecture_docs` | `include_file_list?` | Reads `docs/architecture.md`, optionally lists all docs |
| `get_story_details` | `story_id` | Sprint metadata + full story markdown content |

**Lifecycle transition validation:**
- Forward: `backlog → ready-for-dev → in-progress → review → done`
- Rework: `review → in-progress` (failed code review)
- Reopen: `done → review` (re-review)
- Backward: `ready-for-dev → backlog`, `in-progress → ready-for-dev`

**CLI usage:**
```
pnpm mcp:sprint                          # Run MCP server (stdio)
tsx src/mcp/bmad-sprint-server/index.ts   # Run directly
```

**Verified:** TypeScript compiles clean, MCP initialize handshake succeeds, `tools/list` returns all 5 tools with correct JSON schemas, `tools/call` for `get_sprint_status` and `get_next_story` return correct data from `_bmad-output/sprint-status.yaml`.

---

### Phase 6 — Quality Gates *(needs Phase 4)*

**Goal:** BMAD's adversarial review loop working end-to-end.

**What I build:**
- SDK hooks for pre/post tool execution validation
- Quality gate logic:
  ```
  dev-story completes → code-review runs → 
    if HIGH/CRITICAL → fix in-place → re-review (max 3 passes) →
    if CLEAN → advance story to done
  ```
- Paperclip approval gate for human override

**Blocked by:** Phase 4  
**Your action needed:** None

#### Phase 6 — Delivery Summary

**Delivered modules:**

| Module | File | Description |
|--------|------|-------------|
| Quality Gate Types | `src/quality-gates/types.ts` | Severity levels (LOW→CRITICAL), structured findings, gate verdicts (PASS/FAIL/ESCALATE), review history, orchestrator actions |
| Quality Gate Engine | `src/quality-gates/engine.ts` | Pure logic: severity analysis, weighted scoring, gate evaluation, verdict decision, formatted reports |
| Review Orchestrator | `src/quality-gates/review-orchestrator.ts` | Full review loop: dispatch review → parse findings → evaluate gate → fix or approve → persist history |
| Quality Gate Tool | `src/quality-gates/tool.ts` | Copilot SDK `defineTool("quality_gate_evaluate")` — structured findings → verdict |
| Barrel Export | `src/quality-gates/index.ts` | Module barrel export for all quality gate types, engine, orchestrator, and tool |

**Updated modules:**

| Module | Changes |
|--------|---------|
| `src/tools/code-review.ts` | Review protocol now instructs agents to use `quality_gate_evaluate` with structured findings; added severity guide and finding format reference |
| `src/tools/index.ts` | Added `qualityGateEvaluateTool` to `allTools` array and exports |
| `src/adapter/agent-dispatcher.ts` | Added `qualityGateEvaluateTool` to code-review phase tool list |
| `src/adapter/sprint-runner.ts` | Code-review phase now routes through `ReviewOrchestrator` instead of plain dispatch; added `quality-gate` event type |
| `src/adapter/index.ts` | Re-exports `ReviewOrchestrator` and orchestration types |
| `src/index.ts` | Added `logQualityGateEvent()` handler for all review orchestrator events |
| `src/skills/quality-gates/skill.md` | Enhanced with structured finding format, category reference, severity weights, score computation |

**Quality Gate Flow:**
```
story status = "review"
  → SprintRunner detects code-review phase
  → ReviewOrchestrator.run() takes over:
    ┌─ Loop (max 3 passes) ────────────────────────────┐
    │  1. Dispatch code-review to bmad-qa agent         │
    │  2. Agent analyzes files, collects findings       │
    │  3. Agent calls quality_gate_evaluate tool        │
    │  4. Engine evaluates: severity scores, blocking   │
    │     count, advisory count                         │
    │  5. Verdict:                                      │
    │     • PASS  → story → done ✅                     │
    │     • FAIL  → dispatch fix to bmad-dev → loop ↩  │
    │     • ESCALATE → human intervention ⚠️            │
    └──────────────────────────────────────────────────┘
```

**Severity Scoring:**
| Severity | Weight | Blocks Merge |
|----------|--------|-------------|
| LOW | 1 | No |
| MEDIUM | 3 | No |
| HIGH | 7 | Yes |
| CRITICAL | 15 | Yes |

**Finding Categories:** correctness, security, performance, error-handling, type-safety, maintainability, testing, documentation, style

**Review History Persistence:**
- Each story's review history is saved to `_bmad-output/review-history/{story_id}.review.yaml`
- Survives process restarts — orchestrator resumes from last completed pass
- Full audit trail: findings, verdicts, scores, fix agents, timestamps

**New Copilot SDK Tool:**

| Tool | Parameters | Description |
|------|-----------|-------------|
| `quality_gate_evaluate` | `story_id`, `findings[]`, `reviewer_notes?` | Evaluates structured findings array against quality gate, returns verdict with severity score |

**Event Types Added:**
- `review-start` — review pass beginning
- `review-dispatched` — review sent to agent
- `gate-evaluated` — gate verdict computed
- `fix-start` — fix dispatching for blocking findings
- `fix-dispatched` — fix sent to developer agent
- `fix-complete` — fixes applied
- `review-approved` — story passed quality gate
- `review-escalated` — story needs human intervention
- `review-error` — review dispatch failed

---

### Phase 7 — Production Hardening *(complete)*

**Goal:** Observability, cost optimization, stall detection.

- OpenTelemetry → Grafana/Jaeger dashboards
- BYOK cost routing per agent (expensive ops → BYOK, cheap → Copilot quota)
- Stall detection ported from Claw Loop
- Model strategy (complexity → model tier) from BMAD V6

#### Phase 7 — Delivery Summary

**Delivered modules:**

| Module | File | Description |
|--------|------|-------------|
| Structured Logger | `src/observability/logger.ts` | JSON + human-readable log output with levels, component context, timestamps |
| OTel Tracing | `src/observability/tracing.ts` | Distributed tracing with spans for sprint cycles, story processing, agent dispatches, quality gates |
| OTel Metrics | `src/observability/metrics.ts` | Counters, histograms, gauges for stories, dispatches, sessions, stalls, verdicts |
| Stall Detector | `src/observability/stall-detector.ts` | Monitors stories stuck in a phase beyond configurable thresholds; repeat detection |
| Model Strategy | `src/config/model-strategy.ts` | Complexity → model tier routing with BYOK provider selection |
| Barrel Export | `src/observability/index.ts` | Module barrel export for all observability components |
| Vitest Config | `vitest.config.ts` | Test framework configuration with v8 coverage |

**Updated modules:**

| Module | Changes |
|--------|---------|
| `src/config/config.ts` | Extended `BmadConfig` with `ObservabilityConfig` (log level/format, OTel settings, stall thresholds) |
| `src/config/index.ts` | Re-exports `ObservabilityConfig`, `ModelStrategy` types and functions |
| `src/index.ts` | Initializes Logger, OTel tracing/metrics, StallDetector on startup; graceful OTel shutdown |
| `src/adapter/sprint-runner.ts` | Replaced `console.*` with structured logger; added OTel span tracing per sprint cycle and story; records metrics |
| `src/adapter/agent-dispatcher.ts` | Replaced `console.*` with structured logger; added OTel span tracing per dispatch; records dispatch duration metrics |
| `src/adapter/session-manager.ts` | Replaced `console.*` with structured logger; records session open/close metrics |
| `docs/architecture.md` | Added Observability Architecture section (logging, tracing, metrics, stall detection, model strategy) |
| `package.json` | Added 8 `@opentelemetry/*` dependencies |

**Test suite:**

| Test File | Tests | Coverage |
|-----------|-------|----------|
| `test/quality-gate-engine.test.ts` | 24 | Gate evaluation, severity scoring, verdict logic |
| `test/model-strategy.test.ts` | 22 | Complexity classification, model selection, BYOK routing |
| `test/stall-detector.test.ts` | 12 | Phase tracking, threshold detection, repeat flagging |
| `test/logger.test.ts` | 9 | Level filtering, JSON/human format, error output |
| **Total** | **67** | All passing ✅ |

**New environment variables:**

| Variable | Default | Description |
|----------|---------|-------------|
| `LOG_LEVEL` | `info` | Structured log level: debug, info, warn, error |
| `LOG_FORMAT` | `human` | Log output format: json, human |
| `OTEL_ENABLED` | `false` | Enable OpenTelemetry tracing and metrics |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `http://localhost:4317` | OTLP endpoint for traces/metrics |
| `OTEL_SERVICE_NAME` | `bmad-copilot-factory` | Service name for OTel |
| `STALL_CHECK_INTERVAL_MS` | `60000` | Stall detection check interval |
| `STALL_AUTO_ESCALATE` | `false` | Auto-escalate stalled stories |
| `MODEL_DEFAULT_TIER` | `standard` | Default model tier |
| `MODEL_PREFER_BYOK` | `false` | Prefer BYOK providers over Copilot quota |
| `ANTHROPIC_API_KEY` | *(none)* | Enables Anthropic BYOK tier |
| `OPENAI_API_KEY` | *(none)* | Enables OpenAI BYOK tier |
| `MODEL_TIER_FAST` | `gpt-4o-mini` | Override fast tier Copilot model |
| `MODEL_TIER_STANDARD` | `claude-sonnet-4.6` | Override standard tier Copilot model |
| `MODEL_TIER_POWERFUL` | `claude-opus-4.6` | Override powerful tier Copilot model |

**Model tier routing:**

| Tier | Phase Mapping | BYOK Anthropic | BYOK OpenAI | Copilot Default |
|------|--------------|----------------|-------------|-----------------|
| fast | sprint-status | claude-haiku-3.5 | gpt-4o-mini | gpt-4o-mini |
| standard | create-story, dev-story, sprint-planning | claude-sonnet-4.5 | gpt-4o | claude-sonnet-4.6 |
| powerful | code-review, security, architecture | claude-opus-4 | o3 | claude-opus-4.6 |

**OTel metrics registered:**

| Metric | Type | Labels |
|--------|------|--------|
| `bmad.stories.processed` | Counter | story.id, story.phase |
| `bmad.stories.done` | Counter | story.id |
| `bmad.agent.dispatch_duration` | Histogram | agent.name, agent.phase, dispatch.success |
| `bmad.review.passes` | Counter | story.id, review.pass_number |
| `bmad.gate.verdicts` | Counter | story.id, gate.verdict, gate.score |
| `bmad.sessions.active` | UpDownCounter | agent.name |
| `bmad.stall.detections` | Counter | story.id, story.phase, stall.duration_minutes |
| `bmad.sprint.cycles` | Counter | sprint.number, sprint.stories_processed |

**Observability Docker Stack:**

```
pnpm observability:up                  # Start Jaeger + Prometheus + Grafana
open http://localhost:3000             # Grafana (admin/bmad)
open http://localhost:16686            # Jaeger traces
open http://localhost:9090             # Prometheus
OTEL_ENABLED=true pnpm start:otel     # Run factory with telemetry export
```

Components: OTel Collector (OTLP HTTP :4318 → Jaeger + Prometheus), Grafana with pre-built BMAD Factory dashboard (sprint cycles, agent dispatch latency p50/p95/p99, quality gate verdicts pie chart, stall detections, active sessions gauge).

**Test suite (160 tests, 10 files):**

| Test File | Tests | Coverage |
|-----------|-------|----------|
| `test/quality-gate-engine.test.ts` | 24 | Gate evaluation, severity scoring, verdict logic |
| `test/model-strategy.test.ts` | 22 | Complexity classification, model selection, BYOK routing |
| `test/paperclip-client.test.ts` | 21 | HTTP client: agents, heartbeats, tickets, reports, errors |
| `test/health-check.test.ts` | 19 | All 5 probes, aggregation, format output |
| `test/session-manager.test.ts` | 19 | Lifecycle, sessions, model override, tracking |
| `test/agent-dispatcher.test.ts` | 17 | Phase routing, dispatch flow, error handling |
| `test/stall-detector.test.ts` | 12 | Phase tracking, threshold detection, repeat flagging |
| `test/logger.test.ts` | 9 | Level filtering, JSON/human format, error output |
| `test/review-orchestrator.test.ts` | 9 | Structured finding parser, heuristic parser |
| `test/sprint-runner.test.ts` | 8 | Lifecycle events, dry-run, filtering, error handling |
| **Total** | **160** | **All passing ✅** |

---

## Timeline Estimate

| Phase | Duration | Cumulative | Gate |
|-------|----------|-----------|------|
| **Phase 0** — Scaffolding | 1 session | Day 1 | None |
| **GATE 0** — Your tool installs | *depends on you* | — | **Y1-Y5** |
| **Phase 1** — SDK Hello World | 1 session | Day 2-3 | GATE 0 |
| **GATE 1** — Credentials | *depends on you* | — | **Y6-Y8** |
| **Phase 2** — Agent Definitions | 1-2 sessions | Day 4-5 | Phase 1 |
| **Phase 3** — BMAD Tools | 2-3 sessions | Day 6-10 | Phase 2 |
| **GATE 2** — Paperclip running | *depends on you* | — | **Y9** |
| **Phase 4** — Paperclip Integration | 2-3 sessions | Day 11-15 | GATE 2 |
| **Phase 5** — MCP Server | 1-2 sessions | Day 16-18 | Phase 3 |
| **Phase 6** — Quality Gates | 1-2 sessions | Day 19-21 | Phase 4 |
| **Phase 7** — Hardening | Ongoing | Day 22+ | Phase 6 |

**Estimated MVP (Phases 0-4):** ~3 weeks with your gate clearances  
**Full system (Phases 0-7):** ~4-5 weeks

---

## Immediate Next Steps

**All 8 phases are complete. The factory is ready for a live end-to-end test.**

1. **Start the observability stack:** `pnpm observability:up`
2. **Write real stories** in `_bmad-output/stories/` and `sprint-status.yaml`
3. **Run the factory live:** `OTEL_ENABLED=true pnpm start:otel`
4. **Watch traces in Jaeger** (`http://localhost:16686`) and metrics in Grafana (`http://localhost:3000`)

The ORCH-001/ORCH-002 stories in Sprint 1 were scaffolding test stories for this framework — not real deliverables.

---

## Decision Points Where I'll Ask You

| When | Question |
|------|----------|
| Phase 1 | Which Copilot model to use as default? (Claude Sonnet 4.5 recommended) |
| Phase 2 | Review BMAD agent personas — any customization needed? |
| Phase 4 | Public or private GitHub repo? |
| Phase 4 | Paperclip `local_trusted` mode or authenticated? |
| Phase 7 | BYOK keys — which providers? Budget limits? |

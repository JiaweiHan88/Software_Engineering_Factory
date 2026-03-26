# BMAD Copilot Factory — Architecture

> Generated: 2026-03-26 | Scan Level: Exhaustive | Source: Direct code analysis

## Executive Summary

BMAD Copilot Factory is a layered orchestration system that autonomously executes software development workflows. It consumes Paperclip's push-model heartbeats, routes issues to specialized BMAD agent personas via the GitHub Copilot SDK, enforces adversarial quality gates, and manages the full story lifecycle from backlog to done.

## System Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│ PAPERCLIP ORCHESTRATION LAYER                                   │
│ Issue assignment (push model) · Heartbeats · Org chart · Goals  │
│ Company-scoped data · Agent lifecycle · Cost events              │
│ Base: http://localhost:3100/api                                  │
└──────────────────────────────┬──────────────────────────────────┘
                               │ REST API (Bearer auth)
                               ▼
┌─────────────────────────────────────────────────────────────────┐
│ PROCESS ADAPTER LAYER                                           │
│ ┌─────────────────────┐  ┌──────────────────┐  ┌────────────┐  │
│ │ heartbeat-entrypoint│  │ paperclip-loop   │  │ webhook-   │  │
│ │ 10-step pipeline    │  │ inbox-polling    │  │ server     │  │
│ │ (spawned process)   │  │ (dev mode loop)  │  │ (HTTP:3200)│  │
│ └─────────┬───────────┘  └────────┬─────────┘  └──────┬─────┘  │
│           └──────────────────┬────┘                    │        │
│                              ▼                         │        │
│ ┌─────────────────────────────────────────────────────────────┐ │
│ │ heartbeat-handler.ts                                        │ │
│ │ Issue → phase resolution → context enrichment → dispatch    │ │
│ └──────────────────────────────┬──────────────────────────────┘ │
└────────────────────────────────┼────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────┐
│ COPILOT SDK BRIDGE LAYER                                        │
│                                                                 │
│ ┌──────────────────┐  ┌───────────────────┐  ┌──────────────┐  │
│ │ session-manager  │  │ agent-dispatcher  │  │ ceo-         │  │
│ │ CopilotClient    │  │ Phase → Agent     │  │ orchestrator │  │
│ │ Session lifecycle│  │ Model selection   │  │ Delegation   │  │
│ │ Session resume   │  │ Prompt building   │  │ Sub-issues   │  │
│ └──────────────────┘  └───────────────────┘  └──────────────┘  │
│                                                                 │
│ ┌──────────────────┐  ┌───────────────────┐  ┌──────────────┐  │
│ │ lifecycle.ts     │  │ issue-reassignment│  │ reporter.ts  │  │
│ │ State machine    │  │ SM→Dev→QA handoff │  │ Issue comment │  │
│ │ Sole transition  │  │ Checkout release  │  │ reporting     │  │
│ │ authority        │  │ Metadata merge    │  │               │  │
│ └──────────────────┘  └───────────────────┘  └──────────────┘  │
└─────────────────────────────────┬───────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────┐
│ EXECUTION LAYER — BMAD Agents + Copilot SDK Tools               │
│                                                                 │
│ 9 Agent Personas:                                               │
│ bmad-pm · bmad-architect · bmad-dev · bmad-qa · bmad-sm         │
│ bmad-analyst · bmad-ux · bmad-tech-writer · bmad-quick-flow     │
│                                                                 │
│ 5 Copilot SDK Tools:                                            │
│ create_story · code_review · code_review_result                 │
│ issue_status · quality_gate_evaluate                            │
│                                                                 │
│ Tool Context: Thread-safe workspace + story context injection   │
│ Model Strategy: Complexity → tier routing (fast/standard/power) │
└─────────────────────────────────┬───────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────┐
│ QUALITY GATE LAYER                                              │
│                                                                 │
│ ┌──────────────────┐  ┌───────────────────┐  ┌──────────────┐  │
│ │ engine.ts        │  │ review-           │  │ Severity     │  │
│ │ Pure scoring:    │  │ orchestrator.ts   │  │ Weights:     │  │
│ │ PASS/FAIL/       │  │ Multi-pass loop   │  │ LOW=1        │  │
│ │ ESCALATE         │  │ Fix cycles        │  │ MED=3        │  │
│ │                  │  │ Max 3 passes      │  │ HIGH=7       │  │
│ │                  │  │ History persist   │  │ CRITICAL=15  │  │
│ └──────────────────┘  └───────────────────┘  └──────────────┘  │
└─────────────────────────────────┬───────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────┐
│ OBSERVABILITY LAYER                                             │
│                                                                 │
│ ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌────────────────┐  │
│ │ Logger   │  │ Tracing  │  │ Metrics  │  │ Cost Tracker   │  │
│ │ JSON/    │  │ OTel →   │  │ OTel →   │  │ 34 models      │  │
│ │ human    │  │ Jaeger   │  │ Prometheus│  │ Token estimate │  │
│ └──────────┘  └──────────┘  └──────────┘  └────────────────┘  │
│                                                                 │
│ ┌──────────────────────────────────────────────────────────┐    │
│ │ Stall Detector — Phase timeout monitoring + escalation   │    │
│ └──────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────┘
```

## Data Flow

### Heartbeat Pipeline (10 Steps)

```
Step 1: Extract PAPERCLIP_* environment variables
         ↓
Step 2: Create PaperclipClient (authenticated HTTP client)
         ↓
Step 3: Identify self: GET /api/agents/me → agent metadata
         ↓
Step 4: Resolve BMAD role: agent title/name/metadata → RoleMappingEntry
         ↓
Step 5: Check inbox: GET /api/agents/me/inbox-lite → assigned issues
         ↓
Step 6: Load agent config (persona, tools, skills, model tier)
         ↓
Step 7: Bootstrap Copilot SDK (SessionManager + AgentDispatcher)
         ↓
Step 8: Process each issue:
         ├── CEO agent → orchestrateCeoIssue() (delegation + sub-issues)
         └── Specialist agent → handlePaperclipIssue() (direct execution)
         ↓
Step 9: Report cost tracking (POST cost-events + markdown comment)
         ↓
Step 10: Cleanup (close sessions, flush telemetry, exit)
```

### Issue Lifecycle State Machine

```
backlog → todo (CEO promotes when dependencies met)
    ↓
todo → in_progress (agent checks out issue)
    ↓
in_progress → (phase execution via Copilot SDK)
    ↓
Phase transitions (lifecycle.ts):
    create-story → dev-story (reassign SM → Dev)
    dev-story → code-review (reassign Dev → QA)
    code-review:
        ├── PASS → done (wake parent)
        ├── FAIL → dev-story (reassign QA → Dev, fix cycle)
        └── ESCALATE → done (human escalation comment)
    other phases → done (terminal)
```

### CEO Delegation Flow

```
Parent issue assigned to CEO
    ↓
buildDelegationPrompt() → CEO persona + issue context + agent roster
    ↓
Copilot SDK session → LLM generates DelegationPlan (JSON)
    ↓
parseDelegationPlan() → structured tasks with dependencies
    ↓
For each task:
    resolveAgentId(roleName) → Paperclip agent UUID
    createIssue() → sub-issue with metadata (bmadPhase, dependsOn)
    status = (no deps) ? "todo" : "backlog"
    ↓
Paperclip auto-invokes heartbeat for "todo" sub-issues
    ↓
On sub-issue completion:
    reEvaluateDelegation() → check dependency satisfaction
    Promote ready backlog → todo
    All done → close parent
```

## Key Design Decisions

### 1. Single Source of Truth for State Transitions

**Module:** `src/adapter/lifecycle.ts`

All issue status changes flow through `lifecycle.ts` functions (`completePhase()`, `passReview()`, `failReview()`, `escalateReview()`, `promoteToTodo()`). No other module directly mutates issue status. This prevents race conditions and ensures deterministic state transitions.

### 2. Thread-Safe Tool Context

**Module:** `src/tools/tool-context.ts`

Tools need access to Paperclip client and workspace context but can't receive them as parameters (Copilot SDK tools are invoked by the LLM). The `ToolContext` pattern uses module-scoped state (`setToolContext()` before dispatch, `getToolContext()` inside tool execution). Safe because each heartbeat runs in its own process.

### 3. Phase-Based Agent Routing

**Module:** `src/adapter/agent-dispatcher.ts`

WorkPhase determines which agent, tools, and prompt template to use. Two prompt styles:
- **Template prompts** (create-story, dev-story, code-review): Rigid, tool-specific instructions
- **Context prompts** (research, define, plan, execute): Issue description as primary instruction, BMAD skills provide methodology

### 4. Model Tier Strategy

**Module:** `src/config/model-strategy.ts`

Complexity-based routing to optimize cost/quality tradeoff:
- **fast** (sprint-status): gpt-4o-mini / claude-haiku
- **standard** (create-story, dev-story): claude-sonnet / gpt-4o
- **powerful** (code-review, architecture): claude-opus / o3

Upgrades based on complexity signals: file count > 5, LOC > 500, security-critical, architectural changes.

### 5. Push Model (Not Pull)

Paperclip spawns agent processes via heartbeats. Agents don't poll for work — they're invoked, process their inbox, report results, and exit. This enables:
- Clean process isolation (one heartbeat = one process)
- No long-running daemons (except `paperclip-loop.ts` in dev)
- Budget enforcement via process lifecycle
- Paperclip controls scheduling and concurrency

### 6. Adversarial Quality Gates

**Module:** `src/quality-gates/`

Code review is adversarial by design:
- Severity-weighted scoring (LOW:1, MED:3, HIGH:7, CRITICAL:15)
- HIGH/CRITICAL findings block merge
- Multi-pass fix-and-retry loop (max 3 passes before human escalation)
- Review history persisted to YAML for audit trail
- Categories: correctness, security, performance, error-handling, type-safety, maintainability, testing, documentation, style

### 7. CEO Orchestrator Pattern

**Module:** `src/adapter/ceo-orchestrator.ts`

Complex issues are delegated by a CEO agent that:
- Analyzes the issue context and available specialist agents
- Creates a structured delegation plan with dependencies
- Creates sub-issues assigned to specialist agents
- Re-evaluates when sub-issues complete (dependency-driven promotion)
- Only creates Research/Define/Plan tasks; Execute/Review happen automatically after Plan

### 8. Session Resume

**Module:** `src/adapter/session-manager.ts`

Copilot SDK sessions are persisted to `_bmad-output/session-index.json` (keyed by `agentName:storyId`). When a story re-enters a phase (e.g., after review failure), the session is resumed rather than created fresh, preserving conversation context.

## Security Considerations

- **Bearer auth**: All Paperclip API calls use agent-scoped API keys
- **Company isolation**: API keys bound to single company; cross-company access denied
- **No secrets in code**: All credentials via environment variables
- **Run ID correlation**: `X-Paperclip-Run-Id` header links API calls to heartbeat runs
- **Checkout semantics**: Mutual exclusion prevents concurrent issue processing
- **Process isolation**: Each heartbeat runs in its own process (no shared state)

## Error Handling Strategy

| Layer | Strategy |
|-------|----------|
| HTTP client | `PaperclipApiError` with status code, endpoint, response body |
| Retry | Exponential backoff with ±25% jitter; retryable: 500+, 408, TypeError |
| Lifecycle | Non-fatal transitions (log + continue); fatal only for unknown states |
| Tools | Validation at entry via Zod schemas; graceful error returns to LLM |
| Quality gates | Pure logic (no side effects); errors wrapped in GateResult |
| Observability | Best-effort (non-fatal telemetry failures don't block work) |

## Observability Architecture

```
BMAD Factory
    ├── Structured Logger → stdout (JSON or human-readable)
    ├── OTel Tracer → OTLP (:4317) → OTel Collector → Jaeger (:16686)
    ├── OTel Metrics → OTLP (:4317) → OTel Collector → Prometheus (:9090)
    └── Cost Tracker → POST /api/companies/:companyId/cost-events

Prometheus → Grafana (:3000)
    └── Pre-built dashboard:
        ├── Stories processed / done (counters)
        ├── Agent dispatch latency p50/p95/p99 (histogram)
        ├── Quality gate verdicts (pie chart)
        ├── Active sessions (gauge)
        ├── Stall detections (counter)
        └── Review passes (timeline)
```

### OTel Instruments (8 metrics)

| Instrument | Type | Description |
|-----------|------|-------------|
| `bmad.stories.processed` | Counter | Stories processed per cycle |
| `bmad.stories.done` | Counter | Stories reaching "done" status |
| `bmad.dispatch.duration` | Histogram | Agent dispatch latency (ms) |
| `bmad.review.passes` | Counter | Review pass attempts |
| `bmad.stall.detected` | Counter | Stalled story detections |
| `bmad.sessions.active` | UpDownCounter | Currently active SDK sessions |
| `bmad.gates.evaluated` | Counter | Quality gate evaluations |
| `bmad.cost.tokens` | Counter | Estimated tokens consumed |

### Tracing Spans

| Span | Description |
|------|-------------|
| `bmad.sprint_cycle` | Full sprint processing cycle |
| `bmad.story_processing` | Single story processing |
| `bmad.agent_dispatch` | Agent dispatch (phase + agent) |
| `bmad.quality_gate` | Quality gate evaluation |
| `bmad.paperclip_api` | Individual Paperclip API call |

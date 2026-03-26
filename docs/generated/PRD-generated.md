# BMAD Copilot Factory — Product Requirements Document

> Generated: 2026-03-26 | Source: Exhaustive source code analysis (not derived from existing docs)

## 1. Product Overview

### 1.1 Product Name

BMAD Copilot Factory

### 1.2 Vision

An autonomous software development system that orchestrates specialized AI agents through a structured methodology to build, review, and deliver software — from backlog to production — with minimal human intervention.

### 1.3 Problem Statement

AI-assisted coding tools operate as single-agent, single-task systems. They lack:

- **Orchestration**: No coordination between specialized roles (PM, architect, developer, QA)
- **Methodology**: No structured lifecycle (story creation → implementation → review → delivery)
- **Quality enforcement**: No adversarial review with severity-scored findings
- **Budget awareness**: No cost tracking or model tier optimization
- **Observability**: No distributed tracing or metrics for autonomous operations

### 1.4 Solution

A 3-layer system:

| Layer | Component | Responsibility |
|-------|-----------|---------------|
| Orchestration | Paperclip | Org charts, goals, budgets, governance, push-model heartbeats |
| Methodology | BMAD Method | Sprint lifecycle, story creation, adversarial code review, quality gates |
| Execution | GitHub Copilot SDK | Programmable agent runtime with custom agents, tools, MCP, skills |

### 1.5 Target Users

- **Primary**: Development teams seeking autonomous sprint execution
- **Secondary**: Engineering managers monitoring autonomous agent operations
- **Tertiary**: Platform teams integrating AI agents into existing workflows

---

## 2. Functional Requirements

### FR-1: Agent Persona System

**Priority**: P0 (Critical)

The system SHALL support 9 specialized BMAD agent personas, each with:

| Agent | ID | Primary Capability |
|-------|-----|-------------------|
| Product Manager | `bmad-pm` | PRD creation, requirements discovery, stakeholder alignment |
| Architect | `bmad-architect` | Technical design, system architecture, data models |
| Developer | `bmad-dev` | Story implementation, test-driven development |
| QA Engineer | `bmad-qa` | Adversarial code review with severity scoring |
| Scrum Master | `bmad-sm` | Sprint planning, story preparation |
| Analyst | `bmad-analyst` | Business analysis, competitive research |
| UX Designer | `bmad-ux` | UX design, interaction patterns |
| Tech Writer | `bmad-tech-writer` | Documentation, knowledge curation |
| Quick-Flow Dev | `bmad-quick-flow` | Rapid combined dev+review for simple tasks |

Each agent SHALL have:
- A unique persona identity (name, communication style)
- A structured XML prompt (personality, config loading, greeting, menu, handlers)
- Registration in a central agent registry with lookup by name

### FR-2: CEO Orchestrator

**Priority**: P0 (Critical)

The system SHALL include a CEO orchestrator agent that:

- Analyzes incoming parent issues and available specialist agents
- Generates structured delegation plans (JSON) with dependency chains
- Creates sub-issues assigned to specialist agents with phase metadata
- Manages dependency satisfaction: promotes backlog → todo when prerequisites complete
- Re-evaluates delegation when notified of sub-issue completion
- Creates only Research/Define/Plan tasks; Execute/Review auto-proceed from Plan completion

Delegation plan structure:
```typescript
interface DelegationPlan {
  analysis: string;
  phases: string[];
  tasks: DelegationTask[];
  requiresApproval: boolean;
  approvalReason?: string;
}

interface DelegationTask {
  title: string;
  description: string;
  assignTo: string;        // BMAD role name
  priority: 'critical' | 'high' | 'medium' | 'low';
  phase: 'research' | 'define' | 'plan' | 'execute' | 'review';
  dependsOn: number[];     // Task indices
}
```

### FR-3: Phase-Based Agent Dispatch

**Priority**: P0 (Critical)

The AgentDispatcher SHALL route work items to agents based on WorkPhase:

| Phase | Agent | Tools | Prompt Style |
|-------|-------|-------|-------------|
| create-story | bmad-pm/bmad-sm | create_story, issue_status | Template |
| dev-story | bmad-dev | issue_status | Template |
| code-review | bmad-qa | code_review, code_review_result, quality_gate_evaluate, issue_status | Template |
| research, domain-research, market-research, technical-research | bmad-analyst | issue_status | Context |
| create-prd | bmad-pm | issue_status | Context |
| create-architecture | bmad-architect | issue_status | Context |
| create-ux-design | bmad-ux | issue_status | Context |
| documentation | bmad-tech-writer | issue_status | Context |
| quick-dev | bmad-quick-flow | issue_status | Context |
| delegated-task, ceo-delegation, ceo-reeval | ceo | issue_status | Context |

The dispatcher SHALL support 20+ WorkPhase values and two prompt styles:
- **Template prompts**: Rigid tool-specific instructions for core phases
- **Context prompts**: Issue description as primary instruction with BMAD skill delegation

### FR-4: Copilot SDK Tools

**Priority**: P0 (Critical)

The system SHALL implement 5 tools via the Copilot SDK `defineTool()` API:

#### FR-4.1: create_story
- Generates story markdown file in `_bmad-output/stories/{story_id}.md`
- Creates corresponding Paperclip issue with status='backlog'
- Sets metadata: bmadPhase, storyId, storyFilePath, epicId, reviewPasses=0
- Implements dedup guard (checks for existing sibling with same storyId)

#### FR-4.2: code_review
- Initiates code review pass for a story
- Reads pass count from issue metadata, checks against limit, increments
- Provides review protocol and story content to LLM for analysis

#### FR-4.3: code_review_result
- Records review outcome and transitions issue lifecycle
- On approve: `passReview()` → done, wake parent
- On reject (passes < limit): update metadata
- On reject (passes >= limit): `escalateReview()` → parent comment for human

#### FR-4.4: issue_status
- Read: Lists sibling issues with status, phase, reviewPasses
- Update: Changes status/metadata (merge, not replace), posts comment
- Reassign: Releases checkout, updates assignee, auto-sets workPhase from ROLE_TO_PHASE

#### FR-4.5: quality_gate_evaluate
- Accepts structured findings from LLM (severity, category, file_path, description)
- Evaluates gate via quality gate engine
- Records pass in review history (YAML persistence)
- Transitions issue based on verdict (pass→done, fail→metadata, escalate→parent)

### FR-5: Issue Lifecycle State Machine

**Priority**: P0 (Critical)

All issue state transitions SHALL flow through a single source of truth (`lifecycle.ts`):

```
backlog → todo (CEO promotes when dependencies met)
todo → in_progress (agent checks out)
in_progress → phase execution
    create-story → dev-story (SM → Dev reassignment)
    dev-story → code-review (Dev → QA reassignment)
    code-review:
        PASS → done (wake parent)
        FAIL → dev-story (QA → Dev, fix cycle)
        ESCALATE → done (human escalation)
    other phases → done (terminal)
```

No other module SHALL directly mutate issue status.

### FR-6: Adversarial Quality Gates

**Priority**: P0 (Critical)

The quality gate system SHALL enforce:

| Severity | Weight | Blocks Merge |
|----------|--------|-------------|
| LOW | 1 | No |
| MEDIUM | 3 | No |
| HIGH | 7 | Yes |
| CRITICAL | 15 | Yes |

Finding categories: correctness, security, performance, error-handling, type-safety, maintainability, testing, documentation, style.

Gate verdicts:
- **PASS**: 0 blocking (unfixed HIGH/CRITICAL) findings
- **FAIL**: Blocking findings present, passes remaining (max 3)
- **ESCALATE**: Blocking findings present, max passes exhausted → human intervention

Review history SHALL be persisted to `_bmad-output/review-history/{storyId}.yaml`.

### FR-7: Paperclip Integration

**Priority**: P0 (Critical)

The system SHALL integrate with Paperclip via:

- **Process adapter** (heartbeat-entrypoint.ts): Spawned per heartbeat, 10-step pipeline
- **Inbox polling** (paperclip-loop.ts): Long-running loop for development
- **Webhook server** (webhook-server.ts): HTTP listener on :3200 for production

API integration SHALL cover ~20 endpoints:
- Agent management (CRUD, pause/resume/terminate)
- Heartbeat and wakeup
- Issue management (CRUD, checkout/release mutual exclusion)
- Issue comments (primary result reporting mechanism)
- Cost events (structured token usage reporting)
- Org chart and dashboard

Authentication: Bearer API key (company-scoped, per-agent).

### FR-8: Cost Tracking

**Priority**: P1 (High)

The CostTracker SHALL:

- Estimate tokens from text length (4 chars ≈ 1 token heuristic)
- Maintain 34 model pricing entries (Anthropic, OpenAI, Google, Mistral, Meta)
- Infer provider from model name (e.g., `claude-*` → anthropic, `gpt-*` → openai)
- Track usage per agent, per model with cumulative totals
- Report via dual path:
  - Native: `POST /api/companies/:companyId/cost-events` (structured PaperclipCostEvent)
  - Markdown: Issue comment with formatted cost report

Pricing lookup chain: exact match → normalize dots↔dashes → prefix match → default.

### FR-9: Model Strategy

**Priority**: P1 (High)

The system SHALL route models based on complexity:

| Tier | Phases | Copilot Default | BYOK Anthropic | BYOK OpenAI |
|------|--------|-----------------|----------------|-------------|
| fast | sprint-status | gpt-4o-mini | claude-haiku-3.5 | gpt-4o-mini |
| standard | create-story, dev-story | claude-sonnet-4.6 | claude-sonnet-4.5 | gpt-4o |
| powerful | code-review, architecture | claude-opus-4.6 | claude-opus-4 | o3 |

Complexity upgrades: files > 5, LOC > 500, security-critical, architectural changes.

BYOK preference controlled by `MODEL_PREFER_BYOK` environment variable.

### FR-10: Session Management

**Priority**: P1 (High)

The SessionManager SHALL:

- Manage CopilotClient lifecycle (start, create sessions, stop)
- Support session resume across process restarts via persistent index (`session-index.json`)
- Track per-session metadata (agentName, storyId, messageCount)
- Support streaming via `assistant.message_delta` listener
- Map sessions by `{agentName}:{storyId}` for resume lookup

### FR-11: MCP Server

**Priority**: P2 (Medium)

The system SHALL expose 5 MCP tools via StdioServerTransport:

| Tool | Purpose |
|------|---------|
| get_sprint_status | Read sprint-status.yaml with counts by status |
| get_next_story | Find first story with status='ready-for-dev' |
| update_story_status | Update with lifecycle transition validation |
| get_architecture_docs | Return architecture documentation |
| get_story_details | Return story metadata + full markdown content |

### FR-12: Health Check System

**Priority**: P1 (High)

The system SHALL run 5 health probes:

| Probe | Critical | Checks |
|-------|----------|--------|
| config | Yes | Required fields present and valid |
| agents | Yes | At least 1 BMAD agent registered |
| tools | Yes | Required tools present (create_story, code_review, code_review_result, issue_status) |
| sprint-file | No | sprint-status.yaml readable |
| paperclip | Conditional | Ping /api/health (critical only if PAPERCLIP_ENABLED) |

Status: healthy (all pass) / degraded (non-critical fail) / unhealthy (critical fail).

---

## 3. Non-Functional Requirements

### NFR-1: Observability

**Priority**: P1 (High)

The system SHALL support full observability when `OTEL_ENABLED=true`:

- **Structured logging**: JSON or human-readable format, level filtering (debug/info/warn/error)
- **Distributed tracing**: OpenTelemetry traces exported via OTLP to Jaeger
  - Spans: sprint_cycle, story_processing, agent_dispatch, quality_gate, paperclip_api
- **Metrics**: 8 OTel instruments exported to Prometheus
  - Counters: stories.processed, stories.done, review.passes, stall.detected, gates.evaluated, cost.tokens
  - Histogram: dispatch.duration
  - UpDownCounter: sessions.active
- **Cost tracking**: Per-agent, per-model token and cost tracking with Paperclip cost-event API

### NFR-2: Reliability

**Priority**: P1 (High)

- **Retry**: Exponential backoff with ±25% jitter for transient Paperclip failures
  - Retryable: 500+, 408, TypeError (DNS/fetch), AbortError
  - Non-retryable: 400, 401, 403, 404, 409, 422
  - Idempotent methods (GET/DELETE) retry; mutations do not
- **Stall detection**: Phase timeout monitoring (ready:30m, in-progress:60m, review:30m) with escalation
- **Graceful degradation**: Non-fatal telemetry/comment failures don't block work
- **Process isolation**: Each heartbeat in its own process (no shared mutable state)
- **Checkout semantics**: Mutual exclusion on issue processing

### NFR-3: Security

**Priority**: P0 (Critical)

- All Paperclip API calls use company-scoped Bearer API keys
- No secrets hardcoded in source (environment variables only)
- API keys bound to single company; cross-company access denied
- Run ID correlation via `X-Paperclip-Run-Id` header
- Process isolation prevents cross-heartbeat data leakage

### NFR-4: Performance

**Priority**: P2 (Medium)

- Test suite: 333+ tests executing in ~2.5s
- TypeScript strict mode with ESM modules
- Model tier routing optimizes cost (fast tier for simple tasks)
- Session resume avoids unnecessary session creation
- In-memory reporter history with size-capped circular buffer

### NFR-5: Maintainability

**Priority**: P1 (High)

- TypeScript strict mode (no implicit any, no unused variables)
- ESLint with `@typescript-eslint/no-explicit-any: warn`
- Consistent error handling: `PaperclipApiError` class with structured context
- Barrel exports (`index.ts`) in each module directory
- Path aliases (`@agents/`, `@tools/`, `@adapter/`, `@config/`, `@mcp/`)
- JSDoc on all exported functions and types

### NFR-6: Extensibility

**Priority**: P2 (Medium)

- New agents: Add file in `src/agents/`, register in `registry.ts`
- New tools: Add file in `src/tools/`, register in tool index
- New phases: Add entry to `PHASE_TRANSITIONS` in `lifecycle.ts` and `getPhaseConfig()` in dispatcher
- New MCP tools: Register in `bmad-sprint-server/tools.ts`
- BMAD skills: Loaded from `bmad_res/skills/` directory
- Model pricing: Managed via `scripts/update-model-pricing.ts` (`--show`, `--apply`, `--json`)

---

## 4. Environment Variables

### 4.1 Core Configuration

| Variable | Default | Type | Description |
|----------|---------|------|-------------|
| `COPILOT_MODEL` | `claude-sonnet-4.6` | string | Default LLM model |
| `LOG_LEVEL` | `info` | enum | debug, info, warn, error |
| `LOG_FORMAT` | `human` | enum | json, human |
| `BMAD_DRY_RUN` | `false` | boolean | Skip SDK calls |
| `BMAD_TEST_MODE` | — | boolean | Enable test mode |

### 4.2 Paperclip Integration

| Variable | Default | Type | Description |
|----------|---------|------|-------------|
| `PAPERCLIP_ENABLED` | `false` | boolean | Enable Paperclip integration |
| `PAPERCLIP_URL` | `http://localhost:3100` | URL | Paperclip server URL |
| `PAPERCLIP_COMPANY_ID` | `bmad-factory` | string | Company ID (company-scoped) |
| `PAPERCLIP_AGENT_API_KEY` | — | string | Agent API key (Bearer auth) |
| `PAPERCLIP_AGENT_ID` | — | UUID | Agent UUID |
| `PAPERCLIP_MODE` | `inbox-polling` | enum | inbox-polling, webhook |
| `PAPERCLIP_RUN_ID` | — | UUID | Heartbeat run ID (set by process adapter) |

### 4.3 Webhook Server

| Variable | Default | Type | Description |
|----------|---------|------|-------------|
| `WEBHOOK_PORT` | `3200` | number | Webhook server port |

### 4.4 Model Strategy

| Variable | Default | Type | Description |
|----------|---------|------|-------------|
| `MODEL_PREFER_BYOK` | `false` | boolean | Prefer BYOK over Copilot quota |

### 4.5 Observability

| Variable | Default | Type | Description |
|----------|---------|------|-------------|
| `OTEL_ENABLED` | `false` | boolean | Enable OpenTelemetry export |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `http://localhost:4317` | URL | OTLP endpoint |
| `OTEL_SERVICE_NAME` | `bmad-factory` | string | Service name for traces |
| `OTEL_METRICS_INTERVAL_MS` | `30000` | number | Metrics export interval |

### 4.6 Stall Detection

| Variable | Default | Type | Description |
|----------|---------|------|-------------|
| `STALL_AUTO_ESCALATE` | `false` | boolean | Auto-escalate stalled stories |

### 4.7 Workspace Context (set by Paperclip process adapter)

| Variable | Description |
|----------|-------------|
| `PAPERCLIP_WORKSPACE_CWD` | Working directory for agent execution |
| `PAPERCLIP_WORKSPACE_REPO_URL` | Git repository URL |
| `PAPERCLIP_WORKSPACE_BRANCH` | Git branch name |
| `PAPERCLIP_WORKSPACE_STRATEGY` | Workspace strategy (shared, worktree, clone) |
| `PAPERCLIP_WORKSPACE_WORKTREE_PATH` | Git worktree path |
| `TARGET_PROJECT_ROOT` | Fallback workspace root |

### 4.8 Wake Context (set by Paperclip process adapter)

| Variable | Description |
|----------|-------------|
| `PAPERCLIP_TASK_ID` | Issue that triggered the heartbeat |
| `PAPERCLIP_WAKE_REASON` | Why agent was woken |
| `PAPERCLIP_WAKE_COMMENT_ID` | Comment that triggered wakeup |
| `PAPERCLIP_APPROVAL_ID` | Approval request ID |
| `PAPERCLIP_APPROVAL_STATUS` | Approval decision status |
| `PAPERCLIP_LINKED_ISSUE_IDS` | Comma-separated linked issue UUIDs |

---

## 5. Data Models

### 5.1 BmadAgent

```typescript
interface BmadAgent {
  name: string;          // e.g., "bmad-dev"
  displayName: string;   // e.g., "Amelia"
  description: string;   // Role description
  prompt: string;        // Full XML persona prompt
}
```

### 5.2 WorkItem

```typescript
interface WorkItem {
  id: string;
  phase: WorkPhase;
  storyId?: string;
  storyTitle?: string;
  storyDescription?: string;
  epicId?: string;
  extraContext?: string;
  complexitySignals?: ComplexitySignals;
  agentOverride?: string;
}
```

### 5.3 DispatchResult

```typescript
interface DispatchResult {
  success: boolean;
  response?: string;
  agentName: string;
  sessionId?: string;
  error?: string;
}
```

### 5.4 GateResult

```typescript
interface GateResult {
  verdict: 'PASS' | 'FAIL' | 'ESCALATE';
  storyId: string;
  passNumber: number;
  maxPasses: number;
  findings: ReviewFinding[];
  blockingCount: number;
  advisoryCount: number;
  severityScore: number;
  summary: string;
  evaluatedAt: string;     // ISO-8601
}
```

### 5.5 ReviewFinding

```typescript
interface ReviewFinding {
  id: string;
  severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  category: FindingCategory;
  filePath: string;
  line?: number;
  title: string;
  description: string;
  suggestedFix?: string;
  fixed?: boolean;
}
```

### 5.6 BmadConfig

```typescript
interface BmadConfig {
  projectRoot: string;
  sprintStatusPath: string;
  model: string;
  outputDir: string;
  reviewPassLimit: number;
  logLevel: string;
  logFormat: string;
  dryRun: boolean;
  skillDirectories: string[];
  observability: ObservabilityConfig;
  paperclip: PaperclipConfig;
}
```

---

## 6. Deployment Architecture

### 6.1 Deployment Modes

| Mode | Entry Point | Use Case |
|------|------------|----------|
| Process Adapter | `heartbeat-entrypoint.ts` | Production (Paperclip-managed) |
| Webhook Server | `webhook-server.ts` | Production (HTTP push) |
| Inbox Polling | `paperclip-loop.ts` | Development |
| Standalone CLI | `index.ts` | Testing, local development |

### 6.2 Container

Multi-stage Docker build: base → deps → build → runtime. Production command: `node dist/index.js --paperclip`.

### 6.3 Infrastructure

| Service | Port | Purpose |
|---------|------|---------|
| Paperclip | 3100 | Orchestration API |
| BMAD Webhook | 3200 | Push-model callback receiver |
| OTel Collector | 4317/4318 | Telemetry aggregation |
| Jaeger | 16686 | Trace visualization |
| Prometheus | 9090 | Metrics collection |
| Grafana | 3000 | Dashboards (admin/bmad) |

---

## 7. Testing Requirements

### 7.1 Unit Tests

- 333+ tests across 16+ files
- Framework: Vitest 3.0+ with globals
- Coverage: v8 provider
- Execution: ~2.5s total

### 7.2 E2E Tests

Three modes via `scripts/e2e-test.ts`:
- **Smoke**: Basic connectivity and pipeline validation
- **Full**: Complete pipeline with invariant checking
- **Autonomous**: Multi-agent coordination test

Validated invariants:
- D1-D12: Delegation (CEO creates sub-issues, dependency ordering)
- P1-P5: Phase transitions (create-story → dev-story → code-review)
- C1-C3: Cross-phase coordination (SM→Dev→QA handoff)
- E1-E7: Execution (dispatch, tool invocation, result reporting)
- R1-R3: Review (multi-pass, fix cycles, escalation)

### 7.3 Health Check

5-probe system readiness validation (config, agents, tools, sprint-file, paperclip).

---

## 8. Acceptance Criteria

### AC-1: Autonomous Story Lifecycle
Given a story in backlog status, when processed by the system, then it SHALL progress through create-story → dev-story → code-review → done without human intervention (unless quality gates escalate).

### AC-2: CEO Delegation
Given a complex issue assigned to the CEO agent, when the CEO analyzes it, then it SHALL produce a structured delegation plan and create sub-issues with correct dependency chains.

### AC-3: Quality Gate Enforcement
Given a code review with HIGH or CRITICAL findings, when the quality gate evaluates, then it SHALL block the story from reaching "done" and trigger a fix cycle.

### AC-4: Cost Tracking
Given any agent dispatch, when tokens are consumed, then the system SHALL estimate costs and report them via both Paperclip cost-events API and issue comments.

### AC-5: Observability
Given `OTEL_ENABLED=true`, when the system processes stories, then distributed traces SHALL appear in Jaeger and metrics SHALL appear in Prometheus/Grafana.

### AC-6: Process Isolation
Given concurrent heartbeats for different agents, when processing simultaneously, then no shared state SHALL leak between processes.

### AC-7: Retry Resilience
Given transient Paperclip API failures (5xx), when retryable operations fail, then the system SHALL retry with exponential backoff and jitter.

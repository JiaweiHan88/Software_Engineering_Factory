# BMAD Copilot Factory — Current Workflow Analysis

> Derived from codebase analysis on 2026-03-24.
> Goal: Map the current autonomous software factory workflow end-to-end.

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [System Architecture Overview](#2-system-architecture-overview)
3. [Agent Roster & Capabilities](#3-agent-roster--capabilities)
4. [Entry Points & Integration Modes](#4-entry-points--integration-modes)
5. [End-to-End Workflow: Issue → Delivered Software](#5-end-to-end-workflow-issue--delivered-software)
6. [CEO Orchestration Pipeline](#6-ceo-orchestration-pipeline)
7. [Specialist Agent Execution](#7-specialist-agent-execution)
8. [Quality Gate System](#8-quality-gate-system)
9. [Sprint Runner (Legacy/Alternative Flow)](#9-sprint-runner-legacyalternative-flow)
10. [Traceability & Observability](#10-traceability--observability)
11. [Gap Analysis: What's Missing for a Fully Autonomous Factory](#11-gap-analysis-whats-missing-for-a-fully-autonomous-factory)
12. [Proposed Target Workflow](#12-proposed-target-workflow)

---

## 1. Executive Summary

The BMAD Copilot Factory bridges two systems:

| System | Role |
|--------|------|
| **Paperclip** | Orchestration control plane — org charts, issue tracking, agent lifecycle, budgets, heartbeats (push model) |
| **GitHub Copilot SDK** | Agent runtime — LLM sessions, tool execution, skill prompts, code generation |

**Current state:** The system has **two independent execution paths** that are not yet unified:

1. **CEO Orchestration Path** (via `heartbeat-entrypoint.ts` → `ceo-orchestrator.ts`): Paperclip spawns the CEO heartbeat, the CEO decomposes a high-level issue into a dependency-aware sub-task plan, creates sub-issues in Paperclip assigned to specialists, and re-evaluates when specialists complete. **This is the Paperclip-native flow.**

2. **Sprint Runner Path** (via `sprint-runner.ts`): Reads a local `sprint-status.yaml` file, iterates stories through `backlog → ready-for-dev → in-progress → review → done`, dispatching to agents via the `AgentDispatcher`. **This is the BMAD-native flow.**

**Key insight:** These two paths operate on **different state stores** (Paperclip issues vs. local YAML) and use **different lifecycle models**. The CEO path is issue-centric; the Sprint Runner path is story-centric. They don't currently compose into a single end-to-end pipeline.

---

## 2. System Architecture Overview

```
┌──────────────────────────────────────────────────────────────────────┐
│                        PAPERCLIP SERVER (:3100)                      │
│  Org Chart · Issues · Goals · Budgets · Cost Events · Heartbeats     │
└────────────────────────────┬─────────────────────────────────────────┘
                             │ spawn process (heartbeat invoke)
                             ▼
┌──────────────────────────────────────────────────────────────────────┐
│                    HEARTBEAT ENTRYPOINT (10-step pipeline)            │
│  1. Extract env  2. Create client  3. Identify self  4. Role map     │
│  5. Check inbox  6. Load 4-file config  7. Bootstrap SDK             │
│  8. Process issues  9. Report costs  10. Cleanup                     │
└────────┬──────────────────────────────────┬──────────────────────────┘
         │ isOrchestrator=true              │ isOrchestrator=false
         ▼                                  ▼
┌─────────────────────┐          ┌─────────────────────────┐
│   CEO ORCHESTRATOR   │          │    HEARTBEAT HANDLER     │
│  Delegation plans    │          │  HeartbeatContext →      │
│  Sub-issue creation  │          │  AgentDispatcher →       │
│  Re-evaluation       │          │  Reporter                │
└─────────┬───────────┘          └───────────┬─────────────┘
          │                                   │
          │  Creates sub-issues in            │  Routes to BMAD agents
          │  Paperclip, assigned to           │  via SessionManager
          │  specialists                      │
          ▼                                   ▼
┌──────────────────────────────────────────────────────────────────────┐
│                        COPILOT SDK (CopilotClient)                   │
│  Sessions · Custom Agents · Tools · Skills · Model Strategy          │
└──────────────────────────────────────────────────────────────────────┘
          │
          ▼
┌──────────────────────────────────────────────────────────────────────┐
│                     LLM PROVIDERS (3-tier routing)                    │
│  Standard: gpt-4o-mini, haiku-3.5                                    │
│  Powerful: gpt-4o, claude-sonnet-4.5                                 │
│  Reasoning: o3, opus-4                                               │
└──────────────────────────────────────────────────────────────────────┘
```

---

## 3. Agent Roster & Capabilities

### 3.1 CEO (Orchestrator)

| Field | Value |
|-------|-------|
| **Paperclip Role** | `ceo` / `bmad-ceo` |
| **BMAD Agent** | None (orchestrates, doesn't do domain work) |
| **4-File Config** | `bmad_res/agents/ceo/` |
| **Capabilities** | Issue decomposition, dependency-aware delegation, re-evaluation, unblocking |
| **Tools** | `sprint_status` |
| **Model Tier** | Powerful/Reasoning (strategic reasoning) |

The CEO follows a structured HEARTBEAT.md checklist:
1. Identify self & read wake context
2. Check local planning state
3. Handle approvals
4. Get assignments from inbox
5. Decompose & delegate (Research → Define → Plan → Execute → Review)
6. Monitor progress of previously delegated work
7. Extract facts to memory (PARA system)
8. Exit cleanly

### 3.2 Specialist Agents (9 agents)

| Agent | Name | Canonical ID | Primary Phases | Key Skills | Tools |
|-------|------|-------------|----------------|------------|-------|
| **Product Manager** | John | `bmad-pm` | PRD creation, epics, stories, readiness checks | `bmad-create-prd`, `bmad-create-epics-and-stories`, `bmad-check-implementation-readiness` | `create_story`, `sprint_status` |
| **Architect** | Winston | `bmad-architect` | Architecture design, tech research | `bmad-create-architecture`, `bmad-technical-research` | `sprint_status` |
| **Developer** | Amelia | `bmad-dev` | Story implementation, TDD | `bmad-dev-story`, `bmad-quick-dev` | `dev_story`, `sprint_status` |
| **QA Engineer** | Quinn | `bmad-qa` | Code review, E2E tests, quality gates | `bmad-code-review`, `bmad-qa-generate-e2e-tests`, `bmad-testarch-*` | `code_review`, `code_review_result`, `quality_gate_evaluate`, `sprint_status` |
| **Scrum Master** | Bob | `bmad-sm` | Sprint planning, status, retrospective | `bmad-sprint-planning`, `bmad-sprint-status` | `sprint_status`, `create_story` |
| **Analyst** | Mary | `bmad-analyst` | Market/domain/technical research, brainstorming | `bmad-brainstorming`, `bmad-market-research`, `bmad-domain-research` | `sprint_status` |
| **UX Designer** | Sally | `bmad-ux-designer` | UX design specs | `bmad-create-ux-design` | `sprint_status` |
| **Tech Writer** | Paige | `bmad-tech-writer` | Documentation, editorial review | `bmad-document-project`, `bmad-editorial-review-*` | `sprint_status` |
| **Quick Flow** | Barry | `bmad-quick-flow-solo-dev` | Spec + implement + review in one pass | `bmad-quick-flow-solo-dev`, `bmad-dev-story`, `bmad-code-review` | `dev_story`, `create_story`, `code_review`, `sprint_status` |

---

## 4. Entry Points & Integration Modes

### 4.1 Primary: Heartbeat Entrypoint (`heartbeat-entrypoint.ts`)

**This is the production entry point.** Paperclip's process adapter spawns a Node.js process for each agent heartbeat, injecting environment variables:

```
PAPERCLIP_API_KEY (JWT) · PAPERCLIP_URL · PAPERCLIP_COMPANY_ID
PAPERCLIP_AGENT_ID · PAPERCLIP_RUN_ID · PAPERCLIP_WORKSPACE_CWD
PAPERCLIP_TASK_ID · PAPERCLIP_WAKE_REASON · PAPERCLIP_WAKE_COMMENT_ID
```

The process executes the 10-step pipeline and exits. Key features:
- **Checkout/Release protocol** — atomic issue locking (prevents concurrent processing)
- **Prerequisite guard** — skips issues whose `dependsOn` indices aren't all `done`
- **Blocked-task dedup** — won't re-process a blocked task if no new comments arrived
- **Wake context priority** — `PAPERCLIP_TASK_ID` is moved to front of inbox queue
- **CEO routing** — orchestrators get `orchestrateCeoIssue()` or `reEvaluateDelegation()`, specialists get `handlePaperclipIssue()`
- **Cost tracking** — every LLM interaction posts a `PaperclipCostEvent` to the native costs API

### 4.2 Secondary: Inbox-Polling Loop (`paperclip-loop.ts`)

A long-running Node.js process that periodically calls `GET /api/agents/me/inbox-lite`. Development convenience — simulates the push model. Creates all BMAD agents in Paperclip on startup.

### 4.3 Legacy: Sprint Runner (`sprint-runner.ts`)

Reads `sprint-status.yaml` and drives stories through `backlog → ready-for-dev → in-progress → review → done`. Operates on local YAML state, not Paperclip issues. Includes the `ReviewOrchestrator` for adversarial multi-pass code review.

### 4.4 Planned: Webhook Server (`webhook-server.ts`)

HTTP endpoint on `:3200` that Paperclip calls directly. Not yet implemented (falls back to inbox-polling).

---

## 5. End-to-End Workflow: Issue → Delivered Software

### Current Flow (CEO Orchestration Path)

```
┌─────────────────────────────────────────────────────────────────────────┐
│                       PAPERCLIP BOARD / HUMAN                            │
│  Creates issue: "Build a REST API for user management"                   │
│  Assigns to: CEO agent                                                   │
└────────────────────────────────────┬────────────────────────────────────┘
                                     │ Heartbeat invoke
                                     ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                         CEO HEARTBEAT (Step 8)                           │
│                                                                          │
│  1. No existing children → INITIAL DELEGATION                            │
│     a. Create Copilot session with CEO persona                           │
│     b. Send delegation prompt with issue + agent roster                  │
│     c. Parse DelegationPlan JSON from LLM response                       │
│     d. Create sub-issues in Paperclip with dependency-aware scheduling:  │
│        ┌──────────────────────────────────────────────────────┐          │
│        │ [0] Research: "Investigate REST API patterns"        │ → todo   │
│        │     assignTo: bmad-analyst, dependsOn: []            │          │
│        │ [1] Define: "Create PRD for user management API"     │ → backlog│
│        │     assignTo: bmad-pm, dependsOn: [0]                │          │
│        │ [2] Define: "Design system architecture"             │ → backlog│
│        │     assignTo: bmad-architect, dependsOn: [0, 1]      │          │
│        │ [3] Plan: "Create epics and stories"                 │ → backlog│
│        │     assignTo: bmad-pm, dependsOn: [1, 2]             │          │
│        │ [4] Execute: "Implement user API"                    │ → backlog│
│        │     assignTo: bmad-dev, dependsOn: [3]               │          │
│        │ [5] Review: "Code review"                            │ → backlog│
│        │     assignTo: bmad-qa, dependsOn: [4]                │          │
│        │ [6] Execute: "Write documentation"                   │ → backlog│
│        │     assignTo: bmad-tech-writer, dependsOn: [4]       │          │
│        └──────────────────────────────────────────────────────┘          │
│     e. Post delegation summary comment on parent issue                   │
│                                                                          │
│  2. Existing children → RE-EVALUATION                                    │
│     a. Fetch all child issues                                            │
│     b. Fast path: deterministic promotion (check dependsOn vs status)    │
│     c. Slow path: LLM reasoning for stuck/complex situations             │
│     d. Promote ready backlog → todo (triggers specialist wakeup)         │
│     e. Close parent when all children done                               │
└─────────────────────────────────────────────────────────────────────────┘
                                     │
               Sub-issues in "todo" trigger specialist heartbeats
                                     │
                                     ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                    SPECIALIST HEARTBEAT (Step 8)                          │
│                                                                          │
│  1. handlePaperclipIssue() converts issue → HeartbeatContext             │
│  2. Resolves WorkPhase from:                                             │
│     a. Explicit issue.phase                                              │
│     b. metadata.bmadPhase (from CEO delegation)                          │
│     c. inferPhaseFromRole() (fallback)                                   │
│  3. AgentDispatcher.dispatch():                                          │
│     a. Phase → PhaseConfig lookup (agent, tools, prompt builder)         │
│     b. Resolve optimal LLM model (3-tier strategy)                       │
│     c. Create Copilot session with agent persona + tools + skills        │
│     d. Send constructed prompt                                           │
│     e. Agent uses Copilot built-in tools (read_file, write_file, etc.)   │
│     f. 15-minute timeout per dispatch                                    │
│  4. Reporter posts result as issue comment                               │
│  5. Reporter sets issue status to "done"                                 │
│  6. Reporter.wakeParentAssignee() triggers CEO re-evaluation             │
└─────────────────────────────────────────────────────────────────────────┘
```

### Specialist Phase Routing (from `getPhaseConfig()`)

The `AgentDispatcher` maps each `WorkPhase` to a specific agent, tool set, and prompt:

| Phase | Agent | Prompt Style | Tools |
|-------|-------|-------------|-------|
| `create-story` | bmad-pm | Template: use `create_story` tool | `createStory`, `sprintStatus` |
| `dev-story` | bmad-dev | Template: use `dev_story` tool | `devStory`, `sprintStatus` |
| `code-review` | bmad-qa | Template: use `code_review` tool | `codeReview`, `codeReviewResult`, `qualityGateEvaluate`, `sprintStatus` |
| `sprint-planning` | bmad-sm | Template | `sprintStatus`, `createStory` |
| `sprint-status` | bmad-sm | Template | `sprintStatus` |
| `research` | bmad-analyst | Context: issue title+description as prompt | `sprintStatus` |
| `domain-research` | bmad-analyst | Context | `sprintStatus` |
| `market-research` | bmad-pm | Context | `sprintStatus` |
| `technical-research` | bmad-architect | Context | `sprintStatus` |
| `create-prd` | bmad-pm | Context | `sprintStatus` |
| `create-architecture` | bmad-architect | Context | `sprintStatus` |
| `create-ux-design` | bmad-ux-designer | Context | `sprintStatus` |
| `create-product-brief` | bmad-pm | Context | `sprintStatus` |
| `create-epics` | bmad-pm | Context | `createStory`, `sprintStatus` |
| `check-implementation-readiness` | bmad-pm | Context | `sprintStatus` |
| `e2e-tests` | bmad-qa | Context | `codeReview`, `qualityGateEvaluate`, `sprintStatus` |
| `documentation` | bmad-tech-writer | Context | `sprintStatus` |
| `quick-dev` | bmad-quick-flow | Context | `devStory`, `createStory`, `codeReview`, `sprintStatus` |
| `editorial-review` | bmad-tech-writer | Context | `sprintStatus` |
| `delegated-task` | bmad-dev (default, overridable) | Context: full issue as prompt | All tools |

---

## 6. CEO Orchestration Pipeline

### 6.1 Initial Delegation

The CEO receives a high-level issue and produces a `DelegationPlan`:

```typescript
interface DelegationPlan {
  analysis: string;                    // CEO's analysis of the issue
  phases: string[];                    // Which BMAD phases are needed
  tasks: DelegationTask[];             // Ordered sub-tasks with dependencies
  requiresApproval: boolean;           // Human gate for high-impact decisions
  approvalReason?: string;
}

interface DelegationTask {
  title: string;                       // Human-readable title
  description: string;                 // Self-contained context for the agent
  assignTo: string;                    // BMAD role (e.g., "bmad-architect")
  priority: "critical"|"high"|"medium"|"low";
  phase: "research"|"define"|"plan"|"execute"|"review";
  dependsOn: number[];                 // Task indices that must complete first
}
```

**Dependency-aware scheduling:**
- `dependsOn: []` → issue created as `todo` → **immediate agent wakeup**
- `dependsOn: [0, 1]` → issue created as `backlog` → **held until CEO promotes**

### 6.2 Re-Evaluation

When a specialist completes a sub-issue, the reporter calls `wakeParentAssignee()`, which re-triggers the CEO's heartbeat. The CEO:

1. **Fast path (deterministic):** Check all backlog children — if all `dependsOn` indices have status `done`, promote to `todo` (no LLM call needed)
2. **Slow path (LLM reasoning):** For stuck/blocked/complex situations, create a CEO session to reason about actions: promote, comment, reassign, or close parent
3. **All done:** If every child is `done`, close the parent issue

### 6.3 Approval Gate

If the CEO's plan has `requiresApproval: true` (budget > $1000, irreversible infra, unclear scope), it posts the full plan as an issue comment and waits for human approval before creating sub-issues.

---

## 7. Specialist Agent Execution

### 7.1 Session Creation

Each specialist heartbeat creates a Copilot SDK session with:

1. **Agent persona** — `BmadAgent.prompt` (XML-structured persona with activation steps, menu, rules)
2. **4-file system message** — `AGENTS.md + SOUL.md + HEARTBEAT.md + TOOLS.md` concatenated
3. **Custom agents** — All 9 BMAD agents registered (for @mention cross-referencing)
4. **Tools** — Filtered by role mapping (e.g., dev gets `dev_story` + `sprint_status`)
5. **Skills** — BMAD skill directories loaded as Copilot SDK `skillDirectories`
6. **Model** — Selected via 3-tier model strategy based on task phase and complexity

### 7.2 Workspace & Artifact Protocol

Context-driven prompts (CEO-delegated tasks) include a standard protocol:
- **BEFORE:** List workspace files, read prior artifacts (research, PRDs, architecture docs)
- **DURING:** Use BMAD skills and tools to complete the task
- **AFTER:** Save deliverables as markdown files, provide summary with filenames

### 7.3 Result Reporting

The `PaperclipReporter` handles all result communication:
- Posts structured comments to Paperclip issues (with emoji status indicators)
- Scans workspace for produced artifacts and lists them
- Updates issue status (`done`, `blocked`)
- Wakes the parent assignee (CEO) for re-evaluation on completion

---

## 8. Quality Gate System

### 8.1 Review Orchestrator (Multi-Pass Loop)

The `ReviewOrchestrator` drives adversarial code review:

```
Developer completes → code-review dispatch → parse findings → evaluate gate
  │
  ├─ PASS (0 blocking findings) → story status: done ✅
  │
  ├─ FAIL (blocking findings remain, passes < max) → fix dispatch → re-review 🔄
  │     Developer fixes HIGH/CRITICAL findings in-place
  │     Loop back to code-review (next pass)
  │
  └─ ESCALATE (passes >= max, still blocking) → human intervention ⚠️
       Max 3 review passes before escalation
```

### 8.2 Severity Model

| Severity | Weight | Blocks Merge? |
|----------|--------|--------------|
| LOW | 1 | No — style nit |
| MEDIUM | 3 | No — code smell |
| HIGH | 7 | **Yes** — bug, security issue |
| CRITICAL | 15 | **Yes** — data loss, crash |

### 8.3 Gate Engine (Pure Logic)

- `countBlocking()` — HIGH + CRITICAL findings (unfixed)
- `countAdvisory()` — LOW + MEDIUM findings
- `computeSeverityScore()` — weighted sum for quality trending
- `evaluateGate()` → `PASS` / `FAIL` / `ESCALATE`
- `decideNextAction()` → `approve` / `fix-and-retry` / `escalate`

### 8.4 Finding Parser

Structured format from agent:
```
[FINDING:F-001:HIGH:security:src/foo.ts:42]
Title of finding
Description of the problem.
[/FINDING]
```
Falls back to heuristic parsing for unstructured output.

### 8.5 Review History Persistence

Review history is persisted to YAML files (`review-history/{storyId}.review.yaml`) so review passes survive process restarts.

---

## 9. Sprint Runner (Legacy/Alternative Flow)

The `SprintRunner` operates on **local `sprint-status.yaml`** (not Paperclip issues):

```yaml
sprint:
  number: 1
  goal: "Build user management API"
  stories:
    - id: STORY-001
      title: "User CRUD endpoints"
      status: ready-for-dev    # backlog | ready-for-dev | in-progress | review | done
      assigned: bmad-dev
      reviewPasses: 0
```

### Phase Mapping

| Story Status | Next Phase | Agent |
|-------------|-----------|-------|
| `backlog` | `sprint-planning` | bmad-sm |
| `ready-for-dev` | `dev-story` | bmad-dev |
| `in-progress` | `dev-story` (retry) | bmad-dev |
| `review` | `code-review` | bmad-qa |
| `done` | (none) | — |

### Inner Loop Advancement

The sprint runner has an inner loop that keeps advancing a story through phases in a single cycle (`ready-for-dev → dev-story → code-review → done`), up to 5 phase transitions.

---

## 10. Traceability & Observability

### 10.1 Paperclip-Native Traceability

| Signal | Mechanism |
|--------|-----------|
| **Issue comments** | Every agent action posts a structured comment to the Paperclip issue |
| **Issue status** | Status transitions tracked: `todo → in_progress → done` |
| **Parent/child links** | CEO sub-issues linked via `parentId` |
| **Cost events** | Per-LLM-interaction cost events: model, tokens, cost, agent attribution |
| **Heartbeat runs** | `X-Paperclip-Run-Id` header correlates all API calls per heartbeat |
| **Checkout/release** | Atomic locking prevents concurrent processing |
| **Agent identity** | JWT-based auth attributes every action to the correct agent |

### 10.2 OpenTelemetry Observability

| Component | Purpose |
|-----------|---------|
| **Distributed traces** | Spans for sprint cycles, story processing, agent dispatches, quality gates |
| **Metrics** | Counters (stories processed, review passes), histograms (dispatch duration), gauges (active sessions) |
| **Stall detector** | Timeout-based alerting for stuck stories |
| **Structured logging** | JSON-mode logger with child contexts |

### 10.3 Monitoring Stack

Jaeger (traces) → Prometheus (metrics) → Grafana (dashboards)

---

## 11. Gap Analysis: What's Missing for a Fully Autonomous Factory

### 🔴 Critical Gaps

| # | Gap | Impact | Current State |
|---|-----|--------|---------------|
| **G1** | **No unified state model** | CEO path uses Paperclip issues; Sprint Runner uses local YAML. Two independent lifecycles don't compose. | The `dev_story` and `code_review` tools read/write `sprint-status.yaml`, but CEO-delegated tasks work through Paperclip issues only. |
| **G2** | **Story creation not connected to Paperclip** | The `create_story` tool writes to local markdown files — it doesn't create Paperclip issues. | Sprint planning creates local artifacts but doesn't feed the Paperclip issue tracker. |
| **G3** | **No end-to-end pipeline orchestration** | The CEO creates a delegation plan, but the transition from "plan phase" (epics/stories) to "execute phase" (dev-story per story) is not automated. | The CEO can create a sub-task "Create epics and stories" assigned to bmad-pm, but the resulting stories don't automatically become dev-story sub-tasks. |
| **G4** | **Quality gates only run in Sprint Runner path** | The `ReviewOrchestrator` (multi-pass adversarial review) is only wired into `SprintRunner`. The CEO path just does a single dispatch of `code-review` phase. | CEO-delegated code reviews are single-pass without fix-and-retry loops. |
| **G5** | **No Git integration** | No agent creates branches, commits, or pull requests. Code changes exist only in the workspace filesystem. | No traceability from Paperclip issue → Git branch → PR → merge. |
| **G6** | **Webhook server not implemented** | The production entry mode (Paperclip pushes heartbeats via HTTP) is stubbed. Only inbox-polling and process adapter work. | `webhook-server.ts` exists but is placeholder. |

### 🟡 Important Gaps

| # | Gap | Impact |
|---|-----|--------|
| **G7** | **Context-driven prompts are generic** | CEO-delegated tasks use the same workspace/artifact protocol regardless of phase. No phase-specific templates for research findings, PRD structure, architecture doc format, etc. |
| **G8** | **No artifact validation** | When a specialist "saves deliverables as markdown files," there's no verification that the artifacts meet BMAD quality standards (e.g., PRD must have certain sections). |
| **G9** | **No inter-agent artifact passing** | The "read workspace files" instruction assumes all agents share a workspace. In Paperclip's per-task workspace strategy, each heartbeat may get a fresh workspace. |
| **G10** | **PARA memory system not integrated** | The CEO's HEARTBEAT.md references `para-memory-files` skill and `$AGENT_HOME/memory/` but the heartbeat-entrypoint doesn't persist or load agent memory between runs. |
| **G11** | **No budget enforcement** | The CEO's HEARTBEAT.md says "above 80% spend, focus only on critical tasks" but there's no code that reads the budget from Paperclip and gates delegation. |
| **G12** | **Sprint status is disconnected** | The `sprint_status` tool is available to all agents but reads/writes local YAML. Agents in the CEO path don't have a sprint to read. |

### 🟢 Nice-to-Have

| # | Gap | Impact |
|---|-----|--------|
| **G13** | E2E test generation is defined but not orchestrated in the pipeline. |
| **G14** | Editorial review exists as a phase but never triggered automatically. |
| **G15** | Quick Flow agent could bypass the full pipeline for trivial issues. |
| **G16** | No rollback mechanism if a completed phase produces invalid artifacts. |

---

## 12. Proposed Target Workflow

### Vision: One Issue → Complete Software Project

```
Human creates issue in Paperclip: "Build X"
  │
  ▼
CEO Heartbeat: Initial Delegation
  │
  ├─[0] Research (bmad-analyst): Domain + technical feasibility     → todo
  │
  │  ── CEO re-eval: research done → promote next wave ──
  │
  ├─[1] PRD (bmad-pm): Product requirements document               → todo
  ├─[2] Architecture (bmad-architect): System design                → todo
  ├─[3] UX Design (bmad-ux-designer): User experience spec         → todo
  │
  │  ── CEO re-eval: define phase done → promote plan phase ──
  │
  ├─[4] Sprint Planning (bmad-sm): Create epics, stories, sprints  → todo
  │     📌 THIS IS THE KEY BRIDGE: SM creates stories as Paperclip
  │     sub-issues (not local YAML), each assigned to bmad-dev
  │
  │  ── CEO re-eval: plan phase done → promote execute phase ──
  │
  ├─[5..N] Dev Stories (bmad-dev): One sub-issue per story          → todo
  │     Each dev heartbeat:
  │       a. Checkout issue
  │       b. Read story content from parent/sibling artifacts
  │       c. Implement code (TDD, acceptance criteria)
  │       d. Create Git branch + commit
  │       e. Mark issue done
  │
  │  ── CEO re-eval: dev done → promote review phase ──
  │
  ├─[N+1..M] Code Reviews (bmad-qa): One per dev story             → todo
  │     Full ReviewOrchestrator loop:
  │       Pass 1: Review → findings → gate evaluation
  │       FAIL: Fix dispatch to bmad-dev → re-review (pass 2)
  │       PASS: Mark done
  │       ESCALATE: After 3 passes → human intervention
  │
  │  ── CEO re-eval: reviews done → promote docs + tests ──
  │
  ├─[M+1] E2E Tests (bmad-qa): Generate test suite                 → todo
  ├─[M+2] Documentation (bmad-tech-writer): API docs, guides       → todo
  │
  │  ── CEO re-eval: all children done → close parent ──
  │
  ▼
Parent issue: DONE ✅
All artifacts, code, tests, docs produced and tracked in Paperclip
```

### Key Changes Needed

1. **Unify state on Paperclip issues** — Eliminate `sprint-status.yaml`. Stories become Paperclip sub-issues. `dev_story` and `code_review` tools operate on Paperclip issue metadata instead of local YAML.

2. **Wire ReviewOrchestrator into CEO path** — When a code-review sub-issue is processed, use the full multi-pass adversarial loop (not single dispatch).

3. **Bridge plan → execute** — When the Scrum Master creates stories (plan phase), it should create Paperclip sub-issues assigned to `bmad-dev`, not local markdown files.

4. **Add Git integration** — Each dev story creates a feature branch, commits changes, and creates a PR. Code review happens against the PR diff.

5. **Shared workspace strategy** — Use Paperclip's workspace management to ensure artifacts from phase N are available to phase N+1 (research → PRD → architecture → implementation).

6. **Budget-gated delegation** — CEO checks remaining budget before creating new sub-tasks. Above 80% spend, only critical tasks proceed.

7. **Artifact validation gates** — After each phase, validate that the produced artifact meets minimum quality standards before promoting the next phase.

---

*This analysis was derived from the complete BMAD Copilot Factory codebase. See `docs/architecture.md` for the architecture diagram and `src/adapter/` for implementation details.*

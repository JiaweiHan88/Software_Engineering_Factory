# BMAD × Paperclip — Complete Feature Analysis

> **Date:** 2026-03-25
> **Scope:** TS tools vs BMAD skills, Paperclip API coverage, architectural gaps, recommendations

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Architecture: How Agent Dispatch Works](#2-architecture-how-agent-dispatch-works)
3. [Process Adapter Validation](#3-process-adapter-validation)
4. [TS Tools vs BMAD Skills — Do We Need Both?](#4-ts-tools-vs-bmad-skills--do-we-need-both)
5. [BMAD Skill Coverage Matrix](#5-bmad-skill-coverage-matrix)
6. [Conflicting Instructions Problem](#6-conflicting-instructions-problem)
7. [Paperclip API Coverage Audit](#7-paperclip-api-coverage-audit)
8. [Paperclip Skills Integration](#8-paperclip-skills-integration)
9. [CEO & Project Validation](#9-ceo--project-validation)
10. [Bugs & Migration Gaps](#10-bugs--migration-gaps)
11. [Recommended Architecture](#11-recommended-architecture)
12. [Paperclip Documentation Inventory](#12-paperclip-documentation-inventory)
13. [Implementation Roadmap](#13-implementation-roadmap)

---

## 1. Executive Summary

### The Core Finding

Our TypeScript tools (`src/tools/`) and BMAD skills (`_bmad/`, `skills/`) **do overlapping
work but at different quality levels**, and their instructions **conflict** at runtime.

The BMAD skills provide rich, battle-tested LLM methodology (10-step TDD, parallel
adversarial review, comprehensive story analysis). Our TS tools provide thin wrappers
that mostly read files and manage Paperclip lifecycle state. But the **dispatch prompts
tell the LLM to use the TS tools**, bypassing the BMAD skills entirely.

Meanwhile, Paperclip has grown to **230+ API endpoints and 57 database tables**. Our
`PaperclipClient` exposes only **~25 methods** covering basic issue CRUD, agent
lifecycle, cost events, and checkout/release. We're missing entire subsystems:
heartbeat-context, issue documents, projects/workspaces, approvals, routines, plugins,
budget enforcement, task sessions, and runtime state.

### Scorecard

| Category | Previous | Current | Change |
|---|---|---|---|
| **Core Heartbeat Flow** | 🟢 8/10 | 🟢 8/10 | — |
| **Task Checkout Protocol** | 🔴 0/10 | 🟢 7/10 | ✅ Implemented (checkout + release + 409 handling) |
| **Wake Context Handling** | 🔴 0/10 | 🔴 0/10 | Still not reading PAPERCLIP_TASK_ID, WAKE_REASON, etc. |
| **Issue Lifecycle** | 🟡 5/10 | 🟡 5/10 | No heartbeat-context, documents, relations |
| **Cost Tracking** | 🟢 9/10 | 🟢 9/10 | — |
| **TS Tools vs BMAD Skills** | N/A | 🔴 3/10 | **NEW** — tools bypass skills; conflicting instructions |
| **Session Management** | 🔴 1/10 | 🟡 4/10 | Session index file implemented, no Paperclip task-sessions |
| **Projects / Workspaces** | 🔴 0/10 | 🔴 0/10 | Not used despite Paperclip having full model |
| **Governance / Approvals** | 🔴 0/10 | 🔴 0/10 | 10 approval endpoints unused |
| **Routines** | N/A | 🔴 0/10 | **NEW** — recurring task system, cron triggers, unused |
| **Plugins** | N/A | 🔴 0/10 | **NEW** — 26 plugin endpoints, tool registry, unused |
| **Execution Workspaces** | N/A | 🔴 0/10 | **NEW** — workspace strategies, runtime services, unused |
| **Budget Enforcement** | ⚠️ cost events only | ⚠️ cost events only | No quota windows, auto-pause, budget policies |

---

## 2. Architecture: How Agent Dispatch Works

```
heartbeat-entrypoint.ts
  → agent-dispatcher.ts (selects tools + builds prompt)
  → SessionManager (creates Copilot SDK session)
  → LLM receives: system prompt (agent persona) + dispatch prompt + registered tools
  → LLM DECIDES whether to call a tool based on the prompt instructions
```

The TS tools are **not called programmatically** by our TypeScript code. They are
registered as Copilot SDK `defineTool()` functions and passed into the LLM session.
The **LLM agent** decides whether to invoke them based on the dispatch prompt.

Three instruction layers compete for the LLM's attention:

1. **Agent persona prompt** (`src/agents/*.ts`) — embedded BMAD persona with skill
   menu items like `exec="skill:bmad-dev-story"`, telling the LLM to invoke skills
2. **HEARTBEAT.md** (`agents/*/HEARTBEAT.md`) — references BMAD skills by name
3. **Dispatch prompt** (`agent-dispatcher.ts`) — explicitly says "Use the dev_story tool"

**The dispatch prompt wins** because it's the most recent instruction and directly names
the tool. The BMAD skills' rich methodology is bypassed in the autonomous heartbeat path.

---

## 3. Process Adapter Validation

The `process` adapter exists at `server/src/adapters/process/` and is registered in the
server adapter registry. It is documented at `docs/adapters/process.md` and listed in
`docs/adapters/overview.md` alongside `claude_local`, `codex_local`, `gemini_local`,
`opencode_local`, `openclaw`, and `http`.

**Our architecture is correct.** The process adapter:
- Spawns the configured `command` as a child process via `runChildProcess()`
- Injects all standard `PAPERCLIP_*` env vars (agent ID, company ID, API URL, API key, run ID)
- Injects wake context vars (`TASK_ID`, `WAKE_REASON`, `WAKE_COMMENT_ID`, `APPROVAL_ID`, etc.)
- Injects workspace context vars (`WORKSPACE_CWD`, `WORKSPACE_SOURCE`, `WORKSPACE_STRATEGY`, etc.)
- Injects runtime service URLs and MCP server references
- Supports `PAPERCLIP_API_KEY` as a JWT for per-agent authentication
- Reports exit code, stdout, stderr back to Paperclip

**Config for our agents:**
```json
{
  "adapterType": "process",
  "adapterConfig": {
    "command": "npx tsx src/heartbeat-entrypoint.ts",
    "cwd": "/path/to/BMAD_Copilot_RT",
    "timeoutSec": 300
  }
}
```

### Limitations vs Dedicated Adapters

| Limitation | Impact |
|---|---|
| No session persistence (no `sessionCodec`) | Sessions don't survive across heartbeats — agent loses context |
| No usage/cost parsing from stdout | Our `CostTracker` compensates via API; Paperclip can't display usage in run viewer |
| No UI transcript parsing (`parseStdoutLine`) | Run viewer shows raw stdout |
| No structured `summary` field | Paperclip can't display what the agent did |

**Future consideration:** A dedicated `copilot_sdk` adapter package would add session codec,
stdout parsing, cost extraction, and `testEnvironment()` validation.

### Skill Injection Gap

The process adapter does **NOT** inject skills into the child process (unlike `claude_local`
which symlinks skills into a tmpdir and passes `--add-dir`). The `adapter-skill-sync-rollout`
plan doesn't even mention the process adapter — it likely falls into the "unsupported"
category for skill sync. This confirms why our agents never get Paperclip skills at runtime.

---

## 4. TS Tools vs BMAD Skills — Do We Need Both?

### Tool-by-Tool Comparison

#### `create_story` — Paperclip Registration + Boilerplate

| Aspect | TS Tool (`src/tools/create-story.ts`) | BMAD Skill (`bmad-create-story`) |
|---|---|---|
| **Content quality** | Boilerplate template with placeholder ACs and tasks | 6-step deep artifact analysis: loads PRD, architecture, UX, previous story learnings, git history, web research → comprehensive developer guide |
| **Paperclip integration** | ✅ Creates Paperclip issue with metadata (`workPhase`, `storySequence`, `epicId`) + dedup guard | ❌ Writes to `sprint-status.yaml` only |
| **Sprint status** | Via Paperclip issue | Updates `sprint-status.yaml` |
| **Overlap** | No — TS tool creates skeleton + Paperclip issue; BMAD skill creates rich content | |

**Verdict: KEEP BUT REDUCE** — The Paperclip issue creation + dedup guard is essential.
But the story content it generates is vastly inferior. The LLM should use the BMAD skill
for content, then call `create_story` only to register the issue in Paperclip.

#### `dev_story` — File Reader Wrapper

| Aspect | TS Tool (`src/tools/dev-story.ts`) | BMAD Skill (`bmad-dev-story`) |
|---|---|---|
| **What it does** | `readFile(storyPath)` → returns content to LLM. Checks issue status is actionable. | 10-step TDD workflow: find story → load context → detect review continuation → mark in-progress → red-green-refactor cycle → validate per task → mark for review. 451 lines. |
| **Methodology** | None — just returns "implement ALL tasks and acceptance criteria" | Full red-green-refactor cycle per task, review follow-up handling, definition-of-done validation, continuous execution (no pausing) |
| **State management** | Checks Paperclip issue status | Updates `sprint-status.yaml` |

**Verdict: ELIMINATE** — It's literally `readFile()` + status validation. The status
check is already done upstream by checkout. The dispatch prompt could load the story file
content directly and let the BMAD skill drive the methodology.

#### `code_review` — Pass Tracker + Prompt

| Aspect | TS Tool (`src/tools/code-review.ts`) | BMAD Skill (`bmad-code-review`) |
|---|---|---|
| **What it does** | Reads story file → returns file list + embedded review protocol. Tracks review pass count in Paperclip metadata. | Step-file architecture with parallel review layers (Blind Hunter, Edge Case Hunter, Acceptance Auditor) + structured triage. Just-in-time step loading. |
| **Methodology** | Inline severity guide (LOW/MED/HIGH/CRITICAL) | 4 dedicated step files with distinct reviewer personas running in parallel |
| **State management** | Paperclip issue metadata (reviewPasses) | `sprint-status.yaml` |

**Verdict: REDUCE** — Keep pass-counter tracking. Drop the review protocol (weaker copy
of what `bmad-code-review` already provides). Merge pass-tracking into `issue_status`
metadata and let the BMAD skill drive the actual review.

#### `code_review_result` — Lifecycle Transition Tool

| Aspect | TS Tool (`src/tools/code-review.ts`) | BMAD Skill |
|---|---|---|
| **What it does** | Records verdict → marks issue done or reassigns to dev + escalates to CEO via parent issue comment | N/A — BMAD code-review skill has no Paperclip awareness |
| **Paperclip integration** | ✅ Full lifecycle: done/reassign/escalate | ❌ None |

**Verdict: KEEP** — Required for Paperclip lifecycle transitions. No BMAD equivalent.

#### `quality_gate_evaluate` — Programmatic Scoring Engine

| Aspect | TS Tool (`src/quality-gates/tool.ts`) | BMAD Skill |
|---|---|---|
| **What it does** | Runs structured findings through gate engine (severity scores, blocking logic, PASS/FAIL/ESCALATE). Persists review history. | BMAD code-review has adversarial review with triage, but no programmatic scoring |
| **Quality** | Genuine programmatic logic: `SEVERITY_WEIGHT`, `BLOCKING_SEVERITIES`, `evaluateGate()`, `decideNextAction()` | No equivalent |

**Verdict: KEEP** — Genuine programmatic scoring engine. BMAD skill doesn't replicate this.

**⚠️ BUG:** Still uses `sprint-status.yaml` via `readSprintStatus()` / `writeSprintStatus()` —
never migrated to Paperclip. Will fail in heartbeat path.

#### `issue_status` — Paperclip API Bridge

| Aspect | TS Tool (`src/tools/issue-status.ts`) | BMAD Skill |
|---|---|---|
| **What it does** | Read/update/reassign Paperclip issues | N/A — BMAD skills reference `sprint-status.yaml` |
| **Paperclip integration** | ✅ Full CRUD + auto-workPhase on reassign | ❌ None |

**Verdict: KEEP** — Pure Paperclip API bridge. No BMAD equivalent.

#### `sprint_status` (deprecated) — YAML File Manager

**Verdict: ELIMINATE** — Already marked deprecated. Still imported by `quality_gate_evaluate`
(bug) and `review-orchestrator` (fallback path).

### Summary Table

| Tool | LOC | Verdict | Reasoning |
|---|---|---|---|
| `create_story` | ~200 | **Reduce** — keep Paperclip registration; drop content generation | BMAD skill creates 10× richer story content |
| `dev_story` | ~140 | **Eliminate** | It's `readFile()` + a status check. BMAD `bmad-dev-story` is the real methodology |
| `code_review` | ~180 | **Reduce** — keep pass tracking only | BMAD `bmad-code-review` has far richer review methodology |
| `code_review_result` | ~120 | **Keep** | Paperclip lifecycle transitions |
| `quality_gate_evaluate` | ~200 | **Keep + fix** | Programmatic scoring; needs Paperclip migration |
| `issue_status` | ~260 | **Keep** | Paperclip API bridge |
| `sprint_status` | ~110 | **Eliminate** | Already deprecated |

---

## 5. BMAD Skill Coverage Matrix

### Implementation Phase (`bmm/workflows/4-implementation/`)

| Skill | Quality | Used in Heartbeat? | Problem |
|---|---|---|---|
| `bmad-dev-story` | ⭐⭐⭐⭐⭐ (451-line TDD workflow) | ❌ Bypassed | Dispatch says "use dev_story tool" |
| `bmad-code-review` | ⭐⭐⭐⭐⭐ (step-file, 3 parallel reviewers) | ❌ Bypassed | Dispatch says "use code_review tool" |
| `bmad-create-story` | ⭐⭐⭐⭐⭐ (6-step artifact analysis) | ❌ Bypassed | Dispatch says "use create_story tool" |
| `bmad-sprint-status` | ⭐⭐⭐ | ❌ Bypassed | Dispatch says "use issue_status tool" |
| `bmad-sprint-planning` | ⭐⭐⭐ | ❌ Bypassed | Dispatch says "use issue_status tool" |
| `bmad-retrospective` | ⭐⭐⭐ | ❌ Not wired | SM agent menu references it, never triggered |
| `bmad-correct-course` | ⭐⭐⭐ | ❌ Not wired | PM agent menu references it, never triggered |

### Pre-Implementation Phase

| Skill | Quality | Used? | Notes |
|---|---|---|---|
| `bmad-create-prd` | ⭐⭐⭐⭐ | ⚠️ Phase registered | Uses generic `contextPrompt()` — no skill reference |
| `bmad-create-architecture` | ⭐⭐⭐⭐ | ⚠️ Phase registered | Same |
| `bmad-create-epics-and-stories` | ⭐⭐⭐⭐ | ⚠️ Phase registered | Same |
| `bmad-check-implementation-readiness` | ⭐⭐⭐ | ⚠️ Phase registered | Same |
| `bmad-create-product-brief` | ⭐⭐⭐⭐ | ⚠️ Phase registered | Same |
| Research workflows (3) | ⭐⭐⭐ | ⚠️ Phase registered | Same |
| `bmad-create-ux-design` | ⭐⭐⭐ | ⚠️ Phase registered | Same |

### Core/Universal Skills

| Skill | Quality | Used? | Notes |
|---|---|---|---|
| `bmad-generate-project-context` | ⭐⭐⭐⭐ | ❌ | **High-value gap** — all agents look for `project-context.md` |
| `bmad-party-mode` | ⭐⭐⭐⭐ | ❌ | Referenced in menus, never triggered by orchestration |
| `bmad-review-adversarial-general` | ⭐⭐⭐⭐ | ❌ | Referenced in code-review but our TS tool replaces it |
| `bmad-review-edge-case-hunter` | ⭐⭐⭐⭐ | ❌ | Same |
| `bmad-brainstorming` | ⭐⭐⭐ | ❌ | Not wired |
| `bmad-distillator` | ⭐⭐⭐ | ❌ | Not wired; valuable for large context |
| `bmad-advanced-elicitation` | ⭐⭐⭐ | ❌ | Not wired |
| `bmad-editorial-review-prose` | ⭐⭐⭐ | ❌ | Not wired |
| `bmad-editorial-review-structure` | ⭐⭐⭐ | ❌ | Not wired |

### TEA (Test Architecture Enterprise)

| Skill | Quality | Used? | Notes |
|---|---|---|---|
| 9 testarch workflows | ⭐⭐⭐⭐ | ❌ | Complete test strategy framework with 42 knowledge articles. Untapped. |

### BMAD Builder (Meta)

| Skill | Quality | Used? | Notes |
|---|---|---|---|
| `bmad-agent-builder` | ⭐⭐⭐ | ❌ | Build/optimize agents |
| `bmad-workflow-builder` | ⭐⭐⭐ | ❌ | Build/validate workflows |

---

## 6. Conflicting Instructions Problem

### Example: `dev-story` Phase

The LLM receives these three competing layers:
```
SYSTEM: [bmad-dev agent persona - includes menu: exec="skill:bmad-dev-story"]
SYSTEM: [HEARTBEAT.md - says "use bmad-dev-story skill for story implementation"]
USER:   "@bmad-dev Use the dev_story tool to implement story S-001:
         - story_id: "S-001"
         - story_file_path: "/path/to/story.md"
         Read the story file for acceptance criteria and implement accordingly."
```

The LLM calls `dev_story` (which returns file contents) and implements with
minimal methodology, rather than following the 10-step TDD workflow from the BMAD skill.

### Pre-Implementation Phases: No Conflict but No Guidance

For phases like `create-prd`, `create-architecture`, `research`, the dispatcher uses
a generic `contextPrompt()`:

```
"@bmad-pm You have been assigned a task: PRD creation
 Context: [issue title and description]
 ...
 Use your BMAD skills and tools to complete this task thoroughly."
```

This doesn't name a specific tool, so the LLM *may* invoke `bmad-create-prd` from its
persona menu — but it's vague and should explicitly reference the BMAD skill.

### The Fundamental Compatibility Gap

**BMAD skills assume local YAML state; our system uses Paperclip API state.**

All BMAD implementation workflows (dev-story, create-story, code-review, sprint-planning)
reference `sprint-status.yaml` for state tracking. In our Paperclip-based system, this
file doesn't exist. If the LLM follows a BMAD skill workflow, the status tracking
instructions will fail silently.

---

## 7. Paperclip API Coverage Audit

### What Our `PaperclipClient` Covers (~25 methods)

| Method | Paperclip Endpoint | Status |
|---|---|---|
| `hireAgent()` | `POST /companies/:id/agent-hires` | ✅ |
| `listAgents()` | `GET /companies/:id/agents` | ✅ |
| `getAgent()` | `GET /agents/:id` | ✅ |
| `getAgentSelf()` | `GET /agents/me` | ✅ |
| `updateAgent()` | `PATCH /agents/:id` | ✅ |
| `pauseAgent()` | `POST /agents/:id/pause` | ✅ |
| `resumeAgent()` | `POST /agents/:id/resume` | ✅ |
| `terminateAgent()` | `POST /agents/:id/terminate` | ✅ |
| `invokeHeartbeat()` | `POST /agents/:id/heartbeat/invoke` | ✅ |
| `wakeAgent()` | `POST /agents/:id/wakeup` | ✅ |
| `getAgentInbox()` | `GET /agents/me/inbox-lite` | ✅ |
| `listHeartbeatRuns()` | `GET /companies/:id/heartbeat-runs` | ✅ |
| `getHeartbeatRun()` | `GET /heartbeat-runs/:id` | ✅ |
| `cancelHeartbeatRun()` | `POST /heartbeat-runs/:id/cancel` | ✅ |
| `getLiveRuns()` | `GET /companies/:id/live-runs` | ✅ |
| `listIssues()` | `GET /companies/:id/issues` | ✅ |
| `getIssue()` | `GET /issues/:id` | ✅ |
| `createIssue()` | `POST /companies/:id/issues` | ✅ |
| `updateIssue()` | `PATCH /issues/:id` | ✅ |
| `checkoutIssue()` | `POST /issues/:id/checkout` | ✅ |
| `releaseIssue()` | `POST /issues/:id/release` | ✅ |
| `addIssueComment()` | `POST /issues/:id/comments` | ✅ |
| `getIssueComments()` | `GET /issues/:id/comments` (+ cursor) | ✅ |
| `getIssueComment()` | `GET /issues/:id/comments/:id` | ✅ |
| `reportCostEvent()` | `POST /companies/:id/cost-events` | ✅ |
| `getOrgTree()` | `GET /companies/:id/org` | ✅ |
| `listGoals()` | `GET /companies/:id/goals` | ✅ |
| `ping()` | `GET /api/health` | ✅ |

### Missing Endpoints by Subsystem

#### Issues — Missing 7 Critical Endpoints

| Endpoint | Purpose | Impact |
|---|---|---|
| `GET /issues/:id/heartbeat-context` | Compact issue + ancestors + goal + comment metadata | **HIGH** — reduces API calls ~30% |
| `GET /issues/:id/documents` | List documents attached to issue | **HIGH** — Paperclip stores plans as issue docs |
| `PUT /issues/:id/documents/:key` | Upsert structured documents on issues | **HIGH** — CEO should store plans here |
| `GET /issues/:id/documents/:key` | Get specific document by key | **HIGH** |
| `PATCH /issues/:id` with `comment` field | Atomic status + comment | **MEDIUM** |
| `GET /issues/:id/work-products` | List work products | **MEDIUM** |
| `POST /issues/:id/work-products` | Create work product | **MEDIUM** |

#### Agent Runtime — Missing Entire Subsystem

| Endpoint | Purpose | Impact |
|---|---|---|
| `GET /agents/:id/runtime-state` | Session state, tokens, last run, errors | **HIGH** |
| `GET /agents/:id/task-sessions` | Per-(agent, taskKey) session persistence | **HIGH** |
| `POST /agents/:id/runtime-state/reset-session` | Reset session | **MEDIUM** |
| `GET /agents/:id/configuration` | Full adapter/runtime config | **LOW** |
| `GET /agents/:id/skills` | Agent skill snapshots | **LOW** |

#### Projects & Workspaces — Missing Entire Subsystem

| Endpoint | Purpose | Impact |
|---|---|---|
| `POST /companies/:id/projects` | Create project | **HIGH** |
| `POST /projects/:id/workspaces` | Register workspace | **HIGH** |
| `GET /projects/:id` | Get project details | **MEDIUM** |
| `GET /projects/:id/workspaces` | List workspaces | **MEDIUM** |
| Execution workspace endpoints (5) | Workspace strategies | **LOW** |

#### Budget Enforcement — Missing 5 Endpoints

| Endpoint | Purpose | Impact |
|---|---|---|
| `GET /companies/:id/costs/window-spend` | Current spend in quota window | **HIGH** |
| `GET /companies/:id/budgets/overview` | Budget overview | **HIGH** |
| `POST /companies/:id/budgets/pause-agent` | Auto-pause on breach | **MEDIUM** |

#### Approvals — Missing 10 Endpoints

| Endpoint | Purpose | Impact |
|---|---|---|
| `POST /companies/:id/approvals` | Create approval request | **MEDIUM** |
| `POST /approvals/:id/approve` | Approve | **MEDIUM** |
| `POST /approvals/:id/reject` | Reject | **MEDIUM** |
| `GET /companies/:id/approvals` | List pending | **MEDIUM** |

#### Routines — Missing 10 Endpoints

| Endpoint | Purpose | Impact |
|---|---|---|
| `POST /companies/:id/routines` | Create recurring task | **MEDIUM** |
| `POST /routines/:id/run` | Trigger routine | **MEDIUM** |
| Cron trigger configuration | Schedule recurring work | **MEDIUM** |

#### Dashboard, Activity, Labels, Secrets, Skills

| Endpoint | Purpose | Impact |
|---|---|---|
| `GET /companies/:id/dashboard` | Health overview (CEO situational awareness) | **MEDIUM** |
| `GET /companies/:id/activity` | Audit trail | **LOW** |
| `POST /companies/:id/activity` | Create activity entry | **LOW** |
| `GET /companies/:id/labels` | Issue labels | **LOW** |
| `GET /companies/:id/skills` | Installed company skills | **LOW** |
| `GET /companies/:id/secrets` | Secrets management | **LOW** |

### Wake Context — Environment Variables Not Read

Paperclip's process adapter injects these env vars, but `heartbeat-entrypoint.ts` ignores them:

| Variable | Purpose | Status |
|---|---|---|
| `PAPERCLIP_TASK_ID` | Issue that triggered this wake | ❌ Not read |
| `PAPERCLIP_WAKE_REASON` | timer / assignment / on_demand / comment | ❌ Not read |
| `PAPERCLIP_WAKE_COMMENT_ID` | Specific comment that triggered wake | ❌ Not read |
| `PAPERCLIP_APPROVAL_ID` | Approval needing handling | ❌ Not read |
| `PAPERCLIP_APPROVAL_STATUS` | Approval status | ❌ Not read |
| `PAPERCLIP_LINKED_ISSUE_IDS` | Related issues (comma-separated) | ❌ Not read |
| `PAPERCLIP_WORKSPACE_CWD` | Working directory from workspace | ❌ Not read |
| `PAPERCLIP_WORKSPACE_REPO_URL` | Git repo URL | ❌ Not read |
| `PAPERCLIP_WORKSPACE_BRANCH` | Git branch | ❌ Not read |
| `PAPERCLIP_WORKSPACES_JSON` | All workspace hints as JSON | ❌ Not read |
| `PAPERCLIP_RUNTIME_SERVICES_JSON` | Provisioned runtime services | ❌ Not read |

---

## 8. Paperclip Skills Integration

### Declared but Never Loaded

We define `PAPERCLIP_SKILLS` in `role-mapping.ts`:

```typescript
export const PAPERCLIP_SKILLS = ["paperclip", "paperclip-create-agent", "para-memory-files"];
```

And have loading code in `resolveSkillDirectories()` that checks `PAPERCLIP_SKILLS_DIR`
env var. But this env var is **never set** — not by our setup script, not by our adapter
config, not by any process. The skills are never loaded into agent sessions.

**Paradigm mismatch:** Even if loaded, the Paperclip `SKILL.md` expects agents to
execute `curl` commands directly against the API. Our Copilot SDK agents work through
`defineTool()` tools, not shell commands. The skill content would need adaptation.

### What Each Paperclip Skill Provides

| Skill | Purpose | Our Usage |
|---|---|---|
| `paperclip` | 9-step heartbeat procedure, checkout flow, comment style, delegation, approval handling, issue documents, blocked-task dedup | **Reimplemented in TypeScript** in `heartbeat-entrypoint.ts` (Steps 1-6, 8-9). LLM never sees this skill. |
| `paperclip-create-agent` | Governance-aware agent hiring workflow (adapter discovery, config comparison, approval flow) | **Not used.** We create agents in `setup-paperclip-company.ts`, not at runtime. |
| `para-memory-files` | PARA method memory (knowledge graph, daily notes, tacit knowledge, qmd search) | **Partially reimplemented.** Our heartbeat loads learnings from `_bmad-output/memory/learnings/`. |

### Missing Features from Paperclip Skills

Since our heartbeat procedure is in TypeScript, the `paperclip` skill isn't needed.
But we're **missing features** it documents:
- Issue documents API (plan storage)
- Comment style rules (ticket linking with company-prefixed URLs)
- `heartbeat-context` endpoint
- Approval follow-up workflow
- `X-Paperclip-Run-Id` header on mutating calls

### Company Skills System — Unused Opportunity

Paperclip has a company skills system we're not using:

- `POST /api/companies/:companyId/skills/import` — install skills from skills.sh, GitHub, or local path
- `POST /api/agents/:agentId/skills/sync` — assign installed skills to agents
- `POST /api/companies/:companyId/skills/scan-projects` — discover skills in project workspaces

Our BMAD skills could be imported into Paperclip's company skill library, then assigned
to agents via the sync endpoint — letting Paperclip manage skill assignment rather than
our hardcoded `role-mapping.ts`.

---

## 9. CEO & Project Validation

### CEO Delegation Model — Sound Architecture

Our CEO implementation aligns well with Paperclip's delegation model:

| Paperclip SKILL.md Pattern | Our CEO Implementation | Match? |
|---|---|---|
| Step 9: "Create subtasks with `parentId` and `goalId`" | ✅ Creates sub-issues with proper `parentId`, `goalId`, `projectId` | ✅ |
| "Delegate if needed" with dependency awareness | ✅ `DelegationPlan` with `dependsOn` array, backlog→todo promotion | ✅ |
| "Escalate via `chainOfCommand` when stuck" | ✅ `requiresApproval` gating for high-impact decisions | ✅ |
| "Always comment on `in_progress` work before exiting" | ✅ Posts delegation plan summary as comment | ✅ |
| "Always set `parentId` on subtasks and `goalId`" | ✅ Both set during `createIssue()` | ✅ |
| "Budget: auto-paused at 100%, critical-only above 80%" | ❌ No budget check in CEO path | ❌ |
| Issue documents (`PUT /api/issues/{id}/documents/plan`) | ❌ Plans in description text, not documents | ❌ |
| Comment style (ticket-linking, company-prefixed URLs) | ❌ Plain text issue references | ❌ |
| `X-Paperclip-Run-Id` header on mutations | ⚠️ PaperclipClient has `heartbeatRunId` but may not send on all calls | ⚠️ |
| `heartbeat-context` endpoint | ❌ Uses separate issue + comments calls | ❌ |

**The CEO pattern is sound.** The delegation → dependency tracking → re-evaluation loop
matches what Paperclip expects. The gaps are about **missing API features**, not wrong architecture.

### Project Ownership

**CEO and Managers can create projects too.** The Paperclip SKILL.md has a
"Project Setup Workflow (CEO/Manager Common Path)" section.

Our current approach is correct for initial setup:
- `setup-paperclip-company.ts` creates project + workspace as board-level infrastructure
- This runs before agents exist, so it can't be an agent task

**Future enhancement:** The CEO could create additional projects at runtime for new
workstreams (e.g., "this feature needs a separate microservice repo").

### CEO Agent Hiring (from internal plans)

The governance model for runtime agent creation:
- Company setting: `requireBoardApprovalForNewAgents` (default: true)
- Agent permission: `can_create_agents` (default: ON for CEO, OFF for others)
- New status: `pending_approval` — agent exists but can't run until approved

If we want the CEO to hire agents dynamically, we'd need the `paperclip-create-agent`
skill and the approval flow.

---

## 10. Bugs & Migration Gaps

### 10.1 `quality_gate_evaluate` Still Uses `sprint-status.yaml`

```typescript
// quality-gates/tool.ts — lines 87-88
const sprintData = await readSprintStatus(config.sprintStatusPath);
const story = sprintData.sprint.stories.find((s) => s.id === args.story_id);
```

Never migrated to Paperclip. **Will silently fail** in heartbeat path (returns empty
sprint data with no stories).

### 10.2 `review-orchestrator.ts` Has YAML Fallback

```typescript
// review-orchestrator.ts — line 510
const toolCtx = tryGetToolContext();
if (toolCtx) { /* Paperclip path */ }
// Fallback: sprint-status.yaml (deprecated)
```

Tries Paperclip first, falls back to YAML. Story resolution still uses YAML patterns.

### 10.3 Run ID Env Var Name Mismatch

Our code reads `PAPERCLIP_HEARTBEAT_RUN_ID`. Paperclip injects `PAPERCLIP_RUN_ID`.
We accept both via `||` fallback but the primary name is wrong.

### 10.4 `create_story` Sets Wrong Initial `workPhase`

```typescript
// create-story.ts — line 167
metadata: { workPhase: "dev-story", ... }
```

Stories created with `workPhase: "dev-story"` but status `"backlog"`. The CEO's
sequential promotion logic skips the `create-story` refinement phase — stories go
directly from backlog → dev without SM creating detailed stories via `bmad-create-story`.

---

## 11. Recommended Architecture

### Layer Separation: Skills for Methodology, Tools for Lifecycle

```
Current (broken):
  Dispatch prompt → TS Tool (thin wrapper) → result → lifecycle transition
  BMAD skills → never invoked in heartbeat path

Recommended:
  Dispatch prompt → "Follow bmad-{X} skill methodology" → LLM reads files, implements
    → TS Tool (ONLY for Paperclip state) → lifecycle transition

Tools to KEEP (Paperclip lifecycle):
  ├── issue_status       — read/update/reassign Paperclip issues
  ├── code_review_result — record verdict, transition issue, escalate
  └── quality_gate_evaluate — programmatic scoring (fix YAML bug first)

Tools to CONVERT:
  └── create_story       — keep ONLY Paperclip issue creation + dedup
                           (drop content generation — let BMAD skill do it)

Tools to ELIMINATE:
  ├── dev_story           — it's readFile() + a status check, both redundant
  ├── code_review         — merge pass-tracking into issue_status metadata
  └── sprint_status       — already deprecated
```

### Fix Dispatch Prompts

Instead of:
```typescript
"@bmad-dev Use the dev_story tool to implement story S-001..."
```

Use:
```typescript
"@bmad-dev Implement story S-001 following the bmad-dev-story skill methodology.
 Story file: /path/to/S-001.md
 When implementation is complete, use issue_status tool with action='reassign'
 and target_role='bmad-qa' to hand off for code review."
```

This lets the BMAD skill drive the methodology while the TS tool handles Paperclip transitions.

### Bridge BMAD Sprint-Status References

Three options considered:

| Option | Approach | Recommendation |
|---|---|---|
| A | Generate synthetic `sprint-status.yaml` from Paperclip issues before each heartbeat | Possible but adds complexity |
| B | Override in dispatch prompt: "Use issue_status tool, not sprint-status.yaml" | **Recommended** — simplest, our TS tools already handle all state |
| C | Fork BMAD workflows with Paperclip-aware versions | Maintenance burden, divergence risk |

### Wire Missing BMAD Skills into Dispatch Prompts

| Phase | Current Prompt | Should Reference |
|---|---|---|
| `create-prd` | Generic "PRD creation" | `bmad-create-prd` |
| `create-architecture` | Generic "architecture design" | `bmad-create-architecture` |
| `create-epics` | Generic "epic and story creation" | `bmad-create-epics-and-stories` |
| `check-implementation-readiness` | Generic "readiness check" | `bmad-check-implementation-readiness` |
| `research` | Generic "research" | `bmad-domain-research` / `bmad-technical-research` |
| `e2e-tests` | Generic "e2e test generation" | `bmad-qa-generate-e2e-tests` |
| `documentation` | Generic "documentation" | `bmad-document-project` |

---

## 12. Paperclip Documentation Inventory

### User-Facing Docs (`docs/`)

| Area | Files | Key Info | Our Usage |
|---|---|---|---|
| **Adapters** | overview, process, http, creating-an-adapter, claude/codex/gemini-local | 7 adapter types; process adapter has no skill injection | ✅ Using process |
| **API** | overview, issues, agents, approvals, goals-and-projects, costs, routines, companies, authentication, secrets, activity, dashboard | Full API reference; `X-Paperclip-Run-Id` required on mutations | ⚠️ ~25 of 230+ endpoints |
| **Agent Dev Guides** | heartbeat-protocol, how-agents-work, task-workflow, cost-reporting, handling-approvals, comments-and-communication, writing-a-skill | 9-step protocol, comment style, budget awareness | ⚠️ Partial |
| **Board Guides** | creating-a-company, managing-agents, managing-tasks, org-structure, approvals, costs-and-budgets, activity-log, dashboard | Board operator workflows | ✅ Setup script covers |
| **Deploy** | deployment-modes, environment-variables, secrets, storage, docker | Full env var reference | ✅ Known |
| **Start** | architecture, core-concepts, quickstart | 4-layer stack, control plane model | ✅ Understood |
| **Specs** | agent-config-ui, cliphub-plan | Agent creation dialog, skill marketplace | Informational |
| **CLI** | overview, setup-commands, control-plane-commands | `heartbeat run`, company import/export | Informational |
| **Companies** | companies-spec (agentcompanies/v1) | Markdown-first package format | Future packaging |

### Internal Docs (`doc/plans/`)

| Plan | Key Findings | Relevance |
|---|---|---|
| **adapter-skill-sync-rollout** | Process adapter NOT listed → likely "unsupported" for skill sync | Confirms skill injection gap |
| **workspace-strategy** | 3-tier model: project → execution → git worktree | We read env vars but don't leverage strategies |
| **budget-policies** | Monthly recurring (agents), lifetime (projects), billed_cents, hard stop 100% | We don't check budgets |
| **memory-service** | Provider-based memory with company/agent/project scope | Our PARA is simplified; should integrate when this ships |
| **ceo-agent-hiring** | `can_create_agents` permission, `pending_approval` status | Future dynamic hiring |
| **company-import-export-v2** | Markdown-first package format, GitHub repos as sources | Could package BMAD as importable company |
| **skill-tightening** | Split hot-path from lookup material for token savings (**deferred**) | Validates our TS heartbeat approach |

---

## 13. Implementation Roadmap

All tasks consolidated by priority and grouped by context. Effort: **S**mall (<1h),
**M**edium (1-4h), **L**arge (4h+).

### P0 — Critical: Fix Conflicting Instructions

These changes are blocking correct BMAD methodology from reaching agents. Without them,
agents use thin TS tool wrappers instead of rich BMAD skill workflows.

| # | Task | Context | Effort |
|---|---|---|---|
| P0-1 | Update `dev-story` dispatch prompt to reference `bmad-dev-story` skill instead of `dev_story` tool | Dispatch conflict | S |
| P0-2 | Update `code-review` dispatch prompt to reference `bmad-code-review` skill instead of `code_review` tool | Dispatch conflict | S |
| P0-3 | Update `create-story` dispatch prompt to reference `bmad-create-story` skill + `create_story` tool (Paperclip registration only) | Dispatch conflict | S |
| P0-4 | Add sprint-status.yaml override instruction to all system prompts: "Use issue_status tool, not sprint-status.yaml" | YAML compat gap | S |
| P0-5 | Update all generic `contextPrompt()` phases to name specific BMAD skills | Dispatch gap | M |
| P0-6 | Remove `dev_story` tool from `allTools` and dispatcher | Tool cleanup | S |
| P0-7 | Remove `sprint_status` tool (deprecated) | Tool cleanup | S |

### P1 — Important: Paperclip Integration Gaps

Missing API features and protocol compliance that reduce functionality and break
audit trail expectations.

#### Bug Fixes

| # | Task | Context | Effort |
|---|---|---|---|
| P1-1 | Migrate `quality_gate_evaluate` from `sprint-status.yaml` to Paperclip issue metadata | Bug §10.1 | M |
| P1-2 | Remove YAML fallback from `review-orchestrator.ts` | Bug §10.2 | S |
| P1-3 | Fix primary env var name to `PAPERCLIP_RUN_ID` | Bug §10.3 | S |
| P1-4 | Fix `create_story` initial `workPhase` to allow `create-story` refinement phase | Bug §10.4 | S |

#### Wake Context & Heartbeat Protocol

| # | Task | Context | Effort |
|---|---|---|---|
| P1-5 | Read wake context env vars (`PAPERCLIP_TASK_ID`, `WAKE_REASON`, `WAKE_COMMENT_ID`, `APPROVAL_ID`) | Missing env vars | S |
| P1-6 | Route heartbeat based on wake reason (task/comment/approval/timer) | Wake-aware dispatch | M |
| P1-7 | Add `getHeartbeatContext()` to PaperclipClient | Missing API | S |
| P1-8 | Use heartbeat-context instead of separate issue + comments calls | API optimization | M |

#### Missing High-Impact API Methods

| # | Task | Context | Effort |
|---|---|---|---|
| P1-9 | Add `X-Paperclip-Run-Id` header to all mutating PaperclipClient calls | Audit trail compliance | S |
| P1-10 | Add issue document methods (`getIssueDocuments`, `upsertIssueDocument`) | Issue documents API | S |
| P1-11 | Add budget check early in heartbeat (`GET /agents/me` → `spentMonthlyCents` vs `budgetMonthlyCents`) | Budget enforcement | S |
| P1-12 | Add dashboard endpoint to PaperclipClient (`GET /companies/{companyId}/dashboard`) | CEO situational awareness | S |

### P2 — Valuable: Full BMAD Skills & Paperclip Features

Unlock remaining BMAD methodology and wire additional Paperclip subsystems.

#### BMAD Skill Wiring

| # | Task | Context | Effort |
|---|---|---|---|
| P2-1 | Wire `bmad-generate-project-context` (run once at setup or CEO delegation) | High-value gap — all agents look for `project-context.md` | S |
| P2-2 | Wire `bmad-retrospective` into post-epic completion | SM skill, not wired | S |
| P2-3 | Wire `bmad-party-mode` into CEO escalation for ambiguous decisions | CEO escalation | M |
| P2-4 | Wire `bmad-correct-course` into stall-detector escalation | PM skill, not wired | S |
| P2-5 | Evaluate TEA module for QA agent enhancement | 9 workflows + 42 knowledge articles | M |

#### Paperclip Features

| # | Task | Context | Effort |
|---|---|---|---|
| P2-6 | Implement comment style rules (ticket-linking, company-prefixed URLs) | Comment style compliance | M |
| P2-7 | Wire approval follow-up flow in heartbeat (Step 2 of protocol) | Approval lifecycle | M |
| P2-8 | Read workspace env vars for `cwd` resolution | Workspace model | S |
| P2-9 | Add routines support for scheduled recurring tasks | Sprint cycles, periodic reviews | M |
| P2-10 | Add secrets management to PaperclipClient (`secret_ref` in adapter config) | Avoid hardcoded keys | S |

#### Session Persistence

| # | Task | Context | Effort |
|---|---|---|---|
| P2-11 | Wire task-session persistence via Paperclip runtime state API | Cross-heartbeat memory | L |
| P2-12 | Resume sessions per (agent, issueId) across heartbeats | Conversation continuity | L |

### P3 — Future: Advanced Capabilities

Strategic improvements for scaling and production readiness.

| # | Task | Context | Effort |
|---|---|---|---|
| P3-1 | Evaluate company skills API for BMAD skill distribution | Better than hardcoded role-mapping | M |
| P3-2 | Evaluate `paperclip-create-agent` skill for runtime CEO hiring | Dynamic team scaling | M |
| P3-3 | Create dedicated `copilot_sdk` adapter for session persistence + rich transcripts | Process adapter limitations | L |
| P3-4 | Wire approvals — board governance for agent hires and budget overrides | Governance system | M |
| P3-5 | Wire execution workspaces — multi-project workspace strategies | Multi-repo support | L |
| P3-6 | Wire plugins — evaluate workspace/git/terminal plugin system | Plugin ecosystem | L |
| P3-7 | Add labels — issue categorization for stories/bugs/tech-debt | Organization | S |
| P3-8 | Package BMAD as importable company (`agentcompanies/v1` format) | Portable deployment | M |

### Already Done ✅

| Task | Status |
|---|---|
| Create Paperclip project + workspace for target repo during setup | ✅ `setup-paperclip-company.ts` Step 2c |
| Set `projectId` on all created issues | ✅ Setup and e2e scripts |
| Task checkout protocol (checkout + release + 409 handling) | ✅ Implemented |
| Cost tracking via `reportCostEvent()` | ✅ Working |

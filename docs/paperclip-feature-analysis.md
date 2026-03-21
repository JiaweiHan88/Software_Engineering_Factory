# Paperclip Feature Analysis — BMAD Copilot Factory

> **Purpose:** Comprehensive analysis of Paperclip's feature set vs. our implementation.
> Identifies what we use correctly, what's missing, what's wrong, and what to optimize.
>
> **Date:** 2025-07-22
> **Source:** `paperclipai/paperclip` — doc/SPEC.md, doc/PRODUCT.md, doc/TASKS.md,
> doc/spec/agents-runtime.md, doc/spec/agent-runs.md, skills/paperclip/SKILL.md,
> skills/para-memory-files/SKILL.md, skills/paperclip-create-agent/SKILL.md,
> doc/plugins/PLUGIN_SPEC.md, doc/plans/*.md

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Complete Paperclip Feature Inventory](#2-complete-paperclip-feature-inventory)
3. [What We Use Correctly](#3-what-we-use-correctly)
4. [What We're Doing Wrong](#4-what-were-doing-wrong)
5. [Missing Features — High Impact](#5-missing-features--high-impact)
6. [Missing Features — Medium Impact](#6-missing-features--medium-impact)
7. [Missing Features — Low Priority (Post-V1)](#7-missing-features--low-priority-post-v1)
8. [Optimization Opportunities](#8-optimization-opportunities)
9. [Implementation Roadmap](#9-implementation-roadmap)
10. [Appendix: API Surface Comparison](#10-appendix-api-surface-comparison)

---

## 1. Executive Summary

Our BMAD Copilot Factory is at **Integration Level 2** (status reporting) of Paperclip's
3-level integration model. We use the core heartbeat flow and issue management correctly,
but we're missing several critical features that would bring us to **Level 3** (fully instrumented).

### Scorecard

| Category | Score | Details |
|---|---|---|
| **Core Heartbeat Flow** | 🟢 8/10 | Working heartbeat pipeline, good inbox handling |
| **Task Checkout Protocol** | 🔴 0/10 | **Not implemented** — we skip checkout entirely |
| **Wake Context Handling** | 🔴 0/10 | Env vars referenced in HEARTBEAT.md but not wired in code |
| **Issue Lifecycle** | 🟡 5/10 | Basic CRUD works; missing `in_review`, `blocked` workflow |
| **Cost Tracking** | 🟢 9/10 | Excellent — cost events, budget model, per-model tracking |
| **Communication** | 🟡 6/10 | Comments work; missing @-mentions, comment style, ticket links |
| **Delegation** | 🟢 7/10 | CEO orchestrator works well; missing `goalId`, `billingCode` propagation |
| **Agent Config** | 🟢 8/10 | 4-file system matches Paperclip pattern |
| **Session Management** | 🔴 1/10 | No session resume between heartbeats |
| **Memory** | 🔴 0/10 | PARA memory skill not wired at all |
| **Projects / Workspaces** | 🔴 0/10 | Not used; all work is flat issues |
| **Governance / Approvals** | 🔴 0/10 | Not implemented |

**Bottom line:** We're a functional heartbeat agent that can receive work, delegate, and report.
But we're missing Paperclip's **concurrency safety** (checkout), **context efficiency**
(heartbeat-context, session resume), and **organizational structure** (projects, goals, governance).

---

## 2. Complete Paperclip Feature Inventory

### 2.1 Core Platform

| Feature | Paperclip Spec | Our Status |
|---|---|---|
| Company model | Company = autonomous AI company with board governance | ✅ Used (companyId) |
| Agent model | Agents with roles, titles, capabilities, budget, chainOfCommand | ✅ Partially (no chainOfCommand) |
| Org structure | Full visibility, reporting lines, cross-team rules | ⚠️ Org tree exists, not used at runtime |
| Heartbeat system | Push model, process adapter spawns entrypoint | ✅ Working |
| Issue management | Full CRUD, status workflow, sub-issues, hierarchy | ✅ Working |
| Goal hierarchy | Company → team → agent → task goals | ❌ Not used |
| Project model | Projects group issues, have workspaces | ❌ Not used |
| Workspace model | cwd + repoUrl per project | ❌ Not used |
| Budget system | Per-agent monthly, per-project lifetime, soft/hard stops | ⚠️ Cost events only |
| Approval system | Board governance gates for hires, budget overrides | ❌ Not used |
| Dashboard | `GET /api/companies/:companyId/dashboard` | ❌ Not called |

### 2.2 Agent Runtime

| Feature | Paperclip Spec | Our Status |
|---|---|---|
| Adapter types | `process`, `claude_local`, `codex_local`, `http`, `openclaw_gateway` | ✅ `process` only |
| Heartbeat policy | `enabled`, `intervalSec`, `wakeOnAssignment`, `wakeOnOnDemand`, `cooldownSec` | ❌ Not configured |
| Wakeup Coordinator | Central queue, coalescing, priority (on_demand > assignment > timer) | ❌ Not used |
| Session resume | Per (agent, taskKey, adapterType), rehydration across heartbeats | ❌ Not implemented |
| Run audit trail | `X-Paperclip-Run-Id` on all mutating requests | ⚠️ Set on client, but conditional |
| Agent status lifecycle | `active → paused → terminated` | ✅ In client API |
| Runtime state store | `agent_runtime_state` table for cross-heartbeat persistence | ❌ Not used |
| Task sessions | `agent_task_sessions` table for conversation continuity | ❌ Not used |

### 2.3 Heartbeat Protocol (from SKILL.md)

| Step | Paperclip Spec | Our Status |
|---|---|---|
| **Step 1: Identity** | `GET /api/agents/me` → get id, role, chainOfCommand, budget | ✅ Implemented |
| **Step 2: Approval follow-up** | Check `PAPERCLIP_APPROVAL_ID`, handle approvals | ❌ Not implemented |
| **Step 3: Get assignments** | `GET /api/agents/me/inbox-lite` (compact) | ✅ Implemented |
| **Step 4: Pick work** | in_progress first, then todo, skip blocked (with dedup) | ⚠️ Basic priority only |
| **Step 5: Checkout** | `POST /api/issues/{id}/checkout` — **MANDATORY** | ❌ **NOT IMPLEMENTED** |
| **Step 6: Understand context** | `GET /api/issues/{id}/heartbeat-context` (efficient) | ❌ Not used |
| **Step 7: Do the work** | Use tools and capabilities | ✅ Working |
| **Step 8: Update status** | PATCH with status + comment, handle blocked | ⚠️ Basic status updates |
| **Step 9: Delegate** | Create subtasks with `parentId` + `goalId` | ⚠️ parentId yes, goalId inconsistent |

### 2.4 Wake Context Environment Variables

| Variable | Purpose | Our Status |
|---|---|---|
| `PAPERCLIP_AGENT_ID` | Agent identity | ✅ Used |
| `PAPERCLIP_COMPANY_ID` | Company scope | ✅ Used |
| `PAPERCLIP_API_URL` | Server URL | ✅ Used |
| `PAPERCLIP_RUN_ID` | Current run ID for audit trail | ⚠️ Used as `PAPERCLIP_HEARTBEAT_RUN_ID` |
| `PAPERCLIP_API_KEY` | Agent auth key | ✅ Used (optional) |
| `PAPERCLIP_TASK_ID` | Issue that triggered this wake | ❌ **Not read** |
| `PAPERCLIP_WAKE_REASON` | Why this run was triggered | ❌ **Not read** |
| `PAPERCLIP_WAKE_COMMENT_ID` | Specific comment that triggered wake | ❌ **Not read** |
| `PAPERCLIP_APPROVAL_ID` | Approval that needs handling | ❌ **Not read** |
| `PAPERCLIP_APPROVAL_STATUS` | Approval status | ❌ **Not read** |
| `PAPERCLIP_LINKED_ISSUE_IDS` | Comma-separated linked issues | ❌ **Not read** |

### 2.5 Advanced Issue Features

| Feature | Paperclip Spec | Our Status |
|---|---|---|
| Issue checkout (atomic) | `POST /api/issues/{id}/checkout` — prevents concurrent work | ❌ Missing |
| Issue release | `POST /api/issues/{id}/release` — release checkout | ❌ Missing |
| Heartbeat context | `GET /api/issues/{id}/heartbeat-context` — compact context | ❌ Missing |
| Issue documents | `PUT /api/issues/{id}/documents/{key}` — structured docs on issues | ❌ Missing |
| Issue relations | `related`, `blocks`, `blocked_by`, `duplicate` | ❌ Missing |
| Issue search | `GET /api/companies/{companyId}/issues?q=search+term` | ❌ Missing |
| Workflow states | 6 categories: Triage/Backlog/Unstarted/Started/Completed/Cancelled | ⚠️ Partial |
| Comment deltas | `?after={commentId}&order=asc` for incremental reads | ❌ Missing |
| @-mention wakeups | `@AgentName` in comments triggers heartbeat | ❌ Not wired |
| Ticket-linking in comments | `[PAP-123](/PAP/issues/PAP-123)` format required | ❌ Not implemented |
| Comment with PATCH | `PATCH /api/issues/{id}` with `comment` field | ❌ Uses separate POST |
| Labels / tags | Label groups, mutual exclusivity | ❌ Not used |
| Billing codes | `billingCode` for cross-team cost attribution | ❌ Not used |

### 2.6 Skills (Paperclip-provided)

| Skill | Purpose | Our Status |
|---|---|---|
| `paperclip` | Core API coordination skill | ❌ Not loaded (referenced in TOOLS.md, not wired) |
| `para-memory-files` | PARA memory system for cross-session knowledge | ❌ Not loaded |
| `paperclip-create-agent` | Governance-aware agent hiring workflow | ❌ Not loaded |
| `paperclip-create-plugin` | Plugin creation skill | N/A (post-V1) |

### 2.7 Post-V1 / Planned Features

| Feature | Status | Relevance |
|---|---|---|
| Plugin system | Spec complete, partial implementation | 🟡 Watch for workspace/git/terminal plugins |
| Memory service | Plan stage (company-scoped, provider-agnostic) | 🟡 Will replace file-based PARA |
| Budget policies | Plan stage (agent monthly + project lifetime) | 🟢 Aligns with our cost tracking |
| Agent-plugin config | Plan stage (per-agent tool toggles) | 🟡 Useful when plugins arrive |
| Token optimization | Plan stage | 🟡 Useful for cost reduction |

---

## 3. What We Use Correctly

### ✅ Heartbeat Pipeline Architecture
Our 10-step pipeline in `heartbeat-entrypoint.ts` follows the correct Paperclip model:
identify → inbox → resolve role → load config → dispatch → report. The process adapter
spawns `npx tsx src/heartbeat-entrypoint.ts` with env vars injected — exactly right.

### ✅ Agent API Key Handling
We correctly handle both `local_trusted` (no auth) and `authenticated` (agent API key)
deployment modes. The conditional `useAgentKey` logic is well-reasoned.

### ✅ Issue Comment-Based Reporting
We use `POST /api/issues/{id}/comments` as the primary result reporting mechanism,
matching Paperclip's design. No custom report endpoints.

### ✅ Cost Event Reporting
Our `CostTracker` + `reportCostEvent()` integration is one of the best-aligned features.
We correctly report per-interaction cost events with provider, model, tokens, and cost
in cents. The `billingType: "subscription_included"` for GitHub Copilot is correct.

### ✅ Agent Hire API
We correctly use `POST /api/companies/{companyId}/agent-hires` instead of
`POST /api/agents` — the hire endpoint respects `canCreateAgents` permission
on the calling agent, which is what CEO agents need.

### ✅ 4-File Agent Configuration
Our AGENTS.md / SOUL.md / HEARTBEAT.md / TOOLS.md pattern matches the official
Paperclip convention from `paperclipai/companies`. System message injection via
concatenation is the right approach.

### ✅ CEO Delegation Pattern
The CEO orchestrator creates sub-issues with `parentId`, assigns to specialist agents,
and comments on the parent issue with delegation summary — correct manager heartbeat
pattern per Paperclip's worked examples.

### ✅ Non-Retrying of 409 Conflicts
Our `isPaperclipRetryable()` correctly excludes 4xx errors from retry.
Paperclip explicitly states "Never retry a 409" for checkout conflicts.

### ✅ X-Paperclip-Run-Id Header
We set the run ID header on the client when available. Paperclip requires this
on all mutating issue requests for audit trail traceability.

---

## 4. What We're Doing Wrong

### 🔴 CRITICAL: No Task Checkout Before Working

**Paperclip SKILL.md, Step 5:** "You MUST checkout before doing any work."

Our code **never calls** `POST /api/issues/{id}/checkout`. This is the most critical
protocol violation. The checkout endpoint provides:

1. **Atomic locking** — prevents two agents from working the same issue simultaneously
2. **Status transition** — moves issue to `in_progress` automatically
3. **409 Conflict detection** — tells you if another agent owns the task

**Impact:** Without checkout, two heartbeats could process the same issue concurrently,
creating duplicate work and conflicting status updates.

**Our client doesn't even expose** a `checkoutIssue()` method.

**Fix priority:** P0 — must implement before production use.

### 🔴 CRITICAL: Wake Context Variables Ignored

Our `heartbeat-entrypoint.ts` reads `PAPERCLIP_AGENT_ID`, `PAPERCLIP_COMPANY_ID`,
`PAPERCLIP_API_URL`, and `PAPERCLIP_HEARTBEAT_RUN_ID` — but completely ignores:

- `PAPERCLIP_TASK_ID` — which task triggered this wake (should be prioritized)
- `PAPERCLIP_WAKE_REASON` — why this run was triggered (timer/assignment/on_demand/comment)
- `PAPERCLIP_WAKE_COMMENT_ID` — specific comment that triggered wake (must be read first)
- `PAPERCLIP_APPROVAL_ID` / `PAPERCLIP_APPROVAL_STATUS` — approval handling
- `PAPERCLIP_LINKED_ISSUE_IDS` — related issues context

**Irony:** Our agent HEARTBEAT.md files tell agents to check these variables, but our
TypeScript entrypoint never passes them through. The Copilot SDK agents can't see them.

**Fix priority:** P0 — required for event-driven wakeups to work.

### 🟡 MEDIUM: Run ID Environment Variable Name Mismatch

Paperclip's process adapter injects `PAPERCLIP_RUN_ID`. Our code reads
`PAPERCLIP_HEARTBEAT_RUN_ID`. This likely means we never get the run ID in
process adapter mode, losing audit trail linkage.

**Fix:** Accept both: `PAPERCLIP_RUN_ID || PAPERCLIP_HEARTBEAT_RUN_ID`.

### 🟡 MEDIUM: Separate Comment Instead of PATCH+comment

Paperclip supports `PATCH /api/issues/{id}` with a `comment` field — atomic status
update + comment in one call. We use separate `updateIssue()` + `addIssueComment()`,
which risks partial failure (status updated but comment lost, or vice versa).

**Fix:** Add `comment` to the `updateIssue()` body parameter.

### 🟡 MEDIUM: No Task Release on Exit

Paperclip expects agents to release tasks they can't finish:
`POST /api/issues/{id}/release`. Our agents hold checkout locks indefinitely
(well, we don't checkout at all, but once we do, we need release too).

**Fix:** Add `releaseIssue()` to client and call it in error/timeout paths.

### 🟡 MEDIUM: No Blocked-Task Dedup

Paperclip SKILL.md Step 4 requires blocked-task dedup: "If your most recent comment
was a blocked-status update AND no new comments from other agents have been posted since,
skip the task entirely." We process blocked tasks without checking comment history.

**Fix:** Implement comment-thread check before re-engaging blocked issues.

---

## 5. Missing Features — High Impact

### 5.1 Task Checkout / Release Protocol

**What:** Atomic `POST /api/issues/{id}/checkout` + `POST /api/issues/{id}/release`

**Why critical:** Prevents concurrent work on the same issue. Without it, two heartbeat
runs could process the same issue simultaneously.

**Implementation:**
```
PaperclipClient:
  + checkoutIssue(issueId: string, expectedStatuses?: string[]): Promise<PaperclipIssue>
  + releaseIssue(issueId: string): Promise<void>

heartbeat-entrypoint.ts:
  - Before processing each issue: checkout
  - On error/timeout: release
  - On completion: don't release (checkout holds until status change)
```

### 5.2 Wake Context Routing

**What:** Read and act on `PAPERCLIP_TASK_ID`, `PAPERCLIP_WAKE_REASON`,
`PAPERCLIP_WAKE_COMMENT_ID`, `PAPERCLIP_APPROVAL_ID`.

**Why critical:** Event-driven wakeups (comment mentions, assignment notifications,
approvals) don't work without this. The agent doesn't know *why* it was woken up.

**Implementation:**
```
extractPaperclipEnv():
  + taskId: PAPERCLIP_TASK_ID
  + wakeReason: PAPERCLIP_WAKE_REASON
  + wakeCommentId: PAPERCLIP_WAKE_COMMENT_ID
  + approvalId: PAPERCLIP_APPROVAL_ID
  + approvalStatus: PAPERCLIP_APPROVAL_STATUS
  + linkedIssueIds: PAPERCLIP_LINKED_ISSUE_IDS?.split(',')

main():
  - If approvalId is set → handle approval first (Step 2)
  - If taskId is set → prioritize that task
  - If wakeCommentId is set → read that comment first
```

### 5.3 Heartbeat Context Endpoint

**What:** `GET /api/issues/{id}/heartbeat-context` — compact issue + ancestors + cursor metadata

**Why important:** More efficient than `GET /api/issues/{id}` + `GET /api/issues/{id}/comments`.
Gives agents exactly what they need for a heartbeat without over-fetching.

**Implementation:**
```
PaperclipClient:
  + getIssueHeartbeatContext(issueId: string): Promise<HeartbeatContext>
```

### 5.4 Session Resume

**What:** Persist session IDs per (agent, taskKey) across heartbeats. Resume
conversation context instead of cold-starting every time.

**Why important:** Each heartbeat currently cold-starts the Copilot SDK session,
losing all conversation history. Resuming sessions would dramatically reduce
token usage and improve continuity.

**Paperclip provides:**
- `agent_task_sessions` table (taskKey → sessionId mapping)
- `agent_runtime_state` table (agent → persistent state)
- Session resume in adapter protocol (`runtimeState.sessions[taskKey]`)

**Implementation:**
```
SessionManager:
  - Store sessionId after each task completion
  - On next heartbeat for same task: resume session
  - Requires runtime state persistence via Paperclip API or local files
```

### 5.5 Paperclip Skills Loading

**What:** Load Paperclip's own skills (`paperclip`, `para-memory-files`) into
agent sessions so they can make API calls themselves.

**Why important:** Our agent HEARTBEAT.md files reference the `paperclip` skill
for checkout, comments, and status updates. But the skill SKILL.md is never
loaded into the Copilot SDK session. Agents are told to use a skill they don't have.

**Current code:** `resolveSkillDirectories()` checks `PAPERCLIP_SKILLS_DIR` env var,
but we never set it. The skill directories exist in the Paperclip repo at
`/Users/Q543651/repos/AI Repo/paperclip/skills/`.

**Fix:** Set `PAPERCLIP_SKILLS_DIR` in `.env` or process adapter config pointing to
the Paperclip repo's skills directory.

---

## 6. Missing Features — Medium Impact

### 6.1 Issue Documents API

**What:** `PUT /api/issues/{id}/documents/{key}` — structured markdown documents
attached to issues (plans, specs, etc.)

**Why useful:** Paperclip's planning workflow requires CEOs/managers to store plans
as issue documents (key: `plan`), not in issue descriptions. This keeps plans
versioned and deep-linkable.

**Implementation:**
```
PaperclipClient:
  + getIssueDocuments(issueId: string): Promise<IssueDocument[]>
  + getIssueDocument(issueId: string, key: string): Promise<IssueDocument>
  + upsertIssueDocument(issueId: string, key: string, body: IssueDocumentInput): Promise<IssueDocument>
```

### 6.2 Project + Workspace Model

**What:** Projects group issues toward a deliverable. Workspaces attach
local directories and/or GitHub repos to projects.

**Why useful:** Our agents work on a project (`TARGET_PROJECT_ROOT`) but Paperclip
doesn't know about it. Creating a Paperclip project with workspace would:
- Let agents resolve `cwd` from the project workspace
- Enable project-scoped budgets
- Enable project-level issue filtering

**Implementation:**
```
PaperclipClient:
  + createProject(project: {...}): Promise<PaperclipProject>
  + createProjectWorkspace(projectId: string, ws: {...}): Promise<Workspace>

Setup script:
  - Create project for the target repo
  - Attach workspace with cwd + repoUrl
  - Set projectId on all created issues
```

### 6.3 Comment Style Compliance

**What:** Paperclip requires specific comment formatting:
- Ticket references as links: `[PAP-123](/PAP/issues/PAP-123)`
- Company-prefixed URLs in all internal links
- Status line + bullets format

**Why useful:** Makes the Paperclip UI navigable. Currently our comments are
plain markdown without internal links.

**Implementation:** Update `PaperclipReporter` to format comments per spec.

### 6.4 Goal Hierarchy

**What:** Goals provide company → team → agent → task alignment.
`goalId` should propagate from parent issues to sub-issues.

**Why useful:** Connects all work to strategic objectives. The CEO orchestrator
should set `goalId` on all delegated sub-issues.

**Implementation:** Our CEO orchestrator partially propagates `goalId` from the
parent issue. Ensure it's always set, and consider creating company goals
during setup.

### 6.5 @-Mention Communication

**What:** `@AgentName` in comments triggers agent heartbeats. Enables
inter-agent communication and review requests.

**Why useful:** Code review agent could @-mention developer on findings.
PM could @-mention architect for clarification. Currently no inter-agent
communication except via task delegation.

### 6.6 PATCH Status + Comment Atomically

**What:** Use `PATCH /api/issues/{id}` with both `status` and `comment` fields
in one call instead of separate calls.

**Why useful:** Atomic operation prevents partial failure. Fewer API calls.

---

## 7. Missing Features — Low Priority (Post-V1)

| Feature | Notes |
|---|---|
| **Approval workflows** | Board governance gates; needed when agents create agents or exceed budgets |
| **Issue relations** | `blocks` / `blocked_by` / `duplicate` links between issues |
| **Labels / tags** | Label groups for issue categorization (e.g., `bug`, `feature`, `tech-debt`) |
| **Billing codes** | Cross-team cost attribution; not needed until multi-team |
| **Agent instructions path** | `PATCH /api/agents/{id}/instructions-path` for dynamic AGENTS.md |
| **OpenClaw invite** | CEO generating invite prompts for external agents |
| **Plugin system** | Post-V1; watch for workspace/git/terminal plugins |
| **Memory service** | Company-scoped memory; post-V1 |
| **Budget policies** | Soft alerts + hard stops; partially supported by our cost events |
| **Issue search** | `?q=search+term` on issues list endpoint |
| **Dashboard endpoint** | `GET /api/companies/{companyId}/dashboard` for health overview |

---

## 8. Optimization Opportunities

### 8.1 Token Reduction via Heartbeat Context

**Current:** Each heartbeat does `GET /api/agents/{id}` + `GET /api/agents/me/inbox-lite` +
`GET /api/issues/{id}` per issue + potentially `GET /api/issues/{id}/comments`.

**Optimal:** Use `GET /api/issues/{id}/heartbeat-context` which returns issue + ancestors +
comment cursor metadata in one compact call. Only fetch full comments when needed.

**Estimated savings:** ~30% fewer API calls, faster heartbeat startup.

### 8.2 Session Resume for Continuity

**Current:** Every heartbeat cold-starts a new Copilot SDK session, losing context.

**Optimal:** Resume sessions per (agent, issueId). The Copilot SDK supports session
resume by ID. Store the session mapping in Paperclip's runtime state or local files.

**Estimated savings:** ~50% token reduction for multi-heartbeat tasks.

### 8.3 Conditional Run ID Header

**Current:** We conditionally set `X-Paperclip-Run-Id` only in authenticated mode.

**Optimal:** Always set it when available. Even in `local_trusted` mode, if a run ID
exists, Paperclip can use it for audit trail. The FK constraint issue we had suggests
our env var name is wrong (we read `PAPERCLIP_HEARTBEAT_RUN_ID` but Paperclip injects
`PAPERCLIP_RUN_ID`).

### 8.4 Incremental Comment Reads

**Current:** We read full comment threads each heartbeat.

**Optimal:** Use `GET /api/issues/{id}/comments?after={lastSeenCommentId}&order=asc`
for incremental reads. Store last-seen comment ID in runtime state.

### 8.5 Parallel Issue Processing

**Current:** Issues processed sequentially in a `for` loop.

**Optimal:** For CEO (orchestrator), parallel delegation is safe since each issue
is independent. For IC agents, sequential is correct (single checkout at a time).

### 8.6 Budget-Aware Behavior

**Current:** We report costs but don't check budget before acting.

**Optimal:** Read `budgetMonthlyCents` and `spentMonthlyCents` from agent identity.
Above 80%: focus on critical tasks only (skip medium/low priority).
At 100%: exit heartbeat immediately.

---

## 9. Implementation Roadmap

### Phase A: Protocol Compliance (P0 — Must Fix)

| # | Task | Effort | Impact |
|---|---|---|---|
| A1 | Add `checkoutIssue()` + `releaseIssue()` to PaperclipClient | S | Critical |
| A2 | Wire checkout before processing each issue in heartbeat-entrypoint | S | Critical |
| A3 | Read all PAPERCLIP_* wake context env vars | S | Critical |
| A4 | Route to task/comment/approval based on wake reason | M | Critical |
| A5 | Fix run ID env var: accept `PAPERCLIP_RUN_ID \|\| PAPERCLIP_HEARTBEAT_RUN_ID` | XS | High |
| A6 | Always send X-Paperclip-Run-Id when available | XS | Medium |

**Estimated effort:** 1-2 days

### Phase B: Context Efficiency (P1 — High Value)

| # | Task | Effort | Impact |
|---|---|---|---|
| B1 | Add `getIssueHeartbeatContext()` to client | S | High |
| B2 | Use heartbeat-context instead of separate issue + comments calls | M | High |
| B3 | Add `comment` field to `updateIssue()` for atomic status+comment | XS | Medium |
| B4 | Implement blocked-task dedup (check comment thread before re-engaging) | M | Medium |
| B5 | Set `PAPERCLIP_SKILLS_DIR` to load Paperclip skills into sessions | XS | High |
| B6 | Budget-aware behavior (check spend %, skip low priority above 80%) | S | Medium |

**Estimated effort:** 2-3 days

### Phase C: Session & Memory (P2 — Significant Value)

| # | Task | Effort | Impact |
|---|---|---|---|
| C1 | Implement session resume per (agent, issueId) | L | Very High |
| C2 | Store session state via Paperclip runtime state API or local files | M | High |
| C3 | Wire PARA memory skill loading when `PAPERCLIP_SKILLS_DIR` is set | S | Medium |
| C4 | Add incremental comment reading with cursor tracking | M | Medium |

**Estimated effort:** 3-5 days

### Phase D: Organizational Structure (P3 — Full Integration)

| # | Task | Effort | Impact |
|---|---|---|---|
| D1 | Add project + workspace creation to setup script | M | Medium |
| D2 | Set `projectId` on all created issues | S | Medium |
| D3 | Add issue documents API (`PUT /api/issues/{id}/documents/{key}`) | M | Medium |
| D4 | Propagate `goalId` consistently in CEO orchestrator | S | Low |
| D5 | Implement comment style compliance (ticket links, prefixed URLs) | M | Low |
| D6 | Add @-mention support for inter-agent communication | M | Medium |
| D7 | Add `chainOfCommand` to agent model for escalation routing | S | Low |

**Estimated effort:** 3-5 days

---

## 10. Appendix: API Surface Comparison

### Endpoints We Use (✅ 15 endpoints)

| Method | Endpoint | Client Method |
|---|---|---|
| `GET` | `/api/health` | `ping()` |
| `GET` | `/api/agents/me` | `getAgentSelf()` |
| `GET` | `/api/agents/:id` | `getAgent()` |
| `GET` | `/api/agents/me/inbox-lite` | `getAgentInbox()` |
| `GET` | `/api/companies/:companyId/agents` | `listAgents()` |
| `GET` | `/api/companies/:companyId/issues` | `listIssues()` |
| `GET` | `/api/companies/:companyId/heartbeat-runs` | `listHeartbeatRuns()` |
| `GET` | `/api/companies/:companyId/org` | `getOrgTree()` |
| `GET` | `/api/companies/:companyId/goals` | `listGoals()` |
| `GET` | `/api/issues/:id` | `getIssue()` |
| `GET` | `/api/heartbeat-runs/:runId` | `getHeartbeatRun()` |
| `PATCH` | `/api/agents/:id` | `updateAgent()` |
| `PATCH` | `/api/issues/:id` | `updateIssue()` |
| `POST` | `/api/companies/:companyId/agent-hires` | `createAgent()` |
| `POST` | `/api/companies/:companyId/issues` | `createIssue()` |
| `POST` | `/api/companies/:companyId/cost-events` | `reportCostEvent()` |
| `POST` | `/api/issues/:id/comments` | `addIssueComment()` |
| `POST` | `/api/agents/:id/heartbeat/invoke` | `invokeHeartbeat()` |
| `POST` | `/api/agents/:id/wakeup` | `wakeAgent()` |
| `POST` | `/api/agents/:id/pause` | `pauseAgent()` |
| `POST` | `/api/agents/:id/resume` | `resumeAgent()` |
| `POST` | `/api/agents/:id/terminate` | `terminateAgent()` |
| `POST` | `/api/heartbeat-runs/:runId/cancel` | `cancelHeartbeatRun()` |
| `GET` | `/api/companies/:companyId/live-runs` | `getLiveRuns()` |

### Endpoints We Should Add (❌ Missing — by priority)

| Priority | Method | Endpoint | Purpose |
|---|---|---|---|
| **P0** | `POST` | `/api/issues/:id/checkout` | Atomic task checkout |
| **P0** | `POST` | `/api/issues/:id/release` | Release checkout lock |
| **P1** | `GET` | `/api/issues/:id/heartbeat-context` | Compact heartbeat context |
| **P1** | `GET` | `/api/issues/:id/comments?after=:id` | Incremental comment reads |
| **P1** | `GET` | `/api/issues/:id/comments/:id` | Get specific comment |
| **P2** | `PUT` | `/api/issues/:id/documents/:key` | Issue documents |
| **P2** | `GET` | `/api/issues/:id/documents` | List issue documents |
| **P2** | `GET` | `/api/issues/:id/documents/:key` | Get issue document |
| **P3** | `POST` | `/api/companies/:companyId/projects` | Create project |
| **P3** | `POST` | `/api/projects/:id/workspaces` | Create workspace |
| **P3** | `GET` | `/api/companies/:companyId/dashboard` | Dashboard health |
| **P3** | `GET` | `/api/companies/:companyId/issues?q=` | Issue search |
| **P3** | `PATCH` | `/api/agents/:id/instructions-path` | Set agent instructions |
| **P3** | `GET` | `/api/approvals/:id` | Get approval |
| **P3** | `POST` | `/api/approvals/:id/comments` | Comment on approval |

### Environment Variables We Should Read

| Priority | Variable | Current | Should Be |
|---|---|---|---|
| **P0** | `PAPERCLIP_RUN_ID` | Not read | Accept as alias for heartbeat run ID |
| **P0** | `PAPERCLIP_TASK_ID` | Not read | Prioritize this task in inbox |
| **P0** | `PAPERCLIP_WAKE_REASON` | Not read | Route to correct handler |
| **P0** | `PAPERCLIP_WAKE_COMMENT_ID` | Not read | Read this comment first |
| **P1** | `PAPERCLIP_APPROVAL_ID` | Not read | Handle approval follow-up |
| **P1** | `PAPERCLIP_APPROVAL_STATUS` | Not read | Know approval outcome |
| **P2** | `PAPERCLIP_LINKED_ISSUE_IDS` | Not read | Cross-reference context |

---

## Summary: Path to Integration Level 3

```
Current (Level 2: Status Reporting)
├── ✅ Heartbeat pipeline works
├── ✅ Issue CRUD + comments
├── ✅ Cost event reporting
├── ✅ Agent config (4-file system)
├── ✅ CEO delegation via sub-issues
└── ❌ Missing checkout, wake context, session resume, projects, approvals

Target (Level 3: Fully Instrumented)
├── Phase A: Protocol compliance (checkout, wake context, run ID)
├── Phase B: Context efficiency (heartbeat-context, skills, budget)
├── Phase C: Session & memory (resume, PARA, incremental reads)
└── Phase D: Organizational structure (projects, documents, goals, mentions)
```

**Estimated total effort to reach Level 3:** ~10-15 developer-days across all 4 phases.
Phases A+B are essential and can be done in ~3-5 days for immediate quality improvement.

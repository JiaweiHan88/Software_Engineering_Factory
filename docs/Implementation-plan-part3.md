# Implementation Plan v3 — High-Priority / High-Value Unified

> **Purpose:** Combined implementation plan targeting the highest-priority items from
> both `paperclip-feature-analysis.md` (protocol compliance + context efficiency) and
> `bmad-folder-analysis.md` (unused BMAD skill activation + full SDLC loop).
>
> **Date:** 2025-07-22
> **Prerequisite:** Phases 0–7 complete (IMPLEMENTATION-PLAN.md). All 160 tests passing.
> **Source docs:** `docs/paperclip-feature-analysis.md`, `docs/bmad-folder-analysis.md`

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Current State Recap](#2-current-state-recap)
3. [Phase A — Protocol Compliance (P0)](#3-phase-a--protocol-compliance-p0)
4. [Phase B — Context Efficiency & Skills (P1)](#4-phase-b--context-efficiency--skills-p1)
5. [Phase C — Full SDLC Pipeline (P1)](#5-phase-c--full-sdlc-pipeline-p1)
6. [Phase D — CEO Intelligence & Decision Engine (P1)](#6-phase-d--ceo-intelligence--decision-engine-p1)
7. [Phase E — Session Continuity & Memory (P2)](#7-phase-e--session-continuity--memory-p2)
8. [Phase F — Test Architecture & QA Expansion (P2)](#8-phase-f--test-architecture--qa-expansion-p2)
9. [Cross-Cutting Concerns](#9-cross-cutting-concerns)
10. [Verification Strategy](#10-verification-strategy)
11. [Dependency Graph](#11-dependency-graph)
12. [Effort Summary](#12-effort-summary)

---

## 1. Executive Summary

We're at **Integration Level 2** with Paperclip (status reporting) and use only **~30%**
of the BMAD Method's 56 available skills. This plan targets two objectives:

1. **Paperclip Protocol Compliance** — Fix the critical gaps (task checkout, wake context,
   heartbeat-context, atomic status+comment) that block safe concurrent agent operation.
2. **Full SDLC Skill Activation** — Wire the unused BMAD skills (PRD creation, architecture
   design, epics/stories generation, implementation readiness, E2E tests, retrospectives)
   into the CEO delegation pipeline, closing the loop from "idea → deployed code."

### Target Outcome

```
Current:  Issue → CEO delegates → Dev implements → QA reviews → Done
                                  (5 skills active)

Target:   Issue → CEO evaluates (greenfield/brownfield) →
            Research (brainstorm + market + technical) →
            PRD + Architecture + UX →
            Readiness check →
            Epics & Stories →
            Sprint planning →
            Dev implements → QA reviews (+ E2E tests) →
            Retrospective → Done
            (25+ skills active, full SDLC autonomy)
```

### Priority Matrix

| Phase | Priority | Focus | Effort | Impact |
|-------|----------|-------|--------|--------|
| **A** | P0 | Paperclip protocol compliance | 2 days | Critical — concurrency safety |
| **B** | P1 | Context efficiency + skills loading | 2 days | High — token reduction, richer agents |
| **C** | P1 | Full SDLC pipeline (12 new skills) | 3–4 days | Very High — autonomous factory |
| **D** | P1 | CEO decision engine (greenfield/brownfield) | 2–3 days | Very High — intelligent orchestration |
| **E** | P2 | Session continuity + PARA memory | 3–5 days | High — multi-heartbeat coherence |
| **F** | P2 | Test architecture + QA expansion | 2–3 days | High — quality automation |

**Total estimated effort: 14–19 days**
**Phases A+B+C+D (essential): 9–11 days**

---

## 2. Current State Recap

### What Works (from Implementation Plans v1/v2)

| Component | Status | Files |
|-----------|--------|-------|
| Heartbeat pipeline (10-step) | ✅ | `src/heartbeat-entrypoint.ts` |
| 9 BMAD agents (Copilot SDK) | ✅ | `src/agents/*.ts` |
| 4-file agent configs (10 roles) | ✅ | `agents/*/AGENTS.md, SOUL.md, HEARTBEAT.md, TOOLS.md` |
| PaperclipClient (24 endpoints) | ✅ | `src/adapter/paperclip-client.ts` |
| CEO orchestrator (delegation) | ✅ | `src/adapter/ceo-orchestrator.ts` |
| Sprint runner + lifecycle | ✅ | `src/adapter/sprint-runner.ts` |
| Quality gates (3-pass adversarial) | ✅ | `src/quality-gates/` |
| MCP server (5 tools) | ✅ | `src/mcp/bmad-sprint-server/` |
| Cost tracking | ✅ | `PaperclipClient.reportCostEvent()` |
| Observability (OTel + Grafana) | ✅ | `src/observability/` |
| 160 tests passing | ✅ | `test/*.test.ts` |

### What's Missing (from Both Analyses)

| Gap | Source | Severity |
|-----|--------|----------|
| Task checkout/release protocol | Paperclip analysis §4 | 🔴 CRITICAL |
| Wake context env vars (TASK_ID, WAKE_REASON, etc.) | Paperclip analysis §4 | 🔴 CRITICAL |
| Run ID env var name mismatch | Paperclip analysis §4 | 🟡 MEDIUM |
| Heartbeat-context endpoint | Paperclip analysis §5.3 | 🟡 HIGH |
| Atomic PATCH status+comment | Paperclip analysis §4 | 🟡 MEDIUM |
| Task release on error/timeout | Paperclip analysis §4 | 🟡 MEDIUM |
| Blocked-task dedup | Paperclip analysis §4 | 🟡 MEDIUM |
| Paperclip skills not loaded | Paperclip analysis §5.5 | 🟡 HIGH |
| project-context.md missing | BMAD analysis §6 Prio 1.1 | 🟡 HIGH |
| Implementation readiness gate | BMAD analysis §6 Prio 1.2 | 🟡 HIGH |
| PRD/Architecture creation | BMAD analysis §6 Prio 2.1–2.2 | 🟡 HIGH |
| Epics & stories generation | BMAD analysis §6 Prio 2.3 | 🟡 HIGH |
| E2E test generation | BMAD analysis §6 Prio 2.4 | 🟡 MEDIUM |
| Research workflows | BMAD analysis §6 Prio 3.3 | 🟡 MEDIUM |
| CEO greenfield/brownfield logic | BMAD analysis notes | 🟡 HIGH |
| Budget-aware behavior | Paperclip analysis §8.6 | 🟡 MEDIUM |

---

## 3. Phase A — Protocol Compliance (P0)

> **Goal:** Make our heartbeat agent a correct Paperclip citizen — safe concurrent
> operation, full wake context awareness, proper audit trail.
>
> **Effort:** 2 days  
> **Files touched:** `src/adapter/paperclip-client.ts`, `src/heartbeat-entrypoint.ts`

### A1. Task Checkout + Release in PaperclipClient

**What:** Add `checkoutIssue()` and `releaseIssue()` methods.

**Why:** Paperclip SKILL.md Step 5: "You MUST checkout before doing any work."
Without checkout, two heartbeat runs can process the same issue simultaneously,
causing duplicate work and conflicting state.

```
PaperclipClient additions:
  + checkoutIssue(issueId: string, expectedStatuses?: string[]): Promise<PaperclipIssue>
    → POST /api/issues/{id}/checkout
    → Body: { expectedStatuses: ["todo", "in_progress"] }
    → Returns: updated issue (status auto-set to in_progress)
    → 409 Conflict: another agent owns this task → skip gracefully

  + releaseIssue(issueId: string): Promise<void>
    → POST /api/issues/{id}/release
    → Release checkout lock (for error/timeout paths)
```

**Implementation notes:**
- `checkoutIssue()` must catch `409` and return `null` (not throw) — caller skips task
- `releaseIssue()` must be idempotent (releasing an unchecked-out task = no-op)
- Never retry a 409 (our `isPaperclipRetryable()` already excludes 4xx ✅)

**Test plan:**
- `test/paperclip-client.test.ts`: checkout success, checkout 409, release, release idempotent

### A2. Wire Checkout into Heartbeat Pipeline

**What:** Before processing each issue in `heartbeat-entrypoint.ts`, call checkout.
On error/timeout, call release.

**Where:** `src/heartbeat-entrypoint.ts` — the issue processing loop

```
Current flow:
  for (issue of inbox) → dispatch(issue)

New flow:
  for (issue of inbox) {
    const locked = await client.checkoutIssue(issue.id);
    if (!locked) continue; // 409 — another agent has it
    try {
      await dispatch(locked);
    } catch (err) {
      await client.releaseIssue(issue.id); // release on failure
      throw err;
    }
    // On success: don't release — checkout holds until status change
  }
```

**Test plan:**
- Integration test: checkout → dispatch → verify issue status = in_progress
- Error test: dispatch throws → verify release called

### A3. Full Wake Context Environment Variables

**What:** Read ALL `PAPERCLIP_*` env vars injected by the process adapter.

**Where:** `src/heartbeat-entrypoint.ts` — `extractPaperclipEnv()` + `PaperclipEnv` interface

```typescript
// Add to PaperclipEnv interface:
interface PaperclipEnv {
  // ... existing fields ...

  /** Issue that triggered this wake (prioritize this task) */
  taskId: string | undefined;
  /** Why this run was triggered: timer | assignment | on_demand | comment */
  wakeReason: string | undefined;
  /** Specific comment that triggered wake (read this first) */
  wakeCommentId: string | undefined;
  /** Approval that needs handling */
  approvalId: string | undefined;
  /** Approval outcome: approved | denied */
  approvalStatus: string | undefined;
  /** Comma-separated linked issue IDs */
  linkedIssueIds: string[] | undefined;
}

// In extractPaperclipEnv():
taskId: process.env.PAPERCLIP_TASK_ID || undefined,
wakeReason: process.env.PAPERCLIP_WAKE_REASON || undefined,
wakeCommentId: process.env.PAPERCLIP_WAKE_COMMENT_ID || undefined,
approvalId: process.env.PAPERCLIP_APPROVAL_ID || undefined,
approvalStatus: process.env.PAPERCLIP_APPROVAL_STATUS || undefined,
linkedIssueIds: process.env.PAPERCLIP_LINKED_ISSUE_IDS?.split(',').filter(Boolean) || undefined,
```

### A4. Wake-Reason Routing

**What:** Route the heartbeat based on why the agent was woken up.

**Where:** `src/heartbeat-entrypoint.ts` — main() function, before inbox processing

```
main():
  const env = extractPaperclipEnv();

  // Step 2: Approval follow-up (if set)
  if (env.approvalId) {
    await handleApproval(env.approvalId, env.approvalStatus);
    return; // approval handling is a dedicated heartbeat
  }

  // Step 3: Get assignments
  const inbox = await client.getAgentInbox();

  // Step 4: Prioritize triggered task
  if (env.taskId) {
    // Move the triggered task to the front of the queue
    const triggeredIdx = inbox.findIndex(i => i.id === env.taskId);
    if (triggeredIdx > 0) {
      const [triggered] = inbox.splice(triggeredIdx, 1);
      inbox.unshift(triggered);
    }
  }

  // If wakeCommentId is set, attach it to the task context
  // so the agent reads the triggering comment first
  if (env.wakeCommentId && env.taskId) {
    // Pass to dispatch context: { focusCommentId: env.wakeCommentId }
  }

  // Step 5+: Checkout and process (per A2)
```

### A5. Fix Run ID Environment Variable

**What:** Accept both `PAPERCLIP_RUN_ID` and `PAPERCLIP_HEARTBEAT_RUN_ID`.

**Where:** `src/heartbeat-entrypoint.ts` — `extractPaperclipEnv()`

```typescript
heartbeatRunId: process.env.PAPERCLIP_RUN_ID
  || process.env.PAPERCLIP_HEARTBEAT_RUN_ID
  || undefined,
```

### A6. Always Send X-Paperclip-Run-Id When Available

**What:** Set the run ID header on ALL mutating requests, not just authenticated mode.

**Where:** `src/adapter/paperclip-client.ts` — request builder

```
Current:  header set conditionally (only when useAgentKey is true)
Fix:      Always set if runId is available, regardless of auth mode
```

### A7. Blocked-Task Dedup

**What:** Before re-engaging a blocked task, check if the agent's last comment was a
blocked-status update AND no new comments from other agents since. If so, skip.

**Where:** `src/heartbeat-entrypoint.ts` — issue processing loop (after checkout)

```
for (issue of inbox) {
  if (issue.status === 'blocked') {
    const comments = await client.getIssueComments(issue.id);
    const lastComment = comments[comments.length - 1];
    if (lastComment?.authorId === env.agentId && isBlockedStatusUpdate(lastComment)) {
      logger.info(`Skipping blocked task ${issue.id} — no new context since our last blocked update`);
      continue;
    }
  }
  // ... checkout and process
}
```

**Prerequisite:** Add `getIssueComments(issueId)` to PaperclipClient (currently comments
are only created, never read from client code).

---

## 4. Phase B — Context Efficiency & Skills (P1)

> **Goal:** Reduce token consumption, load Paperclip coordination skills, enable
> budget-aware behavior, use the efficient heartbeat-context endpoint.
>
> **Effort:** 2 days  
> **Files touched:** `src/adapter/paperclip-client.ts`, `src/heartbeat-entrypoint.ts`,
> `src/config/role-mapping.ts`, `.env`

### B1. Heartbeat-Context Endpoint

**What:** Add `getIssueHeartbeatContext()` to PaperclipClient.

```
PaperclipClient addition:
  + getIssueHeartbeatContext(issueId: string): Promise<HeartbeatContext>
    → GET /api/issues/{id}/heartbeat-context
    → Returns: { issue, ancestors, commentCursor, recentComments }

Interface HeartbeatContext {
  issue: PaperclipIssue;
  ancestors: PaperclipIssue[];      // parent chain to root
  commentCursor: string | null;     // last-seen comment ID for incremental reads
  recentComments: PaperclipIssueComment[];  // most recent comments
}
```

### B2. Replace Separate Issue+Comments with Heartbeat-Context

**What:** In the heartbeat pipeline, replace `getIssue()` + manual comment fetching
with a single `getIssueHeartbeatContext()` call.

**Estimated savings:** ~30% fewer API calls per heartbeat, faster startup.

### B3. Atomic Status + Comment via PATCH

**What:** Add `comment` field to `updateIssue()` body for atomic status+comment.

**Where:** `src/adapter/paperclip-client.ts` — `updateIssue()` method

```typescript
// Current: separate updateIssue() + addIssueComment()
// New: single PATCH with { status: "in_review", comment: "Dev complete. Files changed: ..." }

async updateIssue(
  issueId: string,
  updates: Partial<PaperclipIssue> & { comment?: string }
): Promise<PaperclipIssue>
```

**Impact:** Prevents partial failure (status updated but comment lost, or vice versa).

### B4. Load Paperclip Coordination Skills

**What:** Set `PAPERCLIP_SKILLS_DIR` to point to the Paperclip repo's skills directory.

**Where:** `.env` + `src/heartbeat-entrypoint.ts` — `resolveSkillDirectories()`

```env
# .env
PAPERCLIP_SKILLS_DIR=/Users/Q543651/repos/AI Repo/paperclip/skills
```

This loads 3 skills into agent sessions:
- `paperclip` — core API coordination (checkout, comments, status updates)
- `para-memory-files` — PARA memory system for cross-session knowledge
- `paperclip-create-agent` — governance-aware agent hiring

**Impact:** Agent HEARTBEAT.md files reference these skills but they were never loaded.
Agents will now be able to use the full Paperclip coordination protocol autonomously.

### B5. Budget-Aware Heartbeat Behavior

**What:** Check agent budget before processing tasks. Above 80% spend → focus on
high-priority tasks only. At 100% → exit heartbeat immediately.

**Where:** `src/heartbeat-entrypoint.ts` — after `getAgentSelf()`

```typescript
const me = await client.getAgentSelf();
const spendRatio = (me.spentMonthlyCents ?? 0) / (me.budgetMonthlyCents ?? Infinity);

if (spendRatio >= 1.0) {
  logger.warn(`Agent ${me.name} at 100% budget — exiting heartbeat`);
  return;
}

const budgetMode = spendRatio >= 0.8 ? 'conservative' : 'normal';
// In conservative mode: skip medium/low priority issues, only process high/critical
```

### B6. Incremental Comment Reading

**What:** Use `?after={commentId}&order=asc` for incremental comment reads.

**Where:** `src/adapter/paperclip-client.ts`

```
PaperclipClient additions:
  + getIssueComments(issueId: string, after?: string): Promise<PaperclipIssueComment[]>
    → GET /api/issues/{id}/comments?after={after}&order=asc
  + getIssueComment(issueId: string, commentId: string): Promise<PaperclipIssueComment>
    → GET /api/issues/{id}/comments/{commentId}
```

**Combined with session state:** Store `lastSeenCommentId` per issue to only read
new comments on subsequent heartbeats.

---

## 5. Phase C — Full SDLC Pipeline (P1)

> **Goal:** Activate the 12 highest-value unused BMAD skills, wiring them into the
> CEO delegation pipeline to enable full autonomous software development lifecycle.
>
> **Effort:** 3–4 days  
> **Files touched:** `src/adapter/ceo-orchestrator.ts`, `src/adapter/agent-dispatcher.ts`,
> `src/config/role-mapping.ts`, `src/tools/`, `agents/*/TOOLS.md`

### C1. Generate Project Context (`bmad-generate-project-context`)

**What:** Wire the `bmad-generate-project-context` skill to produce `project-context.md`.

**Why:** All 9 agent personas reference `project-context.md` at activation (Step 2 of
persona loading reads `bmad_res/bmm/config.yaml` which points to project context). Currently
this file is missing — agents load empty context.

**Agent:** Tech Writer (`bmad-tech-writer`)  
**Skill source:** `bmad_res/bmm/workflows/bmad-generate-project-context/`

**Implementation:**
1. Add `WorkPhase.GENERATE_PROJECT_CONTEXT` to `agent-dispatcher.ts`
2. Add tool definition in `src/tools/generate-project-context.ts`
3. CEO creates issue: "Generate project context for [target repo]" → assigns Tech Writer
4. Tech Writer runs skill → produces `project-context.md` in project root
5. Subsequent agents load this context automatically

**Run once:** For greenfield projects, run at setup. For brownfield, run as first CEO action.

### C2. Product Brief Creation (`bmad-create-product-brief`)

**What:** Wire product brief discovery skill for the PM agent.

**Agent:** PM (`bmad-pm`)  
**Skill source:** `bmad_res/bmm/workflows/1-analysis/bmad-create-product-brief/`

**Implementation:**
1. Add `WorkPhase.CREATE_PRODUCT_BRIEF` to dispatcher
2. Add tool: `src/tools/create-product-brief.ts`
3. CEO delegates "Create product brief for [feature/product]" → PM
4. PM runs discovery process → produces product brief document

### C3. Research Workflows (3 skills)

**What:** Wire brainstorming, market research, and technical research skills.

| Skill | Agent | Source |
|-------|-------|--------|
| `bmad-brainstorming` | PM / Analyst | `bmad_res/core/skills/bmad-brainstorming/` |
| `bmad-market-research` | PM / Analyst | `bmad_res/bmm/workflows/1-analysis/research/` |
| `bmad-technical-research` | Architect | `bmad_res/bmm/workflows/1-analysis/research/` |

**Implementation:**
1. Add `WorkPhase.RESEARCH_BRAINSTORM`, `.RESEARCH_MARKET`, `.RESEARCH_TECHNICAL`
2. Add tool: `src/tools/research.ts` (multi-type research tool with `type` parameter)
3. CEO delegates research subtasks with appropriate types
4. Agents produce research findings as issue comments + documents

### C4. PRD Creation + Validation (`bmad-create-prd`, `bmad-validate-prd`)

**What:** Wire the full PRD lifecycle — creation from product brief, validation against
BMAD standards, editing for revisions.

**Agent:** PM (`bmad-pm`)  
**Skill sources:**
- `bmad_res/core/tasks/bmad-create-prd/` — 12-step PRD creation workflow
- `bmad_res/bmm/workflows/2-plan-workflows/bmad-validate-prd/` — validation checklist

**Implementation:**
1. Add `WorkPhase.CREATE_PRD`, `WorkPhase.VALIDATE_PRD`
2. Add tools: `src/tools/create-prd.ts`, `src/tools/validate-prd.ts`
3. CEO delegates "Create PRD from product brief" → PM
4. PM creates PRD → CEO delegates "Validate PRD" → PM validates
5. On validation failure: CEO delegates "Edit PRD" with findings

### C5. Architecture Design (`bmad-create-architecture`)

**What:** Wire the architecture creation skill for the Architect agent.

**Agent:** Architect (`bmad-architect`)  
**Skill source:** `bmad_res/bmm/workflows/3-solutioning/bmad-create-architecture/`

**Implementation:**
1. Add `WorkPhase.CREATE_ARCHITECTURE`
2. Add tool: `src/tools/create-architecture.ts`
3. CEO delegates "Design architecture for [project]" → Architect
4. Architect reads PRD + technical research → produces `docs/architecture.md`

### C6. UX Design (`bmad-create-ux-design`)

**What:** Wire UX design creation for the UX Designer agent.

**Agent:** UX Designer (`bmad-ux-designer`)  
**Skill source:** `bmad_res/bmm/workflows/2-plan-workflows/bmad-create-ux-design/`

**Implementation:**
1. Add `WorkPhase.CREATE_UX_DESIGN`
2. Add tool: `src/tools/create-ux-design.ts`
3. CEO delegates "Plan UX design" → UX Designer (in parallel with architecture)

### C7. Implementation Readiness Check (`bmad-check-implementation-readiness`)

**What:** Quality gate before development starts — validates that PRD, architecture,
and UX specs are complete and consistent.

**Agent:** PM (`bmad-pm`)  
**Skill source:** `bmad_res/bmm/workflows/3-solutioning/bmad-check-implementation-readiness/`

**Implementation:**
1. Add `WorkPhase.CHECK_IMPLEMENTATION_READINESS`
2. Add tool: `src/tools/check-readiness.ts`
3. CEO delegates readiness check → PM evaluates all artifacts
4. On PASS: proceed to epics/stories. On FAIL: create remediation subtasks.

**Critical gate:** Nothing enters sprint planning without passing readiness check.

### C8. Epics & Stories Generation (`bmad-create-epics-and-stories`)

**What:** Break validated requirements (PRD + architecture) into epics and individual
user stories with acceptance criteria.

**Agent:** PM (`bmad-pm`)  
**Skill source:** `bmad_res/bmm/workflows/3-solutioning/bmad-create-epics-and-stories/`

**Implementation:**
1. Add `WorkPhase.CREATE_EPICS_AND_STORIES`
2. Add tool: `src/tools/create-epics-stories.ts`
3. PM reads PRD + architecture → generates epic breakdown → creates story files
4. Stories written to `_bmad-output/stories/` and sprint-status.yaml updated

### C9. E2E Test Generation (`bmad-qa-generate-e2e-tests`)

**What:** QA agent generates end-to-end tests from completed features.

**Agent:** QA (`bmad-qa`)  
**Skill source:** `bmad_res/bmm/workflows/bmad-qa-generate-e2e-tests/`

**Implementation:**
1. Add `WorkPhase.GENERATE_E2E_TESTS`
2. Add tool: `src/tools/generate-e2e-tests.ts`
3. After story passes code review → CEO delegates "Generate E2E tests" → QA
4. QA reads implementation + acceptance criteria → generates test files

### C10. Retrospective (`bmad-retrospective`)

**What:** Post-epic/post-sprint lessons learned and process improvement.

**Agent:** Scrum Master (`bmad-sm`)  
**Skill source:** `bmad_res/bmm/workflows/4-implementation/bmad-retrospective/`

**Implementation:**
1. Add `WorkPhase.RETROSPECTIVE`
2. Add tool: `src/tools/retrospective.ts`
3. When all stories in a sprint reach "done" → CEO delegates retrospective → SM
4. SM analyzes sprint data → produces learnings document

### C11. Course Correction (`bmad-correct-course`)

**What:** Mid-sprint course correction when requirements change or blockers appear.

**Agent:** SM / PM  
**Skill source:** `bmad_res/bmm/workflows/4-implementation/bmad-correct-course/`

**Implementation:**
1. Add `WorkPhase.CORRECT_COURSE`
2. Wire into stall-detector escalation path in `src/observability/stall-detector.ts`
3. When story is stalled > threshold → CEO delegates course correction
4. SM/PM evaluates situation → proposes plan adjustment

### C12. Update Role Mapping & Agent TOOLS.md

**What:** Expand `src/config/role-mapping.ts` with all new WorkPhases and skill assignments.
Update each agent's `TOOLS.md` with newly available skills.

**Files:**
- `src/config/role-mapping.ts` — add new phases to each role's `skills` array
- `agents/pm/TOOLS.md` — add: `bmad-create-product-brief`, `bmad-create-prd`,
  `bmad-validate-prd`, `bmad-create-epics-and-stories`, `bmad-check-implementation-readiness`
- `agents/architect/TOOLS.md` — add: `bmad-create-architecture`, `bmad-technical-research`
- `agents/qa/TOOLS.md` — add: `bmad-qa-generate-e2e-tests`
- `agents/analyst/TOOLS.md` — add: `bmad-brainstorming`, `bmad-market-research`,
  `bmad-domain-research`
- `agents/ux-designer/TOOLS.md` — add: `bmad-create-ux-design`
- `agents/scrum-master/TOOLS.md` — add: `bmad-retrospective`, `bmad-correct-course`
- `agents/tech-writer/TOOLS.md` — add: `bmad-generate-project-context`

---

## 6. Phase D — CEO Intelligence & Decision Engine (P1)

> **Goal:** Make the CEO agent intelligent about project type (greenfield vs brownfield),
> development phase, and delegation strategy. The CEO should not need hand-holding —
> it should evaluate context and choose the right workflow autonomously.
>
> **Effort:** 2–3 days  
> **Files touched:** `src/adapter/ceo-orchestrator.ts`, `agents/ceo/HEARTBEAT.md`,
> `agents/ceo/SOUL.md`

### D1. Project Type Detection (Greenfield vs Brownfield)

**What:** CEO evaluates whether the target project is greenfield (no existing code) or
brownfield (existing codebase) and chooses the appropriate workflow path.

**Logic:**
```
if (targetProjectRoot has code files) → BROWNFIELD
  → CEO delegates: "Generate project context" → Tech Writer
  → CEO delegates: "Establish PRD from existing code" → PM
  → CEO delegates: "Establish architecture from existing code" → Architect
  → Then normal sprint flow

else → GREENFIELD
  → CEO evaluates: does user issue have enough context for PRD?
    → YES: proceed to PRD creation
    → NO: delegate research (brainstorming + market + technical)
  → After research: PRD → Architecture → UX → Readiness → Epics → Sprint
```

**Implementation:**
1. Add `detectProjectType()` utility (checks for `package.json`, `src/`, `.git`, etc.)
2. Add to `ceo-orchestrator.ts` — project type detection before delegation plan
3. Update CEO HEARTBEAT.md with decision tree

### D2. Phase-Aware Delegation Strategy

**What:** CEO tracks which SDLC phase the project is in and delegates accordingly.

```
Phase tracking (per parent issue):
  DISCOVERY   → research subtasks active
  DEFINITION  → PRD + architecture + UX subtasks active
  PLANNING    → readiness check + epics/stories active
  EXECUTION   → dev + review subtasks active
  COMPLETION  → retrospective + E2E tests active
```

**Implementation:**
1. CEO reads sub-issue statuses to determine current phase
2. When all sub-issues in a phase are "done", CEO creates next phase's subtasks
3. Phase transitions are logged and reported via issue comments

### D3. Party Mode for Complex Decisions

**What:** When the CEO faces ambiguous or high-stakes decisions, invoke `bmad-party-mode`
for a multi-agent roundtable discussion.

**Skill source:** `bmad_res/core/skills/bmad-party-mode/workflow.md`

**When to trigger:**
- Architecture decisions with multiple viable approaches
- Conflicting research findings from PM + Architect
- Scope disputes (feature too large for one sprint)
- Risk assessment for novel technical approaches

**Implementation:**
1. Add party-mode detection heuristic in CEO orchestrator
2. When triggered: CEO creates a special "Discussion: [topic]" issue
3. Assigns multiple agents (PM, Architect, relevant specialist)
4. Each agent contributes perspective via comments
5. CEO synthesizes and makes final decision

### D4. PRD/Architecture Update Evaluation

**What:** When a new issue is added to an existing project, CEO evaluates whether
PRD and architecture documents need updating.

**Logic:**
```
on new_issue:
  if (issue.type === 'feature' || issue.type === 'change_request'):
    → CEO reads current PRD + architecture
    → CEO evaluates: does this issue require PRD/arch updates?
      → YES: delegate "Update PRD with [new feature]" → PM
             delegate "Update architecture for [new feature]" → Architect
      → NO: proceed to sprint planning directly
```

### D5. Advanced Elicitation Integration

**What:** Wire `bmad-advanced-elicitation` skill as a post-processing step.
After any agent produces output, the CEO can invoke elicitation to push for
higher quality.

**Skill source:** `bmad_res/core/skills/bmad-advanced-elicitation/`

**Implementation:**
- Add as optional post-processing in `agent-dispatcher.ts`
- CEO can flag issues with `elicitation: true` label
- Dispatcher wraps the agent's response through elicitation before reporting

---

## 7. Phase E — Session Continuity & Memory (P2)

> **Goal:** Agents maintain context across heartbeats. Multi-heartbeat tasks
> don't cold-start every time. Knowledge persists.
>
> **Effort:** 3–5 days  
> **Files touched:** `src/adapter/session-manager.ts`, `src/heartbeat-entrypoint.ts`,
> new file `src/adapter/session-state.ts`

### E1. Session Resume per (Agent, Issue)

**What:** Store Copilot SDK session IDs per (agentId, issueId) across heartbeats.
On next heartbeat for the same task: resume the session instead of cold-starting.

**Why:** Each heartbeat currently cold-starts, losing all conversation history.
Resuming sessions dramatically reduces token usage and improves continuity.

**Estimated savings:** ~50% token reduction for multi-heartbeat tasks.

**Implementation:**
```
SessionStateStore:
  - Interface: { get(agentId, issueId): SessionState | null, set(...): void }
  - Backend options:
    a. Local file: `_bmad-output/session-state/{agentId}/{issueId}.json`
    b. Paperclip runtime state API (when available)
  - Data: { sessionId, lastCommentId, lastStatus, checkpoints[] }

SessionManager changes:
  - Before creating new session: check store for existing sessionId
  - If found + valid: resume session
  - If stale: create new session, store new ID
  - After task completion: save session state
```

### E2. PARA Memory Skill Wiring

**What:** Wire `para-memory-files` skill so agents can store and recall facts,
daily notes, and knowledge across heartbeats.

**Skill source:** Paperclip repo `skills/para-memory-files/SKILL.md`

**Implementation:**
1. Verify `PAPERCLIP_SKILLS_DIR` loads `para-memory-files` (from Phase B4)
2. Create `$AGENT_HOME/life/` directory structure per agent
3. Update AGENTS.md files to reference correct `$AGENT_HOME` path
4. Test: agent saves a fact → next heartbeat → agent recalls the fact

**Memory structure per agent:**
```
_bmad-output/agent-memory/{agent-name}/
├── life/
│   ├── projects/    # active work items
│   ├── areas/       # ongoing responsibilities
│   ├── resources/   # reference material
│   └── archives/    # completed/inactive
├── memory/
│   └── YYYY-MM-DD.md  # daily timeline
└── MEMORY.md           # tacit knowledge
```

### E3. Runtime State Persistence

**What:** Use Paperclip's `agent_runtime_state` table (when available) or local files
for cross-heartbeat persistence.

**Data to persist:**
- Session IDs per task
- Last-seen comment IDs per issue (for incremental reads)
- Current project phase (for CEO)
- Budget tracking state
- Blocked-task dedup state

### E4. Incremental Comment Reading with Cursor

**What:** Combine B6 (incremental comment API) with session state to only read
new comments on each heartbeat.

```
On heartbeat:
  lastSeenId = sessionState.get(agentId, issueId).lastCommentId;
  newComments = await client.getIssueComments(issueId, { after: lastSeenId });
  // Process only new comments
  sessionState.set(agentId, issueId, { lastCommentId: newComments.at(-1)?.id });
```

---

## 8. Phase F — Test Architecture & QA Expansion (P2)

> **Goal:** Activate the TEA (Test Architecture Enterprise) module — 9 specialized
> test workflows backed by 42 knowledge base articles.
>
> **Effort:** 2–3 days  
> **Files touched:** `src/tools/`, `agents/qa/TOOLS.md`, `src/config/role-mapping.ts`

### F1. Test Architecture Skill Activation

**What:** Wire the 9 TEA workflows as QA agent capabilities.

| Skill | Purpose | Priority |
|-------|---------|----------|
| `bmad-testarch-atdd` | Generate failing acceptance tests (TDD-first) | HIGH |
| `bmad-testarch-automate` | Expand test automation coverage | HIGH |
| `bmad-testarch-framework` | Initialize test framework (Playwright/Cypress) | HIGH |
| `bmad-testarch-test-design` | Create system/epic-level test plans | MEDIUM |
| `bmad-testarch-test-review` | Review test quality with best practices | MEDIUM |
| `bmad-testarch-ci` | Scaffold CI/CD quality pipeline | MEDIUM |
| `bmad-testarch-nfr` | Assess NFRs (performance, security, reliability) | MEDIUM |
| `bmad-testarch-trace` | Generate traceability matrix (requirements → tests) | LOW |
| `bmad-teach-me-testing` | Interactive testing education | LOW |

**Skill source:** `bmad_res/tea/workflows/testarch/`  
**Knowledge base:** `bmad_res/tea/testarch/knowledge/` (42 articles on fixtures, API patterns,
CI, Pact, Playwright, mocking, etc.)

**Implementation:**
1. Add 9 new `WorkPhase.TESTARCH_*` entries
2. Add tool: `src/tools/test-architecture.ts` (multi-type tool with `workflow` parameter)
3. Update QA role mapping with all TEA skills
4. CEO can delegate: "Set up test framework" → QA → runs `bmad-testarch-framework`

### F2. Document Quality Skills

**What:** Wire editorial review skills for the Tech Writer agent.

| Skill | Purpose |
|-------|---------|
| `bmad-editorial-review-prose` | Clinical copy-editing for prose quality |
| `bmad-editorial-review-structure` | Structural editing for document organization |
| `bmad-distillator` | Lossless LLM-optimized document compression |
| `bmad-shard-doc` | Split large markdown into organized files |

**Implementation:**
1. Add work phases for document quality workflows
2. Add to Tech Writer role mapping
3. CEO can delegate: "Review and polish architecture doc" → Tech Writer

---

## 9. Cross-Cutting Concerns

### 9.1 Issue Documents API (supports Phases C + D)

**What:** Add issue document CRUD to PaperclipClient.

```
PaperclipClient additions:
  + getIssueDocuments(issueId: string): Promise<IssueDocument[]>
  + getIssueDocument(issueId: string, key: string): Promise<IssueDocument>
  + upsertIssueDocument(issueId: string, key: string, body: { content: string, format?: string }): Promise<IssueDocument>

Usage:
  - CEO stores delegation plans as issue documents (key: "plan")
  - PM stores PRD drafts on the PRD issue (key: "prd")
  - Architect stores arch docs on the architecture issue (key: "architecture")
```

### 9.2 Comment Style Compliance

**What:** Format all issue comments per Paperclip spec.

```
Required format:
  - Ticket references as links: [PAP-123](/PAP/issues/PAP-123)
  - Status line + bullets
  - Company-prefixed internal links

Implementation:
  - Update PaperclipReporter.formatComment() to apply formatting rules
  - Add issueId-to-link resolver utility
```

### 9.3 Goal Propagation

**What:** Ensure `goalId` propagates consistently from parent issues to all sub-issues.

**Where:** `src/adapter/ceo-orchestrator.ts` — issue creation

```typescript
// When creating sub-issues, always inherit goalId from parent:
const subIssue = await client.createIssue({
  ...task,
  goalId: parentIssue.goalId,  // Always propagate
  // parentId set via follow-up updateIssue (execution lock workaround)
});
```

### 9.4 Project + Workspace Model (optional, enables Phases C+D)

**What:** Create a Paperclip project with workspace for the target repo.

```
Setup script additions:
  1. POST /api/companies/{companyId}/projects → create project
  2. POST /api/projects/{id}/workspaces → attach target repo
  3. Set projectId on all created issues

Benefits:
  - Agents resolve cwd from project workspace
  - Project-scoped budgets
  - Project-level issue filtering
```

### 9.5 Test Coverage for New Features

Each phase requires corresponding tests:

| Phase | New Test Files | Estimated Tests |
|-------|---------------|----------------|
| A | `test/checkout-release.test.ts`, `test/wake-context.test.ts` | ~25 |
| B | `test/heartbeat-context.test.ts`, `test/budget-behavior.test.ts` | ~15 |
| C | `test/sdlc-tools.test.ts` (multi-tool integration) | ~30 |
| D | `test/ceo-decision-engine.test.ts` | ~20 |
| E | `test/session-state.test.ts`, `test/para-memory.test.ts` | ~15 |
| F | `test/test-architecture.test.ts` | ~10 |
| **Total** | **6 new test files** | **~115 new tests** |

---

## 10. Verification Strategy

### E2E Smoke Test: Full SDLC Pipeline

After Phases A–D are complete, run a full end-to-end test:

```
1. Create Paperclip issue: "Build a REST API for a bookstore"
2. Verify CEO wakes → detects greenfield → delegates:
   a. "Generate project context" → Tech Writer
   b. "Research: brainstorm approaches" → PM
   c. "Research: market analysis" → Analyst
   d. "Research: technical feasibility" → Architect
3. Verify research completes → CEO delegates:
   a. "Create PRD" → PM
   b. "Create architecture" → Architect
   c. "Create UX design" → UX Designer
4. Verify PRD + arch complete → CEO delegates:
   a. "Check implementation readiness" → PM
5. Verify readiness passes → CEO delegates:
   a. "Create epics and stories" → PM
6. Verify stories created → Sprint planning → Dev → QA → Done
7. Verify retrospective runs after sprint completes
```

### Integration Level 3 Checklist

| Criterion | Verification |
|-----------|-------------|
| ✅ Checkout before every task | Observe `POST /api/issues/{id}/checkout` in logs |
| ✅ Release on error | Simulate error → verify release called |
| ✅ Wake context routing | Set `PAPERCLIP_TASK_ID` → verify task prioritized |
| ✅ Heartbeat-context used | Verify single API call instead of issue+comments |
| ✅ Atomic status+comment | Verify single PATCH with both fields |
| ✅ Budget-aware behavior | Set budget to 80% → verify conservative mode |
| ✅ 25+ skills active | Count invoked skills across full pipeline |
| ✅ Session resume | Same task across 2 heartbeats → verify session reused |
| ✅ Full SDLC autonomy | Issue → PRD → arch → stories → code → review → done |

---

## 11. Dependency Graph

```
Phase A (Protocol Compliance)
  │
  ├── A1 (checkout/release)       ← standalone
  ├── A2 (wire checkout)          ← depends on A1
  ├── A3 (wake context vars)      ← standalone
  ├── A4 (wake routing)           ← depends on A3
  ├── A5 (run ID fix)             ← standalone
  ├── A6 (always send run ID)     ← standalone
  └── A7 (blocked dedup)          ← depends on B6
  │
Phase B (Context Efficiency)
  │
  ├── B1 (heartbeat-context)      ← standalone
  ├── B2 (use heartbeat-context)  ← depends on B1
  ├── B3 (atomic status+comment)  ← standalone
  ├── B4 (Paperclip skills)       ← standalone
  ├── B5 (budget-aware)           ← standalone
  └── B6 (incremental comments)   ← standalone
  │
Phase C (Full SDLC)              ← depends on A (checkout must work)
  │                                can start in parallel with B
  ├── C1 (project context)        ← standalone (first to run)
  ├── C2 (product brief)          ← standalone
  ├── C3 (research x3)            ← standalone
  ├── C4 (PRD creation)           ← depends on C2 being available
  ├── C5 (architecture)           ← depends on C4 being available
  ├── C6 (UX design)              ← standalone
  ├── C7 (readiness check)        ← depends on C4 + C5
  ├── C8 (epics & stories)        ← depends on C7
  ├── C9 (E2E tests)              ← standalone
  ├── C10 (retrospective)         ← standalone
  ├── C11 (course correction)     ← standalone
  └── C12 (role mapping update)   ← after all C items defined
  │
Phase D (CEO Intelligence)        ← depends on C (skills must exist to delegate to)
  │
  ├── D1 (greenfield/brownfield)  ← standalone
  ├── D2 (phase-aware delegation) ← depends on C (phases to track)
  ├── D3 (party mode)             ← standalone
  ├── D4 (PRD/arch update eval)   ← depends on C4 + C5
  └── D5 (advanced elicitation)   ← standalone
  │
Phase E (Session & Memory)        ← can start after A+B
  │
  ├── E1 (session resume)         ← standalone
  ├── E2 (PARA memory)            ← depends on B4 (skills loaded)
  ├── E3 (runtime state)          ← standalone
  └── E4 (incremental comments)   ← depends on B6 + E3
  │
Phase F (Test Architecture)       ← can start after C
  │
  ├── F1 (TEA skills)             ← depends on C12 (role mapping)
  └── F2 (doc quality skills)     ← standalone
```

### Recommended Execution Order

```
Week 1:  A1 → A2 → A3 → A4 → A5 → A6   (Protocol compliance — all P0)
         B1 → B2 → B3 → B4              (Context efficiency — parallel track)

Week 2:  C1 → C2 → C3 → C4 → C5 → C6   (SDLC tools — new skills)
         B5 → B6 → A7                    (Remaining B items)

Week 3:  C7 → C8 → C9 → C10 → C11 → C12 (SDLC tools — complete)
         D1 → D2 → D3 → D4 → D5          (CEO intelligence)

Week 4:  E1 → E2 → E3 → E4              (Session continuity)
         F1 → F2                          (Test architecture)
         E2E smoke test                   (Verification)
```

---

## 12. Effort Summary

| Phase | Tasks | New Files | Modified Files | New Tests | Days |
|-------|-------|-----------|---------------|-----------|------|
| **A** Protocol Compliance | 7 | 0 | 2 | ~25 | 2 |
| **B** Context Efficiency | 6 | 0 | 3 | ~15 | 2 |
| **C** Full SDLC Pipeline | 12 | 10 tools | 4 | ~30 | 3–4 |
| **D** CEO Intelligence | 5 | 1 | 3 | ~20 | 2–3 |
| **E** Session & Memory | 4 | 2 | 2 | ~15 | 3–5 |
| **F** Test Architecture | 2 | 2 | 2 | ~10 | 2–3 |
| **Total** | **36** | **~15** | **~10** | **~115** | **14–19** |

### Milestone Targets

| Milestone | After Phase | What's Unlocked |
|-----------|-------------|-----------------|
| **M1: Safe Concurrency** | A complete | Agents can safely work in parallel without conflicts |
| **M2: Efficient Heartbeats** | B complete | 30% fewer API calls, richer agent context |
| **M3: Full SDLC Autonomy** | C+D complete | Issue → PRD → Arch → Stories → Code → Review → Done |
| **M4: Continuous Intelligence** | E complete | Agents remember across heartbeats, 50% token savings |
| **M5: Quality Automation** | F complete | Full test architecture, E2E generation, traceability |

### Integration Level Progression

```
Current:   Level 2 (Status Reporting)     — 30% BMAD skills active
After A+B: Level 2.5 (Protocol Compliant) — 30% skills, safe concurrency
After C+D: Level 3 (Fully Autonomous)     — 70% skills, full SDLC
After E+F: Level 3+ (Self-Improving)      — 85% skills, memory, learning
```

---

## Appendix: Skills Activation Summary

### Currently Active (Phase 0–7)

| # | Skill | Agent | Status |
|---|-------|-------|--------|
| 1 | `bmad-dev-story` | Developer | ✅ |
| 2 | `bmad-quick-dev` | Developer | ✅ |
| 3 | `bmad-quick-spec` | Developer | ✅ |
| 4 | `bmad-code-review` | QA | ✅ |
| 5 | `bmad-review-adversarial-general` | QA | ✅ |
| 6 | `bmad-review-edge-case-hunter` | QA | ✅ |
| 7 | `bmad-create-story` | PM | ✅ |
| 8 | `bmad-sprint-status` | SM | ✅ |
| 9 | `bmad-sprint-planning` | SM | ✅ (partial) |

### Activated by This Plan

| # | Skill | Agent | Phase |
|---|-------|-------|-------|
| 10 | `bmad-generate-project-context` | Tech Writer | C1 |
| 11 | `bmad-create-product-brief` | PM | C2 |
| 12 | `bmad-brainstorming` | PM / Analyst | C3 |
| 13 | `bmad-market-research` | PM / Analyst | C3 |
| 14 | `bmad-technical-research` | Architect | C3 |
| 15 | `bmad-create-prd` | PM | C4 |
| 16 | `bmad-validate-prd` | PM | C4 |
| 17 | `bmad-create-architecture` | Architect | C5 |
| 18 | `bmad-create-ux-design` | UX Designer | C6 |
| 19 | `bmad-check-implementation-readiness` | PM | C7 |
| 20 | `bmad-create-epics-and-stories` | PM | C8 |
| 21 | `bmad-qa-generate-e2e-tests` | QA | C9 |
| 22 | `bmad-retrospective` | SM | C10 |
| 23 | `bmad-correct-course` | SM / PM | C11 |
| 24 | `bmad-party-mode` | CEO (multi) | D3 |
| 25 | `bmad-advanced-elicitation` | Any | D5 |
| 26 | `bmad-document-project` | Tech Writer | C1 (brownfield) |
| 27 | `bmad-editorial-review-prose` | Tech Writer | F2 |
| 28 | `bmad-editorial-review-structure` | Tech Writer | F2 |
| 29 | `bmad-distillator` | Any | F2 |
| 30 | `bmad-testarch-atdd` | QA | F1 |
| 31 | `bmad-testarch-automate` | QA | F1 |
| 32 | `bmad-testarch-framework` | QA | F1 |
| 33 | `bmad-testarch-test-design` | QA | F1 |
| 34 | `bmad-testarch-test-review` | QA | F1 |
| 35 | `bmad-testarch-ci` | QA | F1 |
| 36 | `bmad-testarch-nfr` | QA | F1 |
| 37 | `bmad-testarch-trace` | QA | F1 |

**Total after plan: 37 of 56 skills active (66%)**

### Remaining (post-plan, low priority)

| Skill | Reason Deferred |
|-------|----------------|
| `bmad-edit-prd` | Covered by PRD creation + validation loop |
| `bmad-product-brief-preview` | Superseded by `bmad-create-product-brief` |
| `bmad-quick-dev-new-preview` | Preview/experimental |
| `bmad-quick-flow-solo-dev` | Interactive-only mode |
| `bmad-shard-doc` | Niche utility |
| `bmad-index-docs` | Niche utility |
| `bmad-help` | Interactive-only |
| `bmad-teach-me-testing` | Educational, not automated |
| `bmad-agent-builder` | Meta — self-improvement (Phase 2+) |
| `bmad-workflow-builder` | Meta — self-improvement (Phase 2+) |
| 9 agent-launcher skills | Interactive VS Code only, not heartbeat |
| `bmad-domain-research` | Overlaps with `bmad-technical-research` + `bmad-market-research` |

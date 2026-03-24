# BMAD Copilot Factory — Revised Target Workflow

> Updated: 2026-03-24
> Status: Design approved — implementation plan at [docs/implementation-plan.md](./implementation-plan.md)
> 
> **Design Decisions (finalized):**
> - D1: All agents have `tasks:assign` permission (Paperclip grants this by default via `applyDefaultAgentTaskAssignGrant`)
> - D2: `sprint-status.yaml` eliminated — story lifecycle tracked exclusively in Paperclip issues
> - D3: `epics.md` kept as workspace reference artifact (not lifecycle state)
> - D4: Incremental milestones (M0→M1→M2→M3→M4)

---

## Table of Contents

1. [Design Principles](#1-design-principles)
2. [Revised E2E Workflow](#2-revised-e2e-workflow)
3. [Phase-by-Phase Detail](#3-phase-by-phase-detail)
4. [CEO Autonomy & Escalation Model](#4-ceo-autonomy--escalation-model)
5. [Sequential Story Execution Model](#5-sequential-story-execution-model)
6. [Epic Retrospective & Organizational Learning](#6-epic-retrospective--organizational-learning)
7. [Implementation Changes Required](#7-implementation-changes-required)

---

## 1. Design Principles

| # | Principle | Rationale |
|---|-----------|-----------|
| **P1** | **CEO decides autonomously** — only escalates to the board for critical/irreversible decisions | Minimizes human-in-the-loop bottlenecks. The CEO has strategic judgment (SOUL.md: "default to action"). |
| **P2** | **Planning before execution, detail at execution time** | Sprint planning creates the *what* (epics, stories, sprint plan). Story-level implementation detail is created just-in-time, because it depends on what was implemented in prior stories. |
| **P3** | **Stories are executed sequentially** | Each story's implementation plan depends on the actual code produced by the previous story. No premature parallelism at the story level. |
| **P4** | **One owner at a time, full lifecycle** | A story is assigned to SM (create detailed plan) → Dev (implement until done) → QA (review/fix loop). Ticket assignment changes as ownership transfers. |
| **P5** | **E2E test decision after every story** | Not every story warrants E2E tests. The QA agent evaluates after each story whether E2E tests should be added based on what was built. |
| **P6** | **Learning is structural** | After each epic completes, the CEO runs a retrospective, stores lessons in PARA memory, and applies them to the next epic's delegation. |

---

## 2. Revised E2E Workflow

```
Human creates issue in Paperclip: "Build X"
Assigns to: CEO
  │
  ▼
╔══════════════════════════════════════════════════════════════════╗
║                    PHASE 1: RESEARCH                             ║
║  CEO delegates to analyst + PM (parallel where independent)      ║
║  Artifacts: research-findings.md, market-analysis.md             ║
║  CEO reviews outputs, makes strategic calls autonomously         ║
╚══════════════════════════════════════════════════════════════════╝
  │ CEO re-eval: research done → promote define
  ▼
╔══════════════════════════════════════════════════════════════════╗
║                    PHASE 2: DEFINE                               ║
║  CEO delegates to PM (PRD), Architect (arch), UX (design)        ║
║  Artifacts: prd.md, architecture.md, ux-design.md                ║
║  CEO reviews, resolves conflicts between artifacts               ║
╚══════════════════════════════════════════════════════════════════╝
  │ CEO re-eval: define done → promote plan
  ▼
╔══════════════════════════════════════════════════════════════════╗
║                    PHASE 3: PLAN                                 ║
║  CEO delegates to SM: "Create sprint plan"                       ║
║  SM produces:                                                    ║
║    • epics.md (workspace artifact)                               ║
║    • sprint-status.yaml (workspace artifact)                     ║
║    • Paperclip issues: one per epic, one per story               ║
║      (stories in backlog, linked to parent planning issue)       ║
║  CEO reviews plan, may request adjustments                       ║
╚══════════════════════════════════════════════════════════════════╝
  │ CEO re-eval: plan done → promote execute (story-by-story)
  ▼
╔══════════════════════════════════════════════════════════════════╗
║              PHASE 4: EXECUTE (per story, sequential)            ║
║                                                                  ║
║  For each story in sprint order:                                 ║
║                                                                  ║
║  ┌────────────────────────────────────────────────────────┐      ║
║  │  4a. STORY DETAIL (SM)                                  │      ║
║  │  • SM runs create-story skill                           │      ║
║  │  • Reads prior implementation, PRD, architecture        │      ║
║  │  • Produces detailed story file with:                   │      ║
║  │    - Acceptance criteria, tasks/subtasks, dev notes      │      ║
║  │    - References to existing code from prior stories     │      ║
║  │  • Story file saved to workspace                        │      ║
║  │  • Paperclip issue updated with story file reference    │      ║
║  │  • Issue reassigned to bmad-dev                         │      ║
║  └────────────────────────────────────┬───────────────────┘      ║
║                                       ▼                          ║
║  ┌────────────────────────────────────────────────────────┐      ║
║  │  4b. IMPLEMENT (Dev)                                    │      ║
║  │  • Dev reads story file, implements TDD                 │      ║
║  │  • All tasks/subtasks completed, tests passing          │      ║
║  │  • Code committed to workspace                          │      ║
║  │  • Issue reassigned to bmad-qa                          │      ║
║  └────────────────────────────────────┬───────────────────┘      ║
║                                       ▼                          ║
║  ┌────────────────────────────────────────────────────────┐      ║
║  │  4c. REVIEW LOOP (QA ↔ Dev)                             │      ║
║  │  • QA: adversarial code review (ReviewOrchestrator)     │      ║
║  │  • Gate: PASS → done | FAIL → fix by Dev → re-review   │      ║
║  │  • Max 3 passes → escalate to CEO (not board)           │      ║
║  └────────────────────────────────────┬───────────────────┘      ║
║                                       ▼                          ║
║  ┌────────────────────────────────────────────────────────┐      ║
║  │  4d. E2E TEST DECISION (QA)                             │      ║
║  │  • QA evaluates: does this story warrant E2E tests?     │      ║
║  │  • Decision based on: API endpoints added, user flows   │      ║
║  │    changed, integration points touched                  │      ║
║  │  • If yes: generate E2E tests, commit to workspace      │      ║
║  │  • If no: document reasoning, move on                   │      ║
║  └────────────────────────────────────┬───────────────────┘      ║
║                                       ▼                          ║
║  Story DONE → CEO promotes next story → repeat 4a-4d            ║
║                                                                  ║
╚══════════════════════════════════════════════════════════════════╝
  │ All stories in epic done
  ▼
╔══════════════════════════════════════════════════════════════════╗
║              PHASE 5: EPIC RETROSPECTIVE                         ║
║  CEO triggers SM retrospective (bmad-retrospective skill)        ║
║  Inputs: all story files, code diffs, review histories           ║
║  Outputs:                                                        ║
║    • Retrospective report (workspace artifact)                   ║
║    • CEO extracts learnings → PARA memory                        ║
║    • Learnings inform next epic's delegation strategy             ║
╚══════════════════════════════════════════════════════════════════╝
  │ More epics remaining?
  │  Yes → CEO promotes next epic's first story → Phase 4
  │  No  → Phase 6
  ▼
╔══════════════════════════════════════════════════════════════════╗
║              PHASE 6: FINALIZATION                               ║
║  CEO delegates documentation (tech-writer)                       ║
║  CEO runs final readiness check                                  ║
║  Parent issue: DONE ✅                                           ║
╚══════════════════════════════════════════════════════════════════╝
```

---

## 3. Phase-by-Phase Detail

### Phase 1: Research

| Aspect | Detail |
|--------|--------|
| **CEO action** | Creates 1-2 sub-issues: domain research (analyst), market/technical research (PM or architect) |
| **Parallelism** | Research tasks can run in parallel (no dependencies between them) |
| **Artifacts** | `research-findings.md`, `market-analysis.md`, `technical-feasibility.md` |
| **CEO review** | Reads outputs. If research reveals the issue is infeasible or unclear, CEO narrows scope autonomously. Only escalates to board if the issue fundamentally changes (e.g., "this requires a completely different product direction") |
| **Gate** | CEO satisfied that enough context exists for the Define phase |

### Phase 2: Define

| Aspect | Detail |
|--------|--------|
| **CEO action** | Creates 2-3 sub-issues: PRD (PM), Architecture (Architect), UX Design (UX Designer) |
| **Dependencies** | PRD depends on research. Architecture depends on research + PRD. UX depends on PRD. |
| **Artifacts** | `prd.md`, `architecture.md`, `ux-design.md` |
| **CEO review** | Checks alignment between PRD, architecture, and UX. If PM wants Feature X but Architect says it's not feasible, CEO decides — without involving the board. |
| **Gate** | All three artifacts consistent and complete |

### Phase 3: Plan

| Aspect | Detail |
|--------|--------|
| **CEO action** | Creates 1 sub-issue: Sprint Planning (SM) |
| **SM responsibilities** | 1. Read PRD, architecture, UX artifacts from workspace. 2. Run `bmad-sprint-planning` skill → produce `epics.md` and `sprint-status.yaml` in workspace. 3. **Create Paperclip issues**: one per epic (as grouping issue), one per story (as child of epic). Stories start in `backlog` status. |
| **Key difference from current** | SM produces **both** workspace artifacts (for BMAD skill consumption) **and** Paperclip issues (for orchestration). The sprint-status.yaml is the BMAD-native artifact; Paperclip issues are the orchestration-native tracking. |
| **Artifacts** | `epics.md`, `sprint-status.yaml`, Paperclip issues (one per story) |
| **CEO review** | Reviews the plan structure. May ask SM to reorder, split, or merge stories. |
| **No implementation detail yet** | Story Paperclip issues at this point have only a title and high-level description from the epics file. The detailed implementation plan (tasks, subtasks, developer notes) is created just-in-time in Phase 4a. |

### Phase 4: Execute (Sequential Story Loop)

This is the core innovation. Instead of creating all dev/review tasks upfront, the CEO promotes **one story at a time** through a 4-step sub-lifecycle:

#### 4a. Story Detail Creation (SM)

| Aspect | Detail |
|--------|--------|
| **Trigger** | CEO promotes the story's Paperclip issue to `todo`, assigned to SM |
| **SM action** | Runs `bmad-create-story` skill. This is the heavyweight step: SM reads ALL workspace artifacts (PRD, architecture, UX, **previously implemented code**) and produces a comprehensive story file with tasks, subtasks, acceptance criteria, developer notes, file locations, and warnings about prior implementation patterns. |
| **Why just-in-time** | The detailed plan for Story 3 depends on how Stories 1-2 were actually implemented. File paths, patterns, abstractions — these are only known after prior stories complete. |
| **Output** | Story file written to workspace. Paperclip issue description updated with a reference. Issue reassigned to `bmad-dev`. |

#### 4b. Implementation (Dev)

| Aspect | Detail |
|--------|--------|
| **Trigger** | Issue assigned to Dev (from SM's reassignment) |
| **Dev action** | Reads story file, implements all tasks/subtasks with TDD. Marks each task `[x]` as completed. All tests must pass before proceeding. |
| **Output** | Code in workspace, test files, updated story file with dev notes. Issue reassigned to `bmad-qa`. |

#### 4c. Review Loop (QA ↔ Dev)

| Aspect | Detail |
|--------|--------|
| **Trigger** | Issue assigned to QA (from Dev's reassignment) |
| **QA action** | Full `ReviewOrchestrator` adversarial loop (not single-pass): review → gate → pass/fail/escalate |
| **On FAIL** | QA posts findings. Issue reassigned back to Dev for fixes. Dev fixes, reassigns back to QA. This is the existing multi-pass loop, now operating on Paperclip issue assignment rather than local YAML. |
| **On PASS** | Story marked done. CEO re-evaluates. |
| **On ESCALATE** | After 3 passes, escalate to **CEO first** (not board). CEO reads review history, decides: force-approve with known issues, reassign to a different dev, or — only if truly stuck — escalate to board. |

#### 4d. E2E Test Decision (QA)

| Aspect | Detail |
|--------|--------|
| **Trigger** | Immediately after review passes (same QA heartbeat or follow-up) |
| **QA evaluates** | Does this story's implementation warrant E2E tests? Consider: new API endpoints, new user flows, integration points, critical business logic. |
| **If yes** | QA generates E2E tests using `bmad-qa-generate-e2e-tests` skill. Tests committed to workspace. |
| **If no** | QA posts a brief justification comment (e.g., "Pure refactoring story — no new user-facing behavior. E2E tests not needed.") |

### Phase 5: Epic Retrospective

| Aspect | Detail |
|--------|--------|
| **Trigger** | All stories in an epic reach `done`. CEO detects this during re-evaluation. |
| **CEO action** | Creates a sub-issue assigned to SM: "Run retrospective for Epic N" |
| **SM action** | Runs `bmad-retrospective` skill. Analyzes: what worked, what didn't, quality metrics, code review findings patterns, E2E coverage. Produces `epic-N-retrospective.md`. |
| **CEO learning** | CEO reads retro report, extracts durable facts to PARA memory (`$AGENT_HOME/life/learnings/`). Examples: "Team struggles with database schema changes — require Architect review for all schema stories", "E2E tests caught 3 regressions — increase E2E coverage threshold". |
| **Application** | CEO references past learnings in future delegation prompts. PARA memory is loaded into CEO system message on each heartbeat. |

### Phase 6: Finalization

| Aspect | Detail |
|--------|--------|
| **Trigger** | All epics complete and retros done |
| **CEO action** | Delegates documentation (tech-writer), final readiness check (PM). Closes parent issue. |

---

## 4. CEO Autonomy & Escalation Model

### Decision Authority Matrix

| Decision Type | CEO Authority | Board Escalation |
|---------------|--------------|-----------------|
| Research scope narrowing | ✅ Autonomous | — |
| Conflict between PM and Architect | ✅ CEO decides | — |
| Story reordering or splitting | ✅ Autonomous | — |
| Skip a story (deemed unnecessary) | ✅ Autonomous | — |
| Agent reassignment (stuck agent) | ✅ Autonomous | — |
| Code review escalation (3 passes) | ✅ CEO tries resolution first | Only if CEO can't resolve |
| Change product direction | ❌ | ✅ Board must approve |
| Budget > 80% spent | ⚠️ CEO switches to critical-only mode | ✅ If no critical work remains |
| Irreversible infrastructure decisions | ❌ | ✅ Board approval required |
| New agent hiring | ✅ For known roles | ✅ For novel roles |
| Scope increase > 50% of original | ❌ | ✅ Board must approve |

### Implementation Approach

Since Paperclip doesn't have a formal approval API yet, the CEO uses **issue comments + status** as the escalation mechanism:

```
CEO autonomous decision:
  → CEO posts decision comment on parent issue
  → CEO proceeds immediately

CEO escalation to board:
  → CEO posts detailed rationale + options on parent issue
  → CEO sets issue status to "blocked"
  → CEO adds label: "needs-board-decision"
  → Human resolves, comments decision, unblocks
  → CEO re-evaluates on next heartbeat
```

---

## 5. Sequential Story Execution Model

### Why Sequential?

The `bmad-create-story` skill (workflow.md) is designed around this principle:

> *"Your purpose is NOT to copy from epics — it's to create a comprehensive, optimized story file that gives the DEV agent EVERYTHING needed for flawless implementation."*
>
> *"COMMON LLM MISTAKES TO PREVENT: reinventing wheels, wrong libraries, wrong file locations, breaking regressions"*

This only works if the SM can read the actual codebase produced by prior stories. Story 3 needs to know:
- What file structure Story 1 and 2 established
- What abstractions and patterns they introduced
- What test infrastructure exists
- What imports and dependencies are already configured

### Execution Sequence Diagram

```
Epic 1: Stories [S1, S2, S3]

 S1                     S2                     S3
 ┌──┐ ┌──┐ ┌──┐ ┌──┐   ┌──┐ ┌──┐ ┌──┐ ┌──┐   ┌──┐ ┌──┐ ┌──┐ ┌──┐
 │SM│→│Dv│→│QA│→│E2│   │SM│→│Dv│→│QA│→│E2│   │SM│→│Dv│→│QA│→│E2│
 └──┘ └──┘ └──┘ └──┘   └──┘ └──┘ └──┘ └──┘   └──┘ └──┘ └──┘ └──┘
  │                      ▲ │                    ▲
  │                      │ │                    │
  └── creates story ─────┘ └── creates story ───┘
       with knowledge           with knowledge
       of S1's code             of S1+S2's code

                         ┌─────────────────┐
                         │  EPIC RETRO      │
                         │  CEO extracts    │
                         │  learnings       │
                         └─────────────────┘
```

### Paperclip Issue State Machine (per story)

```
backlog (created by SM in Phase 3)
  │
  │ CEO promotes to todo, assigns to SM
  ▼
todo → SM creates detailed story file
  │
  │ SM reassigns to Dev
  ▼
in_progress → Dev implements (checkout locked)
  │
  │ Dev reassigns to QA
  ▼
in_review → QA reviews (ReviewOrchestrator)
  │         ↕ (fix loop: QA → Dev → QA)
  │
  │ QA approves
  ▼
done → CEO re-eval → promotes next story
```

---

## 6. Epic Retrospective & Organizational Learning

### Retrospective Trigger

The CEO detects epic completion during re-evaluation:

```typescript
// Pseudo-code for the detection logic
const epicStories = children.filter(c => isStoryIssue(c) && sameEpic(c, epicN));
const allStoriesDone = epicStories.every(c => c.status === "done");
const retroNotYetRun = !children.some(c => isRetroIssue(c, epicN));

if (allStoriesDone && retroNotYetRun) {
  // Create retrospective sub-issue assigned to SM
  createIssue({
    title: `Epic ${epicN} Retrospective`,
    assignTo: "bmad-sm",
    phase: "review",
    metadata: { epicNumber: epicN, isRetrospective: true }
  });
}
```

### Memory Integration

The `bmad-retrospective` skill already produces comprehensive retrospective reports. The CEO needs to:

1. **Read** the retro report after SM completes it
2. **Extract** durable facts using `para-memory-files` skill
3. **Store** in `$AGENT_HOME/life/learnings/`:
   - `epic-{N}-learnings.md` — raw learnings from this epic
   - Update `$AGENT_HOME/life/team-patterns.md` — cross-cutting team patterns
4. **Reference** in future delegation prompts:
   ```
   ## Learnings from Previous Epics
   
   From my memory: [loaded from PARA at heartbeat init]
   - "Database schema changes require Architect review" (Epic 2)
   - "E2E tests for auth flows prevented 3 regressions" (Epic 1)
   - "Dev agent works better with explicit file path references" (Epic 1)
   
   Apply these learnings to the current delegation plan.
   ```

### Continuous Improvement Loop

```
Epic 1 → Retro → Learnings stored
  │
  ▼
Epic 2 delegation informed by Epic 1 learnings
  │
  Epic 2 → Retro → More learnings stored
  │
  ▼
Epic 3 delegation informed by Epic 1+2 learnings
  ...
```

This creates a compounding quality effect: each epic gets better delegation, better story detail, and fewer repeated mistakes.

---

## 7. Implementation Changes Required

### Prioritized Change List

| Priority | Change | Files Affected | Effort |
|----------|--------|---------------|--------|
| **P0** | **SM creates Paperclip issues during sprint planning** | `src/tools/create-story.ts`, new tool `create-paperclip-stories.ts` | Medium |
| **P0** | **Wire ReviewOrchestrator into heartbeat handler** | `src/heartbeat-entrypoint.ts`, `src/adapter/heartbeat-handler.ts` | Medium |
| **P0** | **Sequential story promotion in CEO re-evaluation** | `src/adapter/ceo-orchestrator.ts` | Medium |
| **P1** | **Issue reassignment flow (SM → Dev → QA)** | `src/adapter/reporter.ts`, new reassignment logic | Medium |
| **P1** | **CEO autonomous decision-making (reduced board escalation)** | `src/adapter/ceo-orchestrator.ts`, CEO delegation prompt | Low |
| **P1** | **E2E test decision step after review passes** | `src/quality-gates/review-orchestrator.ts` | Medium |
| **P2** | **Epic retro detection in CEO re-evaluation** | `src/adapter/ceo-orchestrator.ts` | Low |
| **P2** | **PARA memory loading in heartbeat-entrypoint** | `src/heartbeat-entrypoint.ts` | Medium |
| **P2** | **CEO delegation prompt includes past learnings** | `src/adapter/ceo-orchestrator.ts` | Low |
| **P3** | **Git integration (branch per story, PRs)** | New module `src/adapter/git-integration.ts` | High |

### Detailed Change Descriptions

#### P0-1: SM Creates Paperclip Issues

The `bmad-sprint-planning` skill currently only writes workspace artifacts. Add a Copilot SDK tool `create_paperclip_story` that:
1. Creates a Paperclip issue for each story (title, high-level description from epics)
2. Links it to the parent planning issue via `parentId`
3. Sets status to `backlog`
4. Stores the story's epic number and sequence number in `metadata`

The SM agent's prompt for the planning phase would instruct it to: first produce workspace artifacts (epics.md, sprint-status.yaml), then call `create_paperclip_story` for each story.

#### P0-2: ReviewOrchestrator in Heartbeat Path

Currently, when the heartbeat handler dispatches a `code-review` phase, it goes through the `AgentDispatcher` for a single-pass review. Instead:

```typescript
// In heartbeat-entrypoint.ts, Step 8 for specialists:
if (resolvedPhase === "code-review") {
  const reviewOrchestrator = new ReviewOrchestrator(dispatcher, config);
  const result = await reviewOrchestrator.run({
    storyId: issue.storyId ?? issue.id,
    storyTitle: issue.title,
    onDelta: (d) => process.stdout.write(d),
  });
  // Report result, handle approval/escalation
} else {
  // Normal dispatch
  await handlePaperclipIssue(issue, ...);
}
```

#### P0-3: Sequential Story Promotion

In CEO re-evaluation, instead of promoting all stories whose deps are met, promote **only the next story** in sprint order:

```typescript
// In reEvaluateDelegation():
// Find stories for the current epic, sorted by sequence
const epicStories = children
  .filter(c => isStoryIssue(c))
  .sort((a, b) => getStorySequence(a) - getStorySequence(b));

// Find the first non-done story
const nextStory = epicStories.find(c => c.status !== "done");
if (nextStory && nextStory.status === "backlog") {
  // Promote to todo, assigned to SM for detail creation
  await client.updateIssue(nextStory.id, { status: "todo", assigneeAgentId: smAgentId });
}
```

#### P1-1: Issue Reassignment Flow

Add a `reassignIssue` method to the reporter that:
1. Updates `assigneeAgentId` via `PATCH /api/issues/:id`
2. Posts a handoff comment: "Reassigned from SM to Dev — story file ready at `stories/1-2-user-auth.md`"
3. Triggers the new assignee's heartbeat (Paperclip handles this via assignment triggers)

#### P1-3: E2E Test Decision Step

After the ReviewOrchestrator returns `approved`, add a follow-up dispatch:

```typescript
if (orchestrationResult.approved) {
  // E2E test decision
  const e2eResult = await dispatcher.dispatch({
    id: `${storyId}-e2e-decision`,
    phase: "e2e-tests",  // existing phase
    storyId,
    storyTitle,
    extraContext: "Evaluate whether this story warrants E2E tests. Consider: new API endpoints, user flows, integration points. If yes, generate tests. If no, document reasoning.",
  });
}
```

---

*This document supersedes the "Proposed Target Workflow" section in `docs/current-workflow-analysis.md`.*

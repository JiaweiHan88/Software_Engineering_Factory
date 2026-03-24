# BMAD Copilot Factory — Implementation Plan

> Created: 2026-03-24
> Status: Ready for execution
> Prerequisite: [Revised Target Workflow](./revised-target-workflow.md)

---

## Table of Contents

1. [Design Decisions](#1-design-decisions)
2. [Milestone Overview](#2-milestone-overview)
3. [Milestone 0: Foundation — Paperclip-Backed State](#3-milestone-0-foundation--paperclip-backed-state)
4. [Milestone 1: Sequential Execution Pipeline](#4-milestone-1-sequential-execution-pipeline)
5. [Milestone 2: Quality Gate Integration](#5-milestone-2-quality-gate-integration)
6. [Milestone 3: Organizational Learning](#6-milestone-3-organizational-learning)
7. [Milestone 4: Git Integration](#7-milestone-4-git-integration)
8. [File Change Inventory](#8-file-change-inventory)
9. [Testing Strategy](#9-testing-strategy)
10. [Risks & Mitigations](#10-risks--mitigations)

---

## 1. Design Decisions

These decisions were finalized by the project owner and constrain the implementation:

| # | Decision | Rationale |
|---|----------|-----------|
| **D1** | **Grant `tasks:assign` to all agents** | Enables SM→Dev→QA reassignment flow. **Already implemented** — Paperclip's `agent-hires` endpoint calls `applyDefaultAgentTaskAssignGrant()` which grants `tasks:assign` to every agent at creation time. No code changes needed. |
| **D2** | **Eliminate `sprint-status.yaml`** | Story lifecycle state is tracked exclusively in Paperclip issues. No dual-state model. The `sprint_status`, `dev_story`, `code_review`, `code_review_result`, and `create_story` tools must all be rewritten to use Paperclip issues instead of YAML. |
| **D3** | **Keep `epics.md` in workspace** | The SM produces `epics.md` (epic breakdown summary) as a workspace artifact that agents can read for context. This is NOT lifecycle state — it's a planning reference document. |
| **D4** | **Incremental milestones** | Each milestone is self-contained and testable. M0 is the foundation; M1-M4 build on it sequentially. |

---

## 2. Milestone Overview

```
M0: Foundation (Paperclip-backed state)         ← MUST DO FIRST
 │   Rewrite tools to use Paperclip issues
 │   Eliminate sprint-status.yaml
 │   SM creates Paperclip issues during planning
 │
M1: Sequential Execution Pipeline
 │   CEO sequential story promotion
 │   Issue reassignment flow (SM → Dev → QA)
 │   CEO autonomous decision-making updates
 │
M2: Quality Gate Integration
 │   Wire ReviewOrchestrator into heartbeat path
 │   E2E test decision step after review
 │   Review escalation to CEO (not board)
 │
M3: Organizational Learning
 │   Epic retro detection in CEO re-evaluation
 │   PARA memory loading in heartbeat-entrypoint
 │   CEO delegation prompt includes past learnings
 │
M4: Git Integration
     Branch per story, commits, PRs
```

### Dependency Graph

```
M0 ──→ M1 ──→ M2
                │
                ├──→ M3
                │
                └──→ M4 (M3 and M4 are independent)
```

---

## 3. Milestone 0: Foundation — Paperclip-Backed State

### Goal

Replace all `sprint-status.yaml` references with Paperclip issue API calls. After M0, the tools operate on Paperclip issues and the YAML file is no longer read or written.

### Prerequisites

- Paperclip running at localhost:3100
- `PaperclipClient` available in tool context (currently tools use `loadConfig()` — needs client injection)

### M0-1: Inject PaperclipClient into Tool Context

**Problem:** Tools currently use `loadConfig()` to get filesystem paths. They have no access to the Paperclip API.

**Solution:** Create a tool context that provides the `PaperclipClient` to tools at runtime.

#### Files to Change

**New file: `src/tools/tool-context.ts`**
```typescript
/**
 * Tool context — provides Paperclip client and runtime config to tools.
 *
 * Tools are defined as singletons (Copilot SDK pattern: `defineTool()` at module level).
 * The PaperclipClient is only available at runtime (heartbeat-entrypoint sets it up).
 * This module bridges the gap with a thread-local-style context.
 */

interface ToolContext {
  paperclipClient: PaperclipClient;
  agentId: string;
  issueId: string;         // Currently processing issue
  parentIssueId?: string;  // Parent issue (for sub-tasks)
  workspaceDir: string;    // PAPERCLIP_WORKSPACE_CWD
}

let currentContext: ToolContext | undefined;

export function setToolContext(ctx: ToolContext): void { ... }
export function getToolContext(): ToolContext { ... }
export function clearToolContext(): void { ... }
```

**Modify: `src/heartbeat-entrypoint.ts`**
- In Step 8 (process issues), call `setToolContext()` before dispatching
- In cleanup, call `clearToolContext()`

**Modify: `src/adapter/heartbeat-handler.ts`**
- Pass tool context setup as part of the dispatch flow

---

### M0-2: Rewrite `dev_story` Tool

**Current behavior:** Reads `sprint-status.yaml` to verify story status, transitions to `in-progress`, reads story markdown file, returns content.

**New behavior:** Reads the Paperclip issue (the issue itself IS the story assignment). The story file content is read from the workspace path referenced in the issue description/metadata.

#### File: `src/tools/dev-story.ts` — Full Rewrite

```
Old flow:
  1. readSprintStatus(yaml) → find story by ID
  2. Verify status is ready-for-dev or in-progress
  3. Read story markdown file from filesystem
  4. Write status='in-progress' to YAML
  5. Return story content

New flow:
  1. getToolContext() → get current issueId + paperclipClient
  2. client.getIssue(issueId) → verify status is todo/in_progress
  3. Read story file path from issue metadata.storyFilePath
  4. Read story markdown from workspace filesystem
  5. (Status already in_progress via checkout — no write needed)
  6. Return story content + instruction to reassign to QA when done
```

**Parameters change:**
- Remove `story_id` (derived from tool context — current issue)
- Keep `story_file_path` but make it optional (auto-resolved from issue metadata)

---

### M0-3: Rewrite `code_review` and `code_review_result` Tools

**Current behavior:** Reads `sprint-status.yaml` for status verification and review pass tracking.

**New behavior:** Uses Paperclip issue metadata for review pass tracking.

#### File: `src/tools/code-review.ts` — Full Rewrite

```
Old flow:
  1. readSprintStatus(yaml) → find story
  2. Verify status='review', check pass count
  3. Increment reviewPasses in YAML
  4. Return story + file list for review

New flow:
  1. getToolContext() → issueId + client
  2. client.getIssue(issueId) → verify status
  3. Read reviewPasses from issue.metadata.reviewPasses
  4. Update issue metadata with incremented pass count
  5. Return story + file list for review
```

#### File: `src/tools/code-review.ts` (`code_review_result`) — Full Rewrite

```
Old flow:
  1. readSprintStatus(yaml) → find story
  2. If approved: set status='done' in YAML
  3. If rejected: keep in 'review' for next pass

New flow:
  1. getToolContext() → issueId + client
  2. If approved: update issue status to 'done'
     (Paperclip auto-wakes parent CEO for re-eval)
  3. If rejected + passes < limit:
     Update issue metadata, reassign to Dev for fixes
  4. If rejected + passes >= limit:
     Escalate — post comment on parent issue for CEO
```

---

### M0-4: Rewrite `create_story` Tool → `create_paperclip_story`

**Current behavior:** Generates story markdown template, writes to `_bmad-output/stories/`, registers in `sprint-status.yaml`.

**New behavior:** Creates a Paperclip issue for the story AND writes the story markdown to the workspace.

#### File: `src/tools/create-story.ts` — Full Rewrite

```
Old flow:
  1. Generate markdown template
  2. Write to _bmad-output/stories/{story_id}.md
  3. Push to sprint-status.yaml with status='ready-for-dev'

New flow:
  1. Generate markdown template (keep existing generator)
  2. Write to workspace: _bmad-output/stories/{story_id}.md
  3. Create Paperclip issue:
     - title: story title
     - description: high-level summary (NOT the full story file)
     - status: 'backlog' (CEO will promote to 'todo' when ready)
     - parentId: current issue's parentId (planning issue)
     - metadata: {
         bmadPhase: 'execute',
         storyId: story_id,
         storyFilePath: '_bmad-output/stories/{story_id}.md',
         epicId: epic_id,
         storySequence: sequence_number,
         workPhase: 'dev-story'
       }
  4. Return: issue ID, story file path, Paperclip issue URL
```

---

### M0-5: Replace `sprint_status` Tool → `issue_status`

**Current behavior:** CRUD on `sprint-status.yaml` (read all stories, update status, add story).

**New behavior:** Reads/updates Paperclip issues.

#### File: `src/tools/sprint-status.ts` → `src/tools/issue-status.ts` — Full Rewrite

```
New tool: issue_status

Actions:
- 'read': List all child issues of the parent planning issue
           Returns: [{id, title, status, assignee, reviewPasses}]
- 'update': Update a specific issue's status/metadata
           Uses: client.updateIssue()
- 'reassign': Change assigneeAgentId on an issue
           Uses: client.updateIssue({ assigneeAgentId })
           Paperclip auto-wakes the new assignee
```

---

### M0-6: Update `agent-dispatcher.ts` Prompts

**All references** to `sprint_status` tool in phase config prompts must be updated:

| Phase | Old Prompt | New Prompt |
|-------|-----------|------------|
| `dev-story` | "use sprint_status to move story to 'review'" | "When done, reassign the issue to bmad-qa using issue_status tool" |
| `code-review` | "use sprint_status to move story to 'done'" | "If approved, update issue status to 'done' using issue_status tool" |
| `sprint-planning` | "Use sprint_status tool to read current state" | "Use issue_status tool to read child issues" |
| All phases | `sprintStatusTool` references | `issueStatusTool` references |

#### File: `src/adapter/agent-dispatcher.ts`
- Replace all `sprintStatusTool` imports and references with `issueStatusTool`
- Update prompt strings to reference the new tool name and behavior
- Update tool arrays in all `PhaseConfig` entries

---

### M0-7: Update `bmad-methodology` Skill

#### File: `src/skills/bmad-methodology/skill.md`
- Replace sprint-status.yaml references with Paperclip issue tracking language
- Update the lifecycle description to reference Paperclip statuses

---

### M0-8: Deprecate Sprint Runner

#### File: `src/adapter/sprint-runner.ts`
- Mark as deprecated (add `@deprecated` JSDoc)
- Do NOT delete yet — keep for reference until M2 is complete (ReviewOrchestrator wiring is extracted)

#### File: `src/index.ts`
- Remove sprint runner startup code
- Update console output

---

### M0-9: Update `tools/index.ts` Barrel Exports

#### File: `src/tools/index.ts`
- Remove `sprintStatusTool`, `readSprintStatus`, `writeSprintStatus` exports
- Add `issueStatusTool` export
- Rename `createStoryTool` (keep name but new implementation)
- Add `toolContext` exports

---

### M0-10: Update Config

#### File: `src/config/config.ts`
- Remove `sprintStatusPath` from `BmadConfig`
- Keep `outputDir` (still used for story markdown files in workspace)
- Keep `reviewPassLimit` (still enforced, just tracked via issue metadata)

---

### M0 Verification

```bash
# 1. Typecheck — no sprint-status.yaml references compile
pnpm -r typecheck

# 2. Unit tests — rewrite tests for new tool implementations
pnpm test:run

# 3. Manual E2E — create issue, SM creates stories as Paperclip issues
npx tsx scripts/e2e-test.ts --smoke
```

---

## 4. Milestone 1: Sequential Execution Pipeline

### Goal

CEO promotes stories one at a time. When a story completes (done), the CEO promotes the next story in sprint order. Issue assignment flows SM→Dev→QA within each story.

### M1-1: Sequential Story Promotion in CEO Re-Evaluation

#### File: `src/adapter/ceo-orchestrator.ts` — Modify `reEvaluateDelegation()`

**Current behavior (fast path):** Promotes ALL backlog children whose `dependsOn` indices are `done` to `todo`.

**New behavior:** Among story issues (identified by `metadata.bmadPhase === 'execute'`), promote **only the next one** in sequence order.

```typescript
// Pseudo-code for the change in fastPathPromotion():

const children = await client.listIssues({ parentId: issue.id });

// Separate story issues from non-story issues
const storyIssues = children.filter(c =>
  (c.metadata as any)?.bmadPhase === 'execute'
);
const nonStoryIssues = children.filter(c =>
  (c.metadata as any)?.bmadPhase !== 'execute'
);

// Non-story issues: existing behavior (dependency-based promotion)
for (const child of nonStoryIssues) {
  if (child.status === 'backlog' && allDependenciesMet(child, children)) {
    await client.updateIssue(child.id, { status: 'todo' });
  }
}

// Story issues: sequential promotion
const sortedStories = storyIssues
  .sort((a, b) => getSequence(a) - getSequence(b));

const firstNonDone = sortedStories.find(s => s.status !== 'done');
if (firstNonDone && firstNonDone.status === 'backlog') {
  // Promote to todo, assign to SM for detailed story creation
  const smAgentId = await resolveAgentId('bmad-sm');
  await client.updateIssue(firstNonDone.id, {
    status: 'todo',
    assigneeAgentId: smAgentId,
    metadata: {
      ...firstNonDone.metadata,
      workPhase: 'create-story',  // SM creates detailed story file
    },
  });
}

// Check epic completion
const currentEpicId = (firstNonDone?.metadata as any)?.epicId;
const epicStories = storyIssues.filter(s =>
  (s.metadata as any)?.epicId === currentEpicId
);
if (epicStories.every(s => s.status === 'done')) {
  // Epic complete — trigger retro (M3)
}
```

**Helper function needed:** `getSequence(issue)` — reads `metadata.storySequence`.

**Helper function needed:** `resolveAgentId(bmadRole)` — looks up agent UUID from org chart by `metadata.bmadRole`. The CEO orchestrator already has org chart data loaded; extract the resolution logic.

---

### M1-2: Issue Reassignment Flow

This is the 4-step sub-lifecycle per story:

```
SM creates detailed story → reassigns to Dev
Dev implements → reassigns to QA
QA reviews (pass) → marks done (CEO auto-wakes)
QA reviews (fail) → reassigns to Dev (fix loop)
```

**Key insight:** Paperclip already wakes the new assignee when `assigneeAgentId` changes (confirmed in `routes/issues.ts` lines 950-955). So reassignment IS the trigger mechanism — no custom wakeup code needed.

#### New file: `src/adapter/issue-reassignment.ts`

```typescript
/**
 * Issue reassignment helper — handles SM→Dev→QA handoff protocol.
 *
 * When an agent completes its step in the story lifecycle,
 * it reassigns the issue to the next agent and posts a handoff comment.
 * Paperclip auto-wakes the new assignee.
 */

export async function reassignIssue(
  client: PaperclipClient,
  issueId: string,
  toRole: string,          // 'bmad-dev' | 'bmad-qa' | 'bmad-sm'
  handoffComment: string,
  metadata?: Record<string, unknown>,
): Promise<void> {
  // 1. Resolve target agent ID from role
  const agents = await client.listAgents();
  const target = agents.find(a =>
    (a.metadata as any)?.bmadRole === toRole && a.status !== 'terminated'
  );
  if (!target) throw new Error(`No active agent with role ${toRole}`);

  // 2. Release current checkout (current agent is done with the issue)
  await client.releaseIssue(issueId).catch(() => {/* ok if not checked out */});

  // 3. Update issue: new assignee + optional metadata changes
  await client.updateIssue(issueId, {
    assigneeAgentId: target.id,
    ...(metadata ? { metadata } : {}),
  });

  // 4. Post handoff comment
  await client.addIssueComment(issueId, handoffComment);
}
```

#### Modify: `src/adapter/heartbeat-handler.ts`

After a successful dispatch, check if the phase completed warrants a reassignment:

```typescript
// After dispatch completes successfully:
const phase = resolvedPhase;

if (phase === 'create-story') {
  // SM finished creating detailed story → reassign to Dev
  await reassignIssue(client, issue.id, 'bmad-dev',
    `📋 Story detail created. Story file: ${storyFilePath}. Ready for implementation.`,
    { ...issue.metadata, workPhase: 'dev-story' }
  );
} else if (phase === 'dev-story') {
  // Dev finished implementing → reassign to QA
  await reassignIssue(client, issue.id, 'bmad-qa',
    `💻 Implementation complete. Ready for code review.`,
    { ...issue.metadata, workPhase: 'code-review' }
  );
}
// code-review reassignment handled by ReviewOrchestrator (M2)
```

---

### M1-3: Update `resolvePhaseFromMetadata()`

#### File: `src/adapter/heartbeat-handler.ts`

The phase resolution already reads `metadata.workPhase` first, then falls back to `metadata.bmadPhase`. The M1 flow sets `workPhase` explicitly on each reassignment, so this already works correctly.

**One addition:** The SM's `create-story` phase should be recognized:

```typescript
const phaseMap: Record<string, WorkPhase> = {
  research: "research",
  define: "create-prd",
  plan: "sprint-planning",
  execute: "dev-story",    // default for execute phase
  review: "code-review",
};
```

No change needed — the `workPhase` metadata override takes priority.

---

### M1-4: CEO Autonomous Decision Updates

#### File: `src/adapter/ceo-orchestrator.ts` — Modify delegation prompt

Update the CEO delegation prompt to:
1. Remove references to requiring board approval for non-critical decisions
2. Add the Decision Authority Matrix from the revised workflow
3. Set `requiresApproval: false` as default (currently, the CEO may set it to `true`)

```typescript
// In buildDelegationPrompt():
// Add to system context:
`
## Decision Authority
You are authorized to make ALL decisions autonomously EXCEPT:
- Changing product direction (requires board)
- Budget above 80% spent (switch to critical-only; if no critical work, escalate)
- Irreversible infrastructure decisions (requires board)
- Scope increase > 50% (requires board)

For everything else: DECIDE and PROCEED. Post your reasoning as a comment.
Do NOT set requiresApproval to true unless one of the above conditions applies.
`
```

---

### M1 Verification

```bash
# 1. Typecheck
pnpm -r typecheck

# 2. Unit tests for new reassignment module + modified ceo-orchestrator
pnpm test:run

# 3. E2E: Create issue → CEO delegates → SM plans → SM creates story issues
#    → CEO promotes story 1 → SM details story 1 → Dev implements → Dev reassigns to QA
npx tsx scripts/e2e-test.ts --full --stop-after=execute
```

---

## 5. Milestone 2: Quality Gate Integration

### Goal

The full adversarial review loop (ReviewOrchestrator) runs in the heartbeat path for every code-review phase. E2E test decisions happen after each story passes review.

### M2-1: Wire ReviewOrchestrator into Heartbeat Path

**Current state:** `ReviewOrchestrator` only runs in `sprint-runner.ts`. The heartbeat path does a single-pass dispatch via `AgentDispatcher`.

**Target:** When a specialist heartbeat receives a `code-review` phase, use `ReviewOrchestrator` instead of `AgentDispatcher.dispatch()`.

#### File: `src/adapter/heartbeat-handler.ts` — Major Modification

```typescript
export async function handlePaperclipIssue(
  issue: PaperclipIssue,
  agentId: string,
  bmadRole: string,
  dispatcher: AgentDispatcher,
  reporter: PaperclipReporter,
  reviewOrchestrator?: ReviewOrchestrator,  // NEW parameter
): Promise<HeartbeatResult> {

  const phase = resolvePhase(issue);

  if (phase === 'code-review' && reviewOrchestrator) {
    // Full adversarial review loop
    return handleCodeReview(issue, reviewOrchestrator, reporter);
  }

  // ... existing dispatch flow
}

async function handleCodeReview(
  issue: PaperclipIssue,
  orchestrator: ReviewOrchestrator,
  reporter: PaperclipReporter,
): Promise<HeartbeatResult> {
  const storyId = issue.metadata?.storyId ?? issue.id;

  const result = await orchestrator.run({
    storyId,
    storyTitle: issue.title,
    onDelta: (d) => process.stdout.write(d),
  });

  if (result.approved) {
    // Story passed review → mark done
    // (Paperclip auto-wakes CEO for re-eval via child_issue_done)
    await reporter.reportHeartbeatResult(agentId, issue.id, {
      status: 'completed',
      message: `Code review PASSED on pass ${result.passNumber}`,
      storyId,
    });
    return { status: 'completed', message: 'Review passed', storyId };
  }

  if (result.escalated) {
    // Max passes exceeded → escalate to CEO (not board)
    // Post findings on parent issue for CEO review
    const parentId = issue.parentId ?? issue.metadata?.parentIssueId;
    if (parentId) {
      await client.addIssueComment(parentId,
        `⚠️ ESCALATION: Story "${issue.title}" failed ${result.passNumber} review passes.\n` +
        `Findings: ${result.findingsSummary}\n` +
        `CEO action needed: force-approve, reassign, or investigate.`
      );
    }
    return { status: 'needs-human', message: 'Review escalated to CEO', storyId };
  }

  // Review failed but passes remain → reassign to Dev for fixes
  await reassignIssue(client, issue.id, 'bmad-dev',
    `❌ Code review FAILED (pass ${result.passNumber}/${config.reviewPassLimit}).\n` +
    `Findings:\n${result.findingsSummary}\n` +
    `Fix the HIGH/CRITICAL issues and reassign back to bmad-qa.`,
    { ...issue.metadata, workPhase: 'dev-story', reviewFixMode: true }
  );

  return { status: 'working', message: 'Review failed, reassigned to Dev', storyId };
}
```

#### File: `src/heartbeat-entrypoint.ts` — Inject ReviewOrchestrator

In Step 8 (process issues), create a `ReviewOrchestrator` instance and pass it to `handlePaperclipIssue()`:

```typescript
// After creating AgentDispatcher:
const reviewOrchestrator = new ReviewOrchestrator(dispatcher, {
  reviewPassLimit: config.reviewPassLimit,
});

// In specialist processing:
await handlePaperclipIssue(issue, agentId, bmadRole, dispatcher, reporter, reviewOrchestrator);
```

---

### M2-2: Adapt ReviewOrchestrator for Paperclip Issues

#### File: `src/quality-gates/review-orchestrator.ts` — Modify

**Current:** Reads/writes review state from `review-history/{storyId}.review.yaml`.

**Change:** Also update Paperclip issue metadata with review pass state:

```typescript
// After each pass:
await client.updateIssue(issueId, {
  metadata: {
    ...existingMetadata,
    reviewPasses: currentPass,
    lastReviewResult: result.approved ? 'pass' : 'fail',
    lastReviewFindings: result.findingsSummary?.slice(0, 500),
  },
});
```

**Keep** the local YAML review history as well — it provides richer data (full findings per pass) that doesn't fit in issue metadata. The YAML history is for analysis; the issue metadata is for orchestration.

---

### M2-3: E2E Test Decision Step

#### File: `src/adapter/heartbeat-handler.ts` — Add E2E decision after review pass

When the ReviewOrchestrator returns `approved`:

```typescript
if (result.approved) {
  // Before marking done, evaluate E2E test need
  const e2eDecision = await dispatcher.dispatch({
    id: `${issue.id}-e2e-decision`,
    phase: 'e2e-tests',
    storyId,
    storyTitle: issue.title,
    storyDescription:
      'Evaluate whether this story warrants E2E tests. ' +
      'Consider: new API endpoints, user flows, integration points, critical logic. ' +
      'If yes, generate tests. If no, post a brief justification.',
  }, onDelta);

  // Then mark done regardless of E2E decision
  await reporter.reportHeartbeatResult(agentId, issue.id, {
    status: 'completed',
    message: `Review passed. E2E: ${e2eDecision.success ? 'generated' : 'skipped'}`,
    storyId,
  });
}
```

---

### M2 Verification

```bash
# 1. Unit tests for ReviewOrchestrator with Paperclip issue integration
pnpm test:run

# 2. E2E: Full story lifecycle including multi-pass review
npx tsx scripts/e2e-test.ts --full
```

---

## 6. Milestone 3: Organizational Learning

### Goal

After each epic completes, the CEO triggers a retrospective. Learnings are stored in PARA memory and inform future delegation.

### M3-1: Epic Completion Detection

#### File: `src/adapter/ceo-orchestrator.ts` — Add to `reEvaluateDelegation()`

```typescript
// After sequential promotion check:

// Check if any epic just completed
const epicIds = [...new Set(
  storyIssues.map(s => (s.metadata as any)?.epicId).filter(Boolean)
)];

for (const epicId of epicIds) {
  const epicStories = storyIssues.filter(s =>
    (s.metadata as any)?.epicId === epicId
  );
  const allDone = epicStories.every(s => s.status === 'done');
  const retroExists = nonStoryIssues.some(c =>
    (c.metadata as any)?.isRetrospective &&
    (c.metadata as any)?.epicId === epicId
  );

  if (allDone && !retroExists) {
    // Create retro sub-issue assigned to SM
    const smId = await resolveAgentId('bmad-sm');
    await client.createIssue({
      title: `Epic ${epicId} Retrospective`,
      description:
        `All stories for epic ${epicId} are complete. ` +
        `Run the bmad-retrospective skill. ` +
        `Analyze: what worked, what didn't, review patterns, E2E coverage.`,
      status: 'todo',
      assigneeAgentId: smId,
      parentId: issue.id,
      metadata: {
        bmadPhase: 'review',
        workPhase: 'retrospective',
        isRetrospective: true,
        epicId,
      },
    });
  }
}
```

---

### M3-2: PARA Memory Loading

#### File: `src/heartbeat-entrypoint.ts` — Step 6.5 (new step)

After loading the 4-file config (AGENTS.md + SOUL.md + HEARTBEAT.md + TOOLS.md) and before bootstrapping the SDK, load PARA memory files for the CEO:

```typescript
// Step 6.5: Load agent memory (PARA system)
if (isOrchestrator) {
  const memoryDir = resolve(workspaceCwd, '_bmad-output/memory');
  const learningsDir = resolve(memoryDir, 'learnings');

  if (existsSync(learningsDir)) {
    const memoryFiles = readdirSync(learningsDir)
      .filter(f => f.endsWith('.md'))
      .sort(); // chronological by filename

    const memoryContent = memoryFiles
      .map(f => readFileSync(resolve(learningsDir, f), 'utf-8'))
      .join('\n\n---\n\n');

    if (memoryContent.length > 0) {
      agentSystemMessage += '\n\n## Learnings from Previous Epics\n\n' + memoryContent;
    }
  }
}
```

---

### M3-3: CEO Delegation Prompt Includes Learnings

#### File: `src/adapter/ceo-orchestrator.ts` — Modify `buildDelegationPrompt()`

The learnings are already injected into `agentSystemMessage` (M3-2), which becomes the system message for the CEO's Copilot session. No additional prompt changes needed — the CEO will naturally reference the learnings when creating delegation plans.

**Optional enhancement:** Add an explicit instruction in the delegation prompt:

```
If the system message contains "Learnings from Previous Epics",
review them and apply relevant lessons to this delegation plan.
For example: if past retros show schema changes need Architect review,
include an Architect review step for stories that touch the schema.
```

---

### M3-4: CEO Extracts Learnings After Retro

When the CEO processes a completed retro sub-issue (SM has produced the retro report), the CEO should extract durable facts to memory.

#### File: `src/adapter/ceo-orchestrator.ts` — Add to re-evaluation

```typescript
// When a retro sub-issue completes:
const completedRetros = children.filter(c =>
  c.status === 'done' &&
  (c.metadata as any)?.isRetrospective &&
  !(c.metadata as any)?.learningsExtracted
);

for (const retro of completedRetros) {
  // Read the retro report from workspace
  const epicId = (retro.metadata as any)?.epicId;
  const retroFilePath = resolve(workspaceCwd, `_bmad-output/epic-${epicId}-retrospective.md`);

  if (existsSync(retroFilePath)) {
    // Use CEO session to extract durable learnings
    const extraction = await ceoSession.send(
      `Read this retrospective report and extract 3-5 durable, actionable learnings ` +
      `that should inform future epic delegation. Format as a markdown list.\n\n` +
      readFileSync(retroFilePath, 'utf-8')
    );

    // Save to PARA memory
    const learningsPath = resolve(workspaceCwd, `_bmad-output/memory/learnings/epic-${epicId}.md`);
    mkdirSync(dirname(learningsPath), { recursive: true });
    writeFileSync(learningsPath, `# Learnings from Epic ${epicId}\n\n${extraction}\n`);

    // Mark as extracted so we don't re-process
    await client.updateIssue(retro.id, {
      metadata: { ...retro.metadata, learningsExtracted: true },
    });
  }
}
```

---

### M3 Verification

```bash
# 1. Unit test: epic completion detection, memory file I/O
pnpm test:run

# 2. E2E: Complete an epic, verify retro is triggered and learnings saved
npx tsx scripts/e2e-test.ts --autonomous --timeout=60
```

---

## 7. Milestone 4: Git Integration

### Goal

Each story gets a Git branch. Code changes are committed. A PR is opened for review. This milestone is independent of M3.

### M4-1: Git Integration Module

#### New file: `src/adapter/git-integration.ts`

```typescript
/**
 * Git integration — branch management, commits, and PR creation.
 *
 * Creates feature branches per story, commits changes, opens PRs.
 * Uses shell git commands (no library dependency).
 */

export async function createStoryBranch(storyId: string): Promise<string> {
  const branchName = `story/${storyId}`;
  await exec(`git checkout -b ${branchName}`);
  return branchName;
}

export async function commitChanges(
  storyId: string,
  message: string,
): Promise<string> {
  await exec('git add -A');
  const result = await exec(`git commit -m "feat(${storyId}): ${message}"`);
  return result.stdout;
}

export async function createPR(
  storyId: string,
  title: string,
  description: string,
): Promise<string> {
  // Uses gh CLI or GitHub API
  const result = await exec(
    `gh pr create --title "${title}" --body "${description}" --base main`
  );
  return result.stdout.trim(); // PR URL
}
```

### M4-2: Integration Points

- **Dev agent dispatch:** After `dev-story` completes, commit and push
- **QA review:** Review against PR diff instead of filesystem
- **Story completion:** Merge PR when story moves to `done`

### M4 Verification

```bash
# Manual: verify branch creation, commits, PR flow
```

---

## 8. File Change Inventory

### New Files

| File | Milestone | Purpose |
|------|-----------|---------|
| `src/tools/tool-context.ts` | M0 | Thread-local context for PaperclipClient in tools |
| `src/tools/issue-status.ts` | M0 | Replacement for sprint-status.ts (Paperclip-backed) |
| `src/adapter/issue-reassignment.ts` | M1 | SM→Dev→QA handoff helper |
| `src/adapter/git-integration.ts` | M4 | Git branch/commit/PR operations |

### Modified Files

| File | Milestone | Change Type |
|------|-----------|-------------|
| `src/tools/dev-story.ts` | M0 | **Full rewrite** — YAML → Paperclip issues |
| `src/tools/code-review.ts` | M0 | **Full rewrite** — YAML → Paperclip issues |
| `src/tools/create-story.ts` | M0 | **Full rewrite** — adds Paperclip issue creation |
| `src/tools/index.ts` | M0 | Update barrel exports |
| `src/adapter/agent-dispatcher.ts` | M0 | Replace tool references + prompts |
| `src/config/config.ts` | M0 | Remove `sprintStatusPath` |
| `src/skills/bmad-methodology/skill.md` | M0 | Update lifecycle references |
| `src/heartbeat-entrypoint.ts` | M0, M2, M3 | Tool context setup, ReviewOrchestrator injection, memory loading |
| `src/adapter/heartbeat-handler.ts` | M1, M2 | Reassignment flow, ReviewOrchestrator routing, E2E decision |
| `src/adapter/ceo-orchestrator.ts` | M1, M3 | Sequential promotion, autonomy updates, epic retro, learnings |
| `src/adapter/reporter.ts` | M1 | Minor: adjust result reporting for new flow |
| `src/quality-gates/review-orchestrator.ts` | M2 | Paperclip issue metadata updates |
| `src/index.ts` | M0 | Remove sprint runner startup |

### Deprecated Files

| File | Milestone | Action |
|------|-----------|--------|
| `src/tools/sprint-status.ts` | M0 | **Deprecated** — replaced by `issue-status.ts` |
| `src/adapter/sprint-runner.ts` | M0 | **Deprecated** — functionality absorbed into heartbeat path |

### Test Files

| File | Milestone | Action |
|------|-----------|--------|
| `test/heartbeat-handler.test.ts` | M0, M1, M2 | Major updates for new flow |
| `test/tools/dev-story.test.ts` | M0 | **New** — test Paperclip-backed dev_story |
| `test/tools/code-review.test.ts` | M0 | **New** — test Paperclip-backed review tools |
| `test/tools/issue-status.test.ts` | M0 | **New** — test issue_status tool |
| `test/tools/create-story.test.ts` | M0 | **New** — test Paperclip issue creation |
| `test/adapter/issue-reassignment.test.ts` | M1 | **New** — test reassignment flow |
| `test/adapter/ceo-sequential.test.ts` | M1 | **New** — test sequential promotion logic |

---

## 9. Testing Strategy

### Unit Tests (vitest)

Each milestone includes unit tests following existing patterns in `test/heartbeat-handler.test.ts`:
- Mock `PaperclipClient` (all API calls)
- Mock `CopilotClient` / `@github/copilot-sdk`
- Mock observability (logger, tracing, metrics)
- Test happy paths + error paths + edge cases

**Key test scenarios per milestone:**

#### M0
- `dev_story` tool: reads issue via client, returns story content, handles re-entry
- `code_review` tool: tracks passes via issue metadata, enforces limit
- `create_story` tool: creates Paperclip issue with correct metadata, writes workspace file
- `issue_status` tool: reads/updates/reassigns issues
- Tool context: set/get/clear lifecycle

#### M1
- Sequential promotion: only promotes one story at a time, respects epic ordering
- Reassignment: resolves agent ID from role, releases checkout, updates assignee, posts comment
- CEO autonomy: `requiresApproval` defaults to `false` for standard decisions

#### M2
- ReviewOrchestrator in heartbeat: full pass→fail→fix→pass cycle
- Escalation: after 3 passes, posts on parent issue (not board)
- E2E test decision: dispatched after review passes

#### M3
- Epic completion detection: triggers retro when all epic stories done, skips if retro exists
- Memory loading: reads learning files from workspace, appends to system message
- Learning extraction: CEO extracts facts from retro report, writes to memory dir

### E2E Tests

The existing `scripts/e2e-test.ts` already supports `--autonomous` mode. Extend it to verify:

1. **M0:** Stories appear as Paperclip issues (not just YAML)
2. **M1:** Stories promoted sequentially (observe issue status transitions)
3. **M2:** Multi-pass review visible in issue comments/metadata
4. **M3:** Retro issue created after epic completion, memory files appear in workspace

---

## 10. Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| **Tool context threading** | Tools are singletons; concurrent heartbeats could clobber context | Paperclip spawns one Node.js process per heartbeat — no concurrency within a process. Thread-local pattern is safe. |
| **Agent UUID resolution** | SM/Dev/QA reassignment needs agent UUIDs, not role names | Cache org chart at heartbeat startup (already fetched in Step 3). Expose `resolveAgentId()` helper that searches by `metadata.bmadRole`. |
| **Checkout/release during reassignment** | Current agent has checkout lock; reassigning while checked out may fail | Release checkout before reassignment. The new agent will checkout on their next heartbeat. |
| **Review history migration** | ReviewOrchestrator writes YAML history; migration to issue metadata has size limits | Keep YAML history for detailed data. Use issue metadata only for pass count and last result (small fields). |
| **Sprint runner removal** | Sprint runner contains the only ReviewOrchestrator wiring | M2 extracts and rewires ReviewOrchestrator before sprint runner is deleted. Sprint runner is deprecated in M0, deleted after M2. |
| **E2E test mode backwards compatibility** | `e2e-test.ts` uses current tool/flow expectations | Update E2E test alongside each milestone. |

---

## Execution Order Summary

```
Week 1:  M0-1 (tool context) → M0-2 (dev_story) → M0-3 (code_review)
         → M0-4 (create_story) → M0-5 (issue_status)
Week 2:  M0-6 (dispatcher prompts) → M0-7 (skill.md) → M0-8 (deprecations)
         → M0-9 (exports) → M0-10 (config) → M0 verification
Week 3:  M1-1 (sequential promotion) → M1-2 (reassignment) → M1-4 (CEO autonomy)
         → M1 verification
Week 4:  M2-1 (ReviewOrchestrator wiring) → M2-2 (Paperclip metadata)
         → M2-3 (E2E test decision) → M2 verification
Week 5:  M3-1 (epic detection) → M3-2 (memory loading) → M3-3 (prompt)
         → M3-4 (learning extraction) → M3 verification
Week 6:  M4 (Git integration) → Full E2E verification
```

---

*This plan is designed to be executed incrementally. Each milestone produces a working system that can be tested independently. M0 is the critical foundation — all other milestones depend on it.*

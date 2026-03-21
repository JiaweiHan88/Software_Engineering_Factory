# E2E Spec Pipeline Test — Design Document

## 1. Goal

Validate the autonomous software specification preparation pipeline end-to-end:

```
Vague issue → CEO delegation → Research → PRD/Architecture → Epics
```

Unlike the existing `e2e-smoke-invoke.ts` (which tests a simple health-check with a predetermined happy path), this test validates **multi-phase, multi-agent orchestration** where:

- The CEO must decompose a deliberately vague/complex requirement
- Multiple specialists must run across multiple BMAD phases
- Research outputs must feed into specification artifacts
- The pipeline stops **before implementation** (no `execute` phase)

**Key constraint:** The test is **observer-based**, not flow-hardcoded. It does NOT prescribe which agents the CEO should delegate to or how many sub-tasks to create. Instead, it observes what the CEO decides, validates structural invariants, then drives each phase to completion and validates the outputs.

---

## 2. Test Issue (Seed)

The test creates a deliberately vague, multi-domain issue that *forces* the CEO to assign research before jumping to specs:

```
Title: "Build a real-time vehicle telemetry dashboard for fleet managers"

Description:
  A fleet management company wants a dashboard that:
  - Shows live GPS positions, speed, fuel level, and engine diagnostics
  - Supports 10,000+ vehicles with < 2s latency
  - Has role-based access (fleet manager, driver, mechanic)
  - Integrates with existing OBD-II dongles
  - Must run on mobile and desktop browsers
  
  The company has not decided on a tech stack, protocol, or data architecture.
  There is no existing PRD or architecture. Budget and timeline are unknown.
  
  This issue covers SPECIFICATION ONLY — do not implement anything.
  Deliver: research findings, PRD, architecture document, and epic breakdown.
```

This seed is intentionally:
- **Vague** (no tech stack → forces research)
- **Multi-domain** (IoT + real-time + RBAC + mobile → needs analyst + architect + PM)
- **Scope-bounded** ("specification only" → CEO should not create `execute` phase tasks)
- **Complex enough** to require multiple phases (research → define → plan)

---

## 3. Architecture: Observer Model

### 3.1 Principle

```
CREATE vague issue → INVOKE CEO → OBSERVE plan → VALIDATE invariants
                                       ↓
                    for each phase in plan:
                      INVOKE assigned specialists → OBSERVE outputs → VALIDATE
```

The test never hard-codes "analyst should do X then architect should do Y". Instead:

1. **CEO decides** the delegation plan (phases, tasks, agents)
2. **Test observes** the plan (via sub-issues created in Paperclip)
3. **Test validates invariants** (structural rules that must hold regardless of the specific plan)
4. **Test drives** each phase by invoking the assigned agents in phase order
5. **Test observes** outputs (comments, status transitions)
6. **Test validates** phase-specific invariants

### 3.2 Observation Surfaces

The test can observe the pipeline through these Paperclip API endpoints:

| Surface | API | What It Reveals |
|---|---|---|
| **Sub-issues** | `GET /api/companies/:id/issues?parentId=:id` | CEO's delegation plan materialized as issues |
| **Issue metadata** | `.metadata.bmadPhase` on each sub-issue | Which BMAD phase the CEO assigned |
| **Assignee** | `.assigneeAgentId` on each sub-issue | Which agent was chosen |
| **Issue comments** | `GET /api/issues/:id/comments` | Agent work outputs, delegation summaries |
| **Issue status** | `.status` field | Lifecycle progression (todo → in_progress → done) |
| **Cost data** | `GET /api/companies/:id/costs/by-agent` | Which agents actually ran |
| **Heartbeat runs** | `GET /api/companies/:id/heartbeat-runs?agentId=:id` | Execution success/failure/duration |

### 3.3 What We Do NOT Observe

- File system artifacts (agents write to workspace but we don't inspect file contents)
- Copilot SDK session internals (prompts, tool calls)
- LLM reasoning (only the final output in comments)

---

## 4. Invariant Assertions

These are structural rules that must hold **regardless of what the CEO decides**. They are the "correctness criteria" for the observer.

### 4.1 CEO Delegation Invariants (after Step 3)

| # | Invariant | Validation |
|---|---|---|
| D1 | CEO creates ≥ 1 sub-issue | `subIssues.length >= 1` |
| D2 | Every sub-issue has `metadata.bmadPhase` | All issues have phase ∈ {research, define, plan, execute, review} |
| D3 | Every sub-issue has an assignee | `assigneeAgentId` is non-null |
| D4 | CEO does not assign to itself | No sub-issue has `assigneeAgentId === AGENTS.ceo` |
| D5 | At least one `research` phase task exists | The seed is vague enough that skipping research is wrong |
| D6 | At least one `define` phase task exists | PRD/architecture required by the seed |
| D7 | No `execute` phase tasks | Seed explicitly says "specification only" |
| D8 | Parent issue is `in_progress` | CEO checked it out correctly |
| D9 | Delegation summary comment exists on parent | CEO reported what it did |
| D10 | Assigned agents are valid specialists | Every `assigneeAgentId` maps to a known agent name |

### 4.2 Phase Execution Invariants (after each specialist runs)

| # | Invariant | Validation |
|---|---|---|
| P1 | Heartbeat run succeeds | `completedRun.status === "succeeded"` |
| P2 | Sub-issue status progresses | Status moves from `todo` → `in_progress` or `done` |
| P3 | Agent posts ≥ 1 comment on its sub-issue | Comment count > 0 after heartbeat |
| P4 | Comment contains substantive content | Comment body length > 100 chars (not just a status tag) |
| P5 | No error/failure markers in comments | No `❌`, `Failed`, `Error` in comment bodies |

### 4.3 Cross-Phase Invariants (after all phases complete)

| # | Invariant | Validation |
|---|---|---|
| C1 | All research tasks completed before define tasks started | Phase ordering respected (by invocation order) |
| C2 | Cost data recorded for all invoked agents | `/costs/by-agent` shows entries for each agent that ran |
| C3 | No orphan sub-issues | Every sub-issue either completed or has an explanatory comment |

### 4.4 Soft Assertions (logged as warnings, not failures)

| # | Check | Rationale |
|---|---|---|
| S1 | Research comments reference the domain (telemetry, OBD-II, fleet) | Agent actually researched the topic, not generic filler |
| S2 | Define comments reference architecture patterns (pub/sub, WebSocket, REST) | Architecture is substantive |
| S3 | Plan comments reference epics or stories | PM created a breakdown |
| S4 | Total specialist count ≤ 6 | CEO shouldn't over-decompose a spec-only task |
| S5 | Total execution time < 10 minutes | Pipeline should be tractable |

---

## 5. Execution Strategy

### Phase Ordering

The test groups sub-issues by `metadata.bmadPhase` and executes them in BMAD pipeline order:

```
research → define → plan
```

Within each phase, all tasks run **sequentially** (one specialist at a time) because:
- Paperclip has execution locks per-issue (concurrent agent runs would conflict)
- Sequential invocation gives deterministic observation

### Step-by-Step Flow

```
Step 0: Resolve agents, check prerequisites (same as smoke test)
Step 1: Create seed issue (vague fleet telemetry dashboard)
Step 2: Pause all agents → move issue to 'todo' → invoke CEO
Step 3: Observe & validate CEO delegation (invariants D1-D10)
Step 4: Group sub-issues by phase → sort by pipeline order
Step 5: For each phase group (research, define, plan):
  Step 5.x: For each sub-issue in the phase:
    a. Ensure sub-issue is 'todo'
    b. Resume assigned agent
    c. Invoke heartbeat via /invoke
    d. Poll for completion
    e. Observe: comments, status, heartbeat run
    f. Validate phase execution invariants (P1-P5)
    g. Pause agent again
Step 6: Validate cross-phase invariants (C1-C3)
Step 7: Run soft assertions (S1-S5), log as warnings
Step 8: Cleanup (cancel all issues, resume agents)
Step 9: Print structured test report
```

### Invocation Mechanics

Same as the existing smoke test — uses Paperclip's `/heartbeat/invoke`:

```
POST /api/agents/:id/heartbeat/invoke → 202 (async)
Poll GET /api/companies/:id/heartbeat-runs?agentId=:id until terminal status
```

### Timeout Strategy

| Phase | Per-agent timeout | Rationale |
|---|---|---|
| CEO delegation | 5 min | CEO may reason deeply about a complex, vague issue |
| Research specialist | 5 min | Copilot session with tool calls |
| Define specialist | 5 min | PRD/architecture generation |
| Plan specialist | 5 min | Epic breakdown |
| **Total pipeline** | **30 min** | Generous ceiling for 5-8 specialist runs |

---

## 6. Test Report Structure

The test produces a structured summary at the end:

```
═══════════════════════════════════════════════════════════════
  Spec Pipeline E2E — Test Report
═══════════════════════════════════════════════════════════════

Seed Issue:  "Build a real-time vehicle telemetry dashboard..."
CEO Plan:    3 phases, 5 tasks
Execution:   research(2) → define(2) → plan(1)

┌─────────────────────────────────────────────────────────────┐
│ Phase Trace                                                 │
├─────────────────────────────────────────────────────────────┤
│ [research] "Research OBD-II integration options"            │
│   Agent:   bmad-analyst (Mary)                              │
│   Status:  ✅ done (45s)                                    │
│   Comment: 1 comment, 1,247 chars                           │
│                                                             │
│ [research] "Market analysis for fleet telemetry platforms"  │
│   Agent:   bmad-pm (John)                                   │
│   Status:  ✅ done (38s)                                    │
│   Comment: 1 comment, 982 chars                             │
│                                                             │
│ [define]   "Create PRD for fleet dashboard"                 │
│   Agent:   bmad-pm (John)                                   │
│   Status:  ✅ done (52s)                                    │
│   Comment: 1 comment, 2,104 chars                           │
│                                                             │
│ ... etc                                                     │
└─────────────────────────────────────────────────────────────┘

Invariant Results:
  ✅ D1  CEO created sub-issues: 5
  ✅ D2  All sub-issues have bmadPhase metadata
  ✅ D3  All sub-issues have assignees
  ✅ D4  CEO did not self-assign
  ✅ D5  Research phase present (2 tasks)
  ✅ D6  Define phase present (2 tasks)
  ✅ D7  No execute phase tasks
  ✅ D8  Parent issue in_progress
  ✅ D9  Delegation summary comment exists
  ✅ D10 All assignees are valid agents
  ✅ P1  All heartbeat runs succeeded (5/5)
  ✅ P2  All sub-issues progressed past todo
  ✅ P3  All agents posted comments
  ✅ P4  All comments are substantive (>100 chars)
  ✅ P5  No error markers in comments
  ✅ C1  Phase ordering respected
  ✅ C2  Cost data for all agents
  ✅ C3  No orphan sub-issues

Soft Assertions:
  ⚠️  S1  1/2 research comments mention domain terms
  ✅ S2  Architecture comments mention patterns
  ✅ S3  Plan comments mention epics
  ✅ S4  Specialist count: 5 (≤ 6)
  ✅ S5  Total time: 4m12s (< 10m)

Total: 18/18 hard assertions passed, 1 soft warning
Pipeline: ✅ PASS
```

---

## 7. File: `scripts/e2e-spec-pipeline.ts`

### CLI Interface

```bash
# Full pipeline (research → define → plan)
npx tsx scripts/e2e-spec-pipeline.ts

# CEO delegation only (observe the plan, don't run specialists)
npx tsx scripts/e2e-spec-pipeline.ts --ceo-only

# Skip cleanup (leave issues for manual inspection)
npx tsx scripts/e2e-spec-pipeline.ts --skip-cleanup

# Verbose mode (show all API calls and intermediate state)
npx tsx scripts/e2e-spec-pipeline.ts --verbose

# Run only through a specific phase (e.g., only research)
npx tsx scripts/e2e-spec-pipeline.ts --stop-after=research
```

### Code Reuse from `e2e-smoke-invoke.ts`

The following can be extracted into a shared module (`scripts/e2e-helpers.ts`):

| Function | Reuse |
|---|---|
| `paperclip<T>()` | HTTP helper — identical |
| `invokeHeartbeat()` | Invoke endpoint wrapper — identical |
| `waitForHeartbeatRun()` | Polling with timeout — identical |
| `resolveAgentIds()` | Agent name → UUID mapping — identical |
| `ensureE2eProject()` | Project/workspace setup — identical |
| `setAgentTargetWorkspace()` | Adapter config injection — identical |
| `log()`, `header()` | Console formatting — identical |

### New Logic Unique to This Test

| Component | Description |
|---|---|
| `groupByPhase()` | Group sub-issues by `metadata.bmadPhase`, sort by pipeline order |
| `validateDelegationInvariants()` | D1-D10 assertion runner |
| `validatePhaseInvariants()` | P1-P5 per-specialist assertion runner |
| `validateCrossPhaseInvariants()` | C1-C3 cross-phase assertion runner |
| `runSoftAssertions()` | S1-S5 keyword-scan heuristics |
| `buildTestReport()` | Structured trace + invariant summary |
| `PhaseTrace` type | Structured log of what happened per sub-issue |

---

## 8. Differences from `e2e-smoke-invoke.ts`

| Aspect | Smoke Test | Spec Pipeline |
|---|---|---|
| **Seed issue** | Simple (health-check endpoint) | Complex (fleet telemetry dashboard) |
| **Expected phases** | 1 (execute) | 3+ (research → define → plan) |
| **Specialist runs** | 1 (quickFlow) | 3-6 (analyst, PM, architect, etc.) |
| **Flow control** | Hardcoded (find first assigned, invoke) | Observer-driven (group by phase, invoke all) |
| **Assertions** | Basic (sub-issue exists, status ok) | Structural invariants (D1-D10, P1-P5, C1-C3) |
| **Soft checks** | None | Domain-relevance keyword scanning |
| **Test report** | Informal log | Structured trace + invariant table |
| **Stop before** | N/A (runs to completion) | `execute` phase (spec-only) |
| **Timeout** | 5 min total | 30 min total |
| **Purpose** | "Does the pipeline start?" | "Does the pipeline produce correct specs?" |

---

## 9. Risk & Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| CEO assigns `execute` phase tasks despite seed saying "spec only" | Test fails D7 | Seed description is explicit; if it happens, the invariant catches it |
| CEO creates too many tasks (> 6) | Long run, higher cost | Soft assertion S4 warns; not a hard failure |
| Specialist produces empty/generic output | Spec quality poor | Soft assertions S1-S3 scan for domain keywords |
| Paperclip phantom 500 on sub-issue creation | Missing sub-issues | Same fallback as smoke test (metadata-based search) |
| LLM non-determinism (different plan each run) | Variable test traces | Observer model handles this — invariants are structural, not flow-specific |
| Total timeout exceeded | Test hangs | Per-agent + total timeout with forced cleanup |

---

## 10. Implementation Sequence

1. **Extract shared helpers** from `e2e-smoke-invoke.ts` → `scripts/e2e-helpers.ts`
2. **Create `scripts/e2e-spec-pipeline.ts`** with the observer skeleton
3. **Implement Steps 0-3** (seed issue + CEO invocation + delegation observation)
4. **Implement Step 4-5** (phase grouping + sequential specialist invocation)
5. **Implement Step 6-7** (cross-phase invariants + soft assertions)
6. **Implement Step 8-9** (cleanup + structured report)
7. **Test run**: `--ceo-only` first, then full pipeline

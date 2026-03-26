# BMAD Copilot Factory — Component Inventory

> Generated: 2026-03-26 | Scan Level: Exhaustive | Source: Direct code analysis

## 1. BMAD Agent Personas (9)

Agent persona definitions implementing the `BmadAgent` interface: `{name, displayName, description, prompt}`.

| Agent ID | Display Name | Persona | Primary Role |
|----------|-------------|---------|--------------|
| `bmad-pm` | John | 8+ yr B2B/consumer product veteran | PRD creation, requirements discovery, stakeholder alignment |
| `bmad-architect` | Winston | Distributed systems, cloud infra expert | Technical design, system architecture, data models |
| `bmad-dev` | Amelia | Senior engineer, TDD advocate | Story implementation, code authoring, all tests must pass |
| `bmad-qa` | Quinn | Test automation engineer | Adversarial code review with severity scoring |
| `bmad-sm` | Bob | Technical scrum master | Sprint planning, story preparation, zero ambiguity tolerance |
| `bmad-analyst` | Mary | Business analyst, market researcher | Requirements analysis, competitive analysis, research |
| `bmad-ux` | Sally | UX designer, user researcher | UX design, interaction design, empathetic storyteller |
| `bmad-tech-writer` | Paige | Documentation specialist | Technical docs, standards compliance, knowledge curation |
| `bmad-quick-flow` | Barry | Elite full-stack developer | Rapid spec-to-implementation, combined dev+review |

### Agent Prompt Structure (XML-based)

Each agent uses a structured XML prompt with steps:
1. Load persona identity and communication style
2. Load config.yaml variables (user_name, communication_language, output_folder)
3. Show greeting message with persona name
4. Display menu of capabilities
5. Wait for user/system input
6. Process via skill/tool handlers

### Agent Registry

- **`allAgents`**: Array of all 9 BmadAgent instances
- **`getAgent(name)`**: Lookup by agent name (e.g., "bmad-dev")
- **Location**: `src/agents/registry.ts`

---

## 2. Copilot SDK Tools (5)

Tool definitions using `defineTool()` from the Copilot SDK. Each tool is invokable by LLM agents during sessions.

### create_story

| Property | Value |
|----------|-------|
| **File** | `src/tools/create-story.ts` |
| **Purpose** | PM/SM creates story markdown file + Paperclip issue |
| **Parameters** | `epic_id`, `story_id`, `story_title`, `story_description?`, `story_sequence?` |
| **Output** | Story markdown in `_bmad-output/stories/{story_id}.md` + Paperclip issue (status=backlog) |
| **Dedup** | Checks for existing sibling issues with same storyId |
| **Metadata** | Sets bmadPhase='execute', storyId, storyFilePath, epicId, reviewPasses=0 |

### code_review

| Property | Value |
|----------|-------|
| **File** | `src/tools/code-review.ts` |
| **Purpose** | Initiates code review pass for a story |
| **Parameters** | `story_id?` (auto-resolved), `story_file_path?` (auto-resolved), `files_to_review` |
| **Logic** | Reads pass count from metadata, checks limit, increments, reads story file |
| **Output** | Review protocol + story content for LLM analysis |

### code_review_result

| Property | Value |
|----------|-------|
| **File** | `src/tools/code-review.ts` |
| **Purpose** | Records review outcome and transitions issue |
| **Parameters** | `story_id?`, `approved` (boolean), `findings_summary`, `high_critical_count` |
| **On approve** | `passReview()` → status=done, wake parent |
| **On reject (< limit)** | Update metadata (increment passes) |
| **On reject (>= limit)** | `escalateReview()` → parent comment for human |

### issue_status

| Property | Value |
|----------|-------|
| **File** | `src/tools/issue-status.ts` |
| **Purpose** | Read, update, or reassign Paperclip issues |
| **Parameters** | `action` (read/update/reassign), `issue_id?`, `new_status?`, `target_role?`, `comment?`, `metadata_updates?` |
| **Read** | Lists sibling issues with status + phase + reviewPasses |
| **Update** | Changes status/metadata (merge, not replace), posts comment |
| **Reassign** | Releases checkout, updates assigneeAgentId, auto-sets workPhase from ROLE_TO_PHASE |

### quality_gate_evaluate

| Property | Value |
|----------|-------|
| **File** | `src/quality-gates/tool.ts` |
| **Purpose** | LLM submits structured findings for gate evaluation |
| **Parameters** | `story_id`, `findings[]` (structured: id, severity, category, file_path, title, description, etc.), `reviewer_notes?` |
| **Logic** | Validates story status, converts findings, evaluates gate, records pass in history, transitions issue |
| **Output** | Formatted gate report with verdict + next steps |

### Tool Context System

| Function | Purpose |
|----------|---------|
| `setToolContext(ctx)` | Set before dispatch (called by heartbeat-handler) |
| `getToolContext()` | Get within tool execution (throws if unset) |
| `tryGetToolContext()` | Optional access (returns undefined if unset) |
| `clearToolContext()` | Cleanup after dispatch |

Context includes: `paperclipClient`, `agentId`, `issueId`, `parentIssueId`, `workspaceDir`, `companyId`

---

## 3. MCP Tools (5)

Model Context Protocol server tools exposed via StdioServerTransport for VS Code integration.

| Tool | Parameters | Purpose |
|------|-----------|---------|
| `get_sprint_status` | none | Returns sprint-status.yaml + counts by status |
| `get_next_story` | none | Finds first story with status='ready-for-dev' |
| `update_story_status` | story_id, new_status, assigned?, increment_review_pass? | Updates story with lifecycle validation |
| `get_architecture_docs` | none | Returns docs/architecture.md content |
| `get_story_details` | story_id | Returns sprint metadata + full markdown |

### Valid Lifecycle Transitions (MCP)

```
backlog → ready-for-dev
ready-for-dev ↔ in-progress
in-progress → review
review ↔ in-progress (rework)
review → done
done ↔ review (reopen)
```

---

## 4. Adapter Components

### SessionManager

| Property | Value |
|----------|-------|
| **File** | `src/adapter/session-manager.ts` |
| **Purpose** | CopilotClient lifecycle, session create/resume/persist |
| **Key methods** | `start()`, `createAgentSession()`, `getOrCreateAgentSession()`, `sendAndWait()`, `stop()` |
| **Session index** | Persists `{agentName}:{storyId}` → sessionId to `_bmad-output/session-index.json` |
| **Streaming** | Supports `assistant.message_delta` listener for real-time output |

### AgentDispatcher

| Property | Value |
|----------|-------|
| **File** | `src/adapter/agent-dispatcher.ts` |
| **Purpose** | Phase → agent routing, model selection, prompt building |
| **Key types** | `WorkPhase` (20+ phases), `WorkItem`, `DispatchResult`, `PhaseConfig` |
| **Two prompt styles** | Template prompts (rigid, tool-specific) vs. Context prompts (issue-driven, skill-delegated) |
| **Workspace context** | Injects CWD, repo URL, branch, strategy, worktree path |

### CEOOrchestrator

| Property | Value |
|----------|-------|
| **File** | `src/adapter/ceo-orchestrator.ts` |
| **Purpose** | Strategic issue delegation, sub-issue management |
| **Key types** | `DelegationTask`, `DelegationPlan`, `OrchestrationResult`, `ReEvaluationResult` |
| **Agent ID cache** | Lazy-loaded Map (roleName → agentId) from listAgents() |
| **Plan parsing** | Extracts JSON from LLM response, validates fields and enums |
| **Creates** | Research/Define/Plan tasks only; Execute/Review auto-proceed |

### Lifecycle Engine

| Property | Value |
|----------|-------|
| **File** | `src/adapter/lifecycle.ts` |
| **Purpose** | Single source of truth for ALL issue state transitions |
| **Constants** | `PHASE_TRANSITIONS`, `ROLE_TO_PHASE`, `PHASE_TO_ROLE` |
| **Key functions** | `completePhase()`, `passReview()`, `failReview()`, `escalateReview()`, `promoteToTodo()`, `closeParent()` |
| **Design** | No other module should directly mutate issue status |

### PaperclipClient

| Property | Value |
|----------|-------|
| **File** | `src/adapter/paperclip-client.ts` |
| **Purpose** | HTTP client for Paperclip REST API (~20 endpoints) |
| **Auth** | Bearer token (PAPERCLIP_AGENT_API_KEY) |
| **Retry** | GET/DELETE retry on 500 (2x with 1s delay); mutations never retry |
| **Error** | `PaperclipApiError` with statusCode, endpoint, responseBody |

### PaperclipLoop

| Property | Value |
|----------|-------|
| **File** | `src/adapter/paperclip-loop.ts` |
| **Purpose** | Inbox-polling integration loop (dev mode) |
| **Events** | loop-start, inbox-check, issue-processed, issue-error, loop-stop |
| **Shutdown** | Pauses all BMAD agents, stops SessionManager |

### Reporter

| Property | Value |
|----------|-------|
| **File** | `src/adapter/reporter.ts` |
| **Purpose** | Posts results to Paperclip via issue comments |
| **History** | In-memory circular buffer (size-capped) |
| **Artifact scan** | Lists workspace files with sizes and previews |

### Retry Utility

| Property | Value |
|----------|-------|
| **File** | `src/adapter/retry.ts` |
| **Purpose** | Generic exponential backoff with jitter |
| **Config** | maxAttempts, baseDelayMs, maxDelayMs, isRetryable predicate |
| **Jitter** | ±25% to prevent thundering herd |

---

## 5. Quality Gate Components

### QualityGateEngine

| Property | Value |
|----------|-------|
| **File** | `src/quality-gates/engine.ts` |
| **Purpose** | Pure gate evaluation logic (no side effects) |
| **Severity weights** | LOW=1, MEDIUM=3, HIGH=7, CRITICAL=15 |
| **Verdicts** | PASS (0 blocking), FAIL (blocking + passes left), ESCALATE (blocking + max passes) |
| **Categories** | correctness, security, performance, error-handling, type-safety, maintainability, testing, documentation, style |

### ReviewOrchestrator

| Property | Value |
|----------|-------|
| **File** | `src/quality-gates/review-orchestrator.ts` |
| **Purpose** | Multi-pass review loop with fix cycles |
| **Max passes** | 3 (configurable) before human escalation |
| **History** | Persisted to `_bmad-output/review-history/{storyId}.yaml` |
| **Events** | review-start, gate-evaluated, fix-start, review-approved, review-escalated |

---

## 6. Observability Components

| Component | File | Purpose |
|-----------|------|---------|
| **Logger** | `src/observability/logger.ts` | Structured JSON/human-readable logging with level filtering + component context |
| **Tracing** | `src/observability/tracing.ts` | OTel distributed tracing to Jaeger (sprint cycle, story, dispatch, gate spans) |
| **Metrics** | `src/observability/metrics.ts` | OTel metrics (8 instruments: counters, histograms, gauges) |
| **CostTracker** | `src/observability/cost-tracker.ts` | Token estimation (4 chars ≈ 1 token), 34 model pricing entries, budget tracking |
| **StallDetector** | `src/observability/stall-detector.ts` | Phase timeout monitoring (ready:30m, in-progress:60m, review:30m) + escalation |

---

## 7. Configuration Components

| Component | File | Purpose |
|-----------|------|---------|
| **Config** | `src/config/config.ts` | `loadConfig()` — 30+ env vars → `BmadConfig` interface |
| **ModelStrategy** | `src/config/model-strategy.ts` | Complexity → model tier routing (fast/standard/powerful) |
| **RoleMapping** | `src/config/role-mapping.ts` | Paperclip agent → BMAD persona + skills mapping (9 roles) |

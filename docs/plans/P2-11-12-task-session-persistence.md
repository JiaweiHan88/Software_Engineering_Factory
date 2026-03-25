# P2-11/12 — Task-Session Persistence via Paperclip Runtime State API

> **Date:** 2026-03-25
> **Priority:** P2 — Valuable
> **Effort:** Large (4h+)
> **Status:** Planned

## Summary

Replace local `session-index.json` with Paperclip's `agent_task_sessions` API so session resume survives container restarts and the board has visibility into session state. Implement per-(agent, issueId) session resume across heartbeats.

## Current State

- `SessionManager` stores session mappings in local `session-index.json` as `agentName:storyId → copilotSessionId`
- Only works when same filesystem is available across heartbeats (fragile in containers)
- Paperclip has no visibility into session state
- Board UI can't show or reset sessions
- If the container restarts, all session mappings are lost

## Steps

### Phase A: Client & Types

1. Create `src/types/runtime-state.ts` with:
   - `AgentRuntimeState` (sessionId, stateJson, lastRunId, lastRunStatus, totalInputTokens, totalOutputTokens, totalCachedInputTokens, totalCostCents, lastError)
   - `AgentTaskSession` (id, agentId, taskKey, adapterType, sessionParamsJson, sessionDisplayId, lastRunId, lastError)
   - `UpsertTaskSessionPayload` (taskKey, sessionParamsJson, sessionDisplayId, lastRunId?)
   - `ResetSessionPayload` (taskKey?)

2. Add 4 methods to `src/adapter/paperclip-client.ts`:
   - `getRuntimeState(agentId)` → `GET /agents/{agentId}/runtime-state`
   - `listTaskSessions(agentId)` → `GET /agents/{agentId}/task-sessions`
   - `upsertTaskSession(agentId, payload)` — may need to use `stateJson` field via `updateAgent()` if no direct REST endpoint exists (see Decisions)
   - `resetSession(agentId, taskKey?)` → `POST /agents/{agentId}/runtime-state/reset-session`

### Phase B: SessionManager Refactor (depends on A)

3. Update `SessionManager` constructor (~L70) to accept optional `PaperclipClient` + `agentId`:
   ```typescript
   constructor(config: SessionManagerConfig, paperclipClient?: PaperclipClient, agentId?: string)
   ```
   When present, use Paperclip for persistence; when absent, fall back to local file (backward compat).

4. Refactor `loadSessionIndex()` (~L99-110):
   - When PaperclipClient available: call `listTaskSessions(agentId)` → convert to in-memory Map keyed by `taskKey`
   - Fallback: read `session-index.json` as today

5. Replace `saveSessionIndex()` (~L116-124) with `saveSessionEntry(taskKey, sessionId)`:
   - Call `upsertTaskSession()` with `{ taskKey, sessionParamsJson: { sessionId }, sessionDisplayId }`
   - Also write through to local `session-index.json` as degradation cache

6. Refactor `getOrCreateAgentSession()` (~L176-239):
   - Derive `taskKey` from issue ID: `"issue:{issueId}"` (Paperclip convention) instead of `"${agentName}:${storyId}"`
   - On cache miss, query Paperclip for task session → attempt resume with stored `sessionParamsJson.sessionId`
   - On resume failure, create new session → upsert updated params
   - On success, update task session with current `lastRunId`

7. Add `removeSessionEntry(taskKey)` that calls `resetSession(agentId, taskKey)`.

### Phase C: Heartbeat Integration (depends on B)

8. Update `src/heartbeat-entrypoint.ts` (~L502-520, bootstrap SDK section) to pass `PaperclipClient` + `agentId` to `SessionManager` constructor.

9. After all issues processed, optionally report cumulative token counts to runtime state (board visibility).

### Phase D: Migration & Cleanup

10. On first load, if local `session-index.json` exists and Paperclip has no sessions, migrate entries:
    - Re-key from `agentName:storyId` → `"issue:{issueId}"` format
    - Upsert each entry to Paperclip

11. Add deprecation log warning when falling back to local file.

## Relevant Files

| File | Change |
|------|--------|
| `src/adapter/paperclip-client.ts` | Add 4 methods: getRuntimeState, listTaskSessions, upsertTaskSession, resetSession |
| `src/adapter/session-manager.ts` | Major refactor: constructor (L70), loadSessionIndex (L99-110), saveSessionIndex (L116-124), getOrCreateAgentSession (L176-239) |
| `src/heartbeat-entrypoint.ts` | Pass PaperclipClient to SessionManager (L502-520) |
| `src/types/runtime-state.ts` | New file — runtime state type definitions |

## Paperclip API Reference

### Endpoints

| Method | Path | Access | Purpose |
|--------|------|--------|---------|
| GET | `/api/agents/{id}/runtime-state` | Board-only | Fetch agent's aggregate state + latest session info |
| GET | `/api/agents/{id}/task-sessions` | Board-only | List all task-scoped sessions for agent |
| POST | `/api/agents/{id}/runtime-state/reset-session` | Board-only | Clear sessions (all or by taskKey) |

### Database Schema

**`agent_task_sessions`** — one row per (agent, task):
- `id` (uuid PK)
- `agentId`, `companyId` (FK)
- `adapterType` (text — must match agent's adapter)
- `taskKey` (text — unique identifier, e.g., `"issue:{uuid}"`)
- `sessionParamsJson` (jsonb — adapter-specific resumption params, e.g., `{ "sessionId": "..." }`)
- `sessionDisplayId` (text — human-readable ID for board UI)
- `lastRunId` (uuid FK — most recent heartbeat run)
- `lastError` (text)
- Unique constraint: `(companyId, agentId, adapterType, taskKey)`

**`agent_runtime_state`** — one row per agent:
- `agentId` (uuid PK)
- `sessionId`, `stateJson` (aggregate state)
- `totalInputTokens`, `totalOutputTokens`, `totalCachedInputTokens`, `totalCostCents` (cumulative)
- `lastRunId`, `lastRunStatus`, `lastError`

### TaskKey Convention

- If issue ID provided → `"issue:{issueId}"`
- If task ID provided → `"task:{taskId}"`
- Else → random UUID

### Session Lifecycle

1. **Create**: heartbeat runs, agent works on issue → `upsertTaskSession({ taskKey: "issue:abc", sessionParamsJson: { sessionId: "copilot-xyz" } })`
2. **Resume**: next heartbeat for same (agent, issue) → `listTaskSessions()` → find entry → `resumeSession(sessionParamsJson.sessionId)` → update `lastRunId`
3. **Reset**: board operator or code → `POST /agents/{id}/runtime-state/reset-session { taskKey: "issue:abc" }` → deletes that session only
4. **Full reset**: `POST /agents/{id}/runtime-state/reset-session {}` → deletes ALL sessions + clears `stateJson`

## Verification

1. `pnpm typecheck` passes
2. Unit test: mock task-session methods → verify `SessionManager` round-trips data through API
3. Unit test: verify fallback to local file when `PaperclipClient` is null
4. Integration test:
   - Heartbeat 1: agent works on issue-123 → verify `upsertTaskSession` called with `taskKey: "issue:{uuid}"` and `sessionParamsJson`
   - Heartbeat 2: same agent, same issue → verify prior session found → `resumeSession` called with stored ID
   - Board: `GET /agents/{id}/task-sessions` shows the entry
5. Resilience test: simulate Paperclip API timeout → verify local file fallback
6. `pnpm test:run` passes

## Decisions

- **Local `session-index.json` becomes write-through cache**, not eliminated immediately — provides graceful degradation during Paperclip outages
- **TaskKey format**: `"issue:{paperclipIssueUUID}"` (matches Paperclip convention)
- **Agent JWT access**: task-session endpoints are board-only. Agent JWT may have board-equivalent access for its own agent ID — needs validation. If blocked, fall back to storing session mapping in `stateJson` field on `agent_runtime_state` via `updateAgent()`
- **No automatic session expiry** — rely on manual reset via board UI or `resetSession()` API
- **Resume failures handled gracefully**: create new session, upsert updated params (no crash on expired Copilot session)
- **Migration**: one-time re-keying from `agentName:storyId` → `"issue:{issueId}"` format on first load

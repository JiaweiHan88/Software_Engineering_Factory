# P2-9 — Routines Support for Scheduled Recurring Tasks

> **Date:** 2026-03-25
> **Priority:** P2 — Valuable
> **Effort:** Medium (1-4h)
> **Status:** Planned

## Summary

Add routines CRUD + trigger management to `PaperclipClient`, then wire the CEO orchestrator to create routines for recurring work (sprint reviews, retrospectives, audits).

## Steps

### Phase A+B: Client & Types (parallel)

1. Create `src/types/routine.ts` with interfaces mirroring Paperclip's shared types:
   - `Routine`, `RoutineTrigger`, `RoutineRun`, `RoutineDetail`
   - `CreateRoutinePayload`, `UpdateRoutinePayload`
   - `CreateRoutineTriggerPayload`, `UpdateRoutineTriggerPayload`
   - `RunRoutinePayload`

2. Add 8 methods to `src/adapter/paperclip-client.ts` following existing patterns (e.g., `createIssue()` at ~L527):
   - `listRoutines(filters?)` → `GET /companies/{companyId}/routines`
   - `createRoutine(payload)` → `POST /companies/{companyId}/routines`
   - `getRoutine(routineId)` → `GET /routines/{routineId}`
   - `updateRoutine(routineId, payload)` → `PATCH /routines/{routineId}`
   - `createRoutineTrigger(routineId, payload)` → `POST /routines/{routineId}/triggers`
   - `updateRoutineTrigger(triggerId, payload)` → `PATCH /routine-triggers/{triggerId}`
   - `deleteRoutineTrigger(triggerId)` → `DELETE /routine-triggers/{triggerId}`
   - `runRoutine(routineId, payload?)` → `POST /routines/{routineId}/run`

### Phase C: CEO Delegation (depends on A+B)

3. Extend `DelegationTask` type in `src/adapter/ceo-orchestrator.ts` (~L50-86) with optional field:
   ```typescript
   recurring?: {
     cronExpression: string;
     timezone?: string;
     concurrencyPolicy?: 'coalesce_if_active' | 'always_enqueue' | 'skip_if_active';
   }
   ```

4. In the issue creation loop (~L729-845), when a task has `recurring`, call `createRoutine()` + `createRoutineTrigger()` instead of `createIssue()`.

5. Update `buildDelegationPrompt()` (~L233-392) to explain when CEO should mark a task as recurring vs one-shot.

### Phase D: Setup Script (depends on A)

6. Optionally seed two routines in `scripts/setup-paperclip-company.ts` behind `--with-routines` flag:
   - Weekly "Sprint Retrospective" assigned to SM agent
   - Biweekly "Sprint Planning" assigned to SM agent

## Relevant Files

| File | Change |
|------|--------|
| `src/adapter/paperclip-client.ts` | Add 8 methods, follow `createIssue()` pattern at ~L527 |
| `src/adapter/ceo-orchestrator.ts` | Extend `DelegationTask` (L50-86), prompt (L233-392), issue loop (L729-845) |
| `src/types/routine.ts` | New file — routine type definitions |
| `scripts/setup-paperclip-company.ts` | Optional routine seeding after agent creation (~L668) |

## Paperclip API Reference

### Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/companies/{companyId}/routines` | List routines |
| POST | `/api/companies/{companyId}/routines` | Create routine |
| GET | `/api/routines/{id}` | Get routine detail (includes triggers, recent runs) |
| PATCH | `/api/routines/{id}` | Update routine |
| POST | `/api/routines/{id}/triggers` | Create trigger (schedule/webhook/api) |
| PATCH | `/api/routine-triggers/{id}` | Update trigger |
| DELETE | `/api/routine-triggers/{id}` | Delete trigger |
| POST | `/api/routines/{id}/run` | Manually execute routine |
| GET | `/api/routines/{id}/runs?limit=50` | List run history |

### Key Types (from Paperclip `packages/shared`)

```typescript
// CreateRoutine request
{
  projectId: string;          // UUID, required
  goalId?: string | null;
  parentIssueId?: string | null;
  title: string;              // 1-200 chars
  description?: string | null;
  assigneeAgentId: string;    // UUID, required
  priority?: "low" | "medium" | "high";  // default: "medium"
  status?: "active" | "paused" | "archived";  // default: "active"
  concurrencyPolicy?: "coalesce_if_active" | "always_enqueue" | "skip_if_active";
  catchUpPolicy?: "skip_missed" | "enqueue_missed_with_cap";
}

// CreateRoutineTrigger (schedule variant)
{
  kind: "schedule";
  cronExpression: string;
  timezone?: string;           // default: "UTC"
  label?: string | null;
  enabled?: boolean;           // default: true
}

// RunRoutine request
{
  triggerId?: string | null;
  payload?: Record<string, unknown> | null;
  idempotencyKey?: string | null;
  source?: "manual" | "api";   // default: "manual"
}
```

### How Routines Trigger Agent Work

1. Scheduler ticks periodically, finds triggers where `nextRunAt ≤ now`
2. `dispatchRoutineRun()` creates a `routine_run` record
3. Concurrency policy checked (skip/coalesce/enqueue)
4. Creates execution issue: `{ originKind: "routine_execution", status: "todo", assigneeAgentId: ... }`
5. Queues heartbeat wakeup → agent invoked automatically

## Verification

1. `pnpm typecheck` passes
2. Unit test: mock routine client methods with expected request/response shapes
3. Integration: create routine with schedule trigger → `runRoutine()` → verify issue created with `originKind: "routine_execution"` and heartbeat fires
4. E2E: create routine with 1-min cron → wait 90s → verify auto-created issue + agent wake

## Decisions

- `coalesce_if_active` default concurrency (prevents duplicate work)
- `skip_missed` default catch-up (no backlog creation on restart)
- Webhook triggers excluded from initial scope (schedule + API only)
- Routines are board-level; CEO creates them, agents don't call routine APIs directly

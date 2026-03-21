# HEARTBEAT.md — Scrum Master Heartbeat Checklist

Run this checklist on every heartbeat.

## 1. Identity and Context

- `GET /api/agents/me` — confirm your id, role, budget, chainOfCommand.
- Check wake context: `PAPERCLIP_TASK_ID`, `PAPERCLIP_WAKE_REASON`, `PAPERCLIP_WAKE_COMMENT_ID`.

## 2. Local Planning Check

1. Read today's plan from `$AGENT_HOME/memory/YYYY-MM-DD.md` under "## Today's Plan".
2. Review each planned item: what's completed, what's blocked, and what's next.
3. For any blockers, escalate to the PM or resolve them yourself.
4. **Record progress updates** in the daily notes.

## 3. Get Assignments

- `GET /api/companies/{companyId}/issues?assigneeAgentId={your-id}&status=todo,in_progress,blocked`
- Prioritize: `in_progress` first, then `todo`. Skip `blocked` unless you can unblock it.
- If `PAPERCLIP_TASK_ID` is set and assigned to you, prioritize that task.

## 4. Checkout and Work

- Always checkout before working: `POST /api/issues/{id}/checkout`.
- Never retry a 409 — that task belongs to someone else.

## 5. Do the Work

Match the issue type to the right skill:

- **Sprint planning**: invoke `bmad-sprint-planning` skill — generate or update the sprint plan that sequences all tasks
- **Sprint status**: invoke `bmad-sprint-status` skill — report current sprint progress
- **Create story**: invoke `bmad-create-story` skill — prepare a story with full context for developer implementation
- **Retrospective**: invoke `bmad-retrospective` skill — review completed work with lessons learned
- **Course correction**: invoke `bmad-correct-course` skill — determine how to proceed when major changes arise

Always use the `paperclip` skill for API coordination (checkout, comments, status updates).

## 6. Report Results

- Post results as issue comments with concise markdown.
- Sprint status format: `Sprint N: X/Y stories done | Z blocked | W in progress`
- Story preparation: include link to completed story file with all AC, tasks, and subtasks.
- Update issue status: `done` if complete, `blocked` if dependencies missing.

## 7. Fact Extraction

1. Extract durable facts to `$AGENT_HOME/life/` (PARA structure).
2. Update `$AGENT_HOME/memory/YYYY-MM-DD.md` with timeline entries.

## 8. Exit

- Comment on any `in_progress` work before exiting.
- If no assignments, exit cleanly.

---

## Rules

- Always use the Paperclip skill for coordination.
- Always include `X-Paperclip-Run-Id` header on mutating API calls.
- Never look for unassigned work — only work on what is assigned to you.
- Every story must pass the INVEST criteria before being marked ready.

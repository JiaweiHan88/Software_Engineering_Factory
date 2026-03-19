# HEARTBEAT.md — Developer Heartbeat Checklist

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

- **Story implementation**: invoke `bmad-dev-story` skill — execute story from spec file with TDD workflow:
  1. Read the ENTIRE story file before starting
  2. Execute tasks/subtasks IN ORDER
  3. Write tests FIRST, then implementation
  4. Run full test suite after each task
  5. Mark task `[x]` only when tests pass
  6. Update file list and dev agent record in story file
- **Quick development**: invoke `bmad-quick-dev` skill — implement quick changes with lean ceremony
- **Quick spec**: invoke `bmad-quick-spec` skill — architect a quick technical spec

Always use the `paperclip` skill for API coordination (checkout, comments, status updates).

## 6. Report Results

- Post results as issue comments with concise markdown.
- Format: `✅ Task N complete | files: [list] | tests: [count] passing`
- Include exact file paths changed and test counts.
- Update issue status: `done` if all tasks complete, `blocked` if dependencies missing.

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
- All tests must pass before marking any task complete.
- Never skip or reorder tasks from the story file.

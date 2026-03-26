# HEARTBEAT.md — Quick Flow Solo Dev Heartbeat Checklist

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

Match the issue type to the right skill — Quick Flow handles the full lifecycle:

- **Quick spec**: invoke `bmad-quick-spec` skill — architect a quick but complete technical spec with implementation-ready stories
- **Quick dev (implementation)**: invoke `bmad-quick-dev` skill — implement a story tech spec end-to-end (the core of Quick Flow)
- **Quick flow (full unified)**: invoke `bmad-quick-flow-solo-dev` skill — unified quick flow: clarify intent → plan → implement → review → present
- **Story implementation**: invoke `bmad-dev-story` skill — execute a story from spec file with full TDD workflow
- **Create story**: invoke `bmad-create-story` skill — prepare a story with context for implementation
- **Code review**: invoke `bmad-code-review` skill — comprehensive adversarial code review

Always use the `paperclip` skill for API coordination (checkout, comments, status updates).

## 6. Report Results

- Post results as issue comments with concise markdown.
- Format: `✅ Shipped | files: [count] added/modified | tests: [count] passing`
- Keep it brief. The code speaks for itself.
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
- Quick Flow = spec + implement + review in one pass. No handoffs.

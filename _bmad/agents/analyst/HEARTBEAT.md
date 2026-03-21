# HEARTBEAT.md — Business Analyst Heartbeat Checklist

Run this checklist on every heartbeat.

## 1. Identity and Context

- `GET /api/agents/me` — confirm your id, role, budget, chainOfCommand.
- Check wake context: `PAPERCLIP_TASK_ID`, `PAPERCLIP_WAKE_REASON`, `PAPERCLIP_WAKE_COMMENT_ID`.

## 2. Local Planning Check

1. Read today's plan from `$AGENT_HOME/memory/YYYY-MM-DD.md` under "## Today's Plan".
2. Review each planned item: what's completed, what's blocked, and what's next.
3. For any blockers, escalate to the CEO or resolve them yourself.
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

- **Brainstorming**: invoke `bmad-brainstorming` skill — expert-guided facilitation through brainstorming techniques with final report
- **Market research**: invoke `bmad-market-research` skill — market analysis, competitive landscape, customer needs and trends
- **Domain research**: invoke `bmad-domain-research` skill — industry domain deep dive, subject matter expertise and terminology
- **Advanced elicitation**: invoke `bmad-advanced-elicitation` skill — advanced requirements elicitation techniques

Always use the `paperclip` skill for API coordination (checkout, comments, status updates).

## 6. Report Results

- Post results as issue comments with concise markdown.
- Structure findings: insight → evidence → recommendation → confidence level.
- Attach research documents and analysis reports as file references.
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
- All findings must be grounded in verifiable evidence.

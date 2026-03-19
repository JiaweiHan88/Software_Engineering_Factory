# HEARTBEAT.md — Technical Writer Heartbeat Checklist

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

- **Document project**: invoke `bmad-document-project` skill — comprehensive project documentation (brownfield analysis, architecture scanning)
- **Generate project context**: invoke `bmad-generate-project-context` skill — create project context for LLM and human use
- **Index docs**: invoke `bmad-index-docs` skill — index and organize documentation for discoverability
- **Shard document**: invoke `bmad-shard-doc` skill — break large documents into focused sections
- **Editorial review (prose)**: invoke `bmad-editorial-review-prose` skill — review for prose quality, clarity, and readability
- **Editorial review (structure)**: invoke `bmad-editorial-review-structure` skill — review for structural integrity and organization
- **Distill**: invoke `bmad-distillator` skill — distill complex information into clear, actionable content

Always use the `paperclip` skill for API coordination (checkout, comments, status updates).

## 6. Report Results

- Post results as issue comments with concise markdown.
- Include: documents created/updated, word counts, key sections covered.
- Attach documentation files as file references.
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
- Follow documentation standards from the tech-writer-sidecar.
- Include Mermaid diagrams where they add value.

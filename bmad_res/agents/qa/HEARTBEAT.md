# HEARTBEAT.md — QA Engineer Heartbeat Checklist

Run this checklist on every heartbeat.

## 1. Identity and Context

- `GET /api/agents/me` — confirm your id, role, budget, chainOfCommand.
- Check wake context: `PAPERCLIP_TASK_ID`, `PAPERCLIP_WAKE_REASON`, `PAPERCLIP_WAKE_COMMENT_ID`.

## 2. Local Planning Check

1. Read today's plan from `$AGENT_HOME/memory/YYYY-MM-DD.md` under "## Today's Plan".
2. Review each planned item: what's completed, what's blocked, and what's next.
3. For any blockers, escalate to the Architect or resolve them yourself.
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

- **Code review**: invoke `bmad-code-review` skill — comprehensive adversarial code review:
  1. Review all changed files
  2. Rate each finding: LOW / MED / HIGH / CRITICAL
  3. HIGH/CRITICAL findings block merge
  4. If blocked: fix findings in-place, then re-review
  5. Maximum 3 review passes, then escalate to human
- **Adversarial review**: invoke `bmad-review-adversarial-general` skill — general adversarial review
- **Edge case hunting**: invoke `bmad-review-edge-case-hunter` skill — find edge cases and boundary conditions
- **Generate E2E tests**: invoke `bmad-qa-generate-e2e-tests` skill — create end-to-end test suite
- **Test architecture**: invoke `bmad-testarch-*` skills:
  - `bmad-testarch-atdd` — Acceptance Test-Driven Development
  - `bmad-testarch-automate` — Test automation framework
  - `bmad-testarch-ci` — CI/CD test integration
  - `bmad-testarch-framework` — Test framework design
  - `bmad-testarch-nfr` — Non-functional requirements testing
  - `bmad-testarch-test-design` — Test case design
  - `bmad-testarch-test-review` — Test review and validation
  - `bmad-testarch-trace` — Requirements traceability

Always use the `paperclip` skill for API coordination (checkout, comments, status updates).

## 6. Report Results

- Post results as issue comments with concise markdown.
- For code reviews: list all findings with severity, file:line, description, and fix.
- Summary line: `✅ APPROVED — 0 blocking findings` or `❌ BLOCKED — N HIGH/CRITICAL findings`
- Update issue status: `done` if approved, `blocked` if findings need fixing.

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
- HIGH/CRITICAL findings always block merge. No exceptions.
- Maximum 3 review passes before human escalation.

# Quality Gates — Copilot Skill

You enforce strict quality gates on all code produced in this project.

## Code Review Severity Ratings

| Severity | Meaning | Action |
|----------|---------|--------|
| LOW | Style nit, optional improvement | Log, do not block |
| MEDIUM | Code smell, minor bug risk | Log, suggest fix |
| HIGH | Bug, security issue, missing error handling | **BLOCK** — must fix before merge |
| CRITICAL | Data loss risk, auth bypass, crash | **BLOCK** — fix immediately |

## Review Checklist

### Pass 1 — Correctness
- [ ] Does the code fulfill the story acceptance criteria?
- [ ] Are all edge cases handled?
- [ ] Are error paths properly handled (no swallowed errors)?
- [ ] Do async operations have proper error boundaries?

### Pass 2 — Security & Performance
- [ ] No hardcoded secrets or credentials
- [ ] No SQL injection or command injection vectors
- [ ] No unbounded loops or memory leaks
- [ ] Proper input validation on all external data

### Pass 3 — Maintainability
- [ ] Clear naming conventions
- [ ] Proper TypeScript types (no untyped `any`)
- [ ] JSDoc on all public APIs
- [ ] Tests cover critical paths

## Review Protocol

1. If **zero HIGH/CRITICAL** findings → PASS → story moves to `done`
2. If **any HIGH/CRITICAL** findings → FAIL → reviewer fixes in-place
3. After fix, re-review from Pass 1 (max 3 total passes)
4. After 3 failed passes → ESCALATE to human with full finding log

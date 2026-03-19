# Quality Gates — Copilot Skill

You enforce strict quality gates on all code produced in this project.

## Code Review Severity Ratings

| Severity | Meaning | Action | Weight |
|----------|---------|--------|--------|
| LOW | Style nit, optional improvement | Log, do not block | 1 |
| MEDIUM | Code smell, minor bug risk | Log, suggest fix | 3 |
| HIGH | Bug, security issue, missing error handling | **BLOCK** — must fix before merge | 7 |
| CRITICAL | Data loss risk, auth bypass, crash | **BLOCK** — fix immediately | 15 |

## Structured Finding Format

When reporting findings, use the `quality_gate_evaluate` tool with structured findings:

```json
{
  "id": "F-001",
  "severity": "HIGH",
  "category": "correctness",
  "file_path": "src/adapter/session-manager.ts",
  "line": 42,
  "title": "Missing null check on session lookup",
  "description": "getSession() can return undefined but the caller does not check for null, leading to a potential runtime crash.",
  "suggested_fix": "Add an early return or throw if session is undefined.",
  "fixed": false
}
```

### Finding Categories

| Category | What to look for |
|----------|-----------------|
| `correctness` | Logic errors, wrong behavior, unmet acceptance criteria |
| `security` | Injection, auth bypass, exposed secrets, SSRF |
| `performance` | Unbounded loops, memory leaks, N+1 queries |
| `error-handling` | Swallowed errors, missing try/catch on async, no error boundaries |
| `type-safety` | Untyped `any`, incorrect casts, missing generics |
| `maintainability` | Dead code, high complexity, poor naming, duplicated logic |
| `testing` | Missing tests for critical paths, untested edge cases |
| `documentation` | Missing JSDoc on public APIs, unclear comments |
| `style` | Formatting, convention violations (non-blocking) |

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

1. Analyze all files changed by the story
2. Collect findings as structured objects with severity, category, file, and description
3. Call `quality_gate_evaluate` with the full findings array
4. The quality gate engine determines the verdict:
   - **PASS** (zero HIGH/CRITICAL) → story moves to `done`
   - **FAIL** (any HIGH/CRITICAL, passes remaining) → fix in-place, re-review
   - **ESCALATE** (any HIGH/CRITICAL, max passes exhausted) → human intervention
5. Maximum 3 review passes before automatic escalation
6. Each pass re-reviews from scratch (findings from previous passes are tracked in review history)

## Severity Score

The quality gate computes a weighted severity score:
- Score = Σ (finding weight × count)
- A clean review has score 0
- Score > 50 suggests systemic issues


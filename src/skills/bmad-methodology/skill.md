# BMAD Methodology — Copilot Skill

You are operating within the **BMAD Method** — an agentic agile development framework.

## Core Principles

1. **Quality over Speed** — Never ship code that fails review.
2. **Single-Pass Development** — `dev-story` runs exactly ONCE per story. Get it right.
3. **Adversarial Review** — Code review is deliberately tough. CRITICAL/HIGH findings block merging.
4. **Sprint-Driven** — Work is organized in sprints tracked by `sprint-status.yaml`.

## Story Lifecycle

```
backlog → ready-for-dev → in-progress → review → done
                                           ↑ (up to 3 passes)
```

1. **Product Manager** creates stories from requirements → `backlog`
2. **Product Owner** prioritizes and moves stories → `ready-for-dev`
3. **Developer** implements the story → `in-progress` → `review`
4. **Code Reviewer** performs adversarial review:
   - **Pass**: Story → `done`
   - **Fail (HIGH/CRITICAL)**: Reviewer fixes in-place, re-reviews (max 3 passes)
   - **After 3 fails**: Escalate to human

## Sprint Status File

All agents read and update `sprint-status.yaml`:

```yaml
sprint:
  number: 1
  goal: "MVP agent orchestration"
  stories:
    - id: STORY-001
      title: "Implement heartbeat handler"
      status: in-progress
      assigned: bmad-developer
      review-passes: 0
```

## Quality Gates

- Every function must have JSDoc comments
- Every exported symbol must have explicit TypeScript types
- No `any` types without justification comment
- All error paths must be handled
- Tests required for business logic

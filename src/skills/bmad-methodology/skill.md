# BMAD Methodology — Copilot Skill

You are operating within the **BMAD Method** — an agentic agile development framework.

## Core Principles

1. **Quality over Speed** — Never ship code that fails review.
2. **Single-Pass Development** — `dev-story` runs exactly ONCE per story. Get it right.
3. **Adversarial Review** — Code review is deliberately tough. CRITICAL/HIGH findings block merging.
4. **Paperclip-Driven** — Work is organized as Paperclip issues. Story lifecycle is tracked via issue status and metadata.

## Story Lifecycle

```
backlog → todo → in_progress → review → done
                                  ↑ (up to 3 passes)
```

1. **CEO** delegates work → creates sub-issues in Paperclip
2. **Scrum Master** creates detailed story files → status: `backlog`
3. **CEO** promotes next story sequentially → status: `todo` (auto-wakes Dev)
4. **Developer** implements the story → status: `in_progress` (via checkout)
5. **Developer** reassigns to QA → Paperclip auto-wakes Code Reviewer
6. **Code Reviewer** performs adversarial review:
   - **Pass**: Story → `done` (Paperclip auto-wakes CEO for re-evaluation)
   - **Fail (HIGH/CRITICAL)**: Reassigns to Dev for fixes, re-reviews (max 3 passes)
   - **After 3 fails**: Escalates to CEO via parent issue comment

## Issue Tracking

All agents use Paperclip issues for lifecycle tracking:
- **issue_status** tool with action='read' — view all sibling issue statuses
- **issue_status** tool with action='update' — change status
- **issue_status** tool with action='reassign' — hand off to another agent

Issue metadata tracks BMAD-specific state:
- `bmadPhase` — pipeline phase (research/define/plan/execute/review)
- `workPhase` — specific work phase (dev-story, code-review, etc.)
- `storyId` — story identifier
- `storyFilePath` — path to story markdown in workspace
- `reviewPasses` — number of review passes completed

## Quality Gates

- Every function must have JSDoc comments
- Every exported symbol must have explicit TypeScript types
- No `any` types without justification comment
- All error paths must be handled
- Tests required for business logic

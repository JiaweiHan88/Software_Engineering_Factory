# BMAD Copilot Factory — Copilot Instructions

## Project Overview

This is the **BMAD Copilot Factory** — an autonomous software building system that uses:
- **Paperclip** for orchestration (org charts, goals, governance, heartbeats)
- **GitHub Copilot SDK** for agent runtime (custom agents, tools, MCP, skills)
- **BMAD Method** for agile methodology (story lifecycle, quality-gated review)

## Architecture

```
Paperclip → Heartbeat Adapter → Copilot SDK → Copilot CLI (headless)
```

BMAD roles (PM, Architect, Developer, Code Reviewer, Product Owner) are implemented
as Copilot SDK `customAgents` with persona prompts. BMAD processes (create-story,
dev-story, code-review, sprint-status) are implemented as `defineTool()` tools.

## Coding Standards

- **TypeScript** with strict mode, ESM modules
- **No `any` types** without explicit justification comment
- **JSDoc** on all exported functions and types
- **Error handling** — all async operations must have error boundaries
- **No hardcoded secrets** — use environment variables
- **Tests** — vitest for all business logic

## File Organization

- `src/agents/` — BMAD agent persona definitions (one file per role)
- `src/tools/` — Copilot SDK tool definitions (one file per tool)
- `src/adapter/` — Paperclip ↔ Copilot SDK bridge
- `src/skills/` — Copilot skills (methodology & quality gate prompts)
- `src/mcp/` — MCP server definitions
- `src/sandbox/` — Smoke-test / exploration scripts
- `docs/` — Architecture and design documentation
- `templates/` — Clipper presets and Paperclip role templates

## BMAD Story Lifecycle

```
backlog → ready-for-dev → in-progress → review → done
```

- `dev-story` runs exactly ONCE per story
- Code review is adversarial with severity ratings (LOW/MED/HIGH/CRITICAL)
- HIGH/CRITICAL findings block merge; reviewer fixes in-place
- Maximum 3 review passes before human escalation

## Key Dependencies

- `@github/copilot-sdk` — Copilot SDK (Technical Preview v0.1.32)
- `tsx` — TypeScript execution for development
- `vitest` — Testing framework
- `typescript` — Compiler with strict mode

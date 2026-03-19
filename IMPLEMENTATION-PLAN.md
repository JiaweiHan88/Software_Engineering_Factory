# BMAD Copilot Factory — Implementation Plan

**Project:** Autonomous Software Building Factory  
**Stack:** Paperclip (orchestration) + Copilot SDK (agent runtime) + BMAD Method (methodology)  
**Date:** March 19, 2026  
**Last Updated:** March 19, 2026

---

## Progress Summary

| Phase | Commit | Status |
|-------|--------|--------|
| **Phase 0** — Scaffolding | `845fc88` | ✅ Complete |
| **Phase 1** — SDK Connectivity | `66e3bd8` | ✅ Complete |
| **Phase 2** — BMAD Tools | `281c74c` | ✅ Complete |
| **BMAD V6 Agents** | `31f85a9` | ✅ Complete (9 authentic agents) |
| **Phase 3** — Orchestrator Engine | `5d8d4b8` | ✅ Complete |
| **Phase 4** — Paperclip Integration | — | ✅ Complete |
| **Phase 5** — MCP Server | — | ✅ Complete |
| **Phase 6** — Quality Gates | — | ✅ Complete |
| **Phase 7** — Production Hardening | — | 🔜 Next |

---

## Current State

| Item | Status |
|------|--------|
| Workspace | `/Users/Q543651/repos/AI Repo/BMAD_Copilot_RT` — 2 markdown files, no git repo |
| Node.js | ❌ **Not installed** |
| npm / pnpm | ❌ **Not installed** |
| Homebrew | ❌ **Not installed** |
| GitHub CLI (`gh`) | ❌ **Not installed** |
| Copilot CLI (`copilot`) | ❌ **Not installed** |
| Git | ✅ 2.50.1 |
| Docker | ✅ Available |
| Python | ⚠️ 3.9.6 (system) |

---

## 🔴 Things I Need From You (Blockers)

These are ordered. Each phase has a "gate" — work below it is blocked until you complete the action.

### GATE 0 — Foundation Tools (blocks everything)

| # | Action | How | Why |
|---|--------|-----|-----|
| **Y1** | **Install Homebrew** | `/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"` | Package manager for everything else |
| **Y2** | **Install Node.js 20+** | `brew install node@22` | Copilot SDK, Paperclip, and Clipper all require Node.js 20+ |
| **Y3** | **Install pnpm** | `npm install -g pnpm` | Paperclip uses pnpm workspaces |
| **Y4** | **Install GitHub CLI** | `brew install gh` then `gh auth login` | Needed for Copilot CLI, GitHub MCP, repo management |
| **Y5** | **Install Copilot CLI** | `gh extension install github/gh-copilot` then follow setup, or see [install docs](https://docs.github.com/en/copilot/how-tos/set-up/install-copilot-cli) | The agent runtime that the SDK wraps |

> **After you complete Y1-Y5**, tell me and I'll verify everything works and continue.

### GATE 1 — Accounts & Credentials (blocks Phase 2+)

| # | Action | How | Why |
|---|--------|-----|-----|
| **Y6** | **Confirm GitHub Copilot subscription tier** | Check at github.com/settings/copilot — need at least **Pro** ($10/mo) for Copilot CLI + agent features | SDK + CLI require an active subscription |
| **Y7** | **Create a GitHub repo** for this project | `gh repo create BMAD_Copilot_RT --public --source .` (or private, your choice) | Central source control, needed for GitHub MCP server integration |
| **Y8** | **(Optional) Provide BYOK API keys** | If you want to use your own Anthropic/OpenAI keys instead of Copilot quota: export `ANTHROPIC_API_KEY` and/or `OPENAI_API_KEY` | Cost control — avoids using Copilot premium request quota |

### GATE 2 — Paperclip Setup (blocks Phase 4+)

| # | Action | How | Why |
|---|--------|-----|-----|
| **Y9** | **Verify Paperclip runs** | After I scaffold the Docker Compose setup, run `docker compose up` and confirm the UI loads at `http://localhost:3100` | Paperclip needs PostgreSQL, which runs in Docker |

---

## 🟢 Things I Can Do Autonomously

Once the gates are cleared, I can build all of this without interrupting you.

---

## Implementation Phases

### Phase 0 — Project Scaffolding *(I can start now)*

**Goal:** Working repo structure, TypeScript project, docs.

**What I build:**
```
BMAD_Copilot_RT/
├── README.md                          # Project overview
├── package.json                       # Root workspace
├── tsconfig.json                      # TypeScript config
├── .gitignore
├── .github/
│   └── copilot-instructions.md        # Custom Copilot instructions for this repo
├── docs/
│   ├── research-autonomous-sw-factory.md  # (existing, moved)
│   └── architecture.md                # Architecture decisions
├── src/
│   ├── agents/                        # BMAD agent definitions
│   │   ├── index.ts                   # Agent registry
│   │   ├── product-manager.ts         # BMAD PM persona
│   │   ├── architect.ts               # BMAD Architect persona
│   │   ├── developer.ts               # BMAD Developer persona
│   │   ├── code-reviewer.ts           # BMAD Code Reviewer persona
│   │   └── product-owner.ts           # BMAD PO persona
│   ├── tools/                         # BMAD tools (Copilot SDK defineTool)
│   │   ├── index.ts                   # Tool registry
│   │   ├── create-story.ts            # Story creation tool
│   │   ├── dev-story.ts               # Story implementation tool
│   │   ├── code-review.ts             # Code review tool
│   │   └── sprint-status.ts           # Sprint status tool
│   ├── skills/                        # Copilot SDK skills (prompt modules)
│   │   ├── bmad-methodology/          # BMAD process knowledge
│   │   ├── quality-gates/             # Review standards
│   │   └── architecture-patterns/     # Arch decision templates
│   ├── adapter/                       # Paperclip ↔ Copilot SDK bridge
│   │   ├── heartbeat-handler.ts       # Translates heartbeats → SDK sessions
│   │   ├── session-manager.ts         # Session lifecycle + persistence
│   │   └── reporter.ts               # Reports back to Paperclip
│   ├── mcp/                           # Custom MCP servers
│   │   └── bmad-sprint-server/        # Sprint status, story queue MCP
│   ├── config/                        # Configuration
│   │   ├── model-strategy.ts          # Complexity → model tier mapping
│   │   └── paperclip.ts              # Paperclip connection config
│   └── index.ts                       # Main entry point
├── templates/                         # Clipper BMAD preset
│   ├── presets/
│   │   └── bmad-factory/
│   │       └── preset.meta.json
│   ├── roles/                         # Paperclip role templates
│   │   ├── bmad-pm/
│   │   ├── bmad-architect/
│   │   ├── bmad-developer/
│   │   ├── bmad-code-reviewer/
│   │   └── bmad-product-owner/
│   └── modules/                       # Paperclip module templates
│       ├── bmad-sprint/
│       ├── bmad-quality-gates/
│       └── bmad-story-lifecycle/
├── docker-compose.yml                 # Paperclip + PostgreSQL
└── orchestrator.md                    # (existing — Claw Loop reference)
```

**Blocked by:** Nothing — I can create the structure now  
**Your action needed:** None yet

---

### Phase 1 — Copilot SDK Hello World *(needs GATE 0)*

**Goal:** Prove the Copilot SDK works, send a message, define a custom tool, verify JSON-RPC to CLI.

**What I build:**
- `src/sandbox/hello-copilot.ts` — minimal SDK client + session + tool
- `src/sandbox/test-agent.ts` — custom agent with BMAD-style prompt
- Test scripts in `package.json`

**Key validation:**
```typescript
import { CopilotClient, defineTool } from "@github/copilot-sdk";
const client = new CopilotClient();
const session = await client.createSession({
  customAgents: [{
    name: "bmad-dev",
    prompt: "You are a senior developer following the BMAD Method..."
  }],
  tools: [myTool],
});
const response = await session.sendAndWait({ prompt: "Create a hello world Express app" });
```

**Blocked by:** Y1-Y5 (Node.js, Copilot CLI)  
**Your action needed:** Confirm tools installed, run `npm test`

---

### Phase 2 — BMAD Agent Definitions *(needs Phase 1 working)*

**Goal:** All 5 BMAD roles defined as Copilot SDK custom agents with full persona prompts.

**What I build:**
- Each agent file exports a `customAgent` config object:
  - **Product Manager** — writes PRDs, defines user stories, prioritizes backlog
  - **Architect** — designs system architecture, tech stack decisions, data models
  - **Developer** — implements stories, writes code, runs tests
  - **Code Reviewer** — adversarial review, finds bugs, security issues
  - **Product Owner** — sprint planning, acceptance criteria, stakeholder voice

- Each agent includes:
  - `name` / `displayName` / `description`
  - `prompt` — full BMAD persona (adapted from BMAD Method templates)
  - Scoped tool access (e.g., Dev gets `dev-story`, Reviewer gets `code-review`)

**Blocked by:** Phase 1 verified  
**Your action needed:** Review agent persona prompts (optional)

---

### Phase 3 — BMAD Tools *(needs Phase 2)*

**Goal:** BMAD workflow steps as callable Copilot SDK tools.

**What I build:**

| Tool | SDK Definition | What It Does |
|------|---------------|--------------|
| `create_story` | `defineTool("create_story", ...)` | Generates story file with ACs, tasks, subtasks from backlog |
| `dev_story` | `defineTool("dev_story", ...)` | Implements a story: code, tests, migrations |
| `code_review` | `defineTool("code_review", ...)` | Adversarial review with severity ratings |
| `sprint_status` | `defineTool("sprint_status", ...)` | Reads/updates sprint-status.yaml |
| `advance_story` | `defineTool("advance_story", ...)` | Moves story through lifecycle states |
| `model_select` | `defineTool("model_select", ...)` | Picks model tier based on complexity |

Each tool:
- Has a JSON schema for parameters
- Has a handler function that executes the BMAD logic
- Returns structured results the agent can interpret

**Blocked by:** Phase 2  
**Your action needed:** None

---

### Phase 4 — Paperclip Integration *(needs GATE 2)*

**Goal:** Paperclip running locally, BMAD roles registered as agents, heartbeats trigger Copilot SDK sessions.

**What I build:**
- `docker-compose.yml` with Paperclip + PostgreSQL
- Clipper preset `bmad-factory` with all BMAD roles and modules
- `src/adapter/heartbeat-handler.ts`:
  ```
  Paperclip heartbeat fires
    → Read assigned ticket from Paperclip API
    → Determine which BMAD agent should handle it
    → Create/resume Copilot SDK session with that agent
    → Send prompt with ticket context
    → Stream results back to Paperclip ticket
  ```
- `src/adapter/session-manager.ts` — session persistence across heartbeats
- `src/adapter/reporter.ts` — structured status reports to Paperclip

**Blocked by:** Y9 (Docker + Paperclip running)  
**Your action needed:** Run `docker compose up`, confirm Paperclip UI loads

#### Phase 4 — Delivery Summary

**Delivered modules:**
- `src/adapter/paperclip-client.ts` — Full HTTP client for Paperclip REST API (agents, tickets, heartbeats, status reports, orgs/goals)
- `src/adapter/reporter.ts` — Structured status reporting back to Paperclip with audit history
- `src/adapter/paperclip-loop.ts` — Heartbeat-driven integration loop (poll → dispatch → report)
- `src/adapter/heartbeat-handler.ts` — Upgraded with `handlePaperclipHeartbeat()` bridging Paperclip → BMAD
- `src/adapter/health-check.ts` — Added Paperclip connectivity probe (Probe 5)
- `src/config/config.ts` — Extended with `PaperclipConfig` (URL, API key, org ID, poll interval, enabled flag)
- `src/index.ts` — Added `--paperclip` CLI mode with SIGINT/SIGTERM graceful shutdown
- `docker-compose.yml` — Enhanced with BMAD factory service, health checks, `factory` profile
- `Dockerfile` — Multi-stage build for containerized deployment
- `templates/presets/bmad-factory/preset.meta.json` — Enhanced with org chart, modules, Paperclip settings

**CLI usage:**
```
pnpm start:paperclip                    # Run Paperclip integration loop
PAPERCLIP_ENABLED=true pnpm start -- --paperclip   # Same, explicit
docker compose --profile factory up      # Run everything in Docker
```

**Environment variables:**
| Variable | Default | Description |
|----------|---------|-------------|
| `PAPERCLIP_ENABLED` | `false` | Enable Paperclip integration |
| `PAPERCLIP_URL` | `http://localhost:3100` | Paperclip server URL |
| `PAPERCLIP_API_KEY` | *(none)* | API key (optional in local_trusted mode) |
| `PAPERCLIP_ORG_ID` | `bmad-factory` | Organization ID |
| `PAPERCLIP_POLL_INTERVAL_MS` | `5000` | Heartbeat poll interval (ms) |
| `PAPERCLIP_TIMEOUT_MS` | `10000` | API request timeout (ms) |

---

### Phase 5 — BMAD MCP Server *(needs Phase 3)*

**Goal:** Custom MCP server that exposes BMAD sprint data as tools for Copilot.

**What I build:**
- `src/mcp/bmad-sprint-server/` — TypeScript MCP server
- MCP tools exposed:
  - `get_sprint_status` — current sprint state
  - `get_next_story` — next story in queue
  - `update_story_status` — move story through lifecycle
  - `get_architecture_docs` — project architecture context
  - `get_story_details` — full story with ACs and tasks

**Blocked by:** Phase 3  
**Your action needed:** None

#### Phase 5 — Delivery Summary

**Delivered modules:**
- `src/mcp/bmad-sprint-server/index.ts` — MCP server entry point with stdio transport, protocol handshake, tool registration
- `src/mcp/bmad-sprint-server/tools.ts` — 5 MCP tool handler implementations reusing existing sprint-status utilities
- `src/mcp/index.ts` — Barrel exports for MCP module
- `.vscode/mcp.json` — VS Code / Copilot MCP server discovery configuration

**Dependencies added:**
- `@modelcontextprotocol/sdk` ^1.27.1

**MCP tools registered:**

| Tool | Parameters | Description |
|------|-----------|-------------|
| `get_sprint_status` | *(none)* | Returns sprint number, goal, all stories with status counts |
| `get_next_story` | *(none)* | Finds first `ready-for-dev` story, includes full markdown |
| `update_story_status` | `story_id`, `new_status`, `assigned?`, `increment_review_pass?` | Moves story through lifecycle with transition validation |
| `get_architecture_docs` | `include_file_list?` | Reads `docs/architecture.md`, optionally lists all docs |
| `get_story_details` | `story_id` | Sprint metadata + full story markdown content |

**Lifecycle transition validation:**
- Forward: `backlog → ready-for-dev → in-progress → review → done`
- Rework: `review → in-progress` (failed code review)
- Reopen: `done → review` (re-review)
- Backward: `ready-for-dev → backlog`, `in-progress → ready-for-dev`

**CLI usage:**
```
pnpm mcp:sprint                          # Run MCP server (stdio)
tsx src/mcp/bmad-sprint-server/index.ts   # Run directly
```

**Verified:** TypeScript compiles clean, MCP initialize handshake succeeds, `tools/list` returns all 5 tools with correct JSON schemas, `tools/call` for `get_sprint_status` and `get_next_story` return correct data from `_bmad-output/sprint-status.yaml`.

---

### Phase 6 — Quality Gates *(needs Phase 4)*

**Goal:** BMAD's adversarial review loop working end-to-end.

**What I build:**
- SDK hooks for pre/post tool execution validation
- Quality gate logic:
  ```
  dev-story completes → code-review runs → 
    if HIGH/CRITICAL → fix in-place → re-review (max 3 passes) →
    if CLEAN → advance story to done
  ```
- Paperclip approval gate for human override

**Blocked by:** Phase 4  
**Your action needed:** None

#### Phase 6 — Delivery Summary

**Delivered modules:**

| Module | File | Description |
|--------|------|-------------|
| Quality Gate Types | `src/quality-gates/types.ts` | Severity levels (LOW→CRITICAL), structured findings, gate verdicts (PASS/FAIL/ESCALATE), review history, orchestrator actions |
| Quality Gate Engine | `src/quality-gates/engine.ts` | Pure logic: severity analysis, weighted scoring, gate evaluation, verdict decision, formatted reports |
| Review Orchestrator | `src/quality-gates/review-orchestrator.ts` | Full review loop: dispatch review → parse findings → evaluate gate → fix or approve → persist history |
| Quality Gate Tool | `src/quality-gates/tool.ts` | Copilot SDK `defineTool("quality_gate_evaluate")` — structured findings → verdict |
| Barrel Export | `src/quality-gates/index.ts` | Module barrel export for all quality gate types, engine, orchestrator, and tool |

**Updated modules:**

| Module | Changes |
|--------|---------|
| `src/tools/code-review.ts` | Review protocol now instructs agents to use `quality_gate_evaluate` with structured findings; added severity guide and finding format reference |
| `src/tools/index.ts` | Added `qualityGateEvaluateTool` to `allTools` array and exports |
| `src/adapter/agent-dispatcher.ts` | Added `qualityGateEvaluateTool` to code-review phase tool list |
| `src/adapter/sprint-runner.ts` | Code-review phase now routes through `ReviewOrchestrator` instead of plain dispatch; added `quality-gate` event type |
| `src/adapter/index.ts` | Re-exports `ReviewOrchestrator` and orchestration types |
| `src/index.ts` | Added `logQualityGateEvent()` handler for all review orchestrator events |
| `src/skills/quality-gates/skill.md` | Enhanced with structured finding format, category reference, severity weights, score computation |

**Quality Gate Flow:**
```
story status = "review"
  → SprintRunner detects code-review phase
  → ReviewOrchestrator.run() takes over:
    ┌─ Loop (max 3 passes) ────────────────────────────┐
    │  1. Dispatch code-review to bmad-qa agent         │
    │  2. Agent analyzes files, collects findings       │
    │  3. Agent calls quality_gate_evaluate tool        │
    │  4. Engine evaluates: severity scores, blocking   │
    │     count, advisory count                         │
    │  5. Verdict:                                      │
    │     • PASS  → story → done ✅                     │
    │     • FAIL  → dispatch fix to bmad-dev → loop ↩  │
    │     • ESCALATE → human intervention ⚠️            │
    └──────────────────────────────────────────────────┘
```

**Severity Scoring:**
| Severity | Weight | Blocks Merge |
|----------|--------|-------------|
| LOW | 1 | No |
| MEDIUM | 3 | No |
| HIGH | 7 | Yes |
| CRITICAL | 15 | Yes |

**Finding Categories:** correctness, security, performance, error-handling, type-safety, maintainability, testing, documentation, style

**Review History Persistence:**
- Each story's review history is saved to `_bmad-output/review-history/{story_id}.review.yaml`
- Survives process restarts — orchestrator resumes from last completed pass
- Full audit trail: findings, verdicts, scores, fix agents, timestamps

**New Copilot SDK Tool:**

| Tool | Parameters | Description |
|------|-----------|-------------|
| `quality_gate_evaluate` | `story_id`, `findings[]`, `reviewer_notes?` | Evaluates structured findings array against quality gate, returns verdict with severity score |

**Event Types Added:**
- `review-start` — review pass beginning
- `review-dispatched` — review sent to agent
- `gate-evaluated` — gate verdict computed
- `fix-start` — fix dispatching for blocking findings
- `fix-dispatched` — fix sent to developer agent
- `fix-complete` — fixes applied
- `review-approved` — story passed quality gate
- `review-escalated` — story needs human intervention
- `review-error` — review dispatch failed

---

### Phase 7 — Production Hardening *(ongoing)*

**Goal:** Observability, cost optimization, stall detection.

- OpenTelemetry → Grafana/Jaeger dashboards
- BYOK cost routing per agent (expensive ops → BYOK, cheap → Copilot quota)
- Stall detection ported from Claw Loop
- Model strategy (complexity → model tier) from BMAD V6

---

## Timeline Estimate

| Phase | Duration | Cumulative | Gate |
|-------|----------|-----------|------|
| **Phase 0** — Scaffolding | 1 session | Day 1 | None |
| **GATE 0** — Your tool installs | *depends on you* | — | **Y1-Y5** |
| **Phase 1** — SDK Hello World | 1 session | Day 2-3 | GATE 0 |
| **GATE 1** — Credentials | *depends on you* | — | **Y6-Y8** |
| **Phase 2** — Agent Definitions | 1-2 sessions | Day 4-5 | Phase 1 |
| **Phase 3** — BMAD Tools | 2-3 sessions | Day 6-10 | Phase 2 |
| **GATE 2** — Paperclip running | *depends on you* | — | **Y9** |
| **Phase 4** — Paperclip Integration | 2-3 sessions | Day 11-15 | GATE 2 |
| **Phase 5** — MCP Server | 1-2 sessions | Day 16-18 | Phase 3 |
| **Phase 6** — Quality Gates | 1-2 sessions | Day 19-21 | Phase 4 |
| **Phase 7** — Hardening | Ongoing | Day 22+ | Phase 6 |

**Estimated MVP (Phases 0-4):** ~3 weeks with your gate clearances  
**Full system (Phases 0-7):** ~4-5 weeks

---

## Immediate Next Steps

1. **I will now:** Scaffold Phase 0 (project structure, TypeScript config, agent/tool stubs, Docker Compose) — no blockers
2. **You do (parallel):** Work through GATE 0 items (Y1-Y5) at your pace
3. **When you're ready:** Tell me "Gate 0 done" and I'll run Phase 1

---

## Decision Points Where I'll Ask You

| When | Question |
|------|----------|
| Phase 1 | Which Copilot model to use as default? (Claude Sonnet 4.5 recommended) |
| Phase 2 | Review BMAD agent personas — any customization needed? |
| Phase 4 | Public or private GitHub repo? |
| Phase 4 | Paperclip `local_trusted` mode or authenticated? |
| Phase 7 | BYOK keys — which providers? Budget limits? |

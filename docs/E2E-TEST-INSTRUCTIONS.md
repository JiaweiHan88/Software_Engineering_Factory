# BMAD Copilot Factory — End-to-End Test Instructions

> Step-by-step guide to validate the full stack: unit tests → dry run → live SDK → observability → Paperclip → full integration.

**Last updated:** 2026-03-19

---

## Table of Contents

1. [Prerequisites](#1-prerequisites)
2. [Phase 1 — Unit Tests & Type Check](#2-phase-1--unit-tests--type-check)
3. [Phase 2 — Standalone Dry Run](#3-phase-2--standalone-dry-run)
4. [Phase 3 — Health Check](#4-phase-3--health-check)
5. [Phase 3.5 — Target Workspace Setup](#5-phase-35--target-workspace-setup)
6. [Phase 4 — Live SDK Run (Single Story)](#6-phase-4--live-sdk-run-single-story)
7. [Phase 5 — Observability Stack](#7-phase-5--observability-stack)
8. [Phase 6 — Paperclip Integration](#8-phase-6--paperclip-integration)
9. [Phase 7 — Full Stack (All Layers)](#9-phase-7--full-stack-all-layers)
10. [Phase 8 — MCP Server (VS Code)](#10-phase-8--mcp-server-vs-code)
11. [Teardown](#11-teardown)
12. [Troubleshooting](#12-troubleshooting)

---

## 1. Prerequisites

Verify each requirement before starting. All commands assume you are in the project root:

```bash
cd /path/to/BMAD_Copilot_RT
```

| # | Requirement | Verification Command | Expected |
|---|-------------|---------------------|----------|
| 1 | Node.js 20+ | `node --version` | `v20.x.x` or higher |
| 2 | pnpm 10+ | `pnpm --version` | `10.x.x` or higher |
| 3 | Docker Desktop running | `docker info` | No connection error |
| 4 | GitHub CLI | `gh --version` | `gh version 2.x.x` |
| 5 | Copilot CLI extension | `gh copilot --version` | Returns a version string |
| 6 | GitHub auth | `gh auth status` | Shows "Logged in" |
| 7 | Copilot subscription | Active GitHub Copilot license | — |
| 8 | Dependencies installed | `pnpm install` | No errors |
| 9 | Paperclip source cloned | `ls ../paperclip/Dockerfile` | File exists |

> **Note:** Item 9 is only needed for Phases 6–7. You can run Phases 1–5 without Paperclip.

### Sprint Data Requirement

Ensure `_bmad-output/sprint-status.yaml` has at least one story in `ready-for-dev` status. If both stories are already `in-progress` or `done`, reset one:

```yaml
# _bmad-output/sprint-status.yaml
sprint:
  number: 1
  goal: Orchestrator smoke test
  stories:
    - id: ORCH-001
      title: Add health check endpoint
      status: ready-for-dev
    - id: ORCH-002
      title: Implement session resume logic
      status: ready-for-dev
```

---

## 2. Phase 1 — Unit Tests & Type Check

**Goal:** Validate that all business logic is correct before touching external systems.

### Steps

```bash
# Step 1: Run the full test suite
pnpm test

# Step 2: Run TypeScript strict type check
pnpm typecheck
```

### Expected Results

```
✓ test/quality-gate-engine.test.ts    (24 tests)
✓ test/model-strategy.test.ts         (22 tests)
✓ test/paperclip-client.test.ts       (21 tests)
✓ test/health-check.test.ts           (19 tests)
✓ test/session-manager.test.ts        (19 tests)
✓ test/agent-dispatcher.test.ts       (17 tests)
✓ test/cost-tracker.test.ts            (47 tests)
✓ test/agent-dispatcher.test.ts       (42 tests)
✓ test/wake-context.test.ts           (34 tests)
✓ test/paperclip-client.test.ts       (33 tests)
✓ test/session-manager.test.ts        (30 tests)
✓ test/ceo-orchestrator.test.ts       (28 tests)
✓ test/heartbeat-handler.test.ts      (27 tests)
✓ test/quality-gate-engine.test.ts    (24 tests)
✓ test/model-strategy.test.ts         (22 tests)
✓ test/checkout-release.test.ts       (22 tests)  ← Phase A: checkout/release/comments
✓ test/health-check.test.ts           (19 tests)
✓ test/retry.test.ts                  (17 tests)
✓ test/stall-detector.test.ts         (12 tests)
✓ test/sprint-runner.test.ts          (10 tests)
✓ test/review-orchestrator.test.ts     (9 tests)
✓ test/logger.test.ts                  (9 tests)
✓ test/health.test.ts                  (3 tests)
✓ test/hello-bmad.test.ts              (1 test)

Test Files  18 passed (18)
     Tests  389 passed (389)
```

### Pass Criteria

- [ ] All 389 tests pass
- [ ] Zero TypeScript errors from `pnpm typecheck`

> **⛔ STOP** — If tests or typecheck fail, fix them before proceeding.

---

## 3. Phase 2 — Standalone Dry Run

**Goal:** Validate the full sprint pipeline logic (story reading, phase routing, agent dispatch) without any LLM calls or external services.

### Steps

```bash
# Run in dry-run mode (no SDK calls, no Copilot CLI needed)
pnpm start:dry-run
```

### Expected Results

The factory should:
1. Load configuration and print startup banner
2. List all 9 BMAD agents
3. Read `_bmad-output/sprint-status.yaml`
4. Find actionable stories (status `ready-for-dev` or `in-progress`)
5. Dispatch them through AgentDispatcher in dry mode
6. Log lifecycle events (story-start → story-complete → sprint-complete)
7. Exit cleanly

### Pass Criteria

- [ ] No crash or unhandled exception
- [ ] Stories are discovered and logged
- [ ] Sprint cycle completes with "Sprint cycle complete" message
- [ ] Exit code 0

---

## 4. Phase 3 — Health Check

**Goal:** Verify all subsystem readiness probes pass.

### Steps

```bash
pnpm start:status
```

### Expected Results

```
Health Check:
  ✅ config    — All required config fields populated
  ✅ agents    — 9 BMAD agents registered
  ✅ tools     — All expected tools registered
  ✅ sprint    — sprint-status.yaml exists and readable
  ⚠️  paperclip — Not reachable (expected if Docker not running)
```

### Pass Criteria

- [ ] `config` probe: ✅
- [ ] `agents` probe: ✅
- [ ] `tools` probe: ✅
- [ ] `sprint-file` probe: ✅
- [ ] `paperclip` probe: ⚠️ degraded (OK — Docker not started yet)
- [ ] Overall status: `healthy` or `degraded` (NOT `unhealthy`)

---

## 5. Phase 3.5 — Target Workspace Setup

**Goal:** Create a separate clean workspace that agents will code in, instead of letting them operate inside the factory repo itself.

### Why This Matters

The Copilot SDK's `workingDirectory` determines the filesystem scope that agents can explore.
If you point agents at the factory repo, they **waste 50–100+ seconds** exploring 30+ factory
source files (adapter, tools, agents, config, etc.) before they even start writing code.

By pointing `workingDirectory` at a separate **target project**, agents focus immediately on
the task. In benchmarks, this reduced a story implementation from **timing out at 120s** to
**completing in ~73 seconds**.

### Benchmark Results (claude-sonnet-4.6)

| Metric | Factory as workspace | Separate target workspace |
|--------|---------------------|--------------------------|
| Completion time | ❌ Timeout (>120s) | ✅ **73.1 seconds** |
| LLM turns | >7 (timed out) | **7** |
| Tool calls | >16 (timed out) | **16** |
| Sub-agent file reads | 30+ factory files | Only target project files |

### Step 1: Create the target workspace

```bash
# Create directory structure
mkdir -p ../bmad-target-project/src
mkdir -p ../bmad-target-project/test
mkdir -p ../bmad-target-project/_bmad-output/stories
```

### Step 2: Add minimal project scaffolding

```bash
# package.json
cat > ../bmad-target-project/package.json << 'SCAFFOLD'
{
  "name": "bmad-target-project",
  "version": "0.0.1",
  "type": "module",
  "scripts": {
    "test": "vitest run",
    "build": "tsc"
  },
  "devDependencies": {
    "typescript": "^5.7.0",
    "vitest": "^4.0.0"
  }
}
SCAFFOLD

# tsconfig.json
cat > ../bmad-target-project/tsconfig.json << 'SCAFFOLD'
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true
  },
  "include": ["src"]
}
SCAFFOLD

# Entry point
cat > ../bmad-target-project/src/index.ts << 'SCAFFOLD'
/**
 * bmad-target-project — Entry point
 * This is an empty project for BMAD agents to build into.
 */
export function main(): void {
  console.log("Hello from bmad-target-project");
}

main();
SCAFFOLD

# README
cat > ../bmad-target-project/README.md << 'SCAFFOLD'
# bmad-target-project

Clean workspace for BMAD Copilot Factory agents to build into.
This project is intentionally minimal — agents create the implementation.
SCAFFOLD
```

### Step 3: Add sprint data to the target workspace

```bash
# Sprint status
cat > ../bmad-target-project/_bmad-output/sprint-status.yaml << 'SPRINT'
sprint:
  number: 1
  goal: Build initial features
  stories:
    - id: ORCH-002
      title: Implement session resume logic
      status: ready-for-dev
SPRINT

# Story file with acceptance criteria
cat > ../bmad-target-project/_bmad-output/stories/ORCH-002.md << 'STORY'
# ORCH-002: Implement Session Resume Logic

## Description
Build a `SessionStore` class that persists session state to disk.

## Acceptance Criteria
- [ ] `SessionStore` class with `save(sessionId, state)`, `load(sessionId)`, `delete(sessionId)` methods
- [ ] State persisted as JSON files in `.sessions/{sessionId}.json`
- [ ] `load()` returns `null` for missing sessions (no throw)
- [ ] `delete()` resolves silently if session doesn't exist
- [ ] Unit tests covering save/load/delete and edge cases (missing files, overwrites)
- [ ] Proper TypeScript types with JSDoc documentation
- [ ] Export from `src/index.ts`

## Technical Notes
- Use Node.js `fs/promises` (no external dependencies)
- Handle `ENOENT` errors gracefully
- Create `.sessions/` directory on first save
STORY
```

### Step 4: Verify structure

```bash
find ../bmad-target-project -type f | sort
```

Expected:
```
../bmad-target-project/README.md
../bmad-target-project/_bmad-output/sprint-status.yaml
../bmad-target-project/_bmad-output/stories/ORCH-002.md
../bmad-target-project/package.json
../bmad-target-project/src/index.ts
../bmad-target-project/tsconfig.json
```

### Pass Criteria

- [ ] Target workspace directory exists at `../bmad-target-project`
- [ ] Minimal scaffolding files present (package.json, tsconfig.json, src/index.ts)
- [ ] Sprint data present (`_bmad-output/sprint-status.yaml` with `ready-for-dev` story)
- [ ] Story file present with acceptance criteria

> **Note:** You only need to create the target workspace once. Before each subsequent
> run, just reset the sprint status and clean up any generated files:
> ```bash
> # Reset sprint for a fresh run
> cat > ../bmad-target-project/_bmad-output/sprint-status.yaml << 'EOF'
> sprint:
>   number: 1
>   goal: Build initial features
>   stories:
>     - id: ORCH-002
>       title: Implement session resume logic
>       status: ready-for-dev
> EOF
>
> # Optional: clean generated source (to test from scratch)
> rm -f ../bmad-target-project/src/session-store.ts
> rm -rf ../bmad-target-project/test/
> ```

---

## 6. Phase 4 — Live SDK Run (Single Story)

**Goal:** Execute a real LLM-powered story through the full BMAD lifecycle — the first time real Copilot SDK calls happen.

### Pre-flight

```bash
# Confirm Copilot CLI is authenticated
gh auth status
gh copilot --version
```

> **⚠️ IMPORTANT: Reset sprint status before each live run.**
> If a previous run timed out or failed, stories may be stuck in `in-progress`.
> The `dev_story` tool now supports resuming in-progress stories, but for a clean
> test, reset the sprint first:
>
> ```bash
> # Reset factory sprint
> cat > _bmad-output/sprint-status.yaml << 'EOF'
> sprint:
>   number: 1
>   goal: Orchestrator smoke test
>   stories:
>     - id: ORCH-001
>       title: Add health check endpoint
>       status: ready-for-dev
>     - id: ORCH-002
>       title: Implement session resume logic
>       status: ready-for-dev
> EOF
>
> # Reset target workspace sprint (if using target workspace)
> cat > ../bmad-target-project/_bmad-output/sprint-status.yaml << 'EOF'
> sprint:
>   number: 1
>   goal: Build initial features
>   stories:
>     - id: ORCH-002
>       title: Implement session resume logic
>       status: ready-for-dev
> EOF
> ```

### Option A: Diagnostic Script (Recommended for first run)

The diagnostic script provides detailed timing telemetry and targets the clean workspace
created in Phase 3.5. This is the **fastest and most reliable** way to test.

```bash
npx tsx src/sandbox/diagnose-dispatch.ts
```

This script:
- Points `workingDirectory` at `../bmad-target-project`
- Overrides `BMAD_OUTPUT_DIR` and `BMAD_SPRINT_STATUS_PATH` for the target workspace
- Logs every turn, tool call, sub-agent spawn, and token usage with elapsed timestamps
- Times out at 300 seconds

#### Expected Output

```
🔬 Dispatch Diagnostic — clean target workspace

🏭 Factory root: /path/to/BMAD_Copilot_RT
🎯 Target workspace: /path/to/bmad-target-project
✅ CLI started

📋 Agent: 💻 Developer Agent (Amelia)
🔧 Tools: 2 (dev_story, sprint_status)
📂 Working directory: /path/to/bmad-target-project
📎 Custom agents: 9

[1.6s]  🔄 turn 1 start
[4.8s]  🔧 tool #1: report_intent
[4.8s]  🔧 tool #2: dev_story
[13.9s] 🔧 tool #3: task               ← sub-agent spawned
[35.8s] 🔧 tool #11: create            ← writing session-store.ts
[48.0s] 🔧 tool #12: create            ← writing tests
[56.7s] 🔧 tool #14: bash              ← running vitest
[68.0s] 🔧 tool #16: sprint_status     ← story → review
[73.1s] 💤 session.idle — DONE

✅ COMPLETED in 73.1s — response: 408 chars
📊 Turns: 7, Tool calls: 16
```

#### What the Agent Creates

After a successful run, inspect the target workspace:

```bash
find ../bmad-target-project/src ../bmad-target-project/test -type f 2>/dev/null
```

Expected new files:
- `src/session-store.ts` — Full `SessionStore` class with `save()`, `load()`, `delete()`
- `test/session-store.test.ts` — 7 tests covering all methods and edge cases
- `src/index.ts` — Updated with re-export of `SessionStore`

Verify the agent's tests pass:
```bash
cd ../bmad-target-project && npx vitest run && cd -
```

### Option B: Full Pipeline (with quality gate)

```bash
# Process a single story end-to-end (live SDK calls + quality gate)
pnpm start -- --story ORCH-002
```

> **Note:** This runs the agent against the factory's own workspace (not the target project).
> It will be slower due to the agent exploring factory source files.

### What Happens Under the Hood

The Copilot SDK session triggers multiple layers of LLM interaction:
1. **Main agent** (claude-sonnet-4.6) receives the prompt and calls `dev_story` tool
2. The tool reads the story file and returns acceptance criteria
3. The agent may spawn **sub-agents** (e.g., "Explore Agent" using claude-haiku-4.5) to understand the codebase
4. Sub-agents run many parallel tool calls (view, grep, bash, glob) — each turn takes 3–8 seconds
5. After exploration, the main agent generates code using `create` / `edit` built-in tools
6. The agent runs tests to validate the implementation
7. Finally the agent calls `sprint_status` to update the story status

**The dispatch timeout is 300 seconds (5 min)** to accommodate this multi-agent flow.
If you see sub-agent activity in the logs, the system is working correctly — just be patient.

### Expected Results

The factory should:

1. **Start SDK** — `🔌 Starting Copilot SDK...` → `✅ SDK ready.`
2. **Dispatch dev-story** — Developer agent (bmad-dev) implements the story
3. **Run quality gate** — QA agent (bmad-qa) performs adversarial code review
4. **Gate verdict:**
   - **PASS** → Story moves to `done` ✅
   - **FAIL** → Fix cycle runs (up to 3 passes), then re-review
   - **ESCALATE** → Too many failures, human intervention needed ⚠️
5. **Sprint status updated** — `_bmad-output/sprint-status.yaml` reflects the new status
6. **Shutdown** — `🧹 Shutdown complete.`

### Console output pattern (Option B)

```
🏭 BMAD Copilot Factory
🔌 Starting Copilot SDK...
✅ SDK ready.

━━━ ORCH-002 → dev-story ━━━
[... streaming LLM output ...]
✅ ORCH-002 (dev-story) — bmad-dev

  🔍 ORCH-002 — review pass 1 starting
  📤 ORCH-002 — review dispatched to bmad-qa
  🚦 ORCH-002 — gate verdict: PASS (blocking: 0, advisory: 2, score: 6)
  🎉 ORCH-002 — APPROVED after 1 pass(es)

🏁 Sprint cycle complete — 1/1 stories done
📊 Sprint cycle result: 1 stories completed.
🧹 Shutdown complete.
```

### Pass Criteria

**Option A (Diagnostic):**
- [ ] Diagnostic completes within 300 seconds
- [ ] `session.idle` fires (not a timeout)
- [ ] Agent creates `src/session-store.ts` in target workspace
- [ ] Agent creates tests in `test/session-store.test.ts`
- [ ] Tests pass: `cd ../bmad-target-project && npx vitest run`
- [ ] Sprint status updated to `review` in target workspace

**Option B (Full Pipeline):**
- [ ] SDK connects successfully
- [ ] Agent dispatch produces LLM output
- [ ] Quality gate runs (at least 1 review pass)
- [ ] Story reaches `done` OR gracefully escalates
- [ ] `_bmad-output/sprint-status.yaml` updated
- [ ] Process exits cleanly (exit code 0)

### Alternative: Single dispatch (skip quality gate)

To test just the developer agent without the full lifecycle:

```bash
pnpm start -- --dispatch dev-story ORCH-002
```

---

## 7. Phase 5 — Observability Stack

**Goal:** Verify distributed tracing, metrics, and dashboards work with live factory runs.

### Step 1: Start the observability containers

```bash
pnpm observability:up
```

### Step 2: Verify containers are running

```bash
docker compose -f docker-compose.observability.yml ps
```

All 4 services should show `running` / `healthy`:

| Service | Port | URL |
|---------|------|-----|
| OTel Collector | 4317 (gRPC), 4318 (HTTP) | — |
| Jaeger | 16686 | http://localhost:16686 |
| Prometheus | 9090 | http://localhost:9090 |
| Grafana | 3000 | http://localhost:3000 |

### Step 3: Verify service UIs are reachable

```bash
# Quick health checks
curl -s http://localhost:16686 | head -c 100    # Jaeger UI HTML
curl -s http://localhost:9090/-/ready            # Prometheus ready
curl -s http://localhost:3000/api/health         # Grafana health
```

### Step 4: Run factory with telemetry

```bash
pnpm start:otel -- --story ORCH-001
```

This sets `OTEL_ENABLED=true` and `OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318`.

### Step 5: Verify traces in Jaeger

1. Open http://localhost:16686
2. Select service: `bmad-copilot-factory`
3. Click **Find Traces**
4. You should see spans for:
   - `sprint-cycle`
   - `agent-dispatch` (with agent name tag)
   - `quality-gate-evaluate` (with verdict tag)

### Step 6: Verify metrics in Prometheus

1. Open http://localhost:9090
2. Query these metrics:
   - `bmad_bmad_stories_processed_stories_total` — story completion counter
   - `bmad_bmad_agent_dispatch_duration_milliseconds_bucket` — dispatch latency histogram
   - `bmad_bmad_gate_verdicts_total` — gate verdicts by result

### Step 7: Verify Grafana dashboard

1. Open http://localhost:3000
2. Login: **admin** / **bmad**
3. Go to **Dashboards** → **BMAD Factory**
4. Verify panels populate:
   - [ ] Stories processed counter
   - [ ] Agent dispatch latency (p50/p95/p99)
   - [ ] Quality gate verdicts (pie chart)
   - [ ] Active sessions gauge
   - [ ] Stall detections counter

### Pass Criteria

- [ ] All 4 observability containers running
- [ ] Jaeger shows traces from the factory run
- [ ] Prometheus returns metric values
- [ ] Grafana dashboard panels have data

---

## 8. Phase 6 — Paperclip Integration

**Goal:** Validate the full orchestration loop — Paperclip assigns issues, the factory picks them up, processes them, and reports back.

### Step 1: Clone Paperclip (if not done)

```bash
cd ..
git clone https://github.com/paperclipai/paperclip.git
cd BMAD_Copilot_RT
```

### Step 2: Set required environment variables

```bash
# Required — Paperclip won't start without this
export BETTER_AUTH_SECRET=$(openssl rand -hex 32)

# Optional — BYOK keys for Paperclip's own agents
# export OPENAI_API_KEY=sk-...
# export ANTHROPIC_API_KEY=sk-ant-...
```

### Step 3: Start Paperclip + PostgreSQL

```bash
docker compose up -d
```

### Step 4: Wait for healthy status

```bash
# Watch until both services show "healthy"
docker compose ps

# Direct API health check
curl -s http://localhost:3100/api/health
```

> **Troubleshooting:** If Paperclip fails to build, ensure `../paperclip/Dockerfile` exists and Docker has enough resources (4GB RAM recommended).

### Step 5: Verify Paperclip UI

Open http://localhost:3100 in your browser. You should see the Paperclip management UI.

### Step 6: Re-run health check (Paperclip should be green now)

```bash
pnpm start:status
```

The `paperclip` probe should now show ✅ instead of ⚠️.

### Step 7: Start factory in Paperclip mode

```bash
pnpm start:paperclip
```

### Expected Startup

```
🏭 BMAD Copilot Factory
📡 Paperclip: enabled (http://localhost:3100, mode: inbox-polling)

📡 Paperclip mode (inbox-polling) — connecting to http://localhost:3100
🔄 Paperclip loop started — 9 agents, mode: inbox-polling
📋 9 agents created in Paperclip
```

### Step 8: Trigger work from Paperclip

1. Open http://localhost:3100
2. Navigate to the company/org: `bmad-factory`
3. Create a new issue (e.g., "Implement user profile endpoint")
4. Assign it to one of the BMAD agents (e.g., `bmad-dev`)
5. Watch the factory terminal — it should:
   - Detect the issue on next inbox poll (within 15 seconds)
   - Dispatch it to the appropriate agent
   - Process the work
   - Post results as an issue comment

### Step 9: Verify result reporting

In the Paperclip UI, check the issue you created — it should now have a comment from the factory with the agent's output.

### Pass Criteria

- [ ] Paperclip + PostgreSQL start and become healthy
- [ ] Paperclip UI accessible at http://localhost:3100
- [ ] Health check shows Paperclip probe ✅
- [ ] Factory creates 9 agents in Paperclip
- [ ] Inbox polling loop starts (log: `🔄 Paperclip loop started`)
- [ ] Assigned issue is detected and processed
- [ ] Result posted back as issue comment

### Alternative: Paperclip without Docker

```bash
npx paperclipai onboard --yes
# Uses PGlite (embedded SQLite-like), no Docker/PostgreSQL needed
```

---

## 9. Phase 7 — Full Stack (All Layers)

**Goal:** Run everything simultaneously — Paperclip orchestration + live SDK + observability telemetry.

### Terminal Layout

You need 3 terminals:

#### Terminal 1 — Observability stack

```bash
pnpm observability:up
```

#### Terminal 2 — Paperclip stack

```bash
export BETTER_AUTH_SECRET=$(openssl rand -hex 32)
docker compose up -d

# Wait for healthy
docker compose ps
```

#### Terminal 3 — Factory (all features enabled)

```bash
PAPERCLIP_ENABLED=true \
OTEL_ENABLED=true \
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 \
LOG_FORMAT=human \
LOG_LEVEL=debug \
tsx src/index.ts --paperclip
```

### Monitor in parallel

Open these browser tabs:

| Tab | URL | What to look for |
|-----|-----|-----------------|
| Paperclip UI | http://localhost:3100 | Org chart, issues, agent status |
| Grafana | http://localhost:3000 | Real-time dashboard panels |
| Jaeger | http://localhost:16686 | Trace waterfall per story |
| Prometheus | http://localhost:9090 | Raw metrics queries |

### Full Stack Test Scenario

1. Create an issue in Paperclip UI, assign to `bmad-dev`
2. Watch Terminal 3 — factory picks it up
3. Watch Grafana — stories_processed counter increments
4. Watch Jaeger — new trace appears with full span hierarchy
5. Check Paperclip UI — issue has a result comment

### Pass Criteria

- [ ] All 8 containers running (4 observability + 2 Paperclip stack + factory process)
- [ ] Factory processes Paperclip issues end-to-end
- [ ] Traces visible in Jaeger with full span tree
- [ ] Grafana dashboard shows live data
- [ ] Issue comments appear in Paperclip UI
- [ ] No stall detections (or stalls are correctly detected if simulated)
- [ ] Graceful shutdown works (`Ctrl+C` → factory pauses agents and exits cleanly)

---

## 10. Phase 8 — MCP Server (VS Code)

**Goal:** Verify the MCP server exposes sprint tools to VS Code Copilot Chat.

### Steps

```bash
# Start the MCP stdio server
pnpm mcp:sprint
```

### Expected Tools

The server exposes 5 tools:

| Tool | Description |
|------|-------------|
| `get_sprint_status` | Read current sprint YAML |
| `get_next_story` | Find next `ready-for-dev` story |
| `get_story_details` | Full story markdown by ID |
| `update_story_status` | Change story lifecycle status |
| `get_architecture_docs` | Read architecture documentation |

### VS Code Integration

If configured in VS Code's MCP settings, these tools appear in Copilot Chat. You can ask:
- "What's the sprint status?"
- "Get me the next story"
- "Show details for ORCH-001"

### Pass Criteria

- [ ] MCP server starts without errors
- [ ] Tools are accessible from VS Code Copilot Chat (if configured)

---

## 11. Teardown

### Stop everything

```bash
# Stop factory (Ctrl+C in the terminal, or):
pkill -f "tsx src/index.ts"

# Stop Paperclip + PostgreSQL
docker compose down

# Stop observability stack
pnpm observability:down
```

### Clean slate (remove all data)

```bash
# Remove Docker volumes (database, metrics, grafana state)
docker compose down -v
docker compose -f docker-compose.observability.yml down -v

# Reset factory sprint status to initial state
cat > _bmad-output/sprint-status.yaml << 'EOF'
sprint:
  number: 1
  goal: Orchestrator smoke test
  stories:
    - id: ORCH-001
      title: Add health check endpoint
      status: ready-for-dev
    - id: ORCH-002
      title: Implement session resume logic
      status: ready-for-dev
EOF

# Reset target workspace for a fresh run
cat > ../bmad-target-project/_bmad-output/sprint-status.yaml << 'EOF'
sprint:
  number: 1
  goal: Build initial features
  stories:
    - id: ORCH-002
      title: Implement session resume logic
      status: ready-for-dev
EOF

# Remove agent-generated files from target workspace
rm -f ../bmad-target-project/src/session-store.ts
rm -rf ../bmad-target-project/test/
rm -rf ../bmad-target-project/.sessions/
rm -rf ../bmad-target-project/node_modules/
git checkout -- ../bmad-target-project/src/index.ts 2>/dev/null || true
```

---

## 12. Troubleshooting

### Copilot SDK won't connect

```bash
# Re-authenticate
gh auth login
gh auth status
# Verify Copilot extension
gh extension list | grep copilot
```

### Paperclip won't start

```bash
# Check if the source is cloned correctly
ls ../paperclip/Dockerfile

# Check Docker logs
docker compose logs paperclip

# Verify the auth secret is set
echo $BETTER_AUTH_SECRET
```

### Observability containers crash

```bash
# Check which container failed
docker compose -f docker-compose.observability.yml ps
docker compose -f docker-compose.observability.yml logs <service-name>

# Common fix: port conflict
lsof -i :3000   # Grafana
lsof -i :16686  # Jaeger
lsof -i :9090   # Prometheus
```

### No traces in Jaeger

- Verify `OTEL_ENABLED=true` is set when running the factory
- Verify OTel Collector is running: `curl http://localhost:4318/v1/traces` (should not refuse connection)
- Check collector logs: `docker compose -f docker-compose.observability.yml logs otel-collector`

### No metrics in Prometheus

- Verify OTel Collector's Prometheus exporter is running: `curl http://localhost:8889/metrics`
- Check Prometheus targets: http://localhost:9090/targets — the `otel-collector` target should be `UP`

### Factory stalls on a story

- Check terminal output for `⚠️ Stall detected` messages
- Set `STALL_AUTO_ESCALATE=true` to auto-escalate stuck stories
- Maximum 3 review passes — after that, the story is escalated automatically

### Agent dispatch times out

The Copilot SDK agent routinely spawns **sub-agents** (Explore Agent, etc.) that read dozens of files.
This is normal behavior. The dispatch timeout is 300 seconds to accommodate this.

If you still hit timeouts:
1. **Use the target workspace** (Phase 3.5) — this is the #1 fix for slow dispatches
2. Check the story's complexity — very large codebases may need more time
3. Look for `subagent.started` events in debug logs — they confirm the agent is working
4. Increase timeout via the `DISPATCH_TIMEOUT_MS` pattern in `agent-dispatcher.ts`
5. If the agent gets stuck in a tool-call loop, the story content or prompt may need refinement

### Agent explores factory source files instead of target project

If you see the agent reading files like `src/adapter/agent-dispatcher.ts`, `src/tools/dev-story.ts`,
etc., the agent's `workingDirectory` is pointing at the factory repo instead of the target workspace.

**Fix:** Use the diagnostic script (`npx tsx src/sandbox/diagnose-dispatch.ts`) which
automatically sets `workingDirectory` to `../bmad-target-project`. For production use,
configure `TARGET_PROJECT_ROOT` or update the session manager's `workingDirectory`.

### Story stuck in `in-progress` after a crash

The `dev_story` tool now supports **resume** — if a story is already `in-progress`, it will
re-read the story file and let the agent continue instead of rejecting with an error.

To manually reset:
```bash
# Edit sprint-status.yaml and set the story back to ready-for-dev
```

### Port conflicts

| Port | Service | Kill command |
|------|---------|-------------|
| 3000 | Grafana | `lsof -ti :3000 \| xargs kill` |
| 3100 | Paperclip | `lsof -ti :3100 \| xargs kill` |
| 4317 | OTel gRPC | `lsof -ti :4317 \| xargs kill` |
| 4318 | OTel HTTP | `lsof -ti :4318 \| xargs kill` |
| 9090 | Prometheus | `lsof -ti :9090 \| xargs kill` |
| 16686 | Jaeger | `lsof -ti :16686 \| xargs kill` |

---

## Quick Reference: Environment Variables

| Variable | Value for Full E2E | Description |
|----------|-------------------|-------------|
| `BETTER_AUTH_SECRET` | `$(openssl rand -hex 32)` | Paperclip auth (required) |
| `PAPERCLIP_ENABLED` | `true` | Enable Paperclip integration |
| `PAPERCLIP_URL` | `http://localhost:3100` | Paperclip server |
| `PAPERCLIP_COMPANY_ID` | `bmad-factory` | Company scope |
| `PAPERCLIP_MODE` | `inbox-polling` | Dev integration mode |
| `OTEL_ENABLED` | `true` | Enable telemetry |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `http://localhost:4318` | OTel collector |
| `LOG_LEVEL` | `debug` | Verbose logging |
| `LOG_FORMAT` | `human` | Readable log output |
| `COPILOT_MODEL` | `claude-sonnet-4.6` | Default LLM model |
| `REVIEW_PASS_LIMIT` | `3` | Max review cycles |
| `STALL_AUTO_ESCALATE` | `false` | Auto-escalate stuck stories |
| `BMAD_OUTPUT_DIR` | `_bmad-output` | Path to sprint data directory |
| `BMAD_SPRINT_STATUS_PATH` | `_bmad-output/sprint-status.yaml` | Path to sprint YAML |

---

## Summary: Recommended Test Order

```
Phase 1:   pnpm test && pnpm typecheck              ← No external deps
Phase 2:   pnpm start:dry-run                        ← No external deps
Phase 3:   pnpm start:status                         ← No external deps
Phase 3.5: Create ../bmad-target-project              ← One-time setup
Phase 4a:  npx tsx src/sandbox/diagnose-dispatch.ts   ← Requires Copilot CLI (target ws)
Phase 4b:  pnpm start -- --story ORCH-002             ← Requires Copilot CLI (factory ws)
Phase 5:   pnpm observability:up + pnpm start:otel    ← Requires Docker
Phase 6:   docker compose up -d + pnpm start:paperclip ← Requires Paperclip
Phase 7:   All of the above simultaneously             ← Full integration
Phase 8:   pnpm mcp:sprint                            ← VS Code integration
```

> **💡 Tip:** Phase 4a (diagnostic script with target workspace) is the recommended
> first live test. It completes in ~73s vs potentially timing out when the agent
> explores the full factory codebase.

Each phase validates the next layer. If something breaks, you know exactly which layer failed.

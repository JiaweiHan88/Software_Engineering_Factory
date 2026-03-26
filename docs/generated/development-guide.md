# BMAD Copilot Factory — Development Guide

> Generated: 2026-03-26 | Scan Level: Exhaustive | Source: Direct code analysis

## Prerequisites

| Requirement | Version | Notes |
|------------|---------|-------|
| Node.js | 20+ | Tested on 25.8.1 |
| pnpm | 10+ | Package manager (corepack-enabled) |
| TypeScript | 5.7+ | Strict mode, ESM modules |
| GitHub Copilot CLI | Latest | Required for live mode (`gh copilot --version`) |
| GitHub Copilot subscription | Active | Required for Copilot SDK sessions |
| Docker | Latest | Optional — for Paperclip and observability stack |
| Docker Compose | Latest | Optional — for multi-service orchestration |

## Installation

```bash
git clone <repo-url>
cd BMAD_Copilot_RT
pnpm install
```

## Environment Setup

Copy `.env.example` to `.env` and configure:

```bash
cp .env.example .env
```

### Core Environment Variables

| Variable | Default | Required | Description |
|----------|---------|----------|-------------|
| `COPILOT_MODEL` | `claude-sonnet-4.6` | No | Default LLM model |
| `LOG_LEVEL` | `info` | No | Log level: debug, info, warn, error |
| `LOG_FORMAT` | `human` | No | Output format: json, human |
| `BMAD_TEST_MODE` | — | No | Set truthy to enable test mode |

### Paperclip Integration (optional)

| Variable | Default | Required | Description |
|----------|---------|----------|-------------|
| `PAPERCLIP_ENABLED` | `false` | No | Enable Paperclip integration |
| `PAPERCLIP_URL` | `http://localhost:3100` | If enabled | Paperclip server URL |
| `PAPERCLIP_COMPANY_ID` | `bmad-factory` | If enabled | Company ID (company-scoped) |
| `PAPERCLIP_AGENT_API_KEY` | — | If enabled | Agent API key for Bearer auth |
| `PAPERCLIP_MODE` | `inbox-polling` | No | Integration mode: inbox-polling or webhook |

### Observability (optional)

| Variable | Default | Required | Description |
|----------|---------|----------|-------------|
| `OTEL_ENABLED` | `false` | No | Enable OpenTelemetry export |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `http://localhost:4317` | If enabled | OTLP endpoint |
| `OTEL_SERVICE_NAME` | `bmad-factory` | No | Service name for traces |
| `OTEL_METRICS_INTERVAL_MS` | `30000` | No | Metrics export interval |

### Workspace Context (set by Paperclip process adapter)

| Variable | Default | Description |
|----------|---------|-------------|
| `PAPERCLIP_WORKSPACE_CWD` | — | Working directory for agent execution |
| `PAPERCLIP_WORKSPACE_REPO_URL` | — | Git repository URL |
| `PAPERCLIP_WORKSPACE_BRANCH` | — | Git branch name |
| `PAPERCLIP_WORKSPACE_STRATEGY` | — | Workspace strategy (shared, worktree, clone) |
| `PAPERCLIP_WORKSPACE_WORKTREE_PATH` | — | Git worktree path |

## Build Commands

```bash
pnpm build                   # Compile TypeScript → dist/
pnpm typecheck               # TypeScript strict check (no emit)
pnpm lint                    # ESLint + TypeScript rules
pnpm clean                   # Remove dist/ and coverage/
```

## Running

### Standalone Mode (no Paperclip)

```bash
pnpm start                             # Process all actionable stories
pnpm start -- --story STORY-001        # Process a single story
pnpm start -- --dispatch dev-story S-1 # Run one phase for one story
pnpm start -- --status                 # Health check + sprint summary
pnpm start:dry-run                     # Full pipeline without SDK calls
```

### Paperclip Integration Mode

```bash
# Option A: Docker (recommended)
docker compose up -d                              # Start Paperclip + PostgreSQL
npx tsx scripts/setup-paperclip-company.ts        # Create company, agents, org chart
pnpm start:paperclip                              # Run inbox-polling integration loop

# Option B: Native
./scripts/start-paperclip.sh                      # Start Paperclip without Docker
npx tsx scripts/setup-paperclip-company.ts        # Setup company

# Option C: Webhook mode (production)
PAPERCLIP_MODE=webhook npx tsx src/webhook-server.ts  # HTTP listener on :3200
```

### Observability Mode

```bash
pnpm observability:up                   # Start Jaeger + Prometheus + Grafana
pnpm start:otel                         # Run with telemetry export
open http://localhost:3000              # Grafana (admin/bmad)
open http://localhost:16686             # Jaeger trace explorer
open http://localhost:9090              # Prometheus metrics
```

### MCP Server (VS Code integration)

```bash
pnpm mcp:sprint                         # Start MCP server (stdio transport)
```

## Testing

### Run Tests

```bash
pnpm test                    # Run all 333+ tests (~2.5s)
pnpm test:watch              # Watch mode (re-run on change)
pnpm test -- --reporter=verbose  # Verbose output
```

### Test Architecture

- **Framework:** Vitest 3.0+ with globals (`describe`, `it`, `expect`)
- **Environment:** Node.js
- **Coverage:** v8 provider
- **Timeout:** 10s per test
- **Location:** `test/` directory, `*.test.ts` naming

### Test Categories

| Category | Files | Tests | Coverage Area |
|----------|-------|-------|---------------|
| Adapter | 6 files | ~176 tests | Session manager, dispatcher, Paperclip client, CEO orchestrator, heartbeat handler, retry |
| Quality Gates | 2 files | ~33 tests | Gate engine (scoring, verdicts), review orchestrator (multi-pass) |
| Config | 1 file | ~22 tests | Model strategy (tiers, BYOK, complexity) |
| Observability | 3 files | ~41 tests | Logger, cost tracker, stall detector |
| Integration | 2 files | ~27 tests | Health check (5 probes), sprint runner (legacy) |
| Smoke | 2 files | ~5 tests | Basic connectivity, hello-bmad |

### Mocking Patterns

Tests use Vitest's built-in mocking:
- `vi.mock()` for module-level mocks (Copilot SDK, file system)
- `vi.fn()` for inline function mocks
- `vi.spyOn()` for partial mocking
- No external HTTP mocking library; PaperclipClient is mocked at method level

### E2E Testing

```bash
npx tsx scripts/e2e-test.ts                 # Basic smoke test
npx tsx scripts/e2e-test.ts --full          # Full pipeline validation
npx tsx scripts/e2e-test.ts --autonomous    # Autonomous multi-agent test
```

E2E tests validate invariants:
- **D1-D12**: Delegation (CEO creates sub-issues, dependency ordering)
- **P1-P5**: Phase transitions (create-story → dev-story → code-review)
- **C1-C3**: Cross-phase coordination (SM→Dev→QA handoff)
- **E1-E7**: Execution (agent dispatch, tool invocation, result reporting)
- **R1-R3**: Review (multi-pass, fix cycles, escalation)

## TypeScript Configuration

### Path Aliases

```json
{
  "@agents/*": ["src/agents/*"],
  "@tools/*": ["src/tools/*"],
  "@adapter/*": ["src/adapter/*"],
  "@config/*": ["src/config/*"],
  "@mcp/*": ["src/mcp/*"]
}
```

### Strict Mode Settings

- `strict: true` (all strict checks enabled)
- `target: ES2022`
- `module: ESNext`
- `moduleResolution: bundler`
- `noUnusedLocals: true`
- `noUnusedParameters: true`

## Code Conventions

- **No `any` types** without explicit justification comment
- **JSDoc** on all exported functions and types
- **ESM imports** with `.js` extension (TypeScript ESM convention)
- **Barrel exports** (`index.ts`) in each module directory
- **Error handling**: All async operations must have error boundaries
- **No hardcoded secrets**: Use environment variables only
- **Structured logging**: Use `logger.ts` (not `console.log`)

## Project Scripts (package.json)

| Script | Command | Description |
|--------|---------|-------------|
| `build` | `tsc` | Compile TypeScript |
| `typecheck` | `tsc --noEmit` | Type check without emitting |
| `test` | `vitest run` | Run all tests |
| `test:watch` | `vitest` | Watch mode |
| `lint` | `eslint src/ test/` | Lint source and tests |
| `clean` | `rm -rf dist coverage` | Clean build artifacts |
| `start` | `tsx src/index.ts` | Run main CLI |
| `start:dry-run` | `BMAD_DRY_RUN=true tsx src/index.ts` | Dry run mode |
| `start:paperclip` | `tsx src/index.ts --paperclip` | Paperclip integration |
| `start:otel` | `OTEL_ENABLED=true tsx src/index.ts` | With observability |
| `start:status` | `tsx src/index.ts --status` | Health + status |
| `mcp:sprint` | `tsx src/mcp/bmad-sprint-server/index.ts` | MCP server |
| `observability:up` | `docker compose -f docker-compose.observability.yml up -d` | Start monitoring |
| `observability:down` | `docker compose -f docker-compose.observability.yml down` | Stop monitoring |

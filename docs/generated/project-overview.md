# BMAD Copilot Factory — Project Overview

> Generated: 2026-03-26 | Scan Level: Exhaustive | Source: Direct code analysis

## Purpose

BMAD Copilot Factory is an autonomous software development system that bridges three layers:

1. **Paperclip** — Orchestration control plane (org charts, goals, budgets, governance, heartbeat-driven agent dispatch)
2. **BMAD Method** — Agile methodology (sprint lifecycle, story creation, adversarial code review, quality gates)
3. **GitHub Copilot SDK** — Programmable agent runtime (custom agents, tools, MCP, skills)

The system reads assigned issues from Paperclip, dispatches them to specialized AI agents (PM, Architect, Developer, QA, Scrum Master, etc.), enforces quality gates with severity-scored adversarial review, and advances work through the BMAD lifecycle — all autonomously.

## Architecture Type

**Layered Orchestration Architecture with Push-Model Event Dispatch**

- **Repository Type:** Monolith (single cohesive TypeScript codebase)
- **Project Type:** Backend runtime (CLI + HTTP webhook + MCP server)
- **Runtime:** Node.js 20+ with TypeScript 5.7+ (strict mode, ESM modules)

## Technology Stack Summary

| Category | Technology | Version | Purpose |
|----------|-----------|---------|---------|
| Language | TypeScript | 5.7+ | Strict mode, ESM, path aliases |
| Runtime | Node.js | 20+ | Process execution |
| Agent SDK | @github/copilot-sdk | 0.1.32 | Custom agents, tools, skills, sessions |
| Validation | Zod | 4.3.6 | Schema validation for tool parameters |
| YAML | js-yaml | 4.1.1 | Sprint status and config parsing |
| Env | dotenv | 17.3.1 | Environment variable loading |
| Tracing | @opentelemetry/sdk-trace-node | 1.30.0 | Distributed tracing (Jaeger) |
| Metrics | @opentelemetry/sdk-metrics | 1.30.0 | Counters, histograms, gauges (Prometheus) |
| MCP | @modelcontextprotocol/sdk | 1.27.1 | Model Context Protocol server |
| Testing | Vitest | 3.0+ | Unit and integration tests |
| Linting | ESLint + @typescript-eslint | 9.0+ / 8.57+ | Code quality |
| Execution | tsx | 4.0+ | TypeScript execution for development |
| Container | Docker | Multi-stage | Production deployment |
| Orchestration | Docker Compose | — | Paperclip + PostgreSQL + observability stack |

## Entry Points

| Entry Point | File | Type | Purpose |
|------------|------|------|---------|
| Main CLI | `src/index.ts` | CLI handler | Sprint orchestration, story lifecycle |
| Heartbeat | `src/heartbeat-entrypoint.ts` | Process adapter | Paperclip heartbeat pipeline (10 steps) |
| Webhook | `src/webhook-server.ts` | HTTP server | Paperclip push-model callbacks (:3200) |
| MCP Server | `src/mcp/bmad-sprint-server/index.ts` | Stdio MCP | Sprint tools for VS Code integration |
| E2E Tests | `scripts/e2e-test.ts` | Test runner | Smoke/full/autonomous validation modes |
| Setup | `scripts/setup-paperclip-company.ts` | Setup utility | Initialize Paperclip company + agents |

## Key Metrics

| Metric | Value |
|--------|-------|
| Source files | ~50+ TypeScript files |
| Test files | 16+ test suites |
| Tests | 333+ passing |
| Agents | 9 BMAD personas + CEO orchestrator |
| Tools | 5 Copilot SDK tools |
| MCP Tools | 5 sprint management tools |
| Paperclip API endpoints | 20+ consumed |
| Model pricing entries | 34 LLM models tracked |
| Environment variables | 30+ configurable |

## Quick Start

```bash
pnpm install                          # Install dependencies
pnpm test                             # Run 333+ tests
pnpm start:dry-run                    # Full pipeline without SDK calls
pnpm start                            # Live execution with Copilot
pnpm start:paperclip                  # Inbox-polling integration loop
```

## Documentation Index

- [Architecture](./architecture.md)
- [Source Tree Analysis](./source-tree-analysis.md)
- [API Contracts](./api-contracts.md)
- [Development Guide](./development-guide.md)
- [Deployment Guide](./deployment-guide.md)
- [Component Inventory](./component-inventory.md)

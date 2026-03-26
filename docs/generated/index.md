# BMAD Copilot Factory — Documentation Index

> Generated: 2026-03-26 | Scan Level: Exhaustive | Source: Direct code analysis (not relying on existing docs)

## Project Overview

- **Type:** Monolith — Backend Agent Orchestration Runtime
- **Primary Language:** TypeScript 5.7+ (strict mode, ESM)
- **Runtime:** Node.js 20+
- **Architecture:** Layered Orchestration with Push-Model Event Dispatch
- **Key Technology:** GitHub Copilot SDK 0.1.32 + Paperclip REST API

## Quick Reference

- **Tech Stack:** TypeScript, Node.js, Copilot SDK, OpenTelemetry, Zod, Vitest
- **Entry Points:** CLI (`src/index.ts`), Heartbeat (`src/heartbeat-entrypoint.ts`), Webhook (`:3200`), MCP (stdio)
- **Architecture Pattern:** 6-layer orchestration (Paperclip → Adapter → SDK Bridge → Execution → Quality → Observability)
- **Agents:** 9 BMAD personas + CEO orchestrator
- **Tools:** 5 Copilot SDK tools, 5 MCP tools
- **Tests:** 333+ across 16+ files

## Generated Documentation

- [PRD](./PRD-generated.md) — Product Requirements Document: functional/non-functional requirements, data models, env vars, acceptance criteria
- [Project Overview](./project-overview.md) — Purpose, architecture type, tech stack summary, entry points, key metrics
- [Architecture](./architecture-generated.md) — System design, data flow, design decisions, security, error handling, observability
- [Source Tree Analysis](./source-tree-analysis.md) — Complete annotated directory tree, critical directories, integration points
- [Component Inventory](./component-inventory.md) — All agents, tools, MCP tools, adapters, quality gates, observability, config components
- [API Contracts](./api-contracts.md) — All consumed Paperclip endpoints, exposed endpoints, data models, auth, error handling
- [Development Guide](./development-guide.md) — Prerequisites, installation, env vars, build commands, testing, code conventions
- [Deployment Guide](./deployment-guide.md) — Docker, Compose stacks, Paperclip setup, health checks, OTel config, Grafana

## Existing Documentation (Pre-existing, not regenerated)

- [PRD](./PRD.md) — Product Requirements Document
- [Architecture (original)](./architecture.md) — Original architecture doc
- [Implementation Plan](./implementation-plan.md) — Phased build plan
- [Implementation Plan Part 1](./Implementation-plan-part1.md) — Detailed phase 1
- [Implementation Plan Part 2](./Implementation-plan-part2.md) — Detailed phase 2
- [Implementation Plan Part 3](./Implementation-plan-part3.md) — Detailed phase 3
- [E2E Test Instructions](./E2E-TEST-INSTRUCTIONS.md) — End-to-end testing guide
- [E2E Pipeline Design](./e2e-spec-pipeline-design.md) — E2E specification
- [Paperclip Feature Analysis](./bmad-paperclip-feature-analysis.md) — Feature gap analysis
- [Current Workflow Analysis](./current-workflow-analysis.md) — Workflow documentation
- [Revised Target Workflow](./revised-target-workflow.md) — Updated workflow design
- [Research](./research-autonomous-sw-factory.md) — Autonomous SW factory research

### Plans

- [P2-9 Routines Support](./plans/P2-9-routines-support.md)
- [P2-10 Secrets Management](./plans/P2-10-secrets-management.md)
- [P2-11-12 Task Session Persistence](./plans/P2-11-12-task-session-persistence.md)
- [Claw Loop Improvements](./plans/claw-loop-improvements.md)

## Getting Started

1. **Install:** `pnpm install`
2. **Test:** `pnpm test` (333+ tests, ~2.5s)
3. **Dry run:** `pnpm start:dry-run` (no SDK calls)
4. **Live:** `pnpm start` (requires Copilot CLI + subscription)
5. **With Paperclip:** `docker compose up -d && npx tsx scripts/setup-paperclip-company.ts && pnpm start:paperclip`
6. **With observability:** `pnpm observability:up && pnpm start:otel`

## For AI-Assisted Development

When creating a brownfield PRD or planning new features, reference this index as the primary entry point. Key documents for context:

- **Full-stack features:** [Architecture](./architecture-generated.md) + [Component Inventory](./component-inventory.md) + [API Contracts](./api-contracts.md)
- **New agent/tool:** [Component Inventory](./component-inventory.md) (agent and tool sections)
- **Paperclip integration:** [API Contracts](./api-contracts.md) + [Architecture](./architecture-generated.md) (lifecycle section)
- **Testing:** [Development Guide](./development-guide.md) (testing section)
- **Deployment:** [Deployment Guide](./deployment-guide.md)

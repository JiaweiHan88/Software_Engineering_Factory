# BMAD Copilot Factory

> Autonomous Software Building Factory — Paperclip orchestration + GitHub Copilot SDK agents + BMAD Method

## What is this?

A 3-layer autonomous software development system that composes the best open-source tools:

| Layer | Tool | Role |
|-------|------|------|
| **Orchestration** | [Paperclip](https://github.com/paperclipai/paperclip) | Company management: org charts, goals, budgets, governance, heartbeats |
| **Methodology** | [BMAD Method](https://github.com/search?q=bmad-method) | Sprint-based SDLC: story creation, implementation, adversarial code review |
| **Execution** | [Copilot SDK](https://github.com/github/copilot-sdk) | Programmable agent runtime: custom agents, tools, MCP, skills, hooks |

## Architecture

```
┌──────────────────────────────────────────────────┐
│              PAPERCLIP SERVER                      │
│   Org chart · Goals · Budgets · Governance        │
│   ┌────────────────────────────────────────────┐  │
│   │  CEO → PM → Architect → Dev → QA → PO     │  │
│   └────────────────────────────────────────────┘  │
│                  ▼ heartbeats                      │
├──────────────────────────────────────────────────┤
│           COPILOT SDK ADAPTER                      │
│   Custom Agents (BMAD roles) + Tools (BMAD cmds)  │
│   MCP Servers + Skills + Hooks + Sessions          │
│                  ▼ JSON-RPC                        │
├──────────────────────────────────────────────────┤
│           COPILOT CLI (headless)                   │
│   File ops · Git ops · Shell · MCP servers         │
│                  ▼ LLM calls                       │
├──────────────────────────────────────────────────┤
│   Claude Sonnet 4.5 | GPT-4.1 | BYOK              │
└──────────────────────────────────────────────────┘
```

## Quick Start

### Prerequisites

- Node.js 20+
- GitHub Copilot CLI (`copilot`)
- GitHub Copilot subscription (Pro or higher)
- Docker (for Paperclip)

### Install

```bash
npm install
```

### Run sandbox (test SDK connectivity)

```bash
npm run sandbox:hello
```

### Run with Paperclip

```bash
docker compose up -d     # Start Paperclip + PostgreSQL
npm run dev               # Start the adapter
```

## Project Status

🔴 **Phase 0** — Project scaffolding (current)

See [IMPLEMENTATION-PLAN.md](./IMPLEMENTATION-PLAN.md) for the full roadmap.

## Docs

- [Research & Comparison](./docs/research-autonomous-sw-factory.md) — Technical research on similar projects
- [Implementation Plan](./IMPLEMENTATION-PLAN.md) — Phased implementation with dependencies
- [Architecture](./docs/architecture.md) — ADRs and technical design

## License

MIT

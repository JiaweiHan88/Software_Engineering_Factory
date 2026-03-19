# Paperclip Refactoring Plan — BMAD Copilot Factory

> **Date:** 2026-03-19
> **Status:** ✅ Completed
> **Scope:** Full alignment of BMAD Copilot Factory with the real Paperclip API
> **Source of truth:** https://github.com/paperclipai/paperclip (MIT, 29.7k ★)

---

## 1. Summary of Findings

After auditing every file in our codebase that touches Paperclip, and
cross-referencing against the **real Paperclip source code** (`paperclipai/paperclip`
on GitHub), the current integration layer is **entirely speculative** — endpoints,
types, and the fundamental integration model (pull vs. push) were invented before
the real API was available.

This document catalogs every discrepancy and prescribes the file-by-file
refactoring needed to align with the real Paperclip platform.

---

## 2. What We Got WRONG (Invented / Assumed)

| Our Code | Real Paperclip | Impact |
|---|---|---|
| API prefix: `/api/v1` | **`/api`** (no version prefix) | Every single endpoint URL is wrong |
| `PUT /api/v1/agents/:id` (register) | Agents are **hired via approval flow** or created via `POST /api/companies/:companyId/agents` | No self-registration endpoint |
| `POST /api/v1/heartbeats/poll` | **No poll endpoint**. Paperclip uses `POST /api/agents/:id/heartbeat/invoke` (server-initiated) and `POST /api/agents/:id/wakeup` (event-triggered) | Our entire poll-loop model is inverted |
| `POST /api/v1/heartbeats/:agentId/ack` | **Doesn't exist**. Heartbeats are fire-and-forget server-side runs | Fake endpoint |
| `PATCH /api/v1/agents/:id/status` | `POST /api/agents/:id/pause`, `POST /api/agents/:id/resume`, `POST /api/agents/:id/terminate` + `PATCH /api/agents/:id` for metadata | Different status model |
| `GET/POST /api/v1/tickets` | **`/api/companies/:companyId/issues`** — Paperclip uses "issues", not "tickets" | Wrong entity name, wrong path |
| `POST /api/v1/reports` | **Doesn't exist**. Results flow back through the heartbeat run transcripts and issue comments | Fake endpoint |
| `GET /api/v1/orgs/:orgId` | **`/api/companies/:companyId/org`** returns org tree. "Companies" not "orgs". | Wrong entity name, wrong path |
| `GET /api/v1/orgs/:orgId/goals` | `/api/companies/:companyId/goals` (company-scoped) | Wrong prefix |
| `X-Paperclip-Org` header | **Not used**. Auth is via Bearer token (agent API key). Company scoping is in the URL path | Invented header |
| Config `orgId` | Should be `companyId` | Wrong naming |
| Agent status: `idle\|working\|stalled\|offline` | Agent status: `active\|paused\|terminated` | Different state machine |
| `PaperclipTicket` type | Should be `PaperclipIssue` with different fields | Wrong type shape |
| `PaperclipHeartbeat` (we-poll-them model) | Paperclip **invokes** the heartbeat on the agent (push model via webhook/callback or CLI adapter) | Architectural inversion |
| `HeartbeatPollResponse` | Doesn't exist — heartbeats are individual runs, not batched polls | Invented type |
| `PaperclipStatusReport` | Doesn't exist — no report-back endpoint | Invented type |
| `PaperclipGoal.progress: number` | Goals exist but the shape differs (company-scoped goals API) | Wrong shape |

---

## 3. What We Got RIGHT

| Our Code | Correct? |
|---|---|
| `GET /api/health` → `{"status":"ok"}` | ✅ Correct (path is `/api/health`) |
| Base URL `http://localhost:3100` | ✅ Correct |
| Bearer token auth | ✅ Correct (agent API keys, hashed at rest) |
| Company-scoped data model | ✅ Conceptually correct, but our `orgId` naming is wrong |
| Docker with PostgreSQL backend | ✅ Correct |
| `docker-compose.yml` (build from source) | ✅ Already fixed last session |
| Embedded PGlite for dev (no Docker needed) | ✅ Real Paperclip does this |

---

## 4. Architectural Correction: Push vs. Pull

### Our current model (WRONG)

```
BMAD Factory  →  pollHeartbeats()  →  Paperclip Server
                                         ↓
BMAD Factory  ←  heartbeats[]      ←  Paperclip Server
```

We poll Paperclip for work. This is **completely wrong**.

### Real Paperclip model

```
Paperclip Server → invokeHeartbeat(agentId) → Agent adapter (webhook/CLI)
                                                      ↓
                                               Agent executes work
                                                      ↓
                                               Results via transcript / issue comments
```

Paperclip **pushes** heartbeats to agents. The agent receives a heartbeat
(via webhook callback for HTTP agents, or via CLI spawn for OpenClaw/Claude
agents). The agent doesn't poll.

### Our corrected model — three integration patterns

1. **Webhook mode** (production): BMAD Factory exposes an HTTP endpoint.
   Paperclip calls it on heartbeat invoke. We process work and respond.

2. **CLI adapter mode** (development): Paperclip spawns a CLI command for each
   heartbeat. Our `pnpm start -- --dispatch <phase> <storyId>` already works
   this way.

3. **Inbox-polling bridge** (dev convenience): For development convenience, we
   can keep a poll-like mode that periodically calls
   `GET /api/agents/me/inbox-lite` (which does exist) to check for assigned
   issues, then processes them. This is a BMAD-side convenience, not a real
   Paperclip API contract.

---

## 5. Real Paperclip API Reference

Source: `packages/shared/src/api.ts`

```typescript
export const API_PREFIX = "/api";
export const API = {
  health:       `${API_PREFIX}/health`,
  companies:    `${API_PREFIX}/companies`,
  agents:       `${API_PREFIX}/agents`,
  projects:     `${API_PREFIX}/projects`,
  issues:       `${API_PREFIX}/issues`,
  goals:        `${API_PREFIX}/goals`,
  approvals:    `${API_PREFIX}/approvals`,
  secrets:      `${API_PREFIX}/secrets`,
  costs:        `${API_PREFIX}/costs`,
  activity:     `${API_PREFIX}/activity`,
  dashboard:    `${API_PREFIX}/dashboard`,
  sidebarBadges:`${API_PREFIX}/sidebar-badges`,
  invites:      `${API_PREFIX}/invites`,
  joinRequests: `${API_PREFIX}/join-requests`,
  members:      `${API_PREFIX}/members`,
  admin:        `${API_PREFIX}/admin`,
} as const;
```

### Key Agent Endpoints (from `server/src/routes/agents.ts`)

| Method | Path | Description |
|--------|------|-------------|
| `GET`  | `/api/companies/:companyId/agents` | List agents in company |
| `POST` | `/api/companies/:companyId/agents` | Create/hire an agent |
| `GET`  | `/api/agents/:id` | Get agent details |
| `PATCH`| `/api/agents/:id` | Update agent metadata |
| `POST` | `/api/agents/:id/pause` | Pause agent |
| `POST` | `/api/agents/:id/resume` | Resume agent |
| `POST` | `/api/agents/:id/terminate` | Terminate agent |
| `POST` | `/api/agents/:id/heartbeat/invoke` | Trigger a heartbeat run |
| `POST` | `/api/agents/:id/wakeup` | Wake agent for event-driven work |
| `GET`  | `/api/agents/me` | Get self (agent-key auth) |
| `GET`  | `/api/agents/me/inbox-lite` | Get assigned work inbox |
| `GET`  | `/api/companies/:companyId/heartbeat-runs` | List heartbeat runs |
| `GET`  | `/api/heartbeat-runs/:runId` | Get a specific run |
| `POST` | `/api/heartbeat-runs/:runId/cancel` | Cancel a running heartbeat |
| `GET`  | `/api/companies/:companyId/live-runs` | Get currently running heartbeats |
| `GET`  | `/api/companies/:companyId/org` | Get org chart tree |
| `GET`  | `/api/instance/scheduler-heartbeats` | Get scheduler state |

### Key Issue Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET`  | `/api/companies/:companyId/issues` | List issues |
| `POST` | `/api/companies/:companyId/issues` | Create issue |
| `GET`  | `/api/issues/:id` | Get issue |
| `PATCH`| `/api/issues/:id` | Update issue |
| `POST` | `/api/issues/:id/comments` | Add comment to issue |

### Auth Model

- **Board access**: Full operator control (session auth)
- **Agent access**: Bearer API keys (`agent_api_keys`), hashed at rest
- Agent keys are company-scoped — cannot access other companies
- Base path: `/api` (no version prefix)

---

## 6. File-by-File Refactoring Plan

### 6.1 `src/config/config.ts` — MINOR UPDATE

**Changes:**
- `PaperclipConfig.orgId` → `companyId`
- `PaperclipConfig.apiKey` → `agentApiKey`
- `PAPERCLIP_ORG_ID` → `PAPERCLIP_COMPANY_ID` env var
- `PAPERCLIP_API_KEY` → `PAPERCLIP_AGENT_API_KEY` env var
- Rename `pollIntervalMs` → `inboxCheckIntervalMs` (bridge mode)

**Reason:** Everything else depends on config field names.

---

### 6.2 `src/adapter/paperclip-client.ts` — FULL REWRITE

**Types to replace:**

| Old Type | New Type | Notes |
|---|---|---|
| `PaperclipAgent` | `PaperclipAgent` | New shape: `status: "active"\|"paused"\|"terminated"`, add `companyId`, `title`, `reportsTo`, `adapterType`, `heartbeatEnabled`, `heartbeatCronSchedule`, `monthlyBudget` |
| `PaperclipTicket` | `PaperclipIssue` | Rename + new fields: `assigneeId`, `projectId`, `goalId`, `parentIssueId` |
| `PaperclipHeartbeat` | `HeartbeatRun` | Represents a completed/running heartbeat run record |
| `HeartbeatPollResponse` | **DELETE** | Doesn't exist |
| `PaperclipStatusReport` | **DELETE** | Doesn't exist |
| `PaperclipOrg` | `OrgNode` | Returns tree structure `{agent, children[]}` |
| `PaperclipGoal` | `PaperclipGoal` | Restructure to match real API |
| `PaperclipClientOptions` | `PaperclipClientOptions` | `orgId` → `companyId`, `apiKey` → `agentApiKey` |

**Methods to replace:**

| Old Method | New Method | Real Endpoint |
|---|---|---|
| `registerAgent()` | `createAgent()` | `POST /api/companies/:companyId/agents` |
| `listAgents()` | `listAgents()` | `GET /api/companies/:companyId/agents` |
| `getAgent(id)` | `getAgent(id)` | `GET /api/agents/:id` |
| `updateAgentStatus()` | `updateAgent()` / `pauseAgent()` / `resumeAgent()` | `PATCH /api/agents/:id` + lifecycle endpoints |
| `pollHeartbeats()` | **DELETE** | Doesn't exist |
| `acknowledgeHeartbeat()` | **DELETE** | Doesn't exist |
| `listTickets()` | `listIssues()` | `GET /api/companies/:companyId/issues` |
| `getTicket()` | `getIssue()` | `GET /api/issues/:id` |
| `createTicket()` | `createIssue()` | `POST /api/companies/:companyId/issues` |
| `updateTicket()` | `updateIssue()` | `PATCH /api/issues/:id` |
| `reportStatus()` | **DELETE** → use `addIssueComment()` | `POST /api/issues/:id/comments` |
| `getOrg()` | `getOrgTree()` | `GET /api/companies/:companyId/org` |
| `listGoals()` | `listGoals()` | `GET /api/companies/:companyId/goals` |
| `ping()` | `ping()` | `GET /api/health` ✅ (fix path only) |
| — | NEW `getAgentSelf()` | `GET /api/agents/me` |
| — | NEW `getAgentInbox()` | `GET /api/agents/me/inbox-lite` |
| — | NEW `invokeHeartbeat()` | `POST /api/agents/:id/heartbeat/invoke` |
| — | NEW `wakeAgent()` | `POST /api/agents/:id/wakeup` |
| — | NEW `listHeartbeatRuns()` | `GET /api/companies/:companyId/heartbeat-runs` |
| — | NEW `addIssueComment()` | `POST /api/issues/:id/comments` |

---

### 6.3 `src/adapter/paperclip-loop.ts` — MAJOR REWRITE

- Remove poll-based loop entirely
- Replace with two modes:
  - **Webhook server mode**: HTTP server that receives heartbeat callbacks from Paperclip
  - **Inbox-polling mode** (bridge/dev): Periodically checks `GET /api/agents/me/inbox-lite` for assigned issues, processes them
- Remove `PaperclipHeartbeat` import → use `PaperclipIssue`
- Update `registerAllAgents()` → `createAgent()` with proper Paperclip agent shape
- Remove `acknowledgeHeartbeat` and `updateAgentStatus` calls
- Update event types

---

### 6.4 `src/adapter/heartbeat-handler.ts` — MODERATE REWRITE

- `PaperclipHeartbeat` type → replaced with `PaperclipIssue` or new `HeartbeatInvocation` context
- `handlePaperclipHeartbeat()` → `handlePaperclipIssue()` — converts an assigned Paperclip issue into a BMAD dispatch
- Remove reporter interaction (no `reportStatus()` endpoint) → replace with `addIssueComment()` for status updates
- `HeartbeatContext.ticket` → `HeartbeatContext.issue`

---

### 6.5 `src/adapter/reporter.ts` — MAJOR REWRITE

- Remove `PaperclipStatusReport` (doesn't exist in real API)
- Remove `PaperclipTicket` → `PaperclipIssue`
- `reportStatus()` → `addIssueComment()` — post a comment to the Paperclip issue thread
- `updateTicketStatus()` → `updateIssue()` with status change
- Keep local history logging (useful for our audit trail)

---

### 6.6 `src/adapter/health-check.ts` — MINOR UPDATE

- `PaperclipClient` constructor: `apiKey` → `agentApiKey`, `orgId` → `companyId`
- Health endpoint at `/api/health` ✅ (fix client prefix)

---

### 6.7 `src/adapter/index.ts` — UPDATE EXPORTS

- Remove: `PaperclipTicket`, `PaperclipHeartbeat`, `HeartbeatPollResponse`, `PaperclipStatusReport`, `PaperclipOrg`, `PaperclipGoal`
- Add: `PaperclipIssue`, `HeartbeatRun`, `OrgNode`

---

### 6.8 `src/index.ts` — MINOR UPDATE

- Update `--paperclip` mode to use new PaperclipLoop API
- Update event types
- Update config field names (`orgId` → `companyId`)

---

### 6.9 `docker-compose.yml` — MINOR UPDATE

- `PAPERCLIP_ORG_ID` → `PAPERCLIP_COMPANY_ID`
- `PAPERCLIP_API_KEY` → `PAPERCLIP_AGENT_API_KEY`
- Add comment about `npx paperclipai onboard --yes` alternative to Docker

---

### 6.10 `test/paperclip-client.test.ts` — FULL REWRITE

- All 21 tests reference old endpoints and types
- Rewrite to match new client API surface

---

### 6.11 `docs/architecture.md` — UPDATE

- Fix the Paperclip integration description
- Correct the data flow (push model, not pull)
- Update type names and API paths
- Correct the agent status model

---

### 6.12 `README.md` — UPDATE

- Fix environment variable names
- Fix Paperclip setup instructions (mention `npx paperclipai onboard`)
- Fix architecture diagram
- Update env var table

---

### 6.13 `IMPLEMENTATION-PLAN.md` — UPDATE

- Mark Phase 4 as needing real Paperclip alignment
- Update Docker instructions

---

### 6.14 `.github/copilot-instructions.md` — REVIEW

- Update "Paperclip" description to match reality

---

## 7. Execution Order

1. **Config** (`config.ts`) — rename fields first since everything depends on it
2. **Client** (`paperclip-client.ts`) — full rewrite with real API
3. **Handler** (`heartbeat-handler.ts`) — adapt to new types
4. **Reporter** (`reporter.ts`) — adapt to issue comments model
5. **Loop** (`paperclip-loop.ts`) — rewrite integration loop
6. **Health check** (`health-check.ts`) — update constructor calls
7. **Barrel exports** (`adapter/index.ts`) — update exports
8. **Entry point** (`src/index.ts`) — update CLI mode
9. **Docker** (`docker-compose.yml`) — update env vars
10. **Tests** (`test/paperclip-client.test.ts`) — full rewrite
11. **Docs** (`architecture.md`, `README.md`, `IMPLEMENTATION-PLAN.md`, `copilot-instructions.md`)

---

## 8. Risk Assessment

| Risk | Mitigation |
|------|------------|
| Breaking standalone mode (sprint-runner) | Standalone mode doesn't use Paperclip client — no impact |
| Breaking dispatch mode (live e2e) | Dispatch mode doesn't use Paperclip client — no impact |
| Tests failing during transition | Rewrite tests in sync with client; run after each file |
| Paperclip API changes rapidly | Pin our integration to a known Paperclip release tag |
| Can't test webhook mode without Paperclip running | Inbox-polling bridge provides a testable fallback |

---

## 9. Out of Scope (Future Work)

- Actually running Paperclip locally and doing a live integration test
- Implementing the webhook receiver HTTP server (Phase 2 — after client is correct)
- Paperclip company/agent provisioning automation (onboarding script)
- Cost tracking integration (`/api/costs`)
- Approval gate integration (`/api/approvals`)
- Invite/join flow for agent onboarding

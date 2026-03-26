# BMAD Copilot Factory — API Contracts

> Generated: 2026-03-26 | Scan Level: Exhaustive | Source: Direct code analysis of `src/adapter/paperclip-client.ts`

## Overview

BMAD Copilot Factory acts as an **API consumer** of the Paperclip control plane. It does not expose its own REST API (except the webhook listener and health endpoint). All interactions with Paperclip use Bearer API key authentication (`PAPERCLIP_AGENT_API_KEY`) scoped to a company.

## Consumed Paperclip API Endpoints

### Agent Management

| Method | Endpoint | Purpose | Auth |
|--------|----------|---------|------|
| `POST` | `/api/companies/:companyId/agent-hires` | Create agent in Paperclip | Bearer |
| `GET` | `/api/companies/:companyId/agents` | List all agents in company | Bearer |
| `GET` | `/api/agents/:agentId` | Get agent by ID | Bearer |
| `GET` | `/api/agents/me` | Get calling agent (self) | Bearer |
| `PATCH` | `/api/agents/:agentId` | Update agent metadata | Bearer |
| `POST` | `/api/agents/:agentId/pause` | Pause agent | Bearer |
| `POST` | `/api/agents/:agentId/resume` | Resume agent | Bearer |
| `POST` | `/api/agents/:agentId/terminate` | Terminate agent | Bearer |

### Heartbeat & Wakeup

| Method | Endpoint | Purpose | Auth |
|--------|----------|---------|------|
| `POST` | `/api/agents/:agentId/heartbeat/invoke` | Trigger heartbeat for agent | Bearer |
| `POST` | `/api/agents/:agentId/wakeup` | Wake sleeping agent | Bearer |
| `GET` | `/api/agents/me/inbox-lite` | Get assigned issues (inbox polling) | Bearer |

### Heartbeat Runs

| Method | Endpoint | Purpose | Auth |
|--------|----------|---------|------|
| `GET` | `/api/companies/:companyId/heartbeat-runs` | List heartbeat runs | Bearer |
| `GET` | `/api/heartbeat-runs/:runId` | Get specific run | Bearer |
| `POST` | `/api/heartbeat-runs/:runId/cancel` | Cancel running heartbeat | Bearer |
| `GET` | `/api/companies/:companyId/live-runs` | List currently running heartbeats | Bearer |

### Issue Management

| Method | Endpoint | Purpose | Auth |
|--------|----------|---------|------|
| `GET` | `/api/companies/:companyId/issues` | List issues (filters: status, assignee, project, goal, parent) | Bearer |
| `GET` | `/api/issues/:issueId` | Get issue by ID | Bearer |
| `POST` | `/api/companies/:companyId/issues` | Create issue | Bearer |
| `PATCH` | `/api/issues/:issueId` | Update issue (status, assignee, metadata, etc.) | Bearer |
| `POST` | `/api/issues/:issueId/checkout` | Checkout issue (mutual exclusion) | Bearer |
| `POST` | `/api/issues/:issueId/release` | Release checkout (idempotent) | Bearer |

### Issue Comments

| Method | Endpoint | Purpose | Auth |
|--------|----------|---------|------|
| `POST` | `/api/issues/:issueId/comments` | Add comment | Bearer |
| `GET` | `/api/issues/:issueId/comments` | List comments (cursor, order) | Bearer |
| `GET` | `/api/issues/:issueId/comments/:commentId` | Get specific comment | Bearer |

### Cost Events

| Method | Endpoint | Purpose | Auth |
|--------|----------|---------|------|
| `POST` | `/api/companies/:companyId/cost-events` | Record cost event (token usage, model, cost) | Bearer |

### Other

| Method | Endpoint | Purpose | Auth |
|--------|----------|---------|------|
| `GET` | `/api/health` | Paperclip server health check | None |
| `GET` | `/api/companies/:companyId/org-chart` | Org chart tree (agent hierarchy) | Bearer |
| `GET` | `/api/companies/:companyId/dashboard` | Dashboard summary (agents, tasks, costs) | Bearer |

## Exposed HTTP Endpoints

### Webhook Server (`src/webhook-server.ts`, port 3200)

| Method | Endpoint | Purpose |
|--------|----------|---------|
| `POST` | `/heartbeat/invoke` | Receive Paperclip heartbeat callbacks |
| `GET` | `/health` | Webhook server health |

### Health Endpoint (`src/health.ts`)

| Method | Endpoint | Purpose |
|--------|----------|---------|
| `GET` | `/health` | Basic health check (embedded in main process) |

## Key Data Models

### PaperclipIssue (consumed)

```typescript
interface PaperclipIssue {
  id: string;                    // UUID
  identifier: string;            // Human-readable (e.g., "BMAD-42")
  title: string;
  description: string;
  status: string;                // backlog | todo | in_progress | done | cancelled
  assigneeAgentId: string;       // Agent UUID
  projectId?: string;
  goalId?: string;
  parentId?: string;             // Parent issue UUID (for sub-issues)
  companyId: string;
  priority?: string;             // critical | high | medium | low
  labels?: string[];
  storyId?: string;
  phase?: string;                // WorkPhase (e.g., "create-story", "dev-story")
  metadata?: Record<string, unknown>;
  createdAt: string;             // ISO-8601
  updatedAt: string;
}
```

### PaperclipAgent (consumed)

```typescript
interface PaperclipAgent {
  id: string;                    // UUID
  name: string;                  // e.g., "bmad-dev"
  title: string;                 // e.g., "Senior Developer"
  companyId: string;
  role: string;                  // Paperclip role enum
  capabilities: string[];
  status: string;                // active | paused | terminated | idle
  reportsTo?: string;            // Parent agent UUID (org chart)
  adapterType?: string;
  heartbeatEnabled: boolean;
  heartbeatCronSchedule?: string;
  monthlyBudget?: number;
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}
```

### PaperclipCostEvent (produced)

```typescript
interface PaperclipCostEvent {
  agentId: string;
  issueId?: string;
  projectId?: string;
  goalId?: string;
  heartbeatRunId?: string;
  provider: string;              // "anthropic" | "openai" | "google" | etc.
  biller: string;                // "copilot" | "anthropic" | "openai"
  billingType: string;           // "copilot_quota" | "byok"
  model: string;                 // e.g., "claude-sonnet-4.5"
  inputTokens: number;
  cachedInputTokens?: number;
  outputTokens: number;
  costCents: number;             // Integer cents
  occurredAt: string;            // ISO-8601
}
```

### IssueHeartbeatContext (internal)

```typescript
interface IssueHeartbeatContext {
  issue: PaperclipIssue;
  ancestors?: PaperclipIssue[];  // Parent chain
  project?: { id: string; title: string };
  goal?: { id: string; title: string };
  commentCursor?: string;        // For incremental comment fetching
  wakeComment?: string;          // Comment that triggered wakeup
}
```

## Authentication

- **Bearer token**: All Paperclip API calls use `Authorization: Bearer <PAPERCLIP_AGENT_API_KEY>`
- **Company-scoped**: API key is scoped to a single company; cross-company access is denied
- **Run ID header**: Heartbeat runs include `X-Paperclip-Run-Id` header for correlation

## Error Handling

- **Retry policy**: GET/DELETE retry on 500 (up to 2 retries with 1s delay); mutations never retry
- **Error class**: `PaperclipApiError` with `statusCode`, `endpoint`, `responseBody`
- **Timeout**: AbortController with configurable timeout; 408 on timeout
- **Retryable errors**: 500+, 408, TypeError (DNS/fetch), AbortError
- **Non-retryable**: 400, 401, 403, 404, 409, 422

## HTTP Request Pattern

```typescript
// All requests follow this pattern:
async request<T>(method: string, path: string, body?: unknown): Promise<T> {
  // 1. Build headers (Content-Type, Accept, Bearer auth, X-Paperclip-Run-Id)
  // 2. Set timeout via AbortController
  // 3. Fetch with error handling
  // 4. Retry 500s for idempotent methods (GET, DELETE) only
  // 5. Parse JSON response
}
```

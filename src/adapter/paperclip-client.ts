/**
 * Paperclip API Client — HTTP interface to Paperclip orchestrator.
 *
 * Aligned with the **real Paperclip API** (paperclipai/paperclip).
 *
 * Key differences from previous (speculative) implementation:
 * - API prefix: `/api` (no version prefix)
 * - Company-scoped data model (not "org")
 * - Issues, not tickets
 * - Push model: Paperclip invokes heartbeats on agents (no polling endpoint)
 * - Agent status: active | paused | terminated (not idle/working/stalled/offline)
 * - Auth: Bearer agent API key (no X-Paperclip-Org header)
 * - Results flow back via issue comments (no /reports endpoint)
 *
 * @module adapter/paperclip-client
 */

// ─────────────────────────────────────────────────────────────────────────────
// Paperclip Data Models (aligned with real API)
// ─────────────────────────────────────────────────────────────────────────────

/** Paperclip agent record — matches real `/api/agents/:id` shape. */
export interface PaperclipAgent {
  id: string;
  name: string;
  title: string;
  companyId: string;
  status: "active" | "paused" | "terminated";
  reportsTo?: string;
  adapterType?: string;
  heartbeatEnabled: boolean;
  heartbeatCronSchedule?: string;
  monthlyBudget?: number;
  metadata?: Record<string, unknown>;
  createdAt?: string;
  updatedAt?: string;
}

/** Paperclip issue record — matches real `/api/issues/:id` shape. */
export interface PaperclipIssue {
  id: string;
  title: string;
  description: string;
  status: string;
  assigneeId?: string;
  projectId?: string;
  goalId?: string;
  parentIssueId?: string;
  companyId?: string;
  labels?: string[];
  /** BMAD-specific: story ID mapped from issue metadata */
  storyId?: string;
  /** BMAD-specific: workflow phase */
  phase?: string;
  createdAt?: string;
  updatedAt?: string;
  metadata?: Record<string, unknown>;
}

/** A comment on a Paperclip issue. */
export interface PaperclipIssueComment {
  id?: string;
  issueId: string;
  body: string;
  authorId?: string;
  createdAt?: string;
}

/** Heartbeat run record — represents a completed/running heartbeat invocation. */
export interface HeartbeatRun {
  id: string;
  agentId: string;
  companyId: string;
  status: "running" | "completed" | "failed" | "cancelled";
  startedAt: string;
  completedAt?: string;
  transcript?: string;
  metadata?: Record<string, unknown>;
}

/** Org chart tree node — matches real `/api/companies/:companyId/org` shape. */
export interface OrgNode {
  agent: PaperclipAgent;
  children: OrgNode[];
}

/** Paperclip goal — matches real `/api/companies/:companyId/goals` shape. */
export interface PaperclipGoal {
  id: string;
  title: string;
  description?: string;
  status: string;
  companyId: string;
  createdAt?: string;
  updatedAt?: string;
  metadata?: Record<string, unknown>;
}

// ─────────────────────────────────────────────────────────────────────────────
// API Error
// ─────────────────────────────────────────────────────────────────────────────

/** Structured error from Paperclip API calls. */
export class PaperclipApiError extends Error {
  readonly statusCode: number;
  readonly endpoint: string;
  readonly responseBody: string;

  constructor(statusCode: number, endpoint: string, responseBody: string) {
    super(`Paperclip API ${statusCode} on ${endpoint}: ${responseBody.slice(0, 200)}`);
    this.name = "PaperclipApiError";
    this.statusCode = statusCode;
    this.endpoint = endpoint;
    this.responseBody = responseBody;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Client Configuration
// ─────────────────────────────────────────────────────────────────────────────

/** Options for constructing a PaperclipClient. */
export interface PaperclipClientOptions {
  /** Base URL of the Paperclip server (e.g., "http://localhost:3100") */
  baseUrl: string;
  /** Agent API key for Bearer auth (optional — not needed in local_trusted mode) */
  agentApiKey?: string;
  /** Company ID to scope company-level requests */
  companyId?: string;
  /** Request timeout in milliseconds (default 10_000) */
  timeoutMs?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Paperclip Client
// ─────────────────────────────────────────────────────────────────────────────

/**
 * HTTP client for the real Paperclip orchestration platform.
 *
 * API reference: `paperclipai/paperclip` → `packages/shared/src/api.ts`
 *
 * Usage:
 * ```ts
 * const client = new PaperclipClient({
 *   baseUrl: "http://localhost:3100",
 *   companyId: "bmad-factory",
 *   agentApiKey: "my-agent-key",
 * });
 *
 * // Create a BMAD agent
 * await client.createAgent({ name: "BMAD Developer", title: "Developer", ... });
 *
 * // Get assigned work (inbox-polling bridge)
 * const inbox = await client.getAgentInbox();
 *
 * // Post status update via issue comment
 * await client.addIssueComment(issueId, "✅ Story implemented successfully.");
 * ```
 */
export class PaperclipClient {
  private baseUrl: string;
  private agentApiKey?: string;
  private companyId: string;
  private timeoutMs: number;

  constructor(opts: PaperclipClientOptions) {
    // Strip trailing slash
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.agentApiKey = opts.agentApiKey;
    this.companyId = opts.companyId ?? "default";
    this.timeoutMs = opts.timeoutMs ?? 10_000;
  }

  // ── Internal HTTP helpers ─────────────────────────────────────────────

  /**
   * Build standard headers for Paperclip API requests.
   *
   * Real Paperclip uses Bearer token auth (agent API keys).
   * No custom headers like X-Paperclip-Org — company scoping is in the URL path.
   */
  private headers(): Record<string, string> {
    const h: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json",
    };
    if (this.agentApiKey) {
      h["Authorization"] = `Bearer ${this.agentApiKey}`;
    }
    return h;
  }

  /**
   * Generic fetch wrapper with timeout and error handling.
   */
  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const res = await fetch(url, {
        method,
        headers: this.headers(),
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new PaperclipApiError(res.status, `${method} ${path}`, text);
      }

      // 204 No Content
      if (res.status === 204) return undefined as T;

      return (await res.json()) as T;
    } catch (err) {
      if (err instanceof PaperclipApiError) throw err;
      if ((err as Error).name === "AbortError") {
        throw new PaperclipApiError(408, `${method} ${path}`, `Request timed out after ${this.timeoutMs}ms`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  // ── Agent Management ──────────────────────────────────────────────────

  /**
   * Create (hire) a new agent in the company.
   * Real endpoint: POST /api/companies/:companyId/agents
   */
  async createAgent(agent: Omit<PaperclipAgent, "id" | "createdAt" | "updatedAt">): Promise<PaperclipAgent> {
    return this.request<PaperclipAgent>(
      "POST",
      `/api/companies/${this.companyId}/agents`,
      agent,
    );
  }

  /**
   * List all agents in the company.
   * Real endpoint: GET /api/companies/:companyId/agents
   */
  async listAgents(): Promise<PaperclipAgent[]> {
    return this.request<PaperclipAgent[]>(
      "GET",
      `/api/companies/${this.companyId}/agents`,
    );
  }

  /**
   * Get a single agent by ID.
   * Real endpoint: GET /api/agents/:id
   */
  async getAgent(agentId: string): Promise<PaperclipAgent> {
    return this.request<PaperclipAgent>("GET", `/api/agents/${agentId}`);
  }

  /**
   * Get the current agent (self) via agent-key auth.
   * Real endpoint: GET /api/agents/me
   */
  async getAgentSelf(): Promise<PaperclipAgent> {
    return this.request<PaperclipAgent>("GET", "/api/agents/me");
  }

  /**
   * Update agent metadata.
   * Real endpoint: PATCH /api/agents/:id
   */
  async updateAgent(
    agentId: string,
    updates: Partial<Pick<PaperclipAgent, "name" | "title" | "reportsTo" | "heartbeatEnabled" | "heartbeatCronSchedule" | "monthlyBudget" | "metadata">>,
  ): Promise<PaperclipAgent> {
    return this.request<PaperclipAgent>(
      "PATCH",
      `/api/agents/${agentId}`,
      updates,
    );
  }

  /**
   * Pause an agent.
   * Real endpoint: POST /api/agents/:id/pause
   */
  async pauseAgent(agentId: string): Promise<void> {
    await this.request<void>("POST", `/api/agents/${agentId}/pause`);
  }

  /**
   * Resume a paused agent.
   * Real endpoint: POST /api/agents/:id/resume
   */
  async resumeAgent(agentId: string): Promise<void> {
    await this.request<void>("POST", `/api/agents/${agentId}/resume`);
  }

  /**
   * Terminate an agent permanently.
   * Real endpoint: POST /api/agents/:id/terminate
   */
  async terminateAgent(agentId: string): Promise<void> {
    await this.request<void>("POST", `/api/agents/${agentId}/terminate`);
  }

  // ── Heartbeat / Wakeup ────────────────────────────────────────────────

  /**
   * Invoke a heartbeat run on an agent (server-initiated push).
   * Real endpoint: POST /api/agents/:id/heartbeat/invoke
   *
   * NOTE: In the real Paperclip model, the *server* calls this endpoint
   * to push work to agents. The BMAD factory doesn't poll for heartbeats.
   */
  async invokeHeartbeat(agentId: string): Promise<HeartbeatRun> {
    return this.request<HeartbeatRun>(
      "POST",
      `/api/agents/${agentId}/heartbeat/invoke`,
    );
  }

  /**
   * Wake an agent for event-driven work.
   * Real endpoint: POST /api/agents/:id/wakeup
   */
  async wakeAgent(agentId: string): Promise<void> {
    await this.request<void>("POST", `/api/agents/${agentId}/wakeup`);
  }

  /**
   * Get the agent's assigned work inbox (dev convenience / bridge mode).
   * Real endpoint: GET /api/agents/me/inbox-lite
   */
  async getAgentInbox(): Promise<PaperclipIssue[]> {
    return this.request<PaperclipIssue[]>("GET", "/api/agents/me/inbox-lite");
  }

  // ── Heartbeat Runs ────────────────────────────────────────────────────

  /**
   * List heartbeat runs for the company.
   * Real endpoint: GET /api/companies/:companyId/heartbeat-runs
   */
  async listHeartbeatRuns(): Promise<HeartbeatRun[]> {
    return this.request<HeartbeatRun[]>(
      "GET",
      `/api/companies/${this.companyId}/heartbeat-runs`,
    );
  }

  /**
   * Get a specific heartbeat run.
   * Real endpoint: GET /api/heartbeat-runs/:runId
   */
  async getHeartbeatRun(runId: string): Promise<HeartbeatRun> {
    return this.request<HeartbeatRun>("GET", `/api/heartbeat-runs/${runId}`);
  }

  /**
   * Cancel a running heartbeat.
   * Real endpoint: POST /api/heartbeat-runs/:runId/cancel
   */
  async cancelHeartbeatRun(runId: string): Promise<void> {
    await this.request<void>("POST", `/api/heartbeat-runs/${runId}/cancel`);
  }

  /**
   * Get currently running heartbeats (live runs).
   * Real endpoint: GET /api/companies/:companyId/live-runs
   */
  async getLiveRuns(): Promise<HeartbeatRun[]> {
    return this.request<HeartbeatRun[]>(
      "GET",
      `/api/companies/${this.companyId}/live-runs`,
    );
  }

  // ── Issue Management ──────────────────────────────────────────────────

  /**
   * List issues for the company.
   * Real endpoint: GET /api/companies/:companyId/issues
   */
  async listIssues(filters?: {
    status?: string;
    assigneeId?: string;
    projectId?: string;
    goalId?: string;
  }): Promise<PaperclipIssue[]> {
    const params = new URLSearchParams();
    if (filters?.status) params.set("status", filters.status);
    if (filters?.assigneeId) params.set("assignee_id", filters.assigneeId);
    if (filters?.projectId) params.set("project_id", filters.projectId);
    if (filters?.goalId) params.set("goal_id", filters.goalId);
    const qs = params.toString();
    return this.request<PaperclipIssue[]>(
      "GET",
      `/api/companies/${this.companyId}/issues${qs ? `?${qs}` : ""}`,
    );
  }

  /**
   * Get a single issue by ID.
   * Real endpoint: GET /api/issues/:id
   */
  async getIssue(issueId: string): Promise<PaperclipIssue> {
    return this.request<PaperclipIssue>("GET", `/api/issues/${issueId}`);
  }

  /**
   * Create a new issue in the company.
   * Real endpoint: POST /api/companies/:companyId/issues
   */
  async createIssue(issue: Omit<PaperclipIssue, "id" | "createdAt" | "updatedAt">): Promise<PaperclipIssue> {
    return this.request<PaperclipIssue>(
      "POST",
      `/api/companies/${this.companyId}/issues`,
      issue,
    );
  }

  /**
   * Update an existing issue.
   * Real endpoint: PATCH /api/issues/:id
   */
  async updateIssue(
    issueId: string,
    updates: Partial<Pick<PaperclipIssue, "title" | "description" | "status" | "assigneeId" | "labels" | "metadata">>,
  ): Promise<PaperclipIssue> {
    return this.request<PaperclipIssue>(
      "PATCH",
      `/api/issues/${issueId}`,
      updates,
    );
  }

  /**
   * Add a comment to an issue (primary mechanism for reporting results).
   * Real endpoint: POST /api/issues/:id/comments
   *
   * This replaces the old reportStatus() — in real Paperclip, results flow
   * back through issue comments and heartbeat run transcripts.
   */
  async addIssueComment(issueId: string, body: string): Promise<PaperclipIssueComment> {
    return this.request<PaperclipIssueComment>(
      "POST",
      `/api/issues/${issueId}/comments`,
      { body },
    );
  }

  // ── Organization & Goals ──────────────────────────────────────────────

  /**
   * Get the org chart tree for the company.
   * Real endpoint: GET /api/companies/:companyId/org
   */
  async getOrgTree(): Promise<OrgNode> {
    return this.request<OrgNode>(
      "GET",
      `/api/companies/${this.companyId}/org`,
    );
  }

  /**
   * List goals for the company.
   * Real endpoint: GET /api/companies/:companyId/goals
   */
  async listGoals(): Promise<PaperclipGoal[]> {
    return this.request<PaperclipGoal[]>(
      "GET",
      `/api/companies/${this.companyId}/goals`,
    );
  }

  // ── Health Check ──────────────────────────────────────────────────────

  /**
   * Ping the Paperclip server — returns true if it responds with 2xx.
   * Real endpoint: GET /api/health ✅
   */
  async ping(): Promise<boolean> {
    try {
      await this.request<unknown>("GET", "/api/health");
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get the base URL for display/logging.
   */
  get url(): string {
    return this.baseUrl;
  }

  /**
   * Get the company ID for display/logging.
   */
  get company(): string {
    return this.companyId;
  }
}

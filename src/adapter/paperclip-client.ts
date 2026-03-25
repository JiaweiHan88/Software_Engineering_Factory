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
  /** Agent role in the org (e.g., "engineer", "pm", "manager") */
  role?: string;
  /** Human-readable description of agent capabilities */
  capabilities?: string;
  status: "active" | "paused" | "terminated" | "idle";
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
  /** Human-readable identifier (e.g., "BMA-3"). Auto-assigned by Paperclip. */
  identifier?: string;
  title: string;
  description: string;
  status: string;
  /** Paperclip field: assigneeAgentId (UUID of agent assigned to this issue) */
  assigneeAgentId?: string;
  projectId?: string;
  goalId?: string;
  /** Paperclip field: parentId (UUID of parent issue for sub-issues) */
  parentId?: string;
  companyId?: string;
  /** Paperclip field: priority (critical | high | medium | low) */
  priority?: string;
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

/**
 * Compact heartbeat context — returned by `GET /api/issues/:id/heartbeat-context`.
 *
 * Contains the issue, its ancestor chain, associated project/goal, the latest
 * comment cursor, and (when wakeCommentId is supplied) the specific wake comment.
 * Replaces separate `getIssue()` + `getIssueComments()` calls with a single
 * round-trip that reduces API calls by ~30%.
 */
export interface IssueHeartbeatContext {
  issue: {
    id: string;
    identifier?: string;
    title: string;
    description: string;
    status: string;
    priority?: string;
    projectId?: string;
    goalId?: string;
    parentId?: string;
    assigneeAgentId?: string;
    assigneeUserId?: string;
    updatedAt?: string;
  };
  ancestors: Array<{
    id: string;
    identifier?: string;
    title: string;
    status: string;
    priority?: string;
  }>;
  project: {
    id: string;
    name: string;
    status: string;
    targetDate?: string;
  } | null;
  goal: {
    id: string;
    title: string;
    status: string;
    level?: string;
    parentId?: string;
  } | null;
  /** Cursor for incremental comment reads — pass as `after` to getIssueComments() */
  commentCursor: string | null;
  /** The specific comment that triggered this wake, if wakeCommentId was provided */
  wakeComment: PaperclipIssueComment | null;
}

/** An issue document — stored at `GET /api/issues/:id/documents/:key`. */
export interface IssueDocument {
  id: string;
  issueId: string;
  key: string;
  title?: string;
  format: "markdown" | "text" | "json";
  body: string;
  latestRevisionNumber: number;
  createdAt?: string;
  updatedAt?: string;
}

/** Dashboard summary — returned by `GET /api/companies/:companyId/dashboard`. */
export interface DashboardSummary {
  companyId: string;
  agents: {
    active: number;
    running: number;
    paused: number;
    error: number;
  };
  tasks: {
    open: number;
    inProgress: number;
    blocked: number;
    done: number;
  };
  costs: {
    monthSpendCents: number;
    monthBudgetCents: number;
    monthUtilizationPercent: number;
  };
  pendingApprovals: number;
  budgets: {
    activeIncidents: number;
    pendingApprovals: number;
    pausedAgents: number;
    pausedProjects: number;
  };
}

/**
 * Paperclip cost event — POST /api/companies/:companyId/cost-events.
 *
 * Feeds the native Paperclip cost dashboard, budget tracking, and
 * per-agent/per-model spend analytics.
 */
export interface PaperclipCostEvent {
  agentId: string;
  issueId?: string | null;
  projectId?: string | null;
  goalId?: string | null;
  heartbeatRunId?: string | null;
  provider: string;
  biller?: string;
  billingType?: "metered_api" | "subscription_included" | "subscription_overage" | "credits" | "fixed" | "unknown";
  model: string;
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  /** Cost in integer cents (e.g., $0.0042 → 0, $0.05 → 5, $1.23 → 123) */
  costCents: number;
  /** ISO 8601 datetime string */
  occurredAt: string;
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
  /** Agent UUID — required for checkout/release protocol (Phase A) */
  agentId?: string;
  /** Request timeout in milliseconds (default 10_000) */
  timeoutMs?: number;
  /**
   * Heartbeat run ID — sent as X-Paperclip-Run-Id header.
   * Required by Paperclip when using agent API key auth to post comments
   * and perform other agent-scoped write operations.
   */
  heartbeatRunId?: string;
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
  private agentId?: string;
  private companyId: string;
  private timeoutMs: number;
  private heartbeatRunId?: string;

  constructor(opts: PaperclipClientOptions) {
    // Strip trailing slash
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.agentApiKey = opts.agentApiKey;
    this.agentId = opts.agentId;
    this.companyId = opts.companyId ?? "default";
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.heartbeatRunId = opts.heartbeatRunId;
  }

  // ── Internal HTTP helpers ─────────────────────────────────────────────

  /**
   * Build standard headers for Paperclip API requests.
   *
   * Real Paperclip uses Bearer token auth (agent API keys).
   * X-Paperclip-Run-Id is required for agent write operations (comments, etc.).
   */
  private headers(): Record<string, string> {
    const h: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json",
    };
    if (this.agentApiKey) {
      h["Authorization"] = `Bearer ${this.agentApiKey}`;
    }
    if (this.heartbeatRunId) {
      h["X-Paperclip-Run-Id"] = this.heartbeatRunId;
    }
    return h;
  }

  /**
   * Generic fetch wrapper with timeout, retries for transient errors, and error handling.
   *
   * Retries up to 2 times on 500 (Internal Server Error) with a 1s delay,
   * but ONLY for idempotent methods (GET, DELETE). POST/PATCH/PUT are NOT
   * retried because Paperclip may return 500 after the write succeeds
   * (e.g., a post-commit hook fails), and retrying would create duplicates.
   */
  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const isIdempotent = method === "GET" || method === "DELETE";
    const maxRetries = isIdempotent ? 2 : 0;
    let lastError: PaperclipApiError | undefined;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (attempt > 0) {
        await new Promise((r) => setTimeout(r, 1000));
      }

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
          const err = new PaperclipApiError(res.status, `${method} ${path}`, text);

          if (res.status === 500 && attempt < maxRetries) {
            lastError = err;
            continue;
          }
          throw err;
        }

        if (res.status === 204) return undefined as T;

        return (await res.json()) as T;
      } catch (err) {
        if (err instanceof PaperclipApiError) {
          if (err.statusCode === 500 && attempt < maxRetries) {
            lastError = err;
            continue;
          }
          throw err;
        }
        if ((err as Error).name === "AbortError") {
          throw new PaperclipApiError(408, `${method} ${path}`, `Request timed out after ${this.timeoutMs}ms`);
        }
        throw err;
      } finally {
        clearTimeout(timer);
      }
    }

    throw lastError ?? new PaperclipApiError(500, `${method} ${path}`, "All retries exhausted");
  }

  // ── Agent Management ──────────────────────────────────────────────────

  /**
   * Hire a new agent in the company.
   *
   * Uses POST /api/companies/:companyId/agent-hires (not /agents).
   * The /agents endpoint requires board-level auth, but /agent-hires
   * respects the `canCreateAgents` permission on the calling agent —
   * which is what we need for the CEO agent to create BMAD sub-agents.
   *
   * Body matches `createAgentHireSchema`:
   *   name (required), role?, title?, adapterType?, adapterConfig?,
   *   runtimeConfig?, capabilities?, reportsTo?, budgetMonthlyCents?,
   *   permissions?, metadata?, sourceIssueId?, sourceIssueIds?
   */
  async createAgent(agent: {
    name: string;
    role?: string;
    title?: string;
    adapterType?: string;
    adapterConfig?: Record<string, unknown>;
    runtimeConfig?: Record<string, unknown>;
    capabilities?: string;
    reportsTo?: string;
    budgetMonthlyCents?: number;
    permissions?: { canCreateAgents?: boolean };
    metadata?: Record<string, unknown>;
  }): Promise<PaperclipAgent> {
    return this.request<PaperclipAgent>(
      "POST",
      `/api/companies/${this.companyId}/agent-hires`,
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
    assigneeAgentId?: string;
    projectId?: string;
    goalId?: string;
    parentId?: string;
  }): Promise<PaperclipIssue[]> {
    const params = new URLSearchParams();
    if (filters?.status) params.set("status", filters.status);
    if (filters?.assigneeAgentId) params.set("assigneeAgentId", filters.assigneeAgentId);
    if (filters?.projectId) params.set("project_id", filters.projectId);
    if (filters?.goalId) params.set("goal_id", filters.goalId);
    if (filters?.parentId) params.set("parentId", filters.parentId);
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
    updates: Partial<Pick<PaperclipIssue, "title" | "description" | "status" | "assigneeAgentId" | "priority" | "labels" | "metadata" | "parentId">>,
  ): Promise<PaperclipIssue> {
    return this.request<PaperclipIssue>(
      "PATCH",
      `/api/issues/${issueId}`,
      updates,
    );
  }

  /**
   * Checkout (lock) an issue before doing any work.
   *
   * Paperclip SKILL.md Step 5: "You MUST checkout before doing any work."
   * Without checkout, two heartbeat runs can process the same issue simultaneously,
   * causing duplicate work and conflicting state.
   *
   * Real endpoint: POST /api/issues/:id/checkout
   *
   * @param issueId - The issue ID to checkout
   * @param expectedStatuses - Only checkout if the issue is in one of these statuses (required, non-empty)
   * @returns The updated issue (status auto-set to in_progress), or the existing issue if
   *          already assigned to this agent (invoke-triggered executionRunId lock), or
   *          `null` if another agent owns the checkout
   */
  async checkoutIssue(
    issueId: string,
    expectedStatuses: string[],
  ): Promise<PaperclipIssue | null> {
    if (!this.agentId) {
      throw new Error(
        "PaperclipClient.checkoutIssue() requires agentId — pass it in PaperclipClientOptions",
      );
    }
    if (!expectedStatuses || expectedStatuses.length === 0) {
      throw new Error(
        "PaperclipClient.checkoutIssue() requires non-empty expectedStatuses",
      );
    }
    try {
      return await this.request<PaperclipIssue>(
        "POST",
        `/api/issues/${issueId}/checkout`,
        {
          agentId: this.agentId,
          expectedStatuses,
        },
      );
    } catch (err) {
      if (err instanceof PaperclipApiError && err.statusCode === 409) {
        // 409 Conflict — could be:
        // (a) Another agent owns the checkout → skip
        // (b) Paperclip's enqueueWakeup already set executionRunId for OUR agent
        //     (common in invoke-triggered heartbeats). In board-access mode our
        //     checkoutRunId is null, so the SQL rejects us even though we are
        //     the rightful assignee. Detect this and treat as "already ours".
        try {
          const issue = await this.getIssue(issueId);
          if (issue.assigneeAgentId === this.agentId) {
            // We are the assignee — the executionRunId lock is ours from the invoke.
            return issue;
          }
        } catch {
          // If we can't fetch the issue, fall through to null (skip)
        }
        return null;
      }
      throw err;
    }
  }

  /**
   * Release a previously checked-out issue.
   *
   * Called on error/timeout paths to release the checkout lock so another
   * agent (or a future heartbeat) can pick up the task.
   *
   * Real endpoint: POST /api/issues/:id/release
   *
   * Idempotent: releasing an unchecked-out task is a no-op (does not throw).
   *
   * @param issueId - The issue ID to release
   */
  async releaseIssue(issueId: string): Promise<void> {
    try {
      await this.request<void>(
        "POST",
        `/api/issues/${issueId}/release`,
      );
    } catch (err) {
      // Releasing an unchecked-out task is a no-op — swallow 404/409
      if (
        err instanceof PaperclipApiError &&
        (err.statusCode === 404 || err.statusCode === 409)
      ) {
        return;
      }
      throw err;
    }
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

  /**
   * Get comments on an issue — supports incremental reads via `after` cursor.
   *
   * Real endpoint: GET /api/issues/:id/comments
   *
   * @param issueId - The issue ID to get comments for
   * @param options - Optional: `after` comment ID for incremental reads, `order` (asc/desc)
   * @returns Array of comments
   */
  async getIssueComments(
    issueId: string,
    options?: { after?: string; order?: "asc" | "desc" },
  ): Promise<PaperclipIssueComment[]> {
    const params = new URLSearchParams();
    if (options?.after) params.set("after", options.after);
    if (options?.order) params.set("order", options.order);
    const qs = params.toString();
    return this.request<PaperclipIssueComment[]>(
      "GET",
      `/api/issues/${issueId}/comments${qs ? `?${qs}` : ""}`,
    );
  }

  /**
   * Get a single comment by ID.
   *
   * Real endpoint: GET /api/issues/:id/comments/:commentId
   *
   * @param issueId - The issue ID
   * @param commentId - The comment ID
   * @returns The comment
   */
  async getIssueComment(
    issueId: string,
    commentId: string,
  ): Promise<PaperclipIssueComment> {
    return this.request<PaperclipIssueComment>(
      "GET",
      `/api/issues/${issueId}/comments/${commentId}`,
    );
  }

  // ── Cost Reporting ────────────────────────────────────────────────────

  /**
   * Report a cost event to Paperclip's native cost tracking system.
   * Real endpoint: POST /api/companies/:companyId/cost-events
   *
   * This feeds the /costs dashboard, budget enforcement, and per-agent/model
   * spend analytics. Each LLM interaction should be reported as one event.
   */
  async reportCostEvent(event: PaperclipCostEvent): Promise<{ id: string }> {
    return this.request<{ id: string }>(
      "POST",
      `/api/companies/${this.companyId}/cost-events`,
      event,
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

  // ── Heartbeat Context ─────────────────────────────────────────────────

  /**
   * Get compact heartbeat context for an issue — single round-trip replacement
   * for separate `getIssue()` + `getIssueComments()` calls.
   *
   * Returns issue state, ancestor chain, project/goal info, comment cursor
   * metadata, and (when wakeCommentId is supplied) the specific wake comment.
   * Reduces API calls by ~30% on the hot heartbeat path.
   *
   * Real endpoint: GET /api/issues/:id/heartbeat-context
   *
   * @param issueId - The issue to load context for
   * @param wakeCommentId - Optional comment that triggered this wake
   */
  async getHeartbeatContext(
    issueId: string,
    wakeCommentId?: string,
  ): Promise<IssueHeartbeatContext> {
    const params = new URLSearchParams();
    if (wakeCommentId) params.set("wakeCommentId", wakeCommentId);
    const qs = params.toString();
    return this.request<IssueHeartbeatContext>(
      "GET",
      `/api/issues/${issueId}/heartbeat-context${qs ? `?${qs}` : ""}`,
    );
  }

  // ── Issue Documents ───────────────────────────────────────────────────

  /**
   * List all documents attached to an issue.
   * Real endpoint: GET /api/issues/:id/documents
   */
  async getIssueDocuments(issueId: string): Promise<IssueDocument[]> {
    return this.request<IssueDocument[]>(
      "GET",
      `/api/issues/${issueId}/documents`,
    );
  }

  /**
   * Get a specific document by key.
   * Real endpoint: GET /api/issues/:id/documents/:key
   */
  async getIssueDocument(issueId: string, key: string): Promise<IssueDocument> {
    return this.request<IssueDocument>(
      "GET",
      `/api/issues/${issueId}/documents/${encodeURIComponent(key)}`,
    );
  }

  /**
   * Upsert (create or update) a structured document on an issue.
   * Real endpoint: PUT /api/issues/:id/documents/:key
   *
   * Documents are keyed values (e.g., "plan", "notes", "spec") that store
   * structured content alongside an issue. Use for storing plans, specs, and
   * other long-lived artifacts instead of embedding them in descriptions.
   *
   * @param issueId - The issue to attach the document to
   * @param key - Lowercase identifier for the document (e.g., "plan")
   * @param document - The document content and metadata
   */
  async upsertIssueDocument(
    issueId: string,
    key: string,
    document: {
      title?: string;
      format: "markdown" | "text" | "json";
      body: string;
      changeSummary?: string;
      baseRevisionId?: string;
    },
  ): Promise<IssueDocument> {
    return this.request<IssueDocument>(
      "PUT",
      `/api/issues/${issueId}/documents/${encodeURIComponent(key)}`,
      document,
    );
  }

  // ── Dashboard ─────────────────────────────────────────────────────────

  /**
   * Get the company dashboard summary.
   *
   * Returns agent health (active/running/paused/error counts), task counts,
   * monthly cost spend and budget utilization, pending approvals, and budget
   * incidents. Use early in the CEO heartbeat for situational awareness.
   *
   * Real endpoint: GET /api/companies/:companyId/dashboard
   */
  async getDashboard(): Promise<DashboardSummary> {
    return this.request<DashboardSummary>(
      "GET",
      `/api/companies/${this.companyId}/dashboard`,
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

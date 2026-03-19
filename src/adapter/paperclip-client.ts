/**
 * Paperclip API Client — HTTP interface to Paperclip orchestrator.
 *
 * Provides typed access to Paperclip's REST API for:
 * - Agent registration and heartbeat polling
 * - Ticket/task assignment and status updates
 * - Organization and role management
 * - Sprint and goal tracking
 *
 * All methods throw `PaperclipApiError` on non-2xx responses.
 *
 * @module adapter/paperclip-client
 */

// ─────────────────────────────────────────────────────────────────────────────
// Paperclip Data Models
// ─────────────────────────────────────────────────────────────────────────────

/** Paperclip agent registration record. */
export interface PaperclipAgent {
  id: string;
  name: string;
  role: string;
  status: "idle" | "working" | "stalled" | "offline";
  lastHeartbeat?: string;
  assignedTicket?: string;
  metadata?: Record<string, unknown>;
}

/** Paperclip ticket/task record. */
export interface PaperclipTicket {
  id: string;
  title: string;
  description: string;
  status: "open" | "assigned" | "in-progress" | "review" | "done" | "blocked";
  assignedAgent?: string;
  priority: number;
  labels: string[];
  storyId?: string;
  phase?: string;
  createdAt: string;
  updatedAt: string;
  metadata?: Record<string, unknown>;
}

/** Paperclip heartbeat payload — sent periodically to each agent. */
export interface PaperclipHeartbeat {
  agentId: string;
  agentRole: string;
  ticket?: PaperclipTicket;
  timestamp: string;
  instructions?: string;
  metadata?: Record<string, unknown>;
}

/** A batch of heartbeats returned by the poll endpoint. */
export interface HeartbeatPollResponse {
  heartbeats: PaperclipHeartbeat[];
  nextPollAfterMs: number;
}

/** Status report payload to send back to Paperclip. */
export interface PaperclipStatusReport {
  agentId: string;
  ticketId: string;
  status: "working" | "completed" | "failed" | "needs-human";
  message: string;
  artifacts?: string[];
  metadata?: Record<string, unknown>;
}

/** Paperclip organization summary. */
export interface PaperclipOrg {
  id: string;
  name: string;
  agentCount: number;
  activeTickets: number;
  goals: PaperclipGoal[];
}

/** Paperclip goal/objective. */
export interface PaperclipGoal {
  id: string;
  title: string;
  status: "active" | "completed" | "paused";
  progress: number;
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
  /** API key for authentication (optional — not needed in local_trusted mode) */
  apiKey?: string;
  /** Organization ID to scope requests */
  orgId?: string;
  /** Request timeout in milliseconds (default 10_000) */
  timeoutMs?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Paperclip Client
// ─────────────────────────────────────────────────────────────────────────────

/**
 * HTTP client for the Paperclip orchestration platform.
 *
 * Usage:
 * ```ts
 * const client = new PaperclipClient({
 *   baseUrl: "http://localhost:3100",
 *   orgId: "bmad-factory",
 * });
 *
 * // Register a BMAD agent
 * await client.registerAgent({ id: "bmad-dev", name: "BMAD Developer", role: "developer" });
 *
 * // Poll for heartbeats
 * const { heartbeats } = await client.pollHeartbeats(["bmad-dev", "bmad-pm"]);
 *
 * // Report status back
 * await client.reportStatus({ agentId: "bmad-dev", ticketId: "T-1", status: "completed", message: "Done" });
 * ```
 */
export class PaperclipClient {
  private baseUrl: string;
  private apiKey?: string;
  private orgId: string;
  private timeoutMs: number;

  constructor(opts: PaperclipClientOptions) {
    // Strip trailing slash
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.apiKey = opts.apiKey;
    this.orgId = opts.orgId ?? "default";
    this.timeoutMs = opts.timeoutMs ?? 10_000;
  }

  // ── Internal HTTP helpers ─────────────────────────────────────────────

  /**
   * Build standard headers for Paperclip API requests.
   */
  private headers(): Record<string, string> {
    const h: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json",
    };
    if (this.apiKey) {
      h["Authorization"] = `Bearer ${this.apiKey}`;
    }
    if (this.orgId) {
      h["X-Paperclip-Org"] = this.orgId;
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
   * Register or update a BMAD agent in Paperclip.
   */
  async registerAgent(agent: Omit<PaperclipAgent, "lastHeartbeat">): Promise<PaperclipAgent> {
    return this.request<PaperclipAgent>("PUT", `/api/v1/agents/${agent.id}`, agent);
  }

  /**
   * List all registered agents.
   */
  async listAgents(): Promise<PaperclipAgent[]> {
    return this.request<PaperclipAgent[]>("GET", "/api/v1/agents");
  }

  /**
   * Get a single agent by ID.
   */
  async getAgent(agentId: string): Promise<PaperclipAgent> {
    return this.request<PaperclipAgent>("GET", `/api/v1/agents/${agentId}`);
  }

  /**
   * Update an agent's status (e.g., working → idle).
   */
  async updateAgentStatus(
    agentId: string,
    status: PaperclipAgent["status"],
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    await this.request<void>("PATCH", `/api/v1/agents/${agentId}/status`, {
      status,
      metadata,
    });
  }

  // ── Heartbeat Polling ─────────────────────────────────────────────────

  /**
   * Poll Paperclip for pending heartbeats for the given agent IDs.
   *
   * This is the core integration point — the BMAD factory calls this on an
   * interval to discover work assigned by Paperclip's org chart scheduler.
   *
   * @param agentIds - Agent IDs to poll for (e.g., ["bmad-dev", "bmad-pm"])
   * @returns Heartbeats with assigned tickets and suggested poll delay
   */
  async pollHeartbeats(agentIds: string[]): Promise<HeartbeatPollResponse> {
    return this.request<HeartbeatPollResponse>(
      "POST",
      "/api/v1/heartbeats/poll",
      { agentIds },
    );
  }

  /**
   * Acknowledge a heartbeat — tells Paperclip the agent received the work.
   */
  async acknowledgeHeartbeat(agentId: string, ticketId: string): Promise<void> {
    await this.request<void>("POST", `/api/v1/heartbeats/${agentId}/ack`, {
      ticketId,
    });
  }

  // ── Ticket Management ─────────────────────────────────────────────────

  /**
   * List tickets, optionally filtered by status or assignment.
   */
  async listTickets(filters?: {
    status?: PaperclipTicket["status"];
    assignedAgent?: string;
    label?: string;
  }): Promise<PaperclipTicket[]> {
    const params = new URLSearchParams();
    if (filters?.status) params.set("status", filters.status);
    if (filters?.assignedAgent) params.set("assigned_agent", filters.assignedAgent);
    if (filters?.label) params.set("label", filters.label);
    const qs = params.toString();
    return this.request<PaperclipTicket[]>("GET", `/api/v1/tickets${qs ? `?${qs}` : ""}`);
  }

  /**
   * Get a single ticket by ID.
   */
  async getTicket(ticketId: string): Promise<PaperclipTicket> {
    return this.request<PaperclipTicket>("GET", `/api/v1/tickets/${ticketId}`);
  }

  /**
   * Create a new ticket in Paperclip.
   */
  async createTicket(ticket: Omit<PaperclipTicket, "id" | "createdAt" | "updatedAt">): Promise<PaperclipTicket> {
    return this.request<PaperclipTicket>("POST", "/api/v1/tickets", ticket);
  }

  /**
   * Update a ticket's status and/or metadata.
   */
  async updateTicket(
    ticketId: string,
    updates: Partial<Pick<PaperclipTicket, "status" | "assignedAgent" | "labels" | "metadata">>,
  ): Promise<PaperclipTicket> {
    return this.request<PaperclipTicket>("PATCH", `/api/v1/tickets/${ticketId}`, updates);
  }

  // ── Status Reporting ──────────────────────────────────────────────────

  /**
   * Report the outcome of processing a heartbeat/ticket back to Paperclip.
   *
   * This closes the loop: Paperclip assigns work → BMAD processes → report result.
   */
  async reportStatus(report: PaperclipStatusReport): Promise<void> {
    await this.request<void>("POST", "/api/v1/reports", report);
  }

  // ── Organization & Goals ──────────────────────────────────────────────

  /**
   * Get organization summary including active goals.
   */
  async getOrg(): Promise<PaperclipOrg> {
    return this.request<PaperclipOrg>("GET", `/api/v1/orgs/${this.orgId}`);
  }

  /**
   * List goals for the organization.
   */
  async listGoals(): Promise<PaperclipGoal[]> {
    return this.request<PaperclipGoal[]>("GET", `/api/v1/orgs/${this.orgId}/goals`);
  }

  // ── Health Check ──────────────────────────────────────────────────────

  /**
   * Ping the Paperclip server — returns true if it responds with 2xx.
   */
  async ping(): Promise<boolean> {
    try {
      await this.request<unknown>("GET", "/api/v1/health");
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
}

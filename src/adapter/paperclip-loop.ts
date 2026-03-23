/**
 * Paperclip Loop — Issue-Driven Integration Engine
 *
 * The main Paperclip ↔ BMAD integration engine. Aligned with the real
 * Paperclip API (push model, not poll model).
 *
 * Two integration modes:
 *
 * 1. **Inbox-polling bridge** (development/default):
 *    Periodically checks GET /api/agents/me/inbox-lite for assigned issues,
 *    then dispatches them to BMAD agents. This is a BMAD-side convenience,
 *    not a real Paperclip API contract.
 *
 * 2. **Webhook server** (production):
 *    Exposes an HTTP endpoint that Paperclip calls on heartbeat invoke.
 *    The BMAD factory processes the work and responds.
 *    (Webhook server implementation is planned for Phase 2.)
 *
 * Lifecycle:
 * 1. Create BMAD agents in Paperclip (POST /api/companies/:companyId/agents)
 * 2. Enter inbox check loop:
 *    a. Check inbox for assigned issues
 *    b. For each issue, dispatch to the appropriate BMAD agent
 *    c. Report results back via issue comments
 *    d. Sleep for the configured interval
 * 3. On shutdown, pause agents and clean up sessions
 *
 * @module adapter/paperclip-loop
 */

import type { BmadConfig } from "../config/config.js";
import type { AgentDispatcher } from "./agent-dispatcher.js";
import type { SessionManager } from "./session-manager.js";
import { PaperclipClient } from "./paperclip-client.js";
import type { PaperclipIssue } from "./paperclip-client.js";
import { PaperclipReporter } from "./reporter.js";
import { handlePaperclipIssue } from "./heartbeat-handler.js";
import type { HeartbeatResult } from "./heartbeat-handler.js";
import { Logger } from "../observability/logger.js";

const log = Logger.child("paperclip-loop");
import { allAgents } from "../agents/registry.js";

// ─────────────────────────────────────────────────────────────────────────────
// Events
// ─────────────────────────────────────────────────────────────────────────────

/** Paperclip loop lifecycle events. */
export type PaperclipLoopEvent =
  | { type: "loop-start"; agentCount: number; mode: "inbox-polling" | "webhook" }
  | { type: "inbox-check"; issueCount: number }
  | { type: "issue-processed"; agentId: string; issueId: string; result: HeartbeatResult }
  | { type: "issue-error"; agentId: string; issueId: string; error: string }
  | { type: "inbox-error"; error: string }
  | { type: "loop-stop"; reason: string }
  | { type: "agents-created"; count: number };

export type PaperclipLoopEventHandler = (event: PaperclipLoopEvent) => void;

// ─────────────────────────────────────────────────────────────────────────────
// Options
// ─────────────────────────────────────────────────────────────────────────────

/** Options for running the Paperclip integration loop. */
export interface PaperclipLoopOptions {
  /** Event callback for lifecycle events */
  onEvent?: PaperclipLoopEventHandler;
  /** Streaming callback for agent output */
  onDelta?: (delta: string) => void;
  /** Override inbox check interval (defaults to config.paperclip.inboxCheckIntervalMs) */
  inboxCheckIntervalMs?: number;
  /** Maximum number of check cycles before stopping (undefined = infinite) */
  maxCycles?: number;
  /** Whether to create agents on startup (default: true) */
  createAgents?: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Paperclip Loop
// ─────────────────────────────────────────────────────────────────────────────

/**
 * PaperclipLoop drives the BMAD factory via Paperclip's issue assignment.
 *
 * In inbox-polling mode (default/dev), periodically checks the agent inbox
 * for assigned issues. In webhook mode (production), receives heartbeat
 * callbacks from Paperclip.
 *
 * Usage:
 * ```ts
 * const loop = new PaperclipLoop(sessionManager, dispatcher, config);
 * await loop.start({
 *   onEvent: (e) => console.log(e),
 * });
 * // ... runs until stopped or maxCycles reached
 * await loop.stop();
 * ```
 */
export class PaperclipLoop {
  private sessionManager: SessionManager;
  private dispatcher: AgentDispatcher;
  private config: BmadConfig;
  private client: PaperclipClient;
  private reporter: PaperclipReporter;
  private running = false;
  private abortController: AbortController | null = null;

  constructor(
    sessionManager: SessionManager,
    dispatcher: AgentDispatcher,
    config: BmadConfig,
  ) {
    this.sessionManager = sessionManager;
    this.dispatcher = dispatcher;
    this.config = config;

    this.client = new PaperclipClient({
      baseUrl: config.paperclip.url,
      agentApiKey: config.paperclip.agentApiKey,
      companyId: config.paperclip.companyId,
      timeoutMs: config.paperclip.timeoutMs,
    });

    this.reporter = new PaperclipReporter(this.client, 500, config.targetProjectRoot);
  }

  /**
   * Start the Paperclip integration loop.
   *
   * This is a long-running async function that blocks until stop() is called
   * or maxCycles is reached.
   */
  async start(opts: PaperclipLoopOptions = {}): Promise<void> {
    const {
      onEvent,
      inboxCheckIntervalMs = this.config.paperclip.inboxCheckIntervalMs,
      maxCycles,
      createAgents = true,
    } = opts;

    if (this.running) {
      throw new Error("PaperclipLoop is already running");
    }

    this.running = true;
    this.abortController = new AbortController();

    const mode = this.config.paperclip.mode;

    // 1. Create BMAD agents in Paperclip
    if (createAgents) {
      await this.createAllAgents(onEvent);
    }

    // 2. Start the Copilot SDK
    if (!this.sessionManager.isReady) {
      log.info("Starting Copilot SDK");
      await this.sessionManager.start();
      log.info("SDK ready");
    }

    onEvent?.({ type: "loop-start", agentCount: allAgents.length, mode });
    log.info("Starting integration loop", { mode, inboxCheckIntervalMs, agents: allAgents.length });

    if (mode === "webhook") {
      // Webhook mode — placeholder for Phase 2
      log.info("Webhook mode: waiting for heartbeat callbacks on port " + this.config.paperclip.webhookPort);
      // TODO: Start HTTP server to receive heartbeat callbacks
      // For now, fall through to inbox-polling as fallback
      log.warn("Webhook server not yet implemented, falling back to inbox-polling");
    }

    // 3. Inbox-polling loop
    let cycle = 0;
    while (this.running) {
      // Check max cycles
      if (maxCycles !== undefined && cycle >= maxCycles) {
        onEvent?.({ type: "loop-stop", reason: `Reached maxCycles (${maxCycles})` });
        break;
      }

      try {
        // Check inbox for assigned issues
        const issues = await this.client.getAgentInbox();

        onEvent?.({ type: "inbox-check", issueCount: issues.length });

        // Process each assigned issue
        for (const issue of issues) {
          await this.processIssue(issue, onEvent);
        }

        // Sleep before next check
        await this.sleep(inboxCheckIntervalMs);
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        onEvent?.({ type: "inbox-error", error: errorMsg });
        log.error("Inbox check error", {}, err instanceof Error ? err : undefined);

        // Back off on errors
        await this.sleep(inboxCheckIntervalMs * 2);
      }

      cycle++;
    }

    this.running = false;
    log.info("Loop stopped");
  }

  /**
   * Stop the Paperclip integration loop gracefully.
   */
  async stop(): Promise<void> {
    log.info("Stopping loop");
    this.running = false;
    this.abortController?.abort();

    // Pause agents (real Paperclip status model)
    for (const agent of allAgents) {
      try {
        await this.client.pauseAgent(agent.name);
      } catch {
        // Best-effort — agent may not exist in Paperclip yet
      }
    }

    // Stop the SDK
    await this.sessionManager.stop();
    log.info("Shutdown complete");
  }

  /**
   * Whether the loop is currently running.
   */
  get isRunning(): boolean {
    return this.running;
  }

  /**
   * Get the Paperclip client for direct API access.
   */
  get paperclipClient(): PaperclipClient {
    return this.client;
  }

  /**
   * Get the reporter for inspecting report history.
   */
  get paperclipReporter(): PaperclipReporter {
    return this.reporter;
  }

  // ── Internal Helpers ──────────────────────────────────────────────────

  /**
   * Create all BMAD agents in Paperclip.
   *
   * Uses POST /api/companies/:companyId/agent-hires (the hire flow).
   * The /agents endpoint requires board-level auth; /agent-hires works
   * with agent API keys that have the `canCreateAgents` permission.
   */
  private async createAllAgents(
    onEvent?: PaperclipLoopEventHandler,
  ): Promise<void> {
    // Map BMAD agent names to Paperclip role enum values
    const roleMap: Record<string, string> = {
      "bmad-analyst": "researcher",
      "bmad-architect": "engineer",
      "bmad-dev": "engineer",
      "bmad-pm": "pm",
      "bmad-qa": "qa",
      "bmad-quick-flow-solo-dev": "engineer",
      "bmad-sm": "pm",
      "bmad-tech-writer": "general",
      "bmad-ux-designer": "designer",
    };

    let created = 0;
    for (const agent of allAgents) {
      try {
        await this.client.createAgent({
          name: agent.displayName,
          role: roleMap[agent.name] ?? "general",
          title: agent.name,
          adapterType: "process",
          capabilities: agent.description,
          metadata: {
            bmadMethodology: "v6",
            bmadRole: agent.name,
          },
        });
        created++;
        log.info("Created agent", { agent: agent.displayName });
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        // 409 Conflict = agent already exists, which is fine
        if (errorMsg.includes("409") || errorMsg.includes("already exists")) {
          log.debug("Agent already exists", { agent: agent.displayName });
          created++;
        } else {
          log.error("Failed to create agent", { agent: agent.displayName, error: errorMsg });
        }
      }
    }

    onEvent?.({ type: "agents-created", count: created });
  }

  /**
   * Process a single issue from the inbox: dispatch to BMAD agent, report result.
   */
  private async processIssue(
    issue: PaperclipIssue,
    onEvent?: PaperclipLoopEventHandler,
  ): Promise<void> {
    // Determine which BMAD agent should handle this issue
    const bmadRole = this.inferAgentRole(issue);
    const agentId = bmadRole; // Use the BMAD role name as agent identifier

    try {
      // Process via the heartbeat handler
      const result = await handlePaperclipIssue(
        issue,
        agentId,
        bmadRole,
        this.dispatcher,
        this.reporter,
      );

      onEvent?.({
        type: "issue-processed",
        agentId,
        issueId: issue.id,
        result,
      });
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      onEvent?.({ type: "issue-error", agentId, issueId: issue.id, error: errorMsg });
      log.error("Issue processing error", { agentId, issueId: issue.id }, err instanceof Error ? err : undefined);
    }
  }

  /**
   * Infer which BMAD agent should handle an issue based on its metadata.
   */
  private inferAgentRole(issue: PaperclipIssue): string {
    // Check metadata for explicit BMAD role
    if (issue.metadata?.bmadRole) {
      return issue.metadata.bmadRole as string;
    }

    // Check phase to determine role
    switch (issue.phase) {
      case "create-story":
        return "bmad-pm";
      case "dev-story":
        return "bmad-dev";
      case "code-review":
        return "bmad-qa";
      case "sprint-planning":
        return "bmad-sm";
      default:
        return "bmad-dev"; // Default to developer
    }
  }

  /**
   * Abortable sleep — respects the abort controller for clean shutdown.
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      this.abortController?.signal.addEventListener("abort", () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
    });
  }
}

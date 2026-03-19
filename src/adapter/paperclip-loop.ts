/**
 * Paperclip Loop — Heartbeat-Driven Integration Loop
 *
 * The main Paperclip ↔ BMAD integration engine. Polls Paperclip for
 * heartbeats, dispatches work to BMAD agents, and reports results back.
 *
 * This is the Paperclip-mode alternative to the standalone SprintRunner.
 * Instead of reading sprint-status.yaml directly, it takes work assignments
 * from Paperclip's org chart scheduler.
 *
 * Lifecycle:
 * 1. Register all BMAD agents with Paperclip
 * 2. Enter poll loop:
 *    a. Poll Paperclip for heartbeats (assigned work)
 *    b. For each heartbeat, dispatch to the appropriate BMAD agent
 *    c. Report results back to Paperclip
 *    d. Sleep for the suggested interval
 * 3. On shutdown, deregister agents and clean up sessions
 *
 * @module adapter/paperclip-loop
 */

import type { BmadConfig } from "../config/config.js";
import type { AgentDispatcher } from "./agent-dispatcher.js";
import type { SessionManager } from "./session-manager.js";
import { PaperclipClient } from "./paperclip-client.js";
import type { PaperclipHeartbeat } from "./paperclip-client.js";
import { PaperclipReporter } from "./reporter.js";
import { handlePaperclipHeartbeat } from "./heartbeat-handler.js";
import type { HeartbeatResult } from "./heartbeat-handler.js";
import { Logger } from "../observability/logger.js";

const log = Logger.child("paperclip-loop");
import { allAgents } from "../agents/registry.js";

// ─────────────────────────────────────────────────────────────────────────────
// Events
// ─────────────────────────────────────────────────────────────────────────────

/** Paperclip loop lifecycle events. */
export type PaperclipLoopEvent =
  | { type: "loop-start"; agentCount: number }
  | { type: "poll"; heartbeatCount: number }
  | { type: "heartbeat-processed"; agentId: string; ticketId?: string; result: HeartbeatResult }
  | { type: "heartbeat-error"; agentId: string; error: string }
  | { type: "poll-error"; error: string }
  | { type: "loop-stop"; reason: string }
  | { type: "agents-registered"; count: number };

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
  /** Override poll interval (defaults to config.paperclip.pollIntervalMs) */
  pollIntervalMs?: number;
  /** Maximum number of poll cycles before stopping (undefined = infinite) */
  maxCycles?: number;
  /** Whether to register agents on startup (default: true) */
  registerAgents?: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Paperclip Loop
// ─────────────────────────────────────────────────────────────────────────────

/**
 * PaperclipLoop drives the BMAD factory via Paperclip's heartbeat mechanism.
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
      apiKey: config.paperclip.apiKey,
      orgId: config.paperclip.orgId,
      timeoutMs: config.paperclip.timeoutMs,
    });

    this.reporter = new PaperclipReporter(this.client);
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
      pollIntervalMs = this.config.paperclip.pollIntervalMs,
      maxCycles,
      registerAgents = true,
    } = opts;

    if (this.running) {
      throw new Error("PaperclipLoop is already running");
    }

    this.running = true;
    this.abortController = new AbortController();

    // 1. Register BMAD agents with Paperclip
    if (registerAgents) {
      await this.registerAllAgents(onEvent);
    }

    // 2. Start the Copilot SDK
    if (!this.sessionManager.isReady) {
      log.info("Starting Copilot SDK");
      await this.sessionManager.start();
      log.info("SDK ready");
    }

    // Get agent IDs for polling
    const agentIds = allAgents.map((a) => a.name);

    onEvent?.({ type: "loop-start", agentCount: agentIds.length });
    log.info("Starting heartbeat loop", { pollIntervalMs, agents: agentIds });

    // 3. Poll loop
    let cycle = 0;
    while (this.running) {
      // Check max cycles
      if (maxCycles !== undefined && cycle >= maxCycles) {
        onEvent?.({ type: "loop-stop", reason: `Reached maxCycles (${maxCycles})` });
        break;
      }

      try {
        // Poll Paperclip for heartbeats
        const pollResult = await this.client.pollHeartbeats(agentIds);

        onEvent?.({ type: "poll", heartbeatCount: pollResult.heartbeats.length });

        // Process each heartbeat
        for (const heartbeat of pollResult.heartbeats) {
          await this.processHeartbeat(heartbeat, onEvent);
        }

        // Respect the server's suggested poll delay
        const delay = pollResult.nextPollAfterMs || pollIntervalMs;
        await this.sleep(delay);
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        onEvent?.({ type: "poll-error", error: errorMsg });
        log.error("Poll error", {}, err instanceof Error ? err : undefined);

        // Back off on errors
        await this.sleep(pollIntervalMs * 2);
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

    // Deregister agents (mark offline)
    for (const agent of allAgents) {
      try {
        await this.client.updateAgentStatus(agent.name, "offline");
      } catch {
        // Best-effort
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
   * Register all BMAD agents with Paperclip.
   */
  private async registerAllAgents(
    onEvent?: PaperclipLoopEventHandler,
  ): Promise<void> {
    let registered = 0;
    for (const agent of allAgents) {
      try {
        await this.client.registerAgent({
          id: agent.name,
          name: agent.displayName,
          role: agent.name,
          status: "idle",
          metadata: {
            description: agent.description,
            bmadMethodology: "v6",
          },
        });
        registered++;
        log.info("Registered agent", { agent: agent.displayName });
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        log.error("Failed to register agent", { agent: agent.displayName, error: errorMsg });
      }
    }

    onEvent?.({ type: "agents-registered", count: registered });
  }

  /**
   * Process a single heartbeat: acknowledge, dispatch, report.
   */
  private async processHeartbeat(
    heartbeat: PaperclipHeartbeat,
    onEvent?: PaperclipLoopEventHandler,
  ): Promise<void> {
    const ticketId = heartbeat.ticket?.id;

    try {
      // Acknowledge the heartbeat
      if (ticketId) {
        await this.client.acknowledgeHeartbeat(heartbeat.agentId, ticketId);
      }

      // Mark agent as working
      await this.client.updateAgentStatus(heartbeat.agentId, "working");

      // Process via the heartbeat handler
      const result = await handlePaperclipHeartbeat(
        heartbeat,
        this.dispatcher,
        this.reporter,
      );

      onEvent?.({
        type: "heartbeat-processed",
        agentId: heartbeat.agentId,
        ticketId,
        result,
      });

      // Mark agent as idle when done
      await this.client.updateAgentStatus(heartbeat.agentId, "idle");
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      onEvent?.({ type: "heartbeat-error", agentId: heartbeat.agentId, error: errorMsg });
      log.error("Heartbeat processing error", { agentId: heartbeat.agentId }, err instanceof Error ? err : undefined);

      // Mark agent as stalled
      try {
        await this.client.updateAgentStatus(heartbeat.agentId, "stalled");
      } catch {
        // Best-effort
      }
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

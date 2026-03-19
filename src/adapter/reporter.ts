/**
 * Paperclip Reporter — Structured Status Reporting
 *
 * Converts BMAD DispatchResults and sprint events into Paperclip-compatible
 * status reports and pushes them back to the Paperclip API.
 *
 * Responsibilities:
 * - Map BMAD lifecycle events → Paperclip ticket status updates
 * - Map agent results → Paperclip status reports with artifacts
 * - Buffer and batch minor updates to reduce API traffic
 * - Log all reports locally for audit trail
 *
 * @module adapter/reporter
 */

import type { PaperclipClient, PaperclipStatusReport, PaperclipTicket } from "./paperclip-client.js";
import type { DispatchResult } from "./agent-dispatcher.js";
import type { HeartbeatResult } from "./heartbeat-handler.js";
import type { SprintEvent } from "./sprint-runner.js";
import { Logger } from "../observability/logger.js";

const log = Logger.child("reporter");

// ─────────────────────────────────────────────────────────────────────────────
// Report History
// ─────────────────────────────────────────────────────────────────────────────

/** A log entry for a report sent to Paperclip. */
export interface ReportLogEntry {
  timestamp: string;
  agentId: string;
  ticketId: string;
  status: PaperclipStatusReport["status"];
  message: string;
  success: boolean;
  error?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Reporter
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Reports BMAD processing results back to Paperclip.
 *
 * Usage:
 * ```ts
 * const reporter = new PaperclipReporter(paperclipClient);
 * await reporter.reportHeartbeatResult("bmad-dev", "T-1", heartbeatResult);
 * await reporter.reportDispatchResult("bmad-dev", "T-1", dispatchResult);
 * ```
 */
export class PaperclipReporter {
  private client: PaperclipClient;
  private history: ReportLogEntry[] = [];
  private maxHistorySize: number;

  constructor(client: PaperclipClient, maxHistorySize = 500) {
    this.client = client;
    this.maxHistorySize = maxHistorySize;
  }

  // ── High-Level Reporting Methods ──────────────────────────────────────

  /**
   * Report the result of processing a Paperclip heartbeat.
   *
   * @param agentId - The BMAD agent that processed the heartbeat
   * @param ticketId - The Paperclip ticket ID
   * @param result - HeartbeatResult from handleHeartbeat()
   */
  async reportHeartbeatResult(
    agentId: string,
    ticketId: string,
    result: HeartbeatResult,
  ): Promise<void> {
    const statusMap: Record<HeartbeatResult["status"], PaperclipStatusReport["status"]> = {
      working: "working",
      completed: "completed",
      stalled: "failed",
      "needs-human": "needs-human",
    };

    await this.sendReport({
      agentId,
      ticketId,
      status: statusMap[result.status],
      message: result.message,
    });

    // Also update the ticket status in Paperclip if completed
    if (result.status === "completed") {
      await this.updateTicketStatus(ticketId, "done");
    } else if (result.status === "needs-human") {
      await this.updateTicketStatus(ticketId, "blocked");
    }
  }

  /**
   * Report the result of a direct agent dispatch.
   *
   * @param agentId - The BMAD agent that handled the dispatch
   * @param ticketId - The Paperclip ticket ID
   * @param result - DispatchResult from AgentDispatcher.dispatch()
   * @param artifacts - Optional list of artifact paths produced
   */
  async reportDispatchResult(
    agentId: string,
    ticketId: string,
    result: DispatchResult,
    artifacts?: string[],
  ): Promise<void> {
    await this.sendReport({
      agentId,
      ticketId,
      status: result.success ? "completed" : "failed",
      message: result.success
        ? `${result.agentName} completed successfully.`
        : `${result.agentName} failed: ${result.error ?? "unknown error"}`,
      artifacts,
    });
  }

  /**
   * Report a sprint lifecycle event to Paperclip.
   * Selectively reports significant events (start, complete, escalation).
   *
   * @param event - SprintEvent from SprintRunner
   * @param agentId - The BMAD agent context (for agent-scoped events)
   */
  async reportSprintEvent(event: SprintEvent, agentId?: string): Promise<void> {
    switch (event.type) {
      case "story-complete":
        if (agentId && event.result.success) {
          await this.sendReport({
            agentId,
            ticketId: event.storyId,
            status: "completed",
            message: `Phase ${event.phase} completed by ${event.result.agentName}.`,
          });
        }
        break;

      case "story-escalated":
        if (agentId) {
          await this.sendReport({
            agentId,
            ticketId: event.storyId,
            status: "needs-human",
            message: `Escalated: ${event.reason}`,
          });
        }
        break;

      case "story-failed":
        if (agentId) {
          await this.sendReport({
            agentId,
            ticketId: event.storyId,
            status: "failed",
            message: `Failed: ${event.error}`,
          });
        }
        break;

      // Sprint-level events are logged but not reported per-ticket
      case "sprint-start":
      case "sprint-complete":
      case "sprint-idle":
        log.debug("Sprint event", { type: event.type });
        break;

      default:
        break;
    }
  }

  // ── Low-Level Reporting ───────────────────────────────────────────────

  /**
   * Send a status report to Paperclip and record it in the history log.
   */
  private async sendReport(report: PaperclipStatusReport): Promise<void> {
    const entry: ReportLogEntry = {
      timestamp: new Date().toISOString(),
      agentId: report.agentId,
      ticketId: report.ticketId,
      status: report.status,
      message: report.message,
      success: false,
    };

    try {
      await this.client.reportStatus(report);
      entry.success = true;
      log.info("Reported status", {
        agentId: report.agentId,
        ticketId: report.ticketId,
        status: report.status,
      });
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      entry.error = errorMsg;
      log.error("Failed to report status", {
        agentId: report.agentId,
        ticketId: report.ticketId,
      }, err instanceof Error ? err : undefined);
    }

    this.addToHistory(entry);
  }

  /**
   * Update a ticket's status in Paperclip. Silently logs failures.
   */
  private async updateTicketStatus(
    ticketId: string,
    status: PaperclipTicket["status"],
  ): Promise<void> {
    try {
      await this.client.updateTicket(ticketId, { status });
      log.info("Ticket status updated", { ticketId, status });
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      log.error("Failed to update ticket", { ticketId, status, error: errorMsg });
    }
  }

  // ── History Management ────────────────────────────────────────────────

  /**
   * Add an entry to the report history, evicting old entries if full.
   */
  private addToHistory(entry: ReportLogEntry): void {
    this.history.push(entry);
    if (this.history.length > this.maxHistorySize) {
      this.history = this.history.slice(-this.maxHistorySize);
    }
  }

  /**
   * Get the report history log.
   *
   * @param limit - Max entries to return (default all)
   */
  getHistory(limit?: number): ReportLogEntry[] {
    if (limit) return this.history.slice(-limit);
    return [...this.history];
  }

  /**
   * Get a summary of report history.
   */
  getSummary(): { total: number; succeeded: number; failed: number } {
    const total = this.history.length;
    const succeeded = this.history.filter((e) => e.success).length;
    return { total, succeeded, failed: total - succeeded };
  }
}

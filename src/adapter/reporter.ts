/**
 * Paperclip Reporter — Structured Status Reporting via Issue Comments
 *
 * Aligned with real Paperclip API:
 * - No /reports endpoint (was invented)
 * - Results flow back through issue comments: POST /api/issues/:id/comments
 * - Issue status updates via: PATCH /api/issues/:id
 *
 * Responsibilities:
 * - Map BMAD lifecycle events → Paperclip issue comments
 * - Map agent results → issue status updates
 * - Buffer and batch minor updates to reduce API traffic
 * - Log all reports locally for audit trail
 *
 * @module adapter/reporter
 */

import type { PaperclipClient } from "./paperclip-client.js";
import type { DispatchResult } from "./agent-dispatcher.js";
import type { HeartbeatResult } from "./heartbeat-handler.js";
import type { SprintEvent } from "./sprint-runner.js";
import { readdirSync, statSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Logger } from "../observability/logger.js";
import { linkifyTickets } from "../utils/comment-format.js";

const log = Logger.child("reporter");

// ─────────────────────────────────────────────────────────────────────────────
// Report History
// ─────────────────────────────────────────────────────────────────────────────

/** A log entry for a report sent to Paperclip. */
export interface ReportLogEntry {
  timestamp: string;
  agentId: string;
  issueId: string;
  status: string;
  message: string;
  success: boolean;
  error?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Reporter
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Reports BMAD processing results back to Paperclip via issue comments.
 *
 * Usage:
 * ```ts
 * const reporter = new PaperclipReporter(paperclipClient);
 * await reporter.reportHeartbeatResult("bmad-dev", "issue-1", heartbeatResult);
 * await reporter.reportDispatchResult("bmad-dev", "issue-1", dispatchResult);
 * ```
 */
export class PaperclipReporter {
  private client: PaperclipClient;
  private history: ReportLogEntry[] = [];
  private maxHistorySize: number;
  private workspaceDir: string | undefined;

  constructor(client: PaperclipClient, maxHistorySize = 500, workspaceDir?: string) {
    this.client = client;
    this.maxHistorySize = maxHistorySize;
    this.workspaceDir = workspaceDir;
  }

  // ── High-Level Reporting Methods ──────────────────────────────────────

  /**
   * Report the result of processing a Paperclip issue.
   *
   * Posts a comment to the Paperclip issue with the result details,
   * and updates the issue status if the work is completed or blocked.
   *
   * @param agentId - The BMAD agent that processed the issue
   * @param issueId - The Paperclip issue ID
   * @param result - HeartbeatResult from handleHeartbeat()
   */
  async reportHeartbeatResult(
    agentId: string,
    issueId: string,
    result: HeartbeatResult,
  ): Promise<void> {
    // Post a comment to the issue with the status
    const statusEmoji: Record<HeartbeatResult["status"], string> = {
      working: "🔄",
      completed: "✅",
      stalled: "❌",
      "needs-human": "⚠️",
    };

    const comment = `${statusEmoji[result.status]} **${result.status.toUpperCase()}** — ${result.message}`;
    await this.postIssueComment(agentId, issueId, result.status, comment);

    // Also update the issue status in Paperclip if completed or blocked
    if (result.status === "completed") {
      // On completion, scan workspace for artifacts and append to comment
      if (this.workspaceDir) {
        const artifactInfo = this.scanWorkspaceArtifacts();
        if (artifactInfo) {
          await this.postIssueComment(agentId, issueId, "artifacts", artifactInfo);
        }
      }
      await this.updateIssueStatus(issueId, "done");

      // Wake the CEO (parent assignee) so it can re-evaluate dependencies
      // and promote the next wave of backlog tasks to "todo".
      await this.wakeParentAssignee(issueId);
    } else if (result.status === "needs-human") {
      await this.updateIssueStatus(issueId, "blocked");
    }
  }

  /**
   * Report the result of a direct agent dispatch.
   *
   * @param agentId - The BMAD agent that handled the dispatch
   * @param issueId - The Paperclip issue ID
   * @param result - DispatchResult from AgentDispatcher.dispatch()
   * @param artifacts - Optional list of artifact paths produced
   */
  async reportDispatchResult(
    agentId: string,
    issueId: string,
    result: DispatchResult,
    artifacts?: string[],
  ): Promise<void> {
    const status = result.success ? "completed" : "failed";
    const emoji = result.success ? "✅" : "❌";
    let comment = `${emoji} **${status.toUpperCase()}** — ${result.success
      ? `${result.agentName} completed successfully.`
      : `${result.agentName} failed: ${result.error ?? "unknown error"}`
    }`;

    if (artifacts?.length) {
      comment += `\n\n**Artifacts:**\n${artifacts.map((a) => `- \`${a}\``).join("\n")}`;
    }

    await this.postIssueComment(agentId, issueId, status, comment);
  }

  /**
   * Report a sprint lifecycle event to Paperclip.
   * Selectively reports significant events (complete, escalation, failure).
   *
   * @param event - SprintEvent from SprintRunner
   * @param agentId - The BMAD agent context (for agent-scoped events)
   */
  async reportSprintEvent(event: SprintEvent, agentId?: string): Promise<void> {
    switch (event.type) {
      case "story-complete":
        if (agentId && event.result.success) {
          await this.postIssueComment(
            agentId,
            event.storyId,
            "completed",
            `✅ Phase ${event.phase} completed by ${event.result.agentName}.`,
          );
        }
        break;

      case "story-escalated":
        if (agentId) {
          await this.postIssueComment(
            agentId,
            event.storyId,
            "needs-human",
            `⚠️ **ESCALATED** — ${event.reason}`,
          );
        }
        break;

      case "story-failed":
        if (agentId) {
          await this.postIssueComment(
            agentId,
            event.storyId,
            "failed",
            `❌ **FAILED** — ${event.error}`,
          );
        }
        break;

      // Sprint-level events are logged but not reported per-issue
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
   * Scan the workspace directory for artifact files produced by agents.
   * Returns a formatted markdown summary of found files, or undefined if none.
   */
  private scanWorkspaceArtifacts(): string | undefined {
    if (!this.workspaceDir) return undefined;
    try {
      const entries = readdirSync(this.workspaceDir, { withFileTypes: true });
      const files = entries
        .filter((e) => e.isFile())
        .map((e) => {
          const fullPath = join(this.workspaceDir!, e.name);
          const stats = statSync(fullPath);
          const sizeKb = (stats.size / 1024).toFixed(1);
          let preview = "";
          try {
            const content = readFileSync(fullPath, "utf-8");
            const lines = content.split("\n").filter((l) => l.trim());
            preview = lines[0]?.slice(0, 100) ?? "";
          } catch {
            preview = "(binary or unreadable)";
          }
          return { name: e.name, sizeKb, preview };
        });
      if (files.length === 0) return undefined;
      return [
        `📁 **Workspace Artifacts** (\`${this.workspaceDir}\`):`,
        "",
        // Format: `filename` | 42 KB — preview
        // Avoid parenthesized decimal sizes like "(41.2 KB)" because Paperclip's
        // file browser plugin regex matches "41.2" as a file path with extension ".2".
        ...files.map((f) => `- \`${f.name}\` | ${Math.round(parseFloat(f.sizeKb))} KB — ${f.preview}`),
      ].join("\n");
    } catch {
      return undefined;
    }
  }

  /**
   * Post a comment to a Paperclip issue and record it in the history log.
   *
   * This is the primary reporting mechanism — replaces the old
   * `reportStatus()` which called a non-existent `/api/v1/reports` endpoint.
   */
  private async postIssueComment(
    agentId: string,
    issueId: string,
    status: string,
    comment: string,
  ): Promise<void> {
    const entry: ReportLogEntry = {
      timestamp: new Date().toISOString(),
      agentId,
      issueId,
      status,
      message: comment,
      success: false,
    };

    try {
      await this.client.addIssueComment(issueId, linkifyTickets(comment));
      entry.success = true;
      log.info("Posted issue comment", {
        agentId,
        issueId,
        status,
      });
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      entry.error = errorMsg;
      log.error("Failed to post issue comment", {
        agentId,
        issueId,
      }, err instanceof Error ? err : undefined);
    }

    this.addToHistory(entry);
  }

  /**
   * Update an issue's status in Paperclip. Silently logs failures.
   *
   * Uses PATCH /api/issues/:id (real endpoint).
   */
  private async updateIssueStatus(
    issueId: string,
    status: string,
  ): Promise<void> {
    try {
      await this.client.updateIssue(issueId, { status });
      log.info("Issue status updated", { issueId, status });
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      log.error("Failed to update issue", { issueId, status, error: errorMsg });
    }
  }

  /**
   * Signal completion to the parent issue's assignee so it can re-evaluate
   * dependencies and promote the next wave of backlog tasks.
   *
   * Strategy: post a brief completion comment on the **parent** issue.
   * Paperclip auto-wakes the parent's assignee when a child issue moves
   * to "done" (child_issue_done trigger), so the comment is purely
   * informational for the audit trail. The actual wake is server-side.
   *
   * Silently logs and returns on any failure — notification is best-effort.
   */
  private async wakeParentAssignee(issueId: string): Promise<void> {
    try {
      const issue = await this.client.getIssue(issueId);
      if (!issue.parentId) {
        return; // Not a sub-issue — nothing to notify
      }

      // Post a brief completion notice on the parent issue for audit trail.
      // Paperclip's child_issue_done trigger handles the actual agent wake.
      const identifier = issue.identifier ?? issue.id.slice(0, 8);
      await this.client.addIssueComment(
        issue.parentId,
        `📋 Sub-task **${identifier}** ("${issue.title.slice(0, 60)}") completed.`,
      );
      log.info("Posted completion notice on parent issue", {
        issueId,
        parentId: issue.parentId,
      });
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      log.warn("Failed to notify parent issue (non-fatal)", {
        issueId,
        error: errorMsg,
      });
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

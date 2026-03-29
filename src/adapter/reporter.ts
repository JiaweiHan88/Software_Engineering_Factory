/**
 * Paperclip Reporter — Structured Status Reporting via Issue Comments
 *
 * COMMENT-ONLY reporter. Does NOT mutate issue state (status, assignee, workPhase).
 * All state transitions are handled exclusively by lifecycle.ts.
 *
 * Aligned with real Paperclip API:
 * - Results flow back through issue comments: POST /api/issues/:id/comments
 *
 * Responsibilities:
 * - Map BMAD lifecycle events → Paperclip issue comments
 * - Scan workspace artifacts and post summaries
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
import { createHash } from "node:crypto";
import { Logger } from "../observability/logger.js";
import { linkifyTickets } from "../utils/comment-format.js";
import { getAgent } from "../agents/registry.js";
import { ROLE_MAPPING } from "../config/role-mapping.js";

const log = Logger.child("reporter");

/**
 * Resolve a human-readable display name for an agent ID.
 *
 * Lookup order:
 * 1. BMAD agent registry (src/agents/registry.ts) — has displayName like "Amelia - Dev"
 * 2. ROLE_MAPPING table (src/config/role-mapping.ts) — covers CEO and aliases
 * 3. Fallback to the raw agentId
 *
 * @param agentId - BMAD agent ID (e.g., "bmad-dev", "ceo")
 * @returns Display name suitable for comment attribution
 */
export function resolveAgentDisplayName(agentId: string): string {
  // 1. BMAD agent registry
  const bmadAgent = getAgent(agentId);
  if (bmadAgent) return bmadAgent.displayName;

  // 2. Role mapping table
  const mapping = ROLE_MAPPING[agentId] ?? ROLE_MAPPING[agentId.toLowerCase()];
  if (mapping) return mapping.displayName;

  // 3. Fallback
  return agentId;
}

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
  /** Dedup map: issueId → SHA-256 hash of last artifact listing posted. */
  private lastArtifactHash = new Map<string, string>();

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

    const displayName = resolveAgentDisplayName(agentId);
    let comment = `${statusEmoji[result.status]} **${result.status.toUpperCase()}** — **${displayName}:** ${result.message}`;

    // On completion, scan workspace for artifacts and merge into the status comment.
    // NOTE: Status transitions (done, blocked, reassignment) are handled
    // exclusively by lifecycle.ts — the reporter is comment-only.
    if (result.status === "completed" && this.workspaceDir) {
      const artifactInfo = this.scanWorkspaceArtifacts();
      if (artifactInfo && !this.isArtifactDuplicate(issueId, artifactInfo)) {
        comment += `\n\n${artifactInfo}`;
      }
    }

    await this.postIssueComment(agentId, issueId, result.status, comment);
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
    const displayName = resolveAgentDisplayName(agentId);
    let comment = `${emoji} **${status.toUpperCase()}** — **${displayName}:** ${result.success
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
          const completeName = resolveAgentDisplayName(agentId);
          await this.postIssueComment(
            agentId,
            event.storyId,
            "completed",
            `✅ **${completeName}:** Phase ${event.phase} completed by ${event.result.agentName}.`,
          );
        }
        break;

      case "story-escalated":
        if (agentId) {
          const escalateName = resolveAgentDisplayName(agentId);
          await this.postIssueComment(
            agentId,
            event.storyId,
            "needs-human",
            `⚠️ **ESCALATED** — **${escalateName}:** ${event.reason}`,
          );
        }
        break;

      case "story-failed":
        if (agentId) {
          const failName = resolveAgentDisplayName(agentId);
          await this.postIssueComment(
            agentId,
            event.storyId,
            "failed",
            `❌ **FAILED** — **${failName}:** ${event.error}`,
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
   * Check if the artifact listing is identical to the last one posted for this issue.
   * Updates the stored hash if it's new content.
   *
   * @param issueId - The issue ID
   * @param artifactInfo - The formatted artifact listing string
   * @returns true if duplicate (should skip), false if new content
   */
  private isArtifactDuplicate(issueId: string, artifactInfo: string): boolean {
    const hash = createHash("sha256").update(artifactInfo).digest("hex");
    const prev = this.lastArtifactHash.get(issueId);
    if (prev === hash) return true;
    this.lastArtifactHash.set(issueId, hash);
    return false;
  }

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
        // Format: filename | 42 KB — preview
        // No backtick wrapping — prevents Paperclip UI from rendering duplicate file badges (BUG-010).
        // Avoid parenthesized decimal sizes like "(41.2 KB)" because Paperclip's
        // file browser plugin regex matches "41.2" as a file path with extension ".2".
        ...files.map((f) => `- ${f.name} | ${Math.round(parseFloat(f.sizeKb))} KB — ${f.preview}`),
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

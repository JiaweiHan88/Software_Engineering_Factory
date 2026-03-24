/**
 * Tool context — provides Paperclip client and runtime config to tools.
 *
 * Tools are defined as singletons (Copilot SDK pattern: `defineTool()` at module level).
 * The PaperclipClient is only available at runtime (heartbeat-entrypoint sets it up).
 * This module bridges the gap with a thread-local-style context.
 *
 * Paperclip spawns one Node.js process per heartbeat — no concurrency within a process.
 * The thread-local pattern is therefore safe.
 *
 * @module tools/tool-context
 */

import type { PaperclipClient } from "../adapter/paperclip-client.js";

/**
 * Runtime context provided to tools during a heartbeat processing cycle.
 */
export interface ToolContext {
  /** Paperclip API client for issue CRUD operations */
  paperclipClient: PaperclipClient;
  /** UUID of the agent processing this heartbeat */
  agentId: string;
  /** ID of the issue currently being processed */
  issueId: string;
  /** Parent issue ID (for sub-tasks delegated by CEO) */
  parentIssueId?: string;
  /** Resolved workspace directory (PAPERCLIP_WORKSPACE_CWD) */
  workspaceDir: string;
  /** Company ID for Paperclip API scoping */
  companyId: string;
}

/** Singleton context — set once per heartbeat processing cycle. */
let currentContext: ToolContext | undefined;

/**
 * Set the tool context for the current heartbeat processing cycle.
 *
 * Called by heartbeat-entrypoint.ts before dispatching work to agents.
 * Must be called before any tool handler that depends on PaperclipClient.
 *
 * @param ctx - The tool context to set
 */
export function setToolContext(ctx: ToolContext): void {
  currentContext = ctx;
}

/**
 * Get the current tool context.
 *
 * @throws Error if no context has been set (tools called outside heartbeat cycle)
 * @returns The current ToolContext
 */
export function getToolContext(): ToolContext {
  if (!currentContext) {
    throw new Error(
      "Tool context not set — tools can only be used during a heartbeat processing cycle. " +
      "Ensure setToolContext() is called before dispatching.",
    );
  }
  return currentContext;
}

/**
 * Get the current tool context, or undefined if not set.
 *
 * Use this for optional context access (e.g., fallback to legacy behavior).
 *
 * @returns The current ToolContext, or undefined
 */
export function tryGetToolContext(): ToolContext | undefined {
  return currentContext;
}

/**
 * Clear the tool context after heartbeat processing completes.
 *
 * Called by heartbeat-entrypoint.ts in cleanup to prevent stale context
 * from leaking between issues (within the same process, if processing multiple).
 */
export function clearToolContext(): void {
  currentContext = undefined;
}

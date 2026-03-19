/**
 * Heartbeat Handler — Paperclip ↔ Copilot SDK Bridge
 *
 * Translates Paperclip issues (assigned work) into BMAD agent dispatches.
 *
 * Two entry points:
 * - `handleHeartbeat()` — direct call with a HeartbeatContext (used by sprint runner, CLI)
 * - `handlePaperclipIssue()` — accepts a PaperclipIssue from the inbox or webhook callback
 *
 * Aligned with real Paperclip API:
 * - Paperclip pushes heartbeats to agents (no polling)
 * - Work comes as PaperclipIssue (not PaperclipHeartbeat/PaperclipTicket)
 * - Results go back via issue comments (not status reports)
 *
 * @module adapter/heartbeat-handler
 */

import { getAgent } from "../agents/registry.js";
import type { AgentDispatcher, WorkPhase } from "./agent-dispatcher.js";
import type { PaperclipIssue } from "./paperclip-client.js";
import type { PaperclipReporter } from "./reporter.js";
import { Logger } from "../observability/logger.js";

const log = Logger.child("heartbeat-handler");

export interface HeartbeatContext {
  /** Paperclip agent ID */
  agentId: string;
  /** Which BMAD role this agent plays */
  bmadRole: string;
  /** Currently assigned issue */
  issue?: {
    id: string;
    title: string;
    description: string;
    storyId?: string;
    phase?: WorkPhase;
  };
  /** Additional context from Paperclip */
  metadata?: Record<string, unknown>;
}

export interface HeartbeatResult {
  status: "working" | "completed" | "stalled" | "needs-human";
  message: string;
  storyId?: string;
}

/**
 * Handle a heartbeat for a BMAD agent (direct call).
 *
 * @param ctx - Heartbeat context (from Paperclip issue or CLI dispatch)
 * @param dispatcher - The agent dispatcher to route work through
 * @returns Result to report back
 */
export async function handleHeartbeat(
  ctx: HeartbeatContext,
  dispatcher: AgentDispatcher,
): Promise<HeartbeatResult> {
  // 1. Resolve the BMAD agent
  const agent = getAgent(ctx.bmadRole);
  if (!agent) {
    return {
      status: "needs-human",
      message: `Unknown BMAD role: ${ctx.bmadRole}`,
    };
  }

  // 2. Check if there's assigned work
  if (!ctx.issue) {
    return {
      status: "working",
      message: `${agent.displayName}: No issue assigned, idle.`,
    };
  }

  // 3. Determine the BMAD workflow phase
  const phase = ctx.issue.phase ?? inferPhaseFromRole(ctx.bmadRole);

  log.info("Processing heartbeat", {
    agent: agent.displayName,
    phase,
    issueId: ctx.issue.id,
  });

  // 4. Dispatch to the agent
  const result = await dispatcher.dispatch(
    {
      id: ctx.issue.id,
      phase,
      storyId: ctx.issue.storyId,
      storyTitle: ctx.issue.title,
      storyDescription: ctx.issue.description,
    },
    (delta) => process.stdout.write(delta),
  );

  if (!result.success) {
    return {
      status: "stalled",
      message: `${agent.displayName}: Failed — ${result.error}`,
      storyId: ctx.issue.storyId,
    };
  }

  return {
    status: "completed",
    message: `${agent.displayName}: Completed ${phase} for "${ctx.issue.title}"`,
    storyId: ctx.issue.storyId,
  };
}

/**
 * Handle a Paperclip issue received via inbox-polling or webhook callback.
 *
 * Converts the PaperclipIssue into a HeartbeatContext, dispatches the work,
 * and reports the result back to Paperclip via issue comments.
 *
 * @param issue - PaperclipIssue from getAgentInbox() or webhook
 * @param agentId - The agent processing this issue
 * @param bmadRole - The BMAD role for this agent
 * @param dispatcher - The agent dispatcher to route work through
 * @param reporter - Reporter to send results back to Paperclip via issue comments
 * @returns HeartbeatResult
 */
export async function handlePaperclipIssue(
  issue: PaperclipIssue,
  agentId: string,
  bmadRole: string,
  dispatcher: AgentDispatcher,
  reporter: PaperclipReporter,
): Promise<HeartbeatResult> {
  // Convert PaperclipIssue → HeartbeatContext
  const ctx: HeartbeatContext = {
    agentId,
    bmadRole,
    metadata: issue.metadata,
    issue: {
      id: issue.id,
      title: issue.title,
      description: issue.description,
      storyId: issue.storyId,
      phase: issue.phase as WorkPhase | undefined,
    },
  };

  // Process the issue
  const result = await handleHeartbeat(ctx, dispatcher);

  // Report result back to Paperclip via issue comment
  await reporter.reportHeartbeatResult(agentId, issue.id, result);

  return result;
}

/**
 * Infer the BMAD phase from agent role when not explicitly provided.
 */
function inferPhaseFromRole(role: string): WorkPhase {
  switch (role) {
    case "bmad-pm":
    case "bmad-analyst":
      return "create-story";
    case "bmad-dev":
    case "bmad-quick-flow-solo-dev":
      return "dev-story";
    case "bmad-qa":
      return "code-review";
    case "bmad-sm":
      return "sprint-planning";
    default:
      return "sprint-status";
  }
}

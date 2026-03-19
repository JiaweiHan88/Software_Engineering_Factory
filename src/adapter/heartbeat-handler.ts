/**
 * Heartbeat Handler — Paperclip ↔ Copilot SDK Bridge
 *
 * Translates Paperclip heartbeat events into BMAD agent dispatches.
 * Each heartbeat carries context about an agent's assigned work.
 * The handler routes it to the AgentDispatcher for execution.
 *
 * Two entry points:
 * - `handleHeartbeat()` — direct call with a HeartbeatContext (used by sprint runner, CLI)
 * - `handlePaperclipHeartbeat()` — accepts a PaperclipHeartbeat from the Paperclip API client
 *
 * @module adapter/heartbeat-handler
 */

import { getAgent } from "../agents/registry.js";
import type { AgentDispatcher, WorkPhase } from "./agent-dispatcher.js";
import type { PaperclipHeartbeat } from "./paperclip-client.js";
import type { PaperclipReporter } from "./reporter.js";

export interface HeartbeatContext {
  /** Paperclip agent ID */
  agentId: string;
  /** Which BMAD role this agent plays */
  bmadRole: string;
  /** Currently assigned ticket/issue */
  ticket?: {
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
 * Handle a Paperclip heartbeat for a BMAD agent (direct call).
 *
 * @param ctx - Heartbeat context from Paperclip
 * @param dispatcher - The agent dispatcher to route work through
 * @returns Result to report back to Paperclip
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
  if (!ctx.ticket) {
    return {
      status: "working",
      message: `${agent.displayName}: No ticket assigned, idle.`,
    };
  }

  // 3. Determine the BMAD workflow phase
  const phase = ctx.ticket.phase ?? inferPhaseFromRole(ctx.bmadRole);

  console.log(
    `[heartbeat] ${agent.displayName} | ${phase} | ticket: ${ctx.ticket.id}`,
  );

  // 4. Dispatch to the agent
  const result = await dispatcher.dispatch(
    {
      id: ctx.ticket.id,
      phase,
      storyId: ctx.ticket.storyId,
      storyTitle: ctx.ticket.title,
      storyDescription: ctx.ticket.description,
    },
    (delta) => process.stdout.write(delta),
  );

  if (!result.success) {
    return {
      status: "stalled",
      message: `${agent.displayName}: Failed — ${result.error}`,
      storyId: ctx.ticket.storyId,
    };
  }

  return {
    status: "completed",
    message: `${agent.displayName}: Completed ${phase} for "${ctx.ticket.title}"`,
    storyId: ctx.ticket.storyId,
  };
}

/**
 * Handle a heartbeat received from the Paperclip API.
 *
 * Converts the PaperclipHeartbeat format to a HeartbeatContext, dispatches
 * the work, and reports the result back to Paperclip via the Reporter.
 *
 * @param heartbeat - Raw heartbeat from PaperclipClient.pollHeartbeats()
 * @param dispatcher - The agent dispatcher to route work through
 * @param reporter - Reporter to send results back to Paperclip
 * @returns HeartbeatResult
 */
export async function handlePaperclipHeartbeat(
  heartbeat: PaperclipHeartbeat,
  dispatcher: AgentDispatcher,
  reporter: PaperclipReporter,
): Promise<HeartbeatResult> {
  // Convert PaperclipHeartbeat → HeartbeatContext
  const ctx: HeartbeatContext = {
    agentId: heartbeat.agentId,
    bmadRole: heartbeat.agentRole,
    metadata: heartbeat.metadata,
  };

  if (heartbeat.ticket) {
    ctx.ticket = {
      id: heartbeat.ticket.id,
      title: heartbeat.ticket.title,
      description: heartbeat.ticket.description,
      storyId: heartbeat.ticket.storyId,
      phase: heartbeat.ticket.phase as WorkPhase | undefined,
    };
  }

  // Process the heartbeat
  const result = await handleHeartbeat(ctx, dispatcher);

  // Report result back to Paperclip
  if (heartbeat.ticket) {
    await reporter.reportHeartbeatResult(
      heartbeat.agentId,
      heartbeat.ticket.id,
      result,
    );
  }

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

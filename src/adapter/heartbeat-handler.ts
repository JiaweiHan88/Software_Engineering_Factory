/**
 * Heartbeat Handler — Paperclip ↔ Copilot SDK Bridge
 *
 * Translates Paperclip heartbeat events into BMAD agent dispatches.
 * Each heartbeat carries context about an agent's assigned work.
 * The handler routes it to the AgentDispatcher for execution.
 *
 * In Phase 4 this will be called by the Paperclip API integration.
 * For now it can be called directly by the sprint runner or CLI.
 *
 * @module adapter/heartbeat-handler
 */

import { getAgent } from "../agents/registry.js";
import type { AgentDispatcher, WorkPhase } from "./agent-dispatcher.js";

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
 * Handle a Paperclip heartbeat for a BMAD agent.
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

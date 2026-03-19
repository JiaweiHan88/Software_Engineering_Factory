/**
 * Heartbeat Handler — Paperclip ↔ Copilot SDK Bridge
 *
 * This module translates Paperclip heartbeat events into Copilot SDK sessions.
 * On each heartbeat, it:
 * 1. Checks the agent's assigned ticket from Paperclip
 * 2. Determines which BMAD workflow step to execute
 * 3. Creates or resumes a Copilot SDK session with the appropriate agent
 * 4. Sends the prompt and streams results
 * 5. Reports back to Paperclip
 *
 * TODO (Phase 4): Implement with actual Paperclip API and Copilot SDK.
 */

import { getAgent } from "../agents/registry.js";
import type { BmadAgent } from "../agents/types.js";

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
    phase?: "create-story" | "dev-story" | "code-review";
  };
  /** Session ID from previous heartbeat (for resume) */
  previousSessionId?: string;
}

export interface HeartbeatResult {
  status: "working" | "completed" | "stalled" | "needs-human";
  message: string;
  sessionId?: string;
  storyId?: string;
}

/**
 * Handle a Paperclip heartbeat for a BMAD agent.
 */
export async function handleHeartbeat(
  ctx: HeartbeatContext
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
  const phase = ctx.ticket.phase || inferPhase(agent, ctx.ticket);

  // 4. Create or resume Copilot SDK session
  // TODO (Phase 4): Replace with actual CopilotClient usage
  //
  // const client = new CopilotClient({ cliUrl: "localhost:4321" });
  // const session = ctx.previousSessionId
  //   ? await client.resumeSession(ctx.previousSessionId)
  //   : await client.createSession({
  //       customAgents: [agent],
  //       agent: agent.name,
  //       tools: getToolsForPhase(phase),
  //       mcpServers: { github: { type: "http", url: "..." } },
  //     });
  //
  // const response = await session.sendAndWait({
  //   prompt: buildPrompt(agent, ctx.ticket, phase),
  // });

  console.log(
    `[heartbeat] ${agent.displayName} | ${phase} | ticket: ${ctx.ticket.id}`
  );

  return {
    status: "working",
    message: `${agent.displayName}: Working on ${phase} for ${ctx.ticket.title}`,
    sessionId: "placeholder-session-id",
    storyId: ctx.ticket.storyId,
  };
}

/**
 * Infer the BMAD phase from agent role and ticket context.
 */
function inferPhase(
  agent: BmadAgent,
  _ticket: NonNullable<HeartbeatContext["ticket"]>
): string {
  switch (agent.name) {
    case "bmad-pm":
      return "create-story";
    case "bmad-developer":
      return "dev-story";
    case "bmad-code-reviewer":
      return "code-review";
    default:
      return "unknown";
  }
}

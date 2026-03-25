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
import type { PaperclipIssue, IssueHeartbeatContext } from "./paperclip-client.js";
import type { PaperclipReporter } from "./reporter.js";
import type { ReviewOrchestrator } from "../quality-gates/review-orchestrator.js";
import { completePhase, passReview, failReview, escalateReview } from "./lifecycle.js";
import { tryGetToolContext } from "../tools/tool-context.js";
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
    /** Issue metadata (may contain bmadPhase from CEO delegation) */
    metadata?: Record<string, unknown>;
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
  //    Priority: explicit issue.phase → metadata.bmadPhase → role-based inference
  const phase = ctx.issue.phase
    ?? resolvePhaseFromMetadata(ctx.issue.metadata)
    ?? inferPhaseFromRole(ctx.bmadRole);

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

  // 5. Lifecycle transition — let lifecycle.ts decide: reassign or done.
  const toolCtx = tryGetToolContext();
  if (toolCtx) {
    try {
      await completePhase(toolCtx.paperclipClient, ctx.issue.id, phase);
    } catch (transitionErr) {
      log.warn("Lifecycle transition failed (non-fatal)", {
        phase,
        issueId: ctx.issue.id,
        error: transitionErr instanceof Error ? transitionErr.message : String(transitionErr),
      });
    }
  }

  return {
    status: "completed",
    message: `${agent.displayName}: Completed ${phase} for "${ctx.issue.title}"`,
    storyId: ctx.issue.storyId,
  };
}

/**
 * Build an enriched issue description by appending context from heartbeat-context
 * (ancestors, goal, project, wake comment) when available.
 *
 * This allows dispatch prompts to include richer context without extra API calls.
 */
function buildEnrichedDescription(issue: PaperclipIssue, ctx?: IssueHeartbeatContext): string {
  if (!ctx) return issue.description;

  const parts: string[] = [issue.description];

  if (ctx.ancestors.length > 0) {
    const ancestorLines = ctx.ancestors
      .map((a) => `- [${a.status.toUpperCase()}] ${a.identifier ? `${a.identifier}: ` : ""}${a.title}`)
      .join("\n");
    parts.push(`\n## Context: Parent Issues\n${ancestorLines}`);
  }

  if (ctx.goal) {
    parts.push(`\n## Goal\n${ctx.goal.title} (${ctx.goal.status})`);
  }

  if (ctx.project) {
    parts.push(`\n## Project\n${ctx.project.name} (${ctx.project.status})`);
  }

  if (ctx.wakeComment) {
    parts.push(`\n## Wake Comment (triggered this run)\n${ctx.wakeComment.body}`);
  }

  return parts.join("\n");
}

/**
 * Handle a Paperclip issue received via inbox-polling or webhook callback.
 *
 * Converts the PaperclipIssue into a HeartbeatContext, dispatches the work,
 * and reports the result back to Paperclip via issue comments.
 *
 * M2: If the phase is 'code-review' and a ReviewOrchestrator is provided,
 * the full adversarial review loop is used instead of single-pass dispatch.
 *
 * @param issue - PaperclipIssue from getAgentInbox() or webhook
 * @param agentId - The agent processing this issue
 * @param bmadRole - The BMAD role for this agent
 * @param dispatcher - The agent dispatcher to route work through
 * @param reporter - Reporter to send results back to Paperclip via issue comments
 * @param reviewOrchestrator - Optional ReviewOrchestrator for full adversarial review loop
 * @param issueCtx - Optional compact heartbeat context (ancestors, project, goal, wake comment)
 * @returns HeartbeatResult
 */
export async function handlePaperclipIssue(
  issue: PaperclipIssue,
  agentId: string,
  bmadRole: string,
  dispatcher: AgentDispatcher,
  reporter: PaperclipReporter,
  reviewOrchestrator?: ReviewOrchestrator,
  issueCtx?: IssueHeartbeatContext,
): Promise<HeartbeatResult> {
  // Convert PaperclipIssue → HeartbeatContext, enriching with heartbeat-context data
  const enrichedDescription = buildEnrichedDescription(issue, issueCtx);
  const ctx: HeartbeatContext = {
    agentId,
    bmadRole,
    metadata: issue.metadata,
    issue: {
      id: issue.id,
      title: issue.title,
      description: enrichedDescription,
      storyId: issue.storyId,
      phase: issue.phase as WorkPhase | undefined,
      metadata: issue.metadata,
    },
  };

  // M2: Check if this is a code-review phase with ReviewOrchestrator available
  const resolvedPhase = (issue.phase as WorkPhase | undefined)
    ?? resolvePhaseFromMetadata(issue.metadata)
    ?? inferPhaseFromRole(bmadRole);

  if (resolvedPhase === "code-review" && reviewOrchestrator) {
    // Full adversarial review loop via ReviewOrchestrator
    const reviewResult = await handleCodeReview(
      issue, agentId, reviewOrchestrator, reporter,
    );
    return reviewResult;
  }

  // Process the issue via standard dispatch
  const result = await handleHeartbeat(ctx, dispatcher);

  // Report result back to Paperclip via issue comment
  await reporter.reportHeartbeatResult(agentId, issue.id, result);

  return result;
}

/**
 * M2: Handle a code-review phase via the full ReviewOrchestrator loop.
 *
 * Runs multi-pass adversarial review with fix cycles and quality gate evaluation.
 * On approval, updates issue status to 'done' (Paperclip auto-wakes CEO).
 * On escalation, posts findings to parent issue for CEO review.
 *
 * @param issue - The Paperclip issue being reviewed
 * @param agentId - The QA agent processing this review
 * @param orchestrator - The ReviewOrchestrator instance
 * @param reporter - Reporter for issue comments
 * @returns HeartbeatResult
 */
async function handleCodeReview(
  issue: PaperclipIssue,
  agentId: string,
  orchestrator: ReviewOrchestrator,
  reporter: PaperclipReporter,
): Promise<HeartbeatResult> {
  const meta = issue.metadata as Record<string, unknown> | undefined;
  const storyId = (meta?.storyId as string) ?? issue.storyId ?? issue.id;
  const toolCtx = tryGetToolContext();

  log.info("Running ReviewOrchestrator for code-review", {
    issueId: issue.id,
    storyId,
  });

  const result = await orchestrator.run({
    storyId,
    storyTitle: issue.title,
    onDelta: (d) => process.stdout.write(d),
  });

  if (result.approved) {
    log.info("Review approved, marking issue done", { storyId, passes: result.totalPasses });

    await reporter.reportHeartbeatResult(agentId, issue.id, {
      status: "completed",
      message: `Code review PASSED on pass ${result.totalPasses}. ${result.summary}`,
      storyId,
    });

    // Lifecycle handles: status → done + wake parent
    if (toolCtx) {
      try {
        await passReview(toolCtx.paperclipClient, issue.id, {
          reviewPasses: result.totalPasses,
          lastReviewFindings: result.summary.slice(0, 500),
        });
      } catch {
        // Non-fatal
      }
    }

    return { status: "completed", message: `Review passed (${result.totalPasses} passes)`, storyId };
  }

  if (result.escalated) {
    log.warn("Review escalated", { storyId, passes: result.totalPasses, reason: result.summary });

    if (toolCtx) {
      const parentId = (meta?.parentIssueId as string) ?? issue.parentId;
      try {
        await escalateReview(
          toolCtx.paperclipClient,
          issue.id,
          `⚠️ **ESCALATION**: Story "${issue.title}" failed ${result.totalPasses} review passes.\n` +
          `Findings: ${result.summary}\n` +
          `CEO action needed: force-approve, reassign, or investigate.`,
          parentId,
          {
            reviewPasses: result.totalPasses,
            lastReviewFindings: result.summary.slice(0, 500),
          },
        );
      } catch {
        // Non-fatal
      }
    }

    return { status: "needs-human", message: `Review escalated to CEO (${result.totalPasses} passes)`, storyId };
  }

  // Review failed but not escalated — lifecycle reassigns to Dev
  if (toolCtx) {
    try {
      await failReview(
        toolCtx.paperclipClient,
        issue.id,
        `❌ Code review FAILED (pass ${result.totalPasses}).\n` +
        `Findings:\n${result.summary}\n` +
        `Fix the HIGH/CRITICAL issues and reassign back to bmad-qa.`,
        { reviewPasses: result.totalPasses },
      );
    } catch (err) {
      log.warn("Failed to reassign after review failure", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { status: "working", message: `Review failed, reassigned to Dev (pass ${result.totalPasses})`, storyId };
}

/**
 * Resolve WorkPhase from issue metadata (set by CEO delegation).
 *
 * The CEO orchestrator sets `metadata.bmadPhase` on sub-issues when delegating.
 * This maps the CEO's pipeline phase (research/define/plan/execute/review) to
 * a specific WorkPhase. If the metadata also contains a more specific phase
 * hint, that takes priority.
 *
 * @returns WorkPhase if resolvable from metadata, undefined otherwise
 */
function resolvePhaseFromMetadata(
  metadata: Record<string, unknown> | undefined,
): WorkPhase | undefined {
  if (!metadata) return undefined;

  // Check for explicit WorkPhase set by CEO or other code
  const explicitPhase = metadata.workPhase as string | undefined;
  if (explicitPhase && isValidWorkPhase(explicitPhase)) {
    return explicitPhase as WorkPhase;
  }

  // Map CEO pipeline phase to a default WorkPhase
  const bmadPhase = metadata.bmadPhase as string | undefined;
  if (!bmadPhase) return undefined;

  const phaseMap: Record<string, WorkPhase> = {
    research: "research",
    define: "create-prd",
    plan: "sprint-planning",
    execute: "dev-story",
    review: "code-review",
  };

  return phaseMap[bmadPhase];
}

/**
 * All valid WorkPhase values.
 */
const VALID_WORK_PHASES = new Set<string>([
  "create-story", "dev-story", "code-review", "sprint-planning", "sprint-status",
  "research", "domain-research", "market-research", "technical-research",
  "create-prd", "create-architecture", "create-ux-design", "create-product-brief",
  "create-epics", "check-implementation-readiness",
  "e2e-tests", "documentation", "quick-dev",
  "editorial-review", "delegated-task",
]);

/**
 * Type guard: is this string a valid WorkPhase?
 */
function isValidWorkPhase(phase: string): phase is WorkPhase {
  return VALID_WORK_PHASES.has(phase);
}

/**
 * Infer the BMAD phase from agent role when not explicitly provided.
 *
 * Expanded to handle all BMAD roles with reasonable defaults.
 * Used as last-resort when neither issue.phase nor metadata.bmadPhase is set.
 */
function inferPhaseFromRole(role: string): WorkPhase {
  switch (role) {
    case "bmad-pm":
      return "create-story";
    case "bmad-analyst":
      return "research";
    case "bmad-dev":
      return "dev-story";
    case "bmad-qa":
      return "code-review";
    case "bmad-sm":
      return "sprint-planning";
    case "bmad-architect":
      return "create-architecture";
    case "bmad-ux-designer":
      return "create-ux-design";
    case "bmad-tech-writer":
      return "documentation";
    case "bmad-quick-flow-solo-dev":
      return "quick-dev";
    default:
      return "delegated-task";
  }
}

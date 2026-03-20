/**
 * CEO Orchestrator — Strategic Issue Delegation via Copilot SDK
 *
 * Replaces the simple heuristic `inferTargetRole()` with a full Copilot SDK
 * session where the CEO agent (with its 4-file identity) reasons about:
 *   1. What BMAD pipeline phase the issue requires
 *   2. Which sub-tasks to create
 *   3. Which agents to assign each sub-task to
 *
 * The CEO does NOT do domain work itself — it decomposes and delegates.
 *
 * Flow:
 *   Issue → CEO session → structured delegation plan (JSON) →
 *   create sub-issues in Paperclip → assign to specialist agents →
 *   report back on parent issue
 *
 * @module adapter/ceo-orchestrator
 */

import { PaperclipApiError } from "./paperclip-client.js";
import type { PaperclipClient, PaperclipAgent, PaperclipIssue } from "./paperclip-client.js";
import type { PaperclipReporter } from "./reporter.js";
import type { SessionManager } from "./session-manager.js";
import type { BmadConfig } from "../config/config.js";
import type { RoleMappingEntry } from "../config/role-mapping.js";
import type { CostTracker } from "../observability/cost-tracker.js";
import { getAgent, allAgents } from "../agents/registry.js";
import { allTools } from "../tools/index.js";
import { Logger } from "../observability/logger.js";

const log = Logger.child("ceo-orchestrator");

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A single sub-task in the CEO's delegation plan.
 */
export interface DelegationTask {
  /** Human-readable title for the sub-issue */
  title: string;
  /** Description with enough context for the assigned agent */
  description: string;
  /** BMAD role to assign (e.g., "bmad-pm", "bmad-architect") */
  assignTo: string;
  /** Priority: critical | high | medium | low */
  priority: "critical" | "high" | "medium" | "low";
  /** BMAD pipeline phase for context */
  phase: "research" | "define" | "plan" | "execute" | "review";
}

/**
 * The CEO's structured delegation plan.
 */
export interface DelegationPlan {
  /** CEO's analysis of the issue */
  analysis: string;
  /** Which BMAD pipeline phase(s) this issue needs */
  phases: string[];
  /** Ordered list of sub-tasks to create */
  tasks: DelegationTask[];
  /** Whether the CEO needs human approval before proceeding */
  requiresApproval: boolean;
  /** Reason for requiring approval (if applicable) */
  approvalReason?: string;
}

/**
 * Result of the CEO orchestration for a single issue.
 */
export interface OrchestrationResult {
  /** Whether the orchestration succeeded */
  success: boolean;
  /** Number of sub-issues created */
  subtasksCreated: number;
  /** The delegation plan produced (for logging/debugging) */
  plan?: DelegationPlan;
  /** Error message if failed */
  error?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Agent ID Resolution
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Cache of BMAD role name → Paperclip agent UUID.
 * Built lazily from the Paperclip agent list.
 */
let agentIdCache: Map<string, string> | null = null;

/**
 * Resolve a BMAD role name (e.g., "bmad-pm") to a Paperclip agent UUID.
 *
 * Uses the Paperclip `title` field which stores the BMAD role name
 * (set during Phase 1 agent creation).
 *
 * @param roleName - BMAD role name (e.g., "bmad-dev", "bmad-architect")
 * @param client - Paperclip API client
 * @returns Agent UUID, or undefined if not found
 */
export async function resolveAgentId(
  roleName: string,
  client: PaperclipClient,
): Promise<string | undefined> {
  // Build cache on first call
  if (!agentIdCache) {
    agentIdCache = new Map();
    try {
      const agents = await client.listAgents();
      for (const agent of agents) {
        // Paperclip agents have BMAD role name in the `title` field
        if (agent.title) {
          agentIdCache.set(agent.title.toLowerCase(), agent.id);
        }
        // Also map by agent name (kebab-cased display name)
        if (agent.name) {
          agentIdCache.set(agent.name.toLowerCase(), agent.id);
        }
      }
      log.info("Agent ID cache built", { entries: agentIdCache.size });
    } catch (err) {
      log.error("Failed to build agent ID cache", {}, err instanceof Error ? err : undefined);
      return undefined;
    }
  }

  return agentIdCache.get(roleName.toLowerCase());
}

/**
 * Clear the agent ID cache (e.g., when agents are added/removed).
 */
export function clearAgentIdCache(): void {
  agentIdCache = null;
}

// ─────────────────────────────────────────────────────────────────────────────
// CEO Delegation Prompt
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build the CEO delegation prompt for a given issue.
 *
 * Provides the issue context, the available agent roster, and strict JSON
 * output instructions so the CEO's response can be parsed programmatically.
 */
function buildDelegationPrompt(
  issue: PaperclipIssue,
  agentRoster: PaperclipAgent[],
): string {
  const rosterSummary = agentRoster
    .filter((a) => a.title !== "ceo") // Exclude CEO from delegation targets
    .map((a) => `  - ${a.title}: ${a.capabilities ?? a.role} (id: ${a.id})`)
    .join("\n");

  return `You are the CEO of the BMAD Copilot Factory. An issue has been assigned to you for delegation.

## Issue Details
- **ID**: ${issue.id}
- **Title**: ${issue.title}
- **Description**: ${issue.description ?? "No description provided."}
- **Status**: ${issue.status}
- **Priority**: ${issue.priority ?? "medium"}

## Available Agents
${rosterSummary}

## Your Task

Analyze this issue and create a delegation plan. Follow the BMAD pipeline:
1. **Research** — Analyst (bmad-analyst) and/or PM (bmad-pm) investigate feasibility
2. **Define** — PM creates PRD (bmad-pm), Architect creates architecture (bmad-architect), UX creates design (bmad-ux-designer)
3. **Plan** — Scrum Master creates sprint plan and stories (bmad-sm)
4. **Execute** — Developer implements (bmad-dev), QA reviews (bmad-qa), Tech Writer documents (bmad-tech-writer)

Rules:
- Do NOT skip phases. If the issue is vague, start with Research.
- If the issue is already well-defined (clear requirements, clear architecture), you may skip to Plan or Execute.
- For simple/quick tasks, consider assigning to Quick Flow (bmad-quick-flow-solo-dev) who handles spec+implement+review in one pass.
- Each sub-task must be self-contained with enough context for the assigned agent.
- Set priority based on the parent issue priority and task criticality.

## Output Format

Respond with ONLY a JSON object (no markdown fences, no explanation outside the JSON):

{
  "analysis": "Brief analysis of what this issue requires",
  "phases": ["research", "define"],
  "tasks": [
    {
      "title": "Research market requirements for X",
      "description": "Investigate ...",
      "assignTo": "bmad-analyst",
      "priority": "medium",
      "phase": "research"
    }
  ],
  "requiresApproval": false,
  "approvalReason": null
}

Set requiresApproval=true if: budget impact > $1000, irreversible infrastructure changes, or unclear scope needing human clarification.`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Plan Parsing
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse the CEO's response into a DelegationPlan.
 *
 * Handles common LLM output quirks: markdown fences, leading text, etc.
 */
export function parseDelegationPlan(response: string): DelegationPlan | null {
  // Strip markdown code fences if present
  let cleaned = response.trim();
  const fenceMatch = cleaned.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (fenceMatch) {
    cleaned = fenceMatch[1].trim();
  }

  // Try to find JSON object boundaries
  const firstBrace = cleaned.indexOf("{");
  const lastBrace = cleaned.lastIndexOf("}");
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
    log.error("No JSON object found in CEO response", {
      responsePreview: response.slice(0, 200),
    });
    return null;
  }

  const jsonStr = cleaned.slice(firstBrace, lastBrace + 1);

  try {
    const parsed = JSON.parse(jsonStr) as Record<string, unknown>;

    // Validate required fields
    if (!parsed.tasks || !Array.isArray(parsed.tasks) || parsed.tasks.length === 0) {
      log.error("CEO plan has no tasks", { parsed });
      return null;
    }

    // Validate each task has required fields
    const validPriorities = new Set(["critical", "high", "medium", "low"]);
    const validPhases = new Set(["research", "define", "plan", "execute", "review"]);

    const tasks: DelegationTask[] = [];
    for (const task of parsed.tasks as Record<string, unknown>[]) {
      if (!task.title || !task.assignTo) {
        log.warn("Skipping task with missing title or assignTo", { task });
        continue;
      }

      tasks.push({
        title: String(task.title),
        description: String(task.description ?? task.title),
        assignTo: String(task.assignTo),
        priority: validPriorities.has(String(task.priority)) ? String(task.priority) as DelegationTask["priority"] : "medium",
        phase: validPhases.has(String(task.phase)) ? String(task.phase) as DelegationTask["phase"] : "execute",
      });
    }

    if (tasks.length === 0) {
      log.error("No valid tasks after validation");
      return null;
    }

    return {
      analysis: String(parsed.analysis ?? "No analysis provided"),
      phases: Array.isArray(parsed.phases) ? (parsed.phases as string[]) : [],
      tasks,
      requiresApproval: Boolean(parsed.requiresApproval),
      approvalReason: parsed.approvalReason ? String(parsed.approvalReason) : undefined,
    };
  } catch (err) {
    log.error("Failed to parse CEO delegation plan JSON", {
      error: String(err),
      responsePreview: response.slice(0, 300),
    });
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Orchestration Entry Point
// ─────────────────────────────────────────────────────────────────────────────

/**
 * CEO Orchestrator — strategic issue delegation.
 *
 * Creates a Copilot SDK session for the CEO agent, sends the issue for
 * analysis, parses the structured delegation plan, and creates sub-issues
 * in Paperclip assigned to the appropriate specialist agents.
 *
 * @param issue - The issue from the CEO's inbox
 * @param ceoAgent - The CEO's Paperclip agent record
 * @param client - Paperclip API client (for creating sub-issues)
 * @param reporter - Reporter for issue comments
 * @param sessionManager - Copilot SDK session manager
 * @param config - Runtime configuration
 * @param mapping - CEO's role mapping entry (for skill directories)
 * @returns Orchestration result
 */
export async function orchestrateCeoIssue(
  issue: PaperclipIssue,
  ceoAgent: PaperclipAgent,
  client: PaperclipClient,
  reporter: PaperclipReporter,
  sessionManager: SessionManager,
  config: BmadConfig,
  _mapping: RoleMappingEntry,
  costTracker?: CostTracker,
): Promise<OrchestrationResult> {
  log.info("CEO orchestration starting", {
    issueId: issue.id,
    title: issue.title,
  });

  // Mark the parent issue as in_progress — CEO is actively working on delegation.
  // This prevents the CEO from re-processing the same issue on subsequent heartbeats
  // (the inbox filter skips in_progress issues for orchestrators).
  try {
    await client.updateIssue(issue.id, { status: "in_progress" });
  } catch {
    // Non-critical — issue may already be in_progress or the update may fail
    // due to activity_log FK constraints. The inbox filter will still work
    // because the issue status is checked after fetching.
    log.warn("Could not set parent issue to in_progress (non-critical)", {
      issueId: issue.id,
    });
  }

  // ── 1. Get agent roster for delegation targets ──────────────────────
  let agentRoster: PaperclipAgent[];
  try {
    agentRoster = await client.listAgents();
  } catch (err) {
    const msg = `Failed to list agents: ${err instanceof Error ? err.message : String(err)}`;
    log.error(msg);
    return { success: false, subtasksCreated: 0, error: msg };
  }

  // ── 2. Create CEO session with 4-file identity ─────────────────────
  // CEO may not be in the BMAD agent registry (it has bmadAgentName: null)
  // since it orchestrates rather than doing domain work. Create a minimal
  // agent definition for the Copilot SDK session.
  const ceoAgentDef = getAgent("ceo") ?? getAgent("bmad-ceo") ?? {
    name: "ceo",
    displayName: "CEO - Chief Executive",
    description: "Strategic orchestrator — decomposes issues into phased delegation plans",
    prompt: "You are the CEO of the BMAD Copilot Factory. You delegate, you do not do domain work.",
  };

  let sessionId: string;
  try {
    sessionId = await sessionManager.createAgentSession({
      agent: ceoAgentDef,
      allAgents,
      tools: allTools,
      model: config.model,
      systemMessage: config.agentSystemMessage,
    });
  } catch (err) {
    const msg = `Failed to create CEO session: ${err instanceof Error ? err.message : String(err)}`;
    log.error(msg);
    return { success: false, subtasksCreated: 0, error: msg };
  }

  // ── 3. Send delegation prompt and get structured plan ──────────────
  const prompt = buildDelegationPrompt(issue, agentRoster);
  let response: string;

  try {
    response = await sessionManager.sendAndWait(
      sessionId,
      prompt,
      120_000, // 2 min timeout for CEO reasoning
    );
  } catch (err) {
    const msg = `CEO session failed: ${err instanceof Error ? err.message : String(err)}`;
    log.error(msg);
    await sessionManager.closeSession(sessionId);
    return { success: false, subtasksCreated: 0, error: msg };
  }

  // Close session — CEO doesn't need multi-turn for delegation
  await sessionManager.closeSession(sessionId);

  // Record token usage for cost tracking (CEO bypasses AgentDispatcher)
  if (costTracker) {
    costTracker.recordUsage(
      "ceo",
      config.model ?? "default",
      prompt,
      response,
      { sessionId, phase: "ceo-delegation" },
    );
  }

  // ── 4. Parse the delegation plan ──────────────────────────────────
  const plan = parseDelegationPlan(response);

  if (!plan) {
    // Fallback: report the raw response for human review
    await client.addIssueComment(
      issue.id,
      `⚠️ **CEO** — Could not parse delegation plan. Raw analysis:\n\n${response.slice(0, 2000)}`,
    );
    return { success: false, subtasksCreated: 0, error: "Failed to parse delegation plan" };
  }

  log.info("CEO delegation plan parsed", {
    issueId: issue.id,
    phases: plan.phases,
    taskCount: plan.tasks.length,
    requiresApproval: plan.requiresApproval,
  });

  // ── 5. Check if approval is required ──────────────────────────────
  if (plan.requiresApproval) {
    await client.addIssueComment(
      issue.id,
      [
        `🛑 **CEO — Approval Required**`,
        ``,
        `**Analysis:** ${plan.analysis}`,
        `**Reason:** ${plan.approvalReason ?? "High-impact decision requires human review"}`,
        ``,
        `**Proposed plan (${plan.tasks.length} tasks):**`,
        ...plan.tasks.map((t, i) => `${i + 1}. **[${t.phase}]** ${t.title} → ${t.assignTo} (${t.priority})`),
        ``,
        `Please approve or modify this plan, then reassign to CEO.`,
      ].join("\n"),
    );

    return {
      success: true,
      subtasksCreated: 0,
      plan,
    };
  }

  // ── 6. Create sub-issues for each task in the plan ─────────────────
  let subtasksCreated = 0;
  const createdIssueIds: string[] = [];

  for (const task of plan.tasks) {
    // Resolve the agent UUID for the assignee
    const assigneeId = await resolveAgentId(task.assignTo, client);

    if (!assigneeId) {
      log.warn("Could not resolve agent ID for role, creating unassigned", {
        role: task.assignTo,
      });
    }

    try {
      const subIssue = await client.createIssue({
        title: task.title,
        description: [
          task.description,
          ``,
          `---`,
          `*Parent issue: ${issue.title} (${issue.id})*`,
          `*Phase: ${task.phase}*`,
          `*Delegated by CEO*`,
        ].join("\n"),
        status: "todo",
        priority: task.priority,
        // NOTE: parentId is omitted during creation because the parent issue
        // has an execution lock (CEO heartbeat is running). Setting parentId
        // on a locked issue causes Paperclip to 500. We link via PATCH after.
        assigneeAgentId: assigneeId,
        goalId: issue.goalId,
        // Propagate projectId so sub-issues live in the same project workspace
        projectId: issue.projectId,
        metadata: {
          bmadPhase: task.phase,
          parentIssueId: issue.id,
          delegatedBy: "ceo",
        },
      });

      // Link to parent issue via PATCH (after creation succeeds)
      try {
        await client.updateIssue(subIssue.id, { parentId: issue.id });
      } catch {
        // Non-critical — the metadata already records the relationship
        log.warn("Could not link sub-issue to parent (non-critical)", {
          subIssueId: subIssue.id,
          parentId: issue.id,
        });
      }

      createdIssueIds.push(subIssue.id);
      subtasksCreated++;

      log.info("Sub-issue created", {
        subIssueId: subIssue.id,
        title: task.title,
        assignTo: task.assignTo,
        assigneeId: assigneeId ?? "unassigned",
      });
    } catch (err: unknown) {
      // Paperclip may return 500 after the write succeeds (phantom 500).
      // Check if the issue was actually created before treating as failure.
      const isPaperclip500 = err instanceof PaperclipApiError && err.statusCode === 500;

      if (isPaperclip500) {
        try {
          // Sub-issues are intentionally created WITHOUT parentId (to avoid the
          // Paperclip execution-lock 500). The parentId is linked via updateIssue
          // after creation. If the phantom 500 fired during createIssue, the
          // issue exists but has no parentId — querying by parentId won't find it.
          // Instead, match on metadata.parentIssueId which IS set at creation time.
          const candidates = await client.listIssues(
            assigneeId ? { assigneeAgentId: assigneeId } : undefined,
          );
          const phantom = candidates.find(
            (c) =>
              c.title === task.title &&
              c.status !== "cancelled" &&
              (c.metadata as Record<string, unknown> | undefined)?.parentIssueId === issue.id,
          );
          if (phantom) {
            log.warn("Phantom 500 — sub-issue was actually created", {
              subIssueId: phantom.id,
              title: task.title,
            });
            // Link to parent now (deferred from the failed createIssue flow)
            try {
              await client.updateIssue(phantom.id, { parentId: issue.id });
            } catch {
              // Non-critical — metadata already records the relationship
            }
            createdIssueIds.push(phantom.id);
            subtasksCreated++;
            continue; // Don't report as error
          }
        } catch {
          // If we can't check, fall through to error reporting
        }
      }

      log.error("Failed to create sub-issue", {
        title: task.title,
        assignTo: task.assignTo,
        error: String(err),
      });

      // Report the failure but continue with remaining tasks
      try {
        await client.addIssueComment(
          issue.id,
          `⚠️ **CEO** — Failed to create sub-task "${task.title}": ${err instanceof Error ? err.message : String(err)}`,
        );
      } catch {
        // Comment may also 500 — don't cascade errors
      }
    }
  }

  // ── 7. Report delegation summary on parent issue ──────────────────
  const summaryLines = [
    `🎯 **CEO — Delegation Complete**`,
    ``,
    `**Analysis:** ${plan.analysis}`,
    `**Phases:** ${plan.phases.join(" → ")}`,
    `**Sub-tasks created:** ${subtasksCreated}/${plan.tasks.length}`,
    ``,
  ];

  for (let i = 0; i < plan.tasks.length; i++) {
    const task = plan.tasks[i];
    const issueId = createdIssueIds[i];
    const status = issueId ? `✅ created (${issueId})` : "❌ failed";
    summaryLines.push(`${i + 1}. **[${task.phase}]** ${task.title} → ${task.assignTo} — ${status}`);
  }

  await client.addIssueComment(issue.id, summaryLines.join("\n"));

  // The parent issue stays in_progress — it was set to in_progress at the
  // start of orchestration. The CEO's inbox filter skips in_progress issues,
  // so it won't re-process on the next heartbeat. The issue should only be
  // marked done when all sub-tasks are complete (future: rollup logic).

  log.info("CEO orchestration complete", {
    issueId: issue.id,
    subtasksCreated,
    totalTasks: plan.tasks.length,
  });

  return {
    success: subtasksCreated > 0,
    subtasksCreated,
    plan,
  };
}

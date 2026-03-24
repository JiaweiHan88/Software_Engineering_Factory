/**
 * CEO Orchestrator — Strategic Issue Delegation via Copilot SDK
 *
 * The CEO is the intelligent orchestrator of the BMAD pipeline. It has two modes:
 *
 * 1. **Initial Delegation** — Decomposes a new parent issue into sub-tasks with
 *    dependency-aware scheduling. Tasks without prerequisites are created as `todo`
 *    (triggering immediate agent wakeup). Tasks with prerequisites are created as
 *    `backlog` (no wakeup). The CEO embeds prerequisite information in each task's
 *    description and metadata so it can reason about readiness later.
 *
 * 2. **Re-evaluation** — When the CEO is re-woken (e.g., after a specialist completes
 *    a sub-issue), it reviews all its sub-issues, checks which `backlog` tasks now
 *    have their prerequisites met, and promotes them to `todo` (triggering wakeup).
 *    It can also detect stalls, reassign, or escalate.
 *
 * The CEO decides the dependency graph — there is no hardcoded phase pipeline. The
 * CEO might create all issues at once with dependencies, or create them incrementally
 * across re-evaluation heartbeats. It is an AI decision, not a coded constraint.
 *
 * Flow:
 *   Initial:  Issue → CEO session → delegation plan (with deps) → create sub-issues → report
 *   Re-eval:  CEO woken → check sub-issue statuses → promote ready backlog → report
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
import { resolveModel, loadModelStrategyConfig } from "../config/model-strategy.js";
import { getAgent, allAgents } from "../agents/registry.js";
import { allTools } from "../tools/index.js";
import { Logger } from "../observability/logger.js";
import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";

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
  /**
   * Task IDs (by index in the tasks array, 0-based) that must complete
   * before this task can start. Empty array means no prerequisites — the
   * task is immediately actionable.
   *
   * Example: [0, 1] means tasks[0] and tasks[1] must be done first.
   */
  dependsOn: number[];
}

/**
 * The CEO's structured delegation plan.
 */
export interface DelegationPlan {
  /** CEO's analysis of the issue */
  analysis: string;
  /** Which BMAD pipeline phase(s) this issue needs */
  phases: string[];
  /** Ordered list of sub-tasks to create (index is the task ID for dependsOn) */
  tasks: DelegationTask[];
  /** Whether the CEO needs human approval before proceeding */
  requiresApproval: boolean;
  /** Reason for requiring approval (if applicable) */
  approvalReason?: string;
}

/**
 * Result of the CEO re-evaluation of existing sub-issues.
 */
export interface ReEvaluationResult {
  /** Whether the re-evaluation succeeded */
  success: boolean;
  /** Number of backlog issues promoted to todo */
  promoted: number;
  /** Whether all sub-issues are done (parent can close) */
  allDone: boolean;
  /** Error message if failed */
  error?: string;
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
        // Map by agent name (primary key — e.g., "bmad-quick-flow")
        if (agent.name) {
          agentIdCache.set(agent.name.toLowerCase(), agent.id);
        }
        // Map by human title (e.g., "Barry", "Quinn")
        if (agent.title) {
          agentIdCache.set(agent.title.toLowerCase(), agent.id);
        }
        // Map by metadata.bmadRole (e.g., from setup script)
        const bmadRole = (agent.metadata as Record<string, unknown> | undefined)?.bmadRole;
        if (typeof bmadRole === "string") {
          agentIdCache.set(bmadRole.toLowerCase(), agent.id);
        }
      }

      // Add known aliases — the LLM may generate role names from
      // the BMAD config (bmad-quick-flow-solo-dev) rather than the
      // Paperclip agent name (bmad-quick-flow). Map both to resolve.
      const ALIASES: Record<string, string> = {
        "bmad-quick-flow-solo-dev": "bmad-quick-flow",
      };
      for (const [alias, canonical] of Object.entries(ALIASES)) {
        const target = agentIdCache.get(canonical.toLowerCase());
        if (target && !agentIdCache.has(alias.toLowerCase())) {
          agentIdCache.set(alias.toLowerCase(), target);
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

/**
 * Extract the story sequence number from issue metadata.
 *
 * Used for sequential story promotion (M1) — stories within an epic
 * are promoted one at a time in sequence order.
 *
 * @param issue - Paperclip issue with metadata
 * @returns Sequence number (defaults to 0 if not set)
 */
function getSequence(issue: PaperclipIssue): number {
  const meta = issue.metadata as Record<string, unknown> | undefined;
  const seq = meta?.storySequence;
  return typeof seq === "number" ? seq : 0;
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
    .filter((a) => a.name !== "bmad-ceo") // Exclude CEO from delegation targets
    .map((a) => `  - ${a.name} (${a.title}): ${a.capabilities ?? a.role}`)
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

Analyze this issue and create a delegation plan with dependency-aware scheduling.

### Agent Capabilities
- **Research** — Analyst (bmad-analyst) and/or PM (bmad-pm) investigate feasibility
- **Define** — PM creates PRD (bmad-pm), Architect creates architecture (bmad-architect), UX creates design (bmad-ux-designer)
- **Plan** — Scrum Master creates sprint plan and stories (bmad-sm)
- **Execute** — Developer implements (bmad-dev), QA reviews (bmad-qa), Tech Writer documents (bmad-tech-writer)
- **Quick** — Quick Flow (bmad-quick-flow) handles simple spec+implement+review in one pass

### Dependency Rules
- Use the \`dependsOn\` field to declare which tasks must complete before another can start.
- \`dependsOn\` uses 0-based task indices from the \`tasks\` array.
- Tasks with \`dependsOn: []\` (empty) are immediately actionable — they will start right away.
- Tasks with dependencies will be held in backlog until their prerequisites are done.
- YOU decide the dependency graph based on what makes sense for this issue. There is no fixed pipeline.
- Multiple tasks can run in parallel if they don't depend on each other.

### Examples of reasonable dependencies
- PRD may depend on research findings (so the PM has data to reference)
- Architecture may depend on PRD (so the architect knows the requirements)
- Epic breakdown may depend on both PRD and architecture
- Implementation depends on the plan
- But research tasks can often run in parallel

### Critical Rules
- Each sub-task description MUST be self-contained with enough context for the agent.
- In each task description, explicitly state what prerequisite outputs the agent should read from the workspace (if any).
- Do NOT skip necessary phases. If the issue is vague, start with Research.
- If the issue is already well-defined, you may skip straight to Plan or Execute.
- For simple/quick tasks, use Quick Flow (bmad-quick-flow).
- Set priority based on the parent issue priority and task criticality.

## Output Format

Respond with ONLY a JSON object (no markdown fences, no explanation outside the JSON):

{
  "analysis": "Brief analysis of what this issue requires",
  "phases": ["research", "define", "plan"],
  "tasks": [
    {
      "title": "Research technical feasibility for X",
      "description": "Investigate ... Save findings as research-findings.md",
      "assignTo": "bmad-analyst",
      "priority": "medium",
      "phase": "research",
      "dependsOn": []
    },
    {
      "title": "Create PRD for X",
      "description": "Based on the research findings (read research-findings.md from the workspace), create a comprehensive PRD ...",
      "assignTo": "bmad-pm",
      "priority": "medium",
      "phase": "define",
      "dependsOn": [0]
    },
    {
      "title": "Design system architecture",
      "description": "Read the PRD (prd.md) and research findings. Design the architecture ...",
      "assignTo": "bmad-architect",
      "priority": "medium",
      "phase": "define",
      "dependsOn": [0, 1]
    }
  ],
  "requiresApproval": false,
  "approvalReason": null
}

Set requiresApproval=true if: budget impact > $1000, irreversible infrastructure changes, or unclear scope needing human clarification.

## Decision Authority
You are authorized to make ALL decisions autonomously EXCEPT:
- Changing product direction (requires board)
- Budget above 80% spent (switch to critical-only; if no critical work, escalate)
- Irreversible infrastructure decisions (requires board)
- Scope increase > 50% (requires board)

For everything else: DECIDE and PROCEED. Post your reasoning as a comment.
Do NOT set requiresApproval to true unless one of the above conditions applies.

## Learnings
If the system message contains "Learnings from Previous Epics", review them and apply relevant lessons to this delegation plan.
For example: if past retros show schema changes need Architect review, include an Architect review step for stories that touch the schema.
Cite which learning informed each decision when applicable.`;
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
        dependsOn: Array.isArray(task.dependsOn)
          ? (task.dependsOn as unknown[]).filter((v): v is number => typeof v === "number")
          : [],
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

  // NOTE: The parent issue is already in_progress from checkout (heartbeat-entrypoint
  // calls checkoutIssue() before orchestrateCeoIssue). Per Paperclip SKILL.md:
  // "Always checkout before working. Never PATCH to in_progress manually."
  // The delegation dedup guard in the entrypoint (checking for existing children)
  // prevents re-processing on subsequent heartbeats.

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

  // Resolve model via strategy (CEO = powerful tier for strategic reasoning)
  const modelStrategy = loadModelStrategyConfig();
  const modelSelection = resolveModel("ceo-delegation", {}, modelStrategy);
  const ceoModel = modelSelection.model;
  log.info("CEO delegation model resolved", {
    model: ceoModel,
    tier: modelSelection.tier,
    reason: modelSelection.reason,
  });

  let sessionId: string;
  try {
    sessionId = await sessionManager.createAgentSession({
      agent: ceoAgentDef,
      allAgents,
      tools: allTools,
      model: ceoModel,
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
      300_000, // 5 min timeout for CEO reasoning
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
      ceoModel,
      prompt,
      response,
      { sessionId, phase: "ceo-delegation", issueId: issue.id },
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

  // ── 6. Create sub-issues with dependency-aware scheduling ───────────
  // Tasks with dependsOn: [] get status "todo" → triggers immediate agent wakeup.
  // Tasks with dependsOn: [n, ...] get status "backlog" → held until CEO promotes.
  let subtasksCreated = 0;
  const createdIssues: Array<{ id: string; identifier?: string }> = [];

  for (let taskIdx = 0; taskIdx < plan.tasks.length; taskIdx++) {
    const task = plan.tasks[taskIdx];
    const isReady = task.dependsOn.length === 0;

    // Resolve the agent UUID for the assignee
    const assigneeId = await resolveAgentId(task.assignTo, client);

    if (!assigneeId) {
      log.warn("Could not resolve agent ID for role, creating unassigned", {
        role: task.assignTo,
      });
    }

    // Build prerequisite summary for the description
    const prereqLines: string[] = [];
    if (task.dependsOn.length > 0) {
      prereqLines.push(``, `## Prerequisites`);
      prereqLines.push(`This task is blocked until the following are completed:`);
      for (const depIdx of task.dependsOn) {
        const dep = plan.tasks[depIdx];
        if (dep) {
          prereqLines.push(`- **[${dep.phase}]** ${dep.title} (${dep.assignTo})`);
        }
      }
      prereqLines.push(``, `*The CEO will move this task to "todo" once prerequisites are met.*`);
    }

    try {
      const subIssue = await client.createIssue({
        title: task.title,
        description: [
          task.description,
          ...prereqLines,
          ``,
          `---`,
          `*Parent issue: ${issue.title} (${issue.id})*`,
          `*Phase: ${task.phase} | Task index: ${taskIdx}*`,
          `*Delegated by CEO*`,
        ].join("\n"),
        // KEY: backlog does NOT trigger agent wakeup. todo DOES.
        status: isReady ? "todo" : "backlog",
        priority: task.priority,
        assigneeAgentId: assigneeId,
        goalId: issue.goalId,
        projectId: issue.projectId,
        metadata: {
          bmadPhase: task.phase,
          parentIssueId: issue.id,
          delegatedBy: "ceo",
          taskIndex: taskIdx,
          dependsOn: task.dependsOn,
        },
      });

      // Link to parent issue via PATCH (after creation succeeds)
      try {
        await client.updateIssue(subIssue.id, { parentId: issue.id });
      } catch {
        log.warn("Could not link sub-issue to parent (non-critical)", {
          subIssueId: subIssue.id,
          parentId: issue.id,
        });
      }

      createdIssues.push({ id: subIssue.id, identifier: subIssue.identifier });
      subtasksCreated++;

      log.info("Sub-issue created", {
        subIssueId: subIssue.id,
        identifier: subIssue.identifier ?? "unknown",
        title: task.title,
        assignTo: task.assignTo,
        assigneeId: assigneeId ?? "unassigned",
        status: isReady ? "todo" : "backlog",
        dependsOn: task.dependsOn,
      });
    } catch (err: unknown) {
      // Paperclip may return 500 after the write succeeds (phantom 500).
      const isPaperclip500 = err instanceof PaperclipApiError && err.statusCode === 500;

      if (isPaperclip500) {
        try {
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
            try {
              await client.updateIssue(phantom.id, { parentId: issue.id });
            } catch {
              // Non-critical
            }
            createdIssues.push({ id: phantom.id, identifier: phantom.identifier });
            subtasksCreated++;
            continue;
          }
        } catch {
          // Fall through to error reporting
        }
      }

      log.error("Failed to create sub-issue", {
        title: task.title,
        assignTo: task.assignTo,
        error: String(err),
      });

      try {
        await client.addIssueComment(
          issue.id,
          `⚠️ **CEO** — Failed to create sub-task "${task.title}": ${err instanceof Error ? err.message : String(err)}`,
        );
      } catch {
        // Don't cascade errors
      }
      // Push empty entry so task indices stay aligned with createdIssues
      createdIssues.push({ id: "" });
    }
  }

  // ── 7. Report delegation summary on parent issue ──────────────────
  const readyCount = plan.tasks.filter((t) => t.dependsOn.length === 0).length;
  const blockedCount = plan.tasks.length - readyCount;

  const summaryLines = [
    `🎯 **CEO — Delegation Complete**`,
    ``,
    `**Analysis:** ${plan.analysis}`,
    `**Phases:** ${plan.phases.join(" → ")}`,
    `**Sub-tasks created:** ${subtasksCreated}/${plan.tasks.length} (${readyCount} ready, ${blockedCount} waiting on prerequisites)`,
    ``,
  ];

  for (let i = 0; i < plan.tasks.length; i++) {
    const task = plan.tasks[i];
    const created = createdIssues[i];
    const label = created?.identifier ?? created?.id?.slice(0, 8) ?? `task-${i}`;
    const depsInfo = task.dependsOn.length > 0
      ? ` ⏳ depends on: ${task.dependsOn.map((d) => {
          const dep = createdIssues[d];
          return dep?.identifier ?? `task-${d}`;
        }).join(", ")}`
      : " ▶️ ready";
    const status = created?.id ? `✅ ${label}` : "❌ failed";
    summaryLines.push(`${i + 1}. **[${task.phase}]** ${task.title} → ${task.assignTo} — ${status}${depsInfo}`);
  }

  summaryLines.push(
    ``,
    `*I will re-evaluate when specialists complete their tasks and promote blocked issues as prerequisites are met.*`,
  );

  await client.addIssueComment(issue.id, summaryLines.join("\n"));

  log.info("CEO orchestration complete", {
    issueId: issue.id,
    subtasksCreated,
    totalTasks: plan.tasks.length,
    readyCount,
    blockedCount,
  });

  return {
    success: subtasksCreated > 0,
    subtasksCreated,
    plan,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// CEO Re-evaluation — Promote Backlog Issues When Prerequisites Are Met
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build a re-evaluation prompt for the CEO.
 *
 * Gives the CEO the full picture of all sub-issues and their statuses so it
 * can decide which backlog tasks to promote, whether to reassign stuck tasks,
 * or whether the parent issue can be closed.
 */
function buildReEvaluationPrompt(
  parentIssue: PaperclipIssue,
  children: PaperclipIssue[],
): string {
  const childSummary = children
    .map((c) => {
      const meta = c.metadata as Record<string, unknown> | undefined;
      const taskIndex = meta?.taskIndex ?? "?";
      const phase = meta?.bmadPhase ?? "?";
      const deps = Array.isArray(meta?.dependsOn) ? (meta.dependsOn as number[]).join(", ") : "none";
      return `  - [${taskIndex}] "${c.title}" — status: ${c.status}, phase: ${phase}, dependsOn: [${deps}], assignee: ${c.assigneeAgentId ?? "unassigned"}`;
    })
    .join("\n");

  return `You are the CEO re-evaluating your delegation plan. A specialist has completed work and you need to check if any blocked tasks can now proceed.

## Parent Issue
- **Title**: ${parentIssue.title}
- **ID**: ${parentIssue.id}

## Current Sub-Issue Statuses
${childSummary}

## Your Task

Review the sub-issues and decide what actions to take. For each decision, provide your reasoning.

### Rules
- A backlog task can be promoted to "todo" if ALL of its \`dependsOn\` tasks have status "done".
- If all sub-issues are "done" or "cancelled", the parent issue should be marked "done".
- If a task is stuck ("blocked" or stalled), you may reassign or add a comment to unblock.
- If something unexpected happened, you may create additional sub-issues.
- Do NOT promote a task if its prerequisites are not yet "done".

## Output Format

Respond with ONLY a JSON object:

{
  "actions": [
    { "type": "promote", "issueId": "<id>", "reason": "All prerequisites done" },
    { "type": "comment", "issueId": "<id>", "body": "Checking on progress..." },
    { "type": "close_parent", "reason": "All sub-tasks are complete" }
  ],
  "summary": "Brief status update"
}

If no actions are needed, return \`{ "actions": [], "summary": "No changes needed" }\`.`;
}

/**
 * Parse a re-evaluation action from the CEO's response.
 */
interface ReEvalAction {
  type: "promote" | "comment" | "close_parent" | "reassign";
  issueId?: string;
  reason?: string;
  body?: string;
  newAssignee?: string;
}

/**
 * Parse the CEO's re-evaluation response.
 */
function parseReEvaluationResponse(response: string): { actions: ReEvalAction[]; summary: string } | null {
  let cleaned = response.trim();
  const fenceMatch = cleaned.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (fenceMatch) {
    cleaned = fenceMatch[1].trim();
  }

  const firstBrace = cleaned.indexOf("{");
  const lastBrace = cleaned.lastIndexOf("}");
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
    return null;
  }

  try {
    const parsed = JSON.parse(cleaned.slice(firstBrace, lastBrace + 1)) as Record<string, unknown>;
    const actions: ReEvalAction[] = [];

    if (Array.isArray(parsed.actions)) {
      for (const a of parsed.actions as Record<string, unknown>[]) {
        const type = String(a.type ?? "");
        if (["promote", "comment", "close_parent", "reassign"].includes(type)) {
          actions.push({
            type: type as ReEvalAction["type"],
            issueId: a.issueId ? String(a.issueId) : undefined,
            reason: a.reason ? String(a.reason) : undefined,
            body: a.body ? String(a.body) : undefined,
            newAssignee: a.newAssignee ? String(a.newAssignee) : undefined,
          });
        }
      }
    }

    return {
      actions,
      summary: String(parsed.summary ?? "No summary"),
    };
  } catch {
    return null;
  }
}

/**
 * CEO re-evaluation — check sub-issue statuses and promote ready tasks.
 *
 * Called when the CEO is re-woken after a specialist completes a sub-issue.
 * The CEO reviews all children, determines which backlog tasks now have their
 * prerequisites met, and promotes them to "todo" (which triggers agent wakeup).
 *
 * @param parentIssue - The parent issue the CEO is managing
 * @param client - Paperclip API client
 * @param sessionManager - For creating a CEO reasoning session
 * @param config - Runtime config
 * @param costTracker - Optional cost tracker
 * @returns Re-evaluation result
 */
export async function reEvaluateDelegation(
  parentIssue: PaperclipIssue,
  client: PaperclipClient,
  sessionManager: SessionManager,
  config: BmadConfig,
  costTracker?: CostTracker,
): Promise<ReEvaluationResult> {
  log.info("CEO re-evaluation starting", { issueId: parentIssue.id });

  // ── 1. Fetch all children ─────────────────────────────────────────
  const children = await client.listIssues({ parentId: parentIssue.id });
  const activeChildren = children.filter((c) => c.status !== "cancelled");

  if (activeChildren.length === 0) {
    log.info("No active children — nothing to re-evaluate");
    return { success: true, promoted: 0, allDone: true };
  }

  // ── 2. Quick check: are all children done? ────────────────────────
  const allDone = activeChildren.every((c) => c.status === "done");
  if (allDone) {
    log.info("All children done — closing parent issue");
    await client.updateIssue(parentIssue.id, { status: "done" });
    await client.addIssueComment(
      parentIssue.id,
      `✅ **CEO — All sub-tasks complete.** Closing parent issue.`,
    );
    return { success: true, promoted: 0, allDone: true };
  }

  // ── 3. Quick path: check for promotable tasks without LLM ────────
  // Build a taskIndex→status lookup from the children
  const taskStatusByIndex = new Map<number, string>();
  const backlogChildren: PaperclipIssue[] = [];

  for (const child of activeChildren) {
    const meta = child.metadata as Record<string, unknown> | undefined;
    const taskIndex = meta?.taskIndex;
    if (typeof taskIndex === "number") {
      taskStatusByIndex.set(taskIndex, child.status);
    }
    if (child.status === "backlog") {
      backlogChildren.push(child);
    }
  }

  // M1: Separate story issues from non-story issues
  const storyIssues = activeChildren.filter(c =>
    (c.metadata as Record<string, unknown> | undefined)?.bmadPhase === "execute",
  );
  const nonStoryIssues = activeChildren.filter(c =>
    (c.metadata as Record<string, unknown> | undefined)?.bmadPhase !== "execute",
  );

  // Non-story issues: existing behavior (dependency-based promotion)
  let promoted = 0;
  for (const child of nonStoryIssues) {
    if (child.status !== "backlog") continue;
    const meta = child.metadata as Record<string, unknown> | undefined;
    const dependsOn = Array.isArray(meta?.dependsOn) ? (meta.dependsOn as number[]) : [];

    if (dependsOn.length === 0) {
      await client.updateIssue(child.id, { status: "todo" });
      promoted++;
      log.info("Promoted non-story task (no deps)", { issueId: child.id, title: child.title });
      continue;
    }

    const allDepsDone = dependsOn.every((depIdx) => {
      const depStatus = taskStatusByIndex.get(depIdx);
      return depStatus === "done";
    });

    if (allDepsDone) {
      await client.updateIssue(child.id, { status: "todo" });
      promoted++;
      log.info("Promoted non-story task (deps met)", {
        issueId: child.id,
        title: child.title,
        dependsOn,
      });
    }
  }

  // M1: Story issues — sequential promotion (one at a time)
  if (storyIssues.length > 0) {
    const sortedStories = [...storyIssues].sort((a, b) => {
      const seqA = getSequence(a);
      const seqB = getSequence(b);
      return seqA - seqB;
    });

    const firstNonDone = sortedStories.find(s => s.status !== "done");
    if (firstNonDone && firstNonDone.status === "backlog") {
      // Check if dependencies are met
      const meta = firstNonDone.metadata as Record<string, unknown> | undefined;
      const dependsOn = Array.isArray(meta?.dependsOn) ? (meta.dependsOn as number[]) : [];
      const depsOk = dependsOn.length === 0 || dependsOn.every((depIdx) => {
        const depStatus = taskStatusByIndex.get(depIdx);
        return depStatus === "done";
      });

      if (depsOk) {
        // Promote to todo and assign to SM for detailed story creation
        const smAgentId = await resolveAgentId("bmad-sm", client);
        await client.updateIssue(firstNonDone.id, {
          status: "todo",
          ...(smAgentId ? { assigneeAgentId: smAgentId } : {}),
          metadata: {
            ...(firstNonDone.metadata as Record<string, unknown> | undefined),
            workPhase: "create-story",
          },
        });
        promoted++;
        log.info("Sequential story promotion", {
          issueId: firstNonDone.id,
          title: firstNonDone.title,
          sequence: getSequence(firstNonDone),
        });
      }
    }
  }

  // M3: Check for epic completion — trigger retrospective
  if (storyIssues.length > 0) {
    const epicIds = [...new Set(
      storyIssues
        .map(s => (s.metadata as Record<string, unknown> | undefined)?.epicId)
        .filter((id): id is string => typeof id === "string"),
    )];

    for (const epicId of epicIds) {
      const epicStories = storyIssues.filter(s =>
        (s.metadata as Record<string, unknown> | undefined)?.epicId === epicId,
      );
      const allEpicDone = epicStories.every(s => s.status === "done");
      const retroExists = nonStoryIssues.some(c =>
        (c.metadata as Record<string, unknown> | undefined)?.isRetrospective === true &&
        (c.metadata as Record<string, unknown> | undefined)?.epicId === epicId,
      );

      if (allEpicDone && !retroExists) {
        // Create retro sub-issue assigned to SM
        const smId = await resolveAgentId("bmad-sm", client);
        try {
          await client.createIssue({
            title: `Epic ${epicId} Retrospective`,
            description:
              `All stories for epic ${epicId} are complete. ` +
              `Run the bmad-retrospective skill. ` +
              `Analyze: what worked, what didn't, review patterns, E2E coverage. ` +
              `Save the retrospective report as \`_bmad-output/epic-${epicId}-retrospective.md\`.`,
            status: "todo",
            assigneeAgentId: smId,
            parentId: parentIssue.id,
            metadata: {
              bmadPhase: "review",
              workPhase: "retrospective",
              isRetrospective: true,
              epicId,
            },
          });
          log.info("Epic retro issue created", { epicId, parentId: parentIssue.id });
        } catch (err) {
          log.warn("Failed to create retro issue", {
            epicId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
  }

  // M3-4: Extract learnings from completed retrospectives
  const completedRetros = activeChildren.filter(c =>
    c.status === "done" &&
    (c.metadata as Record<string, unknown> | undefined)?.isRetrospective === true &&
    !(c.metadata as Record<string, unknown> | undefined)?.learningsExtracted,
  );

  for (const retro of completedRetros) {
    const retroMeta = retro.metadata as Record<string, unknown> | undefined;
    const epicId = retroMeta?.epicId;
    if (typeof epicId !== "string") continue;

    const workspaceCwd = config.targetProjectRoot ?? process.cwd();
    const retroFilePath = resolve(workspaceCwd, `_bmad-output/epic-${epicId}-retrospective.md`);

    if (!existsSync(retroFilePath)) {
      log.warn("Retro file not found, skipping learnings extraction", { epicId, retroFilePath });
      continue;
    }

    try {
      // Create a CEO session to extract durable learnings
      const ceoAgent = getAgent("ceo") ?? getAgent("bmad-ceo") ?? {
        name: "ceo",
        displayName: "CEO - Chief Executive",
        description: "Strategic orchestrator",
        prompt: "You are the CEO. You orchestrate, not execute.",
      };

      const extractionStrategy = loadModelStrategyConfig();
      const extractionModel = resolveModel("ceo-reeval", {}, extractionStrategy);
      const extractionSessionId = await sessionManager.createAgentSession({
        agent: ceoAgent,
        allAgents,
        tools: [],
        model: extractionModel.model,
        systemMessage: config.agentSystemMessage,
      });

      const retroContent = readFileSync(retroFilePath, "utf-8");
      const extraction = await sessionManager.sendAndWait(
        extractionSessionId,
        `Read this retrospective report and extract 3-5 durable, actionable learnings ` +
        `that should inform future epic delegation. Format as a markdown list with brief ` +
        `explanations. Focus on process improvements, not task-specific details.\n\n` +
        retroContent,
        60_000,
      );

      // Save to PARA memory
      const learningsPath = resolve(workspaceCwd, `_bmad-output/memory/learnings/epic-${epicId}.md`);
      mkdirSync(dirname(learningsPath), { recursive: true });
      writeFileSync(learningsPath, `# Learnings from Epic ${epicId}\n\n${extraction}\n`);

      // Mark as extracted so we don't re-process
      await client.updateIssue(retro.id, {
        metadata: { ...retroMeta, learningsExtracted: true },
      });

      log.info("Learnings extracted from retro", { epicId, learningsPath });
      await client.addIssueComment(
        parentIssue.id,
        `📝 **CEO — Learnings extracted** from epic ${epicId} retrospective and saved to memory.`,
      );
    } catch (err) {
      log.warn("Failed to extract learnings from retro", {
        epicId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ── 4. If promotions happened, report and exit (fast path) ────────
  if (promoted > 0) {
    const statusSummary = activeChildren.map((c) => {
      const meta = c.metadata as Record<string, unknown> | undefined;
      const idx = meta?.taskIndex ?? "?";
      return `[${idx}] ${c.title}: ${c.status}`;
    }).join("\n");

    await client.addIssueComment(
      parentIssue.id,
      [
        `🔄 **CEO — Re-evaluation Complete**`,
        ``,
        `Promoted **${promoted}** task(s) from backlog → todo.`,
        ``,
        `**Current status:**`,
        statusSummary,
      ].join("\n"),
    );

    return { success: true, promoted, allDone: false };
  }

  // ── 5. No deterministic promotions — use LLM for complex reasoning ─
  // This handles edge cases: stuck tasks, reassignment, unexpected states
  const hasStuckTasks = activeChildren.some(
    (c) => c.status === "blocked" || c.status === "in_progress",
  );

  if (!hasStuckTasks) {
    // Everything is either backlog (waiting) or in-progress — nothing to do
    log.info("No promotions needed, no stuck tasks — CEO re-evaluation idle");
    return { success: true, promoted: 0, allDone: false };
  }

  // Use LLM to reason about stuck/complex situations
  const ceoAgentDef = getAgent("ceo") ?? getAgent("bmad-ceo") ?? {
    name: "ceo",
    displayName: "CEO - Chief Executive",
    description: "Strategic orchestrator",
    prompt: "You are the CEO. You orchestrate, not execute.",
  };

  // Resolve model via strategy (re-eval = standard tier)
  const reEvalStrategy = loadModelStrategyConfig();
  const reEvalModel = resolveModel("ceo-reeval", {}, reEvalStrategy);
  const reEvalModelId = reEvalModel.model;

  let sessionId: string;
  try {
    sessionId = await sessionManager.createAgentSession({
      agent: ceoAgentDef,
      allAgents,
      tools: allTools,
      model: reEvalModelId,
      systemMessage: config.agentSystemMessage,
    });
  } catch (err) {
    log.error("Failed to create CEO re-eval session", {}, err instanceof Error ? err : undefined);
    return { success: false, promoted: 0, allDone: false, error: String(err) };
  }

  const prompt = buildReEvaluationPrompt(parentIssue, activeChildren);
  let response: string;
  try {
    response = await sessionManager.sendAndWait(sessionId, prompt, 120_000);
  } catch (err) {
    log.error("CEO re-eval session failed", {}, err instanceof Error ? err : undefined);
    await sessionManager.closeSession(sessionId);
    return { success: false, promoted: 0, allDone: false, error: String(err) };
  }

  await sessionManager.closeSession(sessionId);

  if (costTracker) {
    costTracker.recordUsage("ceo", reEvalModelId, prompt, response, {
      phase: "ceo-reeval",
      issueId: parentIssue.id,
    });
  }

  const result = parseReEvaluationResponse(response);
  if (!result || result.actions.length === 0) {
    log.info("CEO re-eval: no actions from LLM");
    return { success: true, promoted: 0, allDone: false };
  }

  // Execute LLM-decided actions
  for (const action of result.actions) {
    try {
      switch (action.type) {
        case "promote":
          if (action.issueId) {
            await client.updateIssue(action.issueId, { status: "todo" });
            promoted++;
            log.info("CEO promoted (LLM)", { issueId: action.issueId, reason: action.reason });
          }
          break;
        case "comment":
          if (action.issueId && action.body) {
            await client.addIssueComment(action.issueId, `💬 **CEO**: ${action.body}`);
          }
          break;
        case "close_parent":
          await client.updateIssue(parentIssue.id, { status: "done" });
          await client.addIssueComment(parentIssue.id, `✅ **CEO**: ${action.reason ?? "All work complete"}`);
          return { success: true, promoted, allDone: true };
        case "reassign":
          if (action.issueId && action.newAssignee) {
            const newId = await resolveAgentId(action.newAssignee, client);
            if (newId) {
              await client.updateIssue(action.issueId, { assigneeAgentId: newId });
              log.info("CEO reassigned", { issueId: action.issueId, to: action.newAssignee });
            }
          }
          break;
      }
    } catch (err) {
      log.warn("CEO re-eval action failed", {
        action: action.type,
        issueId: action.issueId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (result.summary) {
    await client.addIssueComment(parentIssue.id, `🔄 **CEO — Re-evaluation:** ${result.summary}`);
  }

  return { success: true, promoted, allDone: false };
}

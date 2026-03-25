/**
 * Agent Dispatcher — Routes Work to BMAD Agents
 *
 * Determines which agent handles a given work item, selects appropriate tools,
 * builds the prompt with context, and delegates to the SessionManager.
 *
 * This is the tactical "who does what" module — the sprint-runner provides
 * the strategic "what needs doing" flow.
 *
 * @module adapter/agent-dispatcher
 */

import { resolve } from "node:path";
import { existsSync } from "node:fs";
import type { BmadConfig } from "../config/config.js";
import { getAgent, allAgents } from "../agents/registry.js";
import {
  allTools,
  createStoryTool,
  codeReviewTool,
  codeReviewResultTool,
  issueStatusTool,
  qualityGateEvaluateTool,
} from "../tools/index.js";
import type { Tool } from "../tools/types.js";
import type { SessionManager } from "./session-manager.js";
import { Logger } from "../observability/logger.js";
import { traceAgentDispatch } from "../observability/tracing.js";
import { recordDispatchDuration } from "../observability/metrics.js";
import { resolveModel, loadModelStrategyConfig } from "../config/model-strategy.js";
import type { ModelStrategyConfig, ComplexitySignals } from "../config/model-strategy.js";
import type { CostTracker } from "../observability/cost-tracker.js";

const log = Logger.child("agent-dispatcher");

/**
 * Work item lifecycle phases.
 *
 * Original 5 phases cover the core BMAD story lifecycle. The expanded
 * phases align with the CEO's delegation pipeline (research → define →
 * plan → execute → review) and map to specific BMAD agent capabilities.
 *
 * The "delegated-task" phase is a catch-all for CEO-delegated work where
 * the issue title and description ARE the prompt — no rigid template needed.
 */
export type WorkPhase =
  // ── Core story lifecycle (original) ───────────────────────────────
  | "create-story"
  | "dev-story"
  | "code-review"
  | "sprint-planning"
  | "sprint-status"
  // ── Research phase ────────────────────────────────────────────────
  | "research"
  | "domain-research"
  | "market-research"
  | "technical-research"
  // ── Define phase ──────────────────────────────────────────────────
  | "create-prd"
  | "create-architecture"
  | "create-ux-design"
  | "create-product-brief"
  // ── Plan phase ────────────────────────────────────────────────────
  | "create-epics"
  | "check-implementation-readiness"
  // ── Execute phase (extensions) ────────────────────────────────────
  | "e2e-tests"
  | "documentation"
  | "quick-dev"
  // ── Review phase (extensions) ─────────────────────────────────────
  | "editorial-review"
  // ── Generic delegated work ────────────────────────────────────────
  | "delegated-task"
  // ── CEO orchestration phases ──────────────────────────────────────
  | "ceo-delegation"
  | "ceo-reeval";

/**
 * A work item to dispatch to an agent.
 */
export interface WorkItem {
  /** Unique identifier */
  id: string;
  /** The lifecycle phase */
  phase: WorkPhase;
  /** Story ID (for story-scoped phases) */
  storyId?: string;
  /** Story title for context */
  storyTitle?: string;
  /** Story description for context */
  storyDescription?: string;
  /** Epic ID for context */
  epicId?: string;
  /** Additional context to inject into the prompt */
  extraContext?: string;
  /** Complexity signals for model tier selection */
  complexitySignals?: ComplexitySignals;
  /**
   * Override the default agent from getPhaseConfig().
   * Used when the CEO explicitly assigned a task to a specific BMAD agent
   * that differs from the phase's default routing.
   */
  agentOverride?: string;
}

/**
 * Result from dispatching a work item.
 */
export interface DispatchResult {
  /** Whether the dispatch succeeded */
  success: boolean;
  /** The agent response content */
  response: string;
  /** The agent that handled it */
  agentName: string;
  /** Session ID (for multi-turn follow-ups) */
  sessionId: string;
  /** Error message if failed */
  error?: string;
}

/**
 * Phase-to-agent mapping with tool selection.
 */
interface PhaseConfig {
  agentName: string;
  tools: Tool<unknown>[];
  buildPrompt: (item: WorkItem, config: BmadConfig) => string;
}

/**
 * Phase routing table — maps lifecycle phases to agents, tools, and prompts.
 *
 * Two categories of prompts:
 * 1. **Template prompts** — Original 5 phases with rigid tool-specific instructions
 * 2. **Context prompts** — Expanded phases that use the issue description as primary
 *    instruction, since the CEO already wrote detailed, self-contained task descriptions
 */
function getPhaseConfig(): Record<WorkPhase, PhaseConfig> {
  /**
   * Helper: build a context-driven prompt for CEO-delegated tasks.
   * Uses the issue title + description as the primary instruction rather
   * than a rigid template. The agent's BMAD skills (loaded via skillDirectories)
   * provide the methodology context.
   */
  const contextPrompt = (agentMention: string, phaseName: string) =>
    (item: WorkItem, _config: BmadConfig): string => [
      `@${agentMention} You have been assigned the following ${phaseName} task:`,
      ``,
      `## Task: ${item.storyTitle ?? "Untitled"}`,
      ``,
      item.storyDescription ?? "No description provided.",
      ``,
      `## Workspace & Artifact Protocol`,
      ``,
      `**BEFORE you begin:** List all files in the current working directory. Previous phases may`,
      `have produced artifacts (research findings, PRDs, architecture docs, etc.) that you MUST`,
      `read and use as inputs for your work. Do not duplicate or contradict prior phase outputs.`,
      ``,
      `**WHEN you finish:** Save your deliverables as markdown files in the current working`,
      `directory with descriptive filenames (e.g., \`prd.md\`, \`architecture.md\`,`,
      `\`ux-design-spec.md\`, \`epic-breakdown.md\`). Use clear, descriptive names.`,
      ``,
      `**FINAL STEP:** After saving files, provide a comprehensive summary of your work that`,
      `includes: (1) what you produced, (2) key findings or decisions, (3) the exact filenames`,
      `of all artifacts you created or updated.`,
      ``,
      `## State Management`,
      ``,
      `**IMPORTANT:** Do NOT use sprint-status.yaml for state tracking. Use the issue_status`,
      `tool to read, update, and manage issue state via the Paperclip API.`,
      ``,
      `Use your BMAD skills and tools to complete this task thoroughly.`,
      item.extraContext ? `\n## Additional Context\n${item.extraContext}` : "",
    ].filter(Boolean).join("\n");

  return {
    // ═══════════════════════════════════════════════════════════════════
    // Core Story Lifecycle (original 5 phases — template prompts)
    // ═══════════════════════════════════════════════════════════════════

    "create-story": {
      agentName: "bmad-pm",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      tools: [createStoryTool, issueStatusTool] as Tool<any>[],
      buildPrompt: (item, _config) => [
        `@bmad-pm Create a detailed story following the bmad-create-story skill methodology.`,
        ``,
        `## Story Details`,
        `- Epic ID: "${item.epicId ?? "epic-1"}"`,
        `- Story ID: "${item.storyId ?? "STORY-NEW"}"`,
        `- Title: "${item.storyTitle ?? "Untitled Story"}"`,
        `- Description: "${item.storyDescription ?? "No description provided."}"`,
        ``,
        `## Instructions`,
        `1. Follow the bmad-create-story skill for deep artifact analysis (PRD, architecture,`,
        `   UX specs, previous story learnings) to produce comprehensive story content.`,
        `2. After generating rich story content, use the create_story tool to register the`,
        `   story in Paperclip with the generated content.`,
        `3. Do NOT use sprint-status.yaml — use issue_status tool for state management.`,
        ``,
        `Confirm the Paperclip issue was created after completion.`,
        item.extraContext ? `\nAdditional context:\n${item.extraContext}` : "",
      ].filter(Boolean).join("\n"),
    },

    "dev-story": {
      agentName: "bmad-dev",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      tools: [issueStatusTool] as Tool<any>[],
      buildPrompt: (item, config) => {
        const storyPath = resolve(config.outputDir, "stories", `${item.storyId}.md`);
        return [
          `@bmad-dev Implement story ${item.storyId} following the bmad-dev-story skill methodology.`,
          ``,
          `## Story`,
          `- Story ID: "${item.storyId}"`,
          `- Story file: "${storyPath}"`,
          ``,
          `## Instructions`,
          `1. Read the story file at the path above for acceptance criteria and tasks.`,
          `2. Follow the bmad-dev-story skill's 10-step TDD workflow:`,
          `   load context → detect review continuation → red-green-refactor cycle per task`,
          `   → validate per task → mark for review.`,
          `3. Do NOT use sprint-status.yaml — use issue_status tool for state management.`,
          `4. When implementation is complete, use issue_status tool with action='reassign'`,
          `   and target_role='bmad-qa' to hand off for code review.`,
          ``,
          `BMAD rule: dev-story runs exactly ONCE per story.`,
          item.extraContext ? `\nAdditional context:\n${item.extraContext}` : "",
        ].filter(Boolean).join("\n");
      },
    },

    "code-review": {
      agentName: "bmad-qa",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      tools: [codeReviewTool, codeReviewResultTool, qualityGateEvaluateTool, issueStatusTool] as Tool<any>[],
      buildPrompt: (item, config) => {
        const storyPath = resolve(config.outputDir, "stories", `${item.storyId}.md`);
        return [
          `@bmad-qa Review story ${item.storyId} following the bmad-code-review skill methodology.`,
          ``,
          `## Story`,
          `- Story ID: "${item.storyId}"`,
          `- Story file: "${storyPath}"`,
          `- Files to review: "src/"`,
          ``,
          `## Instructions`,
          `1. Follow the bmad-code-review skill's adversarial review process with parallel`,
          `   review layers (Blind Hunter, Edge Case Hunter, Acceptance Auditor).`,
          `2. Apply BMAD quality gates:`,
          `   - LOW/MEDIUM findings: log but don't block`,
          `   - HIGH/CRITICAL findings: BLOCK and require fixes`,
          `3. Use the code_review tool to track review passes in Paperclip metadata.`,
          `4. After review, use code_review_result to record your verdict.`,
          `5. If approved, the issue status will be updated to 'done' automatically.`,
          `6. If rejected, use issue_status tool with action='reassign' and target_role='bmad-dev'`,
          `   to send back for fixes.`,
          `7. Do NOT use sprint-status.yaml — use issue_status tool for state management.`,
          item.extraContext ? `\nAdditional context:\n${item.extraContext}` : "",
        ].filter(Boolean).join("\n");
      },
    },

    "sprint-planning": {
      agentName: "bmad-sm",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      tools: [issueStatusTool, createStoryTool] as Tool<any>[],
      buildPrompt: (item, _config) => [
        `@bmad-sm Review the current issue status and plan the next set of work.`,
        `Use the issue_status tool with action='read' to get current state.`,
        `Identify stories that need to move forward.`,
        item.extraContext ? `\nContext:\n${item.extraContext}` : "",
      ].filter(Boolean).join("\n"),
    },

    "sprint-status": {
      agentName: "bmad-sm",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      tools: [issueStatusTool] as Tool<any>[],
      buildPrompt: (_item, _config) => [
        `@bmad-sm Use the issue_status tool with action='read' to read the current issue statuses.`,
        `Provide a brief summary of the sprint state.`,
      ].join("\n"),
    },

    // ═══════════════════════════════════════════════════════════════════
    // Research Phase — Analyst, PM, or Architect investigate
    // ═══════════════════════════════════════════════════════════════════

    "research": {
      agentName: "bmad-analyst",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      tools: [issueStatusTool] as Tool<any>[],
      buildPrompt: contextPrompt("bmad-analyst", "research (use bmad-domain-research or bmad-market-research skill)"),
    },

    "domain-research": {
      agentName: "bmad-analyst",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      tools: [issueStatusTool] as Tool<any>[],
      buildPrompt: contextPrompt("bmad-analyst", "domain research (use bmad-domain-research skill)"),
    },

    "market-research": {
      agentName: "bmad-pm",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      tools: [issueStatusTool] as Tool<any>[],
      buildPrompt: contextPrompt("bmad-pm", "market research (use bmad-market-research skill)"),
    },

    "technical-research": {
      agentName: "bmad-architect",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      tools: [issueStatusTool] as Tool<any>[],
      buildPrompt: contextPrompt("bmad-architect", "technical research (use bmad-technical-research skill)"),
    },

    // ═══════════════════════════════════════════════════════════════════
    // Define Phase — PM, Architect, UX create specs
    // ═══════════════════════════════════════════════════════════════════

    "create-prd": {
      agentName: "bmad-pm",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      tools: [issueStatusTool] as Tool<any>[],
      buildPrompt: contextPrompt("bmad-pm", "PRD creation (use bmad-create-prd skill)"),
    },

    "create-architecture": {
      agentName: "bmad-architect",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      tools: [issueStatusTool] as Tool<any>[],
      buildPrompt: contextPrompt("bmad-architect", "architecture design (use bmad-create-architecture skill)"),
    },

    "create-ux-design": {
      agentName: "bmad-ux-designer",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      tools: [issueStatusTool] as Tool<any>[],
      buildPrompt: contextPrompt("bmad-ux-designer", "UX design (use bmad-create-ux-design skill)"),
    },

    "create-product-brief": {
      agentName: "bmad-pm",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      tools: [issueStatusTool] as Tool<any>[],
      buildPrompt: contextPrompt("bmad-pm", "product brief creation (use bmad-create-product-brief skill)"),
    },

    // ═══════════════════════════════════════════════════════════════════
    // Plan Phase — SM & PM break down into stories/epics
    // ═══════════════════════════════════════════════════════════════════

    "create-epics": {
      agentName: "bmad-pm",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      tools: [createStoryTool, issueStatusTool] as Tool<any>[],
      buildPrompt: contextPrompt("bmad-pm", "epic and story creation (use bmad-create-epics-and-stories skill)"),
    },

    "check-implementation-readiness": {
      agentName: "bmad-pm",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      tools: [issueStatusTool] as Tool<any>[],
      buildPrompt: contextPrompt("bmad-pm", "implementation readiness check (use bmad-check-implementation-readiness skill)"),
    },

    // ═══════════════════════════════════════════════════════════════════
    // Execute Phase Extensions — Dev, QA, Tech Writer
    // ═══════════════════════════════════════════════════════════════════

    "e2e-tests": {
      agentName: "bmad-qa",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      tools: [codeReviewTool, qualityGateEvaluateTool, issueStatusTool] as Tool<any>[],
      buildPrompt: contextPrompt("bmad-qa", "end-to-end test generation (use bmad-qa-generate-e2e-tests skill)"),
    },

    "documentation": {
      agentName: "bmad-tech-writer",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      tools: [issueStatusTool] as Tool<any>[],
      buildPrompt: contextPrompt("bmad-tech-writer", "documentation (use bmad-document-project skill)"),
    },

    "quick-dev": {
      agentName: "bmad-quick-flow-solo-dev",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      tools: [createStoryTool, codeReviewTool, issueStatusTool] as Tool<any>[],
      buildPrompt: contextPrompt("bmad-quick-flow-solo-dev", "quick development (use bmad-quick-dev skill)"),
    },

    // ═══════════════════════════════════════════════════════════════════
    // Review Phase Extensions
    // ═══════════════════════════════════════════════════════════════════

    "editorial-review": {
      agentName: "bmad-tech-writer",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      tools: [issueStatusTool] as Tool<any>[],
      buildPrompt: contextPrompt("bmad-tech-writer", "editorial review (use bmad-editorial-review-prose and bmad-editorial-review-structure skills)"),
    },

    // ═══════════════════════════════════════════════════════════════════
    // Generic Delegated Task — CEO-assigned work with full context
    // ═══════════════════════════════════════════════════════════════════

    "delegated-task": {
      agentName: "bmad-dev", // Default — will be overridden by dispatchDelegated()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      tools: allTools as Tool<any>[],
      buildPrompt: (item, _config) => [
        `You have been assigned the following task by the CEO:`,
        ``,
        `## ${item.storyTitle ?? "Delegated Task"}`,
        ``,
        item.storyDescription ?? "No description provided.",
        ``,
        `## Workspace & Artifact Protocol`,
        ``,
        `**BEFORE you begin:** List all files in the current working directory. Previous phases may`,
        `have produced artifacts (research findings, PRDs, architecture docs, etc.) that you MUST`,
        `read and use as inputs for your work. Do not duplicate or contradict prior phase outputs.`,
        ``,
        `**WHEN you finish:** Save your deliverables as markdown files in the current working`,
        `directory with descriptive filenames (e.g., \`prd.md\`, \`architecture.md\`,`,
        `\`ux-design-spec.md\`, \`epic-breakdown.md\`). Use clear, descriptive names.`,
        ``,
        `**FINAL STEP:** After saving files, provide a comprehensive summary of your work that`,
        `includes: (1) what you produced, (2) key findings or decisions, (3) the exact filenames`,
        `of all artifacts you created or updated.`,
        ``,
        `Complete this task using all available tools and skills.`,
        item.extraContext ? `\n## Additional Context\n${item.extraContext}` : "",
      ].filter(Boolean).join("\n"),
    },

    // CEO phases — not dispatched via AgentDispatcher but registered
    // so WorkPhase → PhaseConfig map is complete for model-strategy.
    "ceo-delegation": {
      agentName: "ceo",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      tools: allTools as Tool<any>[],
      buildPrompt: () => "(CEO delegation — handled by ceo-orchestrator)",
    },
    "ceo-reeval": {
      agentName: "ceo",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      tools: allTools as Tool<any>[],
      buildPrompt: () => "(CEO re-evaluation — handled by ceo-orchestrator)",
    },
  };
}

/**
 * AgentDispatcher routes work items to BMAD agents via the SessionManager.
 */
export class AgentDispatcher {
  private sessionManager: SessionManager;
  private config: BmadConfig;
  private skillDirs: string[];
  private modelStrategy: ModelStrategyConfig;
  private costTracker: CostTracker | undefined;

  constructor(sessionManager: SessionManager, config: BmadConfig, costTracker?: CostTracker) {
    this.sessionManager = sessionManager;
    this.config = config;
    this.costTracker = costTracker;
    this.modelStrategy = loadModelStrategyConfig();

    // Resolve skill directories — filter to only directories that exist on disk
    this.skillDirs = [
      resolve(config.projectRoot, "src/skills"),
      resolve(config.projectRoot, ".github/skills"),
    ].filter((dir) => existsSync(dir));
  }

  /**
   * Dispatch a work item to the appropriate BMAD agent.
   *
   * @param item - The work item to process
   * @param onDelta - Optional streaming callback
   * @returns Dispatch result with agent response
   */
  async dispatch(item: WorkItem, onDelta?: (delta: string) => void): Promise<DispatchResult> {
    const phaseConfigs = getPhaseConfig();
    const phaseConfig = phaseConfigs[item.phase];

    if (!phaseConfig) {
      return {
        success: false,
        response: "",
        agentName: "unknown",
        sessionId: "",
        error: `Unknown phase: ${item.phase}`,
      };
    }

    // Resolve the agent — agentOverride takes precedence (CEO-delegated tasks)
    const targetAgentName = item.agentOverride ?? phaseConfig.agentName;
    const agent = getAgent(targetAgentName);
    if (!agent) {
      return {
        success: false,
        response: "",
        agentName: targetAgentName,
        sessionId: "",
        error: `Agent not found: ${targetAgentName}`,
      };
    }

    // Build the prompt
    const prompt = phaseConfig.buildPrompt(item, this.config);

    log.info("Dispatching work item", {
      phase: item.phase,
      agent: agent.displayName,
      storyId: item.storyId ?? "n/a",
    });

    // Resolve optimal model based on task complexity
    const modelSelection = resolveModel(item.phase, item.complexitySignals ?? {}, this.modelStrategy);
    log.info("Model selected", {
      model: modelSelection.model,
      tier: modelSelection.tier,
      provider: modelSelection.provider,
      reason: modelSelection.complexityReason,
    });

    const startTime = Date.now();

    try {
      const result = await traceAgentDispatch(
        agent.name,
        item.phase,
        item.storyId ?? "unknown",
        async (span) => {
          // Create a session for this agent
          const sessionId = await this.sessionManager.createAgentSession({
            agent,
            allAgents,
            tools: phaseConfig.tools,
            skillDirectories: this.skillDirs,
            model: modelSelection.model,
            systemMessage: this.config.agentSystemMessage,
          });

          // Track story association
          if (item.storyId) {
            this.sessionManager.setSessionStory(sessionId, item.storyId);
          }

          // Send the prompt (15 min timeout — agent may spawn sub-agents with many tool calls)
          const response = await this.sessionManager.sendAndWait(
            sessionId,
            prompt,
            900_000,
            onDelta,
          );

          // Record token usage for cost tracking
          if (this.costTracker) {
            this.costTracker.recordUsage(
              agent.name,
              modelSelection.model,
              prompt,
              response,
              { sessionId, phase: item.phase, issueId: item.id },
            );
          }

          // Close the session (one-shot per phase)
          await this.sessionManager.closeSession(sessionId);

          span.setAttribute("dispatch.success", true);
          span.setAttribute("response.length", response.length);
          span.setAttribute("model.name", modelSelection.model);
          span.setAttribute("model.tier", modelSelection.tier);
          span.setAttribute("model.provider", modelSelection.provider);

          return {
            success: true,
            response,
            agentName: agent.name,
            sessionId,
          } as DispatchResult;
        },
      );

      recordDispatchDuration(agent.name, item.phase, Date.now() - startTime, true);
      return result;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      const durationMs = Date.now() - startTime;
      recordDispatchDuration(agent.name, item.phase, durationMs, false);
      log.error("Dispatch failed", { phase: item.phase, agent: agent.name, durationMs }, err instanceof Error ? err : undefined);
      return {
        success: false,
        response: "",
        agentName: agent.name,
        sessionId: "",
        error: errorMsg,
      };
    }
  }

  /**
   * Dispatch a free-form prompt to a specific agent (for ad-hoc tasks).
   */
  async dispatchDirect(
    agentName: string,
    prompt: string,
    tools?: Tool<unknown>[],
    onDelta?: (delta: string) => void,
  ): Promise<DispatchResult> {
    const agent = getAgent(agentName);
    if (!agent) {
      return {
        success: false,
        response: "",
        agentName,
        sessionId: "",
        error: `Agent not found: ${agentName}`,
      };
    }

    try {
      const sessionId = await this.sessionManager.createAgentSession({
        agent,
        allAgents,
        tools: tools ?? allTools,
        skillDirectories: this.skillDirs,
        systemMessage: this.config.agentSystemMessage,
      });

      const response = await this.sessionManager.sendAndWait(
        sessionId,
        `@${agentName} ${prompt}`,
        900_000,
        onDelta,
      );

      // Record token usage for cost tracking
      if (this.costTracker) {
        this.costTracker.recordUsage(
          agent.name,
          "default", // dispatchDirect doesn't go through model selection
          `@${agentName} ${prompt}`,
          response,
          { sessionId, phase: "delegated-task" },
        );
      }

      await this.sessionManager.closeSession(sessionId);

      return { success: true, response, agentName: agent.name, sessionId };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      return { success: false, response: "", agentName: agent.name, sessionId: "", error: errorMsg };
    }
  }
}

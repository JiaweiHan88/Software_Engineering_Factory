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
import type { BmadConfig } from "../config/config.js";
import { getAgent, allAgents } from "../agents/registry.js";
import {
  allTools,
  createStoryTool,
  devStoryTool,
  codeReviewTool,
  codeReviewResultTool,
  sprintStatusTool,
  qualityGateEvaluateTool,
} from "../tools/index.js";
import type { Tool } from "../tools/types.js";
import type { SessionManager } from "./session-manager.js";
import { Logger } from "../observability/logger.js";
import { traceAgentDispatch } from "../observability/tracing.js";
import { recordDispatchDuration } from "../observability/metrics.js";
import { resolveModel, loadModelStrategyConfig } from "../config/model-strategy.js";
import type { ModelStrategyConfig, ComplexitySignals } from "../config/model-strategy.js";

const log = Logger.child("agent-dispatcher");

/**
 * Work item lifecycle phases.
 */
export type WorkPhase =
  | "create-story"
  | "dev-story"
  | "code-review"
  | "sprint-planning"
  | "sprint-status";

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
 */
function getPhaseConfig(): Record<WorkPhase, PhaseConfig> {
  return {
    "create-story": {
      agentName: "bmad-pm",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      tools: [createStoryTool, sprintStatusTool] as Tool<any>[],
      buildPrompt: (item, _config) => [
        `@bmad-pm Use the create_story tool to create a new story:`,
        `- epic_id: "${item.epicId ?? "epic-1"}"`,
        `- story_id: "${item.storyId ?? "STORY-NEW"}"`,
        `- story_title: "${item.storyTitle ?? "Untitled Story"}"`,
        `- story_description: "${item.storyDescription ?? "No description provided."}"`,
        ``,
        `After creating the story, confirm the sprint status was updated.`,
        item.extraContext ? `\nAdditional context:\n${item.extraContext}` : "",
      ].filter(Boolean).join("\n"),
    },

    "dev-story": {
      agentName: "bmad-dev",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      tools: [devStoryTool, sprintStatusTool] as Tool<any>[],
      buildPrompt: (item, config) => {
        const storyPath = resolve(config.outputDir, "stories", `${item.storyId}.md`);
        return [
          `@bmad-dev Use the dev_story tool to implement story ${item.storyId}:`,
          `- story_id: "${item.storyId}"`,
          `- story_file_path: "${storyPath}"`,
          ``,
          `Read the story file for acceptance criteria and implement accordingly.`,
          `When implementation is complete, use sprint_status to move the story to 'review'.`,
          item.extraContext ? `\nAdditional context:\n${item.extraContext}` : "",
        ].filter(Boolean).join("\n");
      },
    },

    "code-review": {
      agentName: "bmad-qa",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      tools: [codeReviewTool, codeReviewResultTool, qualityGateEvaluateTool, sprintStatusTool] as Tool<any>[],
      buildPrompt: (item, config) => {
        const storyPath = resolve(config.outputDir, "stories", `${item.storyId}.md`);
        return [
          `@bmad-qa Use the code_review tool to review story ${item.storyId}:`,
          `- story_id: "${item.storyId}"`,
          `- story_file_path: "${storyPath}"`,
          `- files_to_review: "src/"`,
          ``,
          `Perform an adversarial code review following BMAD quality gates:`,
          `- LOW/MEDIUM findings: log but don't block`,
          `- HIGH/CRITICAL findings: BLOCK and require fixes`,
          ``,
          `After review, use code_review_result to record your verdict.`,
          `If approved, use sprint_status to move the story to 'done'.`,
          item.extraContext ? `\nAdditional context:\n${item.extraContext}` : "",
        ].filter(Boolean).join("\n");
      },
    },

    "sprint-planning": {
      agentName: "bmad-sm",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      tools: [sprintStatusTool, createStoryTool] as Tool<any>[],
      buildPrompt: (item, _config) => [
        `@bmad-sm Review the current sprint status and plan the next set of work.`,
        `Use the sprint_status tool to read current state.`,
        `Identify stories that need to move forward.`,
        item.extraContext ? `\nContext:\n${item.extraContext}` : "",
      ].filter(Boolean).join("\n"),
    },

    "sprint-status": {
      agentName: "bmad-sm",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      tools: [sprintStatusTool] as Tool<any>[],
      buildPrompt: (_item, _config) => [
        `@bmad-sm Use the sprint_status tool to read the current sprint status.`,
        `Provide a brief summary of the sprint state.`,
      ].join("\n"),
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

  constructor(sessionManager: SessionManager, config: BmadConfig) {
    this.sessionManager = sessionManager;
    this.config = config;
    this.modelStrategy = loadModelStrategyConfig();

    // Resolve skill directories — both our custom skills and BMAD's .github/skills
    this.skillDirs = [
      resolve(config.projectRoot, "src/skills"),
      resolve(config.projectRoot, ".github/skills"),
    ];
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

    // Resolve the agent
    const agent = getAgent(phaseConfig.agentName);
    if (!agent) {
      return {
        success: false,
        response: "",
        agentName: phaseConfig.agentName,
        sessionId: "",
        error: `Agent not found: ${phaseConfig.agentName}`,
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
          });

          // Track story association
          if (item.storyId) {
            this.sessionManager.setSessionStory(sessionId, item.storyId);
          }

          // Send the prompt
          const response = await this.sessionManager.sendAndWait(
            sessionId,
            prompt,
            120_000,
            onDelta,
          );

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
      });

      const response = await this.sessionManager.sendAndWait(
        sessionId,
        `@${agentName} ${prompt}`,
        120_000,
        onDelta,
      );

      await this.sessionManager.closeSession(sessionId);

      return { success: true, response, agentName: agent.name, sessionId };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      return { success: false, response: "", agentName: agent.name, sessionId: "", error: errorMsg };
    }
  }
}

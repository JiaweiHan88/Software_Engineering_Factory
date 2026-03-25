/**
 * BMAD Tool Definitions — Copilot SDK defineTool() implementations
 *
 * Each tool corresponds to a BMAD workflow step and uses Zod schemas
 * for type-safe parameter validation via the Copilot SDK.
 *
 * M0 migration: sprint-status.yaml tools replaced by Paperclip-backed
 * issue-status tool. Tool context provides PaperclipClient at runtime.
 */

export { createStoryTool } from "./create-story.js";
export { codeReviewTool, codeReviewResultTool } from "./code-review.js";
export { issueStatusTool } from "./issue-status.js";
export { defineTool } from "./types.js";
export type { Tool, ToolHandler } from "./types.js";

// Tool context — provides PaperclipClient to tool handlers at runtime
export { setToolContext, getToolContext, tryGetToolContext, clearToolContext } from "./tool-context.js";
export type { ToolContext } from "./tool-context.js";

// Re-export quality gate tool
export { qualityGateEvaluateTool } from "../quality-gates/tool.js";

/**
 * Legacy sprint-status exports — kept for backward compatibility with
 * quality-gates/review-orchestrator.ts and quality-gates/tool.ts.
 * The sprint_status tool itself has been removed from allTools.
 * @deprecated Use issue-status.ts and Paperclip issues instead.
 */
export { readSprintStatus, writeSprintStatus } from "./sprint-status.js";
export type { SprintStatusData, SprintStory } from "./sprint-status.js";

import type { Tool } from "./types.js";
import { createStoryTool } from "./create-story.js";
import { codeReviewTool, codeReviewResultTool } from "./code-review.js";
import { issueStatusTool } from "./issue-status.js";
import { qualityGateEvaluateTool } from "../quality-gates/tool.js";

/**
 * All BMAD tools, ready to pass to CopilotClient.createSession({ tools }).
 *
 * M0: Replaced sprintStatusTool with issueStatusTool.
 * P0: Removed devStoryTool — BMAD skill handles methodology, agent reads story file directly.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const allTools: Tool<any>[] = [
  createStoryTool,
  codeReviewTool,
  codeReviewResultTool,
  issueStatusTool,
  qualityGateEvaluateTool,
];

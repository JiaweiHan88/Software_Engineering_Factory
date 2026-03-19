/**
 * BMAD Tool Definitions — Copilot SDK defineTool() implementations
 *
 * Each tool corresponds to a BMAD workflow step and uses Zod schemas
 * for type-safe parameter validation via the Copilot SDK.
 */

export { createStoryTool } from "./create-story.js";
export { devStoryTool } from "./dev-story.js";
export { codeReviewTool, codeReviewResultTool } from "./code-review.js";
export { sprintStatusTool } from "./sprint-status.js";
export { defineTool } from "./types.js";
export type { Tool, ToolHandler } from "./types.js";

// Re-export sprint-status utilities for use in other tools
export { readSprintStatus, writeSprintStatus } from "./sprint-status.js";
export type { SprintStatusData, SprintStory } from "./sprint-status.js";

// Re-export quality gate tool
export { qualityGateEvaluateTool } from "../quality-gates/tool.js";

import type { Tool } from "./types.js";
import { createStoryTool } from "./create-story.js";
import { devStoryTool } from "./dev-story.js";
import { codeReviewTool, codeReviewResultTool } from "./code-review.js";
import { sprintStatusTool } from "./sprint-status.js";
import { qualityGateEvaluateTool } from "../quality-gates/tool.js";

/**
 * All BMAD tools, ready to pass to CopilotClient.createSession({ tools }).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const allTools: Tool<any>[] = [
  createStoryTool,
  devStoryTool,
  codeReviewTool,
  codeReviewResultTool,
  sprintStatusTool,
  qualityGateEvaluateTool,
];

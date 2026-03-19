import type { BmadToolDefinition } from "./types.js";

/**
 * sprint-status tool — BMAD sprint status management.
 *
 * Reads and updates the sprint-status.yaml file.
 * Used by all agents to understand current sprint state.
 *
 * TODO (Phase 3): Implement handler with YAML file management.
 */
export const sprintStatusTool: BmadToolDefinition = {
  name: "sprint_status",
  description:
    "Read or update the sprint status (sprint-status.yaml). Returns current epic, story, status, and review pass information.",
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        description:
          "Action to perform: 'read' to get current status, 'update' to change a story's status",
      },
      story_id: {
        type: "string",
        description: "Story identifier (required for 'update' action)",
      },
      new_status: {
        type: "string",
        description:
          "New status value: backlog, ready-for-dev, in-progress, review, done",
      },
    },
    required: ["action"],
  },
  handler: async (args) => {
    // TODO: Phase 3 — Implement sprint-status.yaml management
    // 1. Read sprint-status.yaml
    // 2. If action=read: return current state
    // 3. If action=update: modify story status, write back
    console.log(`[sprint_status] Action: ${args.action}`);
    return {
      action: args.action,
      current_epic: "epic-1",
      current_story: args.story_id || "unknown",
      status: args.new_status || "backlog",
      stories_completed: 0,
      stories_total: 0,
    };
  },
};

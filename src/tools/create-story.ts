import type { BmadToolDefinition } from "./types.js";

/**
 * create-story tool — BMAD story creation workflow.
 *
 * Called by the PM agent to generate a comprehensive story file
 * from the sprint backlog.
 *
 * TODO (Phase 3): Implement handler with actual file generation.
 */
export const createStoryTool: BmadToolDefinition = {
  name: "create_story",
  description:
    "Generate a comprehensive user story file with acceptance criteria, tasks, subtasks, and developer notes from the sprint backlog. Moves story status from 'backlog' to 'ready-for-dev'.",
  parameters: {
    type: "object",
    properties: {
      epic_id: {
        type: "string",
        description: "The epic identifier (e.g., 'epic-1')",
      },
      story_id: {
        type: "string",
        description:
          "The story identifier (e.g., '1-3-owner-registration')",
      },
      story_title: {
        type: "string",
        description: "Human-readable story title",
      },
      story_description: {
        type: "string",
        description: "Brief description of what the story delivers",
      },
    },
    required: ["epic_id", "story_id", "story_title"],
  },
  handler: async (args) => {
    // TODO: Phase 3 — Implement story file generation
    // 1. Read architecture docs and existing stories for context
    // 2. Generate story file with ACs, tasks, subtasks
    // 3. Write to _bmad-output/stories/{story_id}.md
    // 4. Update sprint-status.yaml: backlog → ready-for-dev
    console.log(`[create_story] Creating story: ${args.story_id}`);
    return {
      status: "created",
      story_id: args.story_id,
      file_path: `_bmad-output/stories/${args.story_id}.md`,
      new_status: "ready-for-dev",
    };
  },
};

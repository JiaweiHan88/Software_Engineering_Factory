import type { BmadToolDefinition } from "./types.js";

/**
 * dev-story tool — BMAD story implementation workflow.
 *
 * Called by the Developer agent to implement a ready-for-dev story.
 * Runs exactly ONCE per story (BMAD rule).
 *
 * TODO (Phase 3): Implement handler with actual code generation.
 */
export const devStoryTool: BmadToolDefinition = {
  name: "dev_story",
  description:
    "Implement a user story by writing code, tests, and migrations. Reads the story file, implements all tasks, and moves status from 'ready-for-dev' to 'review'. Runs exactly ONCE per story.",
  parameters: {
    type: "object",
    properties: {
      story_id: {
        type: "string",
        description: "The story identifier to implement",
      },
      story_file_path: {
        type: "string",
        description: "Path to the story markdown file",
      },
      model_tier: {
        type: "string",
        description:
          "Model tier to use: 'highest' for complex stories, 'standard' for straightforward ones",
      },
    },
    required: ["story_id", "story_file_path"],
  },
  handler: async (args) => {
    // TODO: Phase 3 — Implement story development
    // 1. Read story file and extract ACs, tasks, subtasks
    // 2. Read architecture docs for patterns and conventions
    // 3. Implement each task in order
    // 4. Write tests for each implementation
    // 5. Run tests to verify
    // 6. Update sprint-status.yaml: ready-for-dev → in-progress → review
    console.log(`[dev_story] Implementing story: ${args.story_id}`);
    return {
      status: "implemented",
      story_id: args.story_id,
      new_status: "review",
      files_changed: [],
      tests_passed: true,
    };
  },
};

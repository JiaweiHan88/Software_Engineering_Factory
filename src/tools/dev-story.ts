/**
 * dev-story tool — BMAD story implementation workflow.
 *
 * Called by the Developer agent to implement a ready-for-dev story.
 * BMAD rule: dev-story runs exactly ONCE per story.
 *
 * This tool reads the story markdown, marks it as in-progress,
 * and instructs the LLM to implement the tasks. The actual code generation
 * is done by the Copilot session's built-in tools (read_file, write_file, etc.)
 * — this tool handles the lifecycle bookkeeping.
 *
 * @module tools/dev-story
 */

import { readFile } from "node:fs/promises";
import { z } from "zod";
import { defineTool } from "./types.js";
import { loadConfig } from "../config/index.js";
import { readSprintStatus, writeSprintStatus } from "./sprint-status.js";

/**
 * Copilot SDK tool: dev_story
 *
 * Reads the story file, transitions status to 'in-progress', and returns
 * the full story content so the LLM agent can implement it using built-in tools.
 * When implementation is complete, call sprint_status to move to 'review'.
 */
export const devStoryTool = defineTool("dev_story", {
  description:
    "Begin implementing a BMAD user story. Reads the story file, transitions status to 'in-progress', " +
    "and returns the story content (acceptance criteria, tasks, developer notes) for the developer agent " +
    "to implement. BMAD rule: dev_story runs exactly ONCE per story. " +
    "After completing implementation, use sprint_status tool to move the story to 'review'.",
  parameters: z.object({
    story_id: z
      .string()
      .describe("The story identifier to implement (e.g., 'STORY-001')"),
    story_file_path: z
      .string()
      .describe("Absolute or relative path to the story markdown file"),
  }),
  handler: async (args) => {
    const config = loadConfig();

    // 1. Verify story is in the right status
    const sprintData = await readSprintStatus(config.sprintStatusPath);
    const story = sprintData.sprint.stories.find((s) => s.id === args.story_id);

    if (!story) {
      return {
        textResultForLlm: `Error: Story ${args.story_id} not found in sprint-status.yaml. Use sprint_status tool to check available stories.`,
        resultType: "failure" as const,
      };
    }

    if (story.status === "in-progress") {
      return {
        textResultForLlm: `Error: Story ${args.story_id} is already in-progress. BMAD rule: dev_story runs exactly ONCE per story. If you need to continue, read the story file directly.`,
        resultType: "failure" as const,
      };
    }

    if (story.status === "review" || story.status === "done") {
      return {
        textResultForLlm: `Error: Story ${args.story_id} has status '${story.status}' — it has already been implemented.`,
        resultType: "failure" as const,
      };
    }

    // 2. Read the story file
    let storyContent: string;
    try {
      storyContent = await readFile(args.story_file_path, "utf-8");
    } catch {
      return {
        textResultForLlm: `Error: Could not read story file at '${args.story_file_path}'. Verify the path is correct.`,
        resultType: "failure" as const,
      };
    }

    // 3. Transition to in-progress
    story.status = "in-progress";
    story.assigned = "bmad-developer";
    await writeSprintStatus(config.sprintStatusPath, sprintData);

    // 4. Return story content for the LLM to implement
    return {
      textResultForLlm: [
        `=== DEV-STORY: ${args.story_id} ===`,
        `Status transitioned: ready-for-dev → in-progress`,
        `Assigned to: bmad-developer`,
        ``,
        `INSTRUCTIONS: Implement ALL tasks and acceptance criteria below.`,
        `After implementation, use sprint_status tool to update status to 'review'.`,
        ``,
        `--- STORY CONTENT ---`,
        storyContent,
        `--- END STORY CONTENT ---`,
      ].join("\n"),
      resultType: "success" as const,
    };
  },
});


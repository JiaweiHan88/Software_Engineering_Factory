/**
 * create-story tool — BMAD story creation workflow.
 *
 * Called by the PM agent to generate a comprehensive story markdown file
 * and register it in the sprint tracker.
 *
 * @module tools/create-story
 */

import { writeFile, mkdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { z } from "zod";
import { defineTool } from "./types.js";
import { loadConfig } from "../config/index.js";
import { readSprintStatus, writeSprintStatus } from "./sprint-status.js";

/**
 * Generate a BMAD story markdown template.
 */
function generateStoryMarkdown(args: {
  storyId: string;
  storyTitle: string;
  storyDescription: string;
  epicId: string;
}): string {
  return `# ${args.storyTitle}

**Story ID:** ${args.storyId}
**Epic:** ${args.epicId}
**Status:** ready-for-dev

## Description

${args.storyDescription}

## Acceptance Criteria

<!-- PM: Fill in acceptance criteria -->
- [ ] AC-1: (describe expected behavior)
- [ ] AC-2: (describe expected behavior)
- [ ] AC-3: (describe expected behavior)

## Tasks

<!-- PM: Break down implementation tasks -->
1. **Task 1** — (describe implementation step)
2. **Task 2** — (describe implementation step)
3. **Task 3** — (describe implementation step)

## Developer Notes

- Follow BMAD coding standards (JSDoc, strict types, error handling)
- Write tests for all acceptance criteria
- dev-story runs exactly ONCE — ensure completeness

## Review Checklist

- [ ] All ACs verified
- [ ] Tests pass
- [ ] No HIGH/CRITICAL code review findings
- [ ] JSDoc on public APIs
`;
}

/**
 * Copilot SDK tool: create_story
 *
 * Generates a story markdown file and adds it to the sprint tracker
 * with status 'ready-for-dev'.
 */
export const createStoryTool = defineTool("create_story", {
  description:
    "Create a new BMAD user story file with acceptance criteria, tasks, and developer notes. " +
    "Writes the story to _bmad-output/stories/{story_id}.md and registers it in sprint-status.yaml " +
    "with status 'ready-for-dev'.",
  parameters: z.object({
    epic_id: z
      .string()
      .describe("The epic identifier (e.g., 'epic-1')"),
    story_id: z
      .string()
      .describe("The story identifier (e.g., 'STORY-001')"),
    story_title: z
      .string()
      .describe("Human-readable story title"),
    story_description: z
      .string()
      .default("No description provided.")
      .describe("Brief description of what the story delivers"),
  }),
  handler: async (args) => {
    const config = loadConfig();
    const storyDir = resolve(config.outputDir, "stories");
    const storyPath = resolve(storyDir, `${args.story_id}.md`);

    // 1. Generate story markdown
    const markdown = generateStoryMarkdown({
      storyId: args.story_id,
      storyTitle: args.story_title,
      storyDescription: args.story_description,
      epicId: args.epic_id,
    });

    // 2. Write story file
    await mkdir(dirname(storyPath), { recursive: true });
    await writeFile(storyPath, markdown, "utf-8");

    // 3. Register in sprint-status.yaml
    const sprintData = await readSprintStatus(config.sprintStatusPath);
    const existing = sprintData.sprint.stories.find((s) => s.id === args.story_id);
    if (!existing) {
      sprintData.sprint.stories.push({
        id: args.story_id,
        title: args.story_title,
        status: "ready-for-dev",
        reviewPasses: 0,
      });
      await writeSprintStatus(config.sprintStatusPath, sprintData);
    }

    return {
      textResultForLlm: [
        `Story created: ${args.story_id} — "${args.story_title}"`,
        `File: ${storyPath}`,
        `Sprint status: registered as 'ready-for-dev' in sprint ${sprintData.sprint.number}`,
        `Next step: Developer agent should run dev_story tool to implement this story.`,
      ].join("\n"),
      resultType: "success" as const,
    };
  },
});


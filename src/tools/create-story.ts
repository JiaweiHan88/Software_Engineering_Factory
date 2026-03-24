/**
 * create-story tool — BMAD story creation workflow (Paperclip-backed).
 *
 * Called by the PM/SM agent to generate a comprehensive story markdown file,
 * write it to the workspace, and create a corresponding Paperclip issue.
 *
 * Migration: Now creates a Paperclip issue in addition to the workspace
 * file. The issue status starts as 'backlog' — the CEO promotes to 'todo'
 * when ready (sequential story promotion in M1).
 *
 * @module tools/create-story
 */

import { writeFile, mkdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { z } from "zod";
import { defineTool } from "./types.js";
import { tryGetToolContext } from "./tool-context.js";
import { loadConfig } from "../config/index.js";

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
**Status:** backlog

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
 * Generates a story markdown file, writes it to the workspace, and creates
 * a corresponding Paperclip issue with status 'backlog'. The CEO will promote
 * stories to 'todo' sequentially when ready.
 */
export const createStoryTool = defineTool("create_story", {
  description:
    "Create a new BMAD user story file with acceptance criteria, tasks, and developer notes. " +
    "Writes the story to _bmad-output/stories/{story_id}.md and creates a corresponding " +
    "Paperclip issue with status 'backlog'. The CEO will promote stories to 'todo' when ready.",
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
    story_sequence: z
      .number()
      .optional()
      .describe("Sequence number within the epic for ordering (e.g., 1, 2, 3)"),
  }),
  handler: async (args) => {
    const config = loadConfig();
    const ctx = tryGetToolContext();
    const storyDir = resolve(config.outputDir, "stories");
    const storyRelativePath = `_bmad-output/stories/${args.story_id}.md`;
    const storyPath = resolve(storyDir, `${args.story_id}.md`);

    // 1. Generate story markdown
    const markdown = generateStoryMarkdown({
      storyId: args.story_id,
      storyTitle: args.story_title,
      storyDescription: args.story_description,
      epicId: args.epic_id,
    });

    // 2. Write story file to workspace
    await mkdir(dirname(storyPath), { recursive: true });
    await writeFile(storyPath, markdown, "utf-8");

    // 3. Create Paperclip issue (if tool context is available)
    let paperclipIssueId: string | undefined;
    let paperclipIdentifier: string | undefined;

    if (ctx) {
      try {
        const parentIssueId = ctx.parentIssueId ?? ctx.issueId;
        const issue = await ctx.paperclipClient.createIssue({
          title: args.story_title,
          description: [
            args.story_description,
            ``,
            `---`,
            `*Story ID: ${args.story_id} | Epic: ${args.epic_id}*`,
            `*Story file: \`${storyRelativePath}\`*`,
          ].join("\n"),
          status: "backlog",
          parentId: parentIssueId,
          metadata: {
            bmadPhase: "execute",
            storyId: args.story_id,
            storyFilePath: storyRelativePath,
            epicId: args.epic_id,
            storySequence: args.story_sequence ?? 0,
            workPhase: "dev-story",
            reviewPasses: 0,
          },
        });

        paperclipIssueId = issue.id;
        paperclipIdentifier = issue.identifier;
      } catch (err) {
        // Non-fatal — the story file was already written to the workspace
        const errMsg = err instanceof Error ? err.message : String(err);
        return {
          textResultForLlm: [
            `Story file created: ${args.story_id} — "${args.story_title}"`,
            `File: ${storyPath}`,
            `⚠️ Paperclip issue creation failed: ${errMsg}`,
            `The story file exists in the workspace but is not tracked in Paperclip.`,
          ].join("\n"),
          resultType: "success" as const,
        };
      }
    }

    return {
      textResultForLlm: [
        `Story created: ${args.story_id} — "${args.story_title}"`,
        `File: ${storyPath}`,
        paperclipIssueId
          ? `Paperclip issue: ${paperclipIdentifier ?? paperclipIssueId} (status: backlog)`
          : `Note: No Paperclip context — story file created locally only.`,
        `Next step: CEO will promote this story to 'todo' when ready for implementation.`,
      ].join("\n"),
      resultType: "success" as const,
    };
  },
});


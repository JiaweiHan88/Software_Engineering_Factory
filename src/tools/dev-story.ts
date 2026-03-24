/**
 * dev-story tool — BMAD story implementation workflow (Paperclip-backed).
 *
 * Called by the Developer agent to implement a story.
 * BMAD rule: dev-story runs exactly ONCE per story.
 *
 * This tool reads the story markdown from the workspace, verifies the
 * issue status via Paperclip, and returns the story content for the
 * LLM agent to implement using built-in tools (read_file, write_file, etc.).
 *
 * Migration: Replaces YAML-based sprint-status.yaml tracking with
 * Paperclip issue state. The issue is already in_progress from checkout.
 *
 * @module tools/dev-story
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import { defineTool } from "./types.js";
import { tryGetToolContext } from "./tool-context.js";
import { loadConfig } from "../config/index.js";

/**
 * Copilot SDK tool: dev_story
 *
 * Reads the story file and returns the full story content so the LLM agent
 * can implement it using built-in tools. The issue is already checked out
 * and in_progress via Paperclip — no status transition needed.
 *
 * When implementation is complete, the agent should reassign the issue to
 * bmad-qa using the issue_status tool for code review.
 */
export const devStoryTool = defineTool("dev_story", {
  description:
    "Begin implementing a BMAD user story. Reads the story file and returns " +
    "the story content (acceptance criteria, tasks, developer notes) for the developer agent " +
    "to implement. BMAD rule: dev_story runs exactly ONCE per story. " +
    "After completing implementation, use issue_status tool with action='reassign' " +
    "to reassign the issue to bmad-qa for code review.",
  parameters: z.object({
    story_id: z
      .string()
      .optional()
      .describe("The story identifier (e.g., 'STORY-001'). Auto-resolved from tool context if omitted."),
    story_file_path: z
      .string()
      .optional()
      .describe("Path to the story markdown file. Auto-resolved from issue metadata if omitted."),
  }),
  handler: async (args) => {
    const ctx = tryGetToolContext();
    const config = loadConfig();

    // Resolve story ID from tool context or args
    const storyId = args.story_id ?? (ctx?.issueId ? `issue-${ctx.issueId.slice(0, 8)}` : undefined);

    if (!storyId && !args.story_file_path) {
      return {
        textResultForLlm: "Error: story_id or story_file_path is required. " +
          "No tool context available — provide at least one parameter.",
        resultType: "failure" as const,
      };
    }

    // Resolve story file path from:
    // 1. Explicit parameter
    // 2. Issue metadata.storyFilePath (set by create_story)
    // 3. Default convention: _bmad-output/stories/{story_id}.md
    let storyFilePath = args.story_file_path;

    if (!storyFilePath && ctx) {
      try {
        const issue = await ctx.paperclipClient.getIssue(ctx.issueId);
        const meta = issue.metadata as Record<string, unknown> | undefined;

        // Verify issue is in an actionable status
        const actionableStatuses = new Set(["todo", "in_progress", "in-progress"]);
        if (!actionableStatuses.has(issue.status)) {
          return {
            textResultForLlm: `Error: Issue "${issue.title}" has status '${issue.status}' — ` +
              `expected 'todo' or 'in_progress'. It may have already been implemented.`,
            resultType: "failure" as const,
          };
        }

        // Resolve story file path from metadata
        if (meta?.storyFilePath) {
          storyFilePath = resolve(ctx.workspaceDir, String(meta.storyFilePath));
        }
      } catch (err) {
        return {
          textResultForLlm: `Error: Failed to read issue from Paperclip: ${err instanceof Error ? err.message : String(err)}`,
          resultType: "failure" as const,
        };
      }
    }

    // Fallback to conventional path
    if (!storyFilePath && storyId) {
      storyFilePath = resolve(config.outputDir, "stories", `${storyId}.md`);
    }

    if (!storyFilePath) {
      return {
        textResultForLlm: "Error: Could not determine story file path. " +
          "Provide story_file_path parameter or ensure issue metadata contains storyFilePath.",
        resultType: "failure" as const,
      };
    }

    // Read the story file
    let storyContent: string;
    try {
      storyContent = await readFile(storyFilePath, "utf-8");
    } catch {
      return {
        textResultForLlm: `Error: Could not read story file at '${storyFilePath}'. Verify the path is correct.`,
        resultType: "failure" as const,
      };
    }

    // Build response — no status write needed (Paperclip checkout already set in_progress)
    const resolvedStoryId = args.story_id ?? storyId ?? "unknown";

    return {
      textResultForLlm: [
        `=== DEV-STORY: ${resolvedStoryId} ===`,
        `Status: in-progress (via Paperclip checkout)`,
        ``,
        `INSTRUCTIONS: Implement ALL tasks and acceptance criteria below.`,
        `After completing implementation, use issue_status tool with action='reassign'`,
        `and target_role='bmad-qa' to hand off for code review.`,
        ``,
        `--- STORY CONTENT ---`,
        storyContent,
        `--- END STORY CONTENT ---`,
      ].join("\n"),
      resultType: "success" as const,
    };
  },
});


/**
 * code-review tool — BMAD adversarial code review workflow.
 *
 * Called by the Code Reviewer agent. Performs lifecycle bookkeeping:
 * - Verifies story is in 'review' status
 * - Tracks review pass count (max 3)
 * - Returns story + file list for the LLM to review
 * - On pass: moves story to 'done'
 * - On fail after 3 passes: escalates to human
 *
 * The actual code analysis is done by the LLM using built-in tools.
 * This tool manages the review lifecycle.
 *
 * @module tools/code-review
 */

import { readFile } from "node:fs/promises";
import { z } from "zod";
import { defineTool } from "./types.js";
import { loadConfig } from "../config/index.js";
import { readSprintStatus, writeSprintStatus } from "./sprint-status.js";

/**
 * Copilot SDK tool: code_review
 *
 * Initiates a review pass. The agent should then:
 * 1. Read and analyze the files listed
 * 2. Rate issues by severity (LOW/MEDIUM/HIGH/CRITICAL)
 * 3. Call code_review_result to record the outcome
 */
export const codeReviewTool = defineTool("code_review", {
  description:
    "Initiate a code review pass for a BMAD story. Returns the story content and file list " +
    "for the Code Reviewer agent to analyze. After reviewing, use code_review_result to record " +
    "the outcome. Max 3 review passes — escalates to human after that.",
  parameters: z.object({
    story_id: z
      .string()
      .describe("The story identifier to review (e.g., 'STORY-001')"),
    story_file_path: z
      .string()
      .describe("Path to the story markdown file"),
    files_to_review: z
      .string()
      .describe("Comma-separated list of file paths changed by dev_story"),
  }),
  handler: async (args) => {
    const config = loadConfig();
    const sprintData = await readSprintStatus(config.sprintStatusPath);
    const story = sprintData.sprint.stories.find((s) => s.id === args.story_id);

    if (!story) {
      return {
        textResultForLlm: `Error: Story ${args.story_id} not found in sprint-status.yaml.`,
        resultType: "failure" as const,
      };
    }

    if (story.status !== "review") {
      return {
        textResultForLlm: `Error: Story ${args.story_id} has status '${story.status}'. Expected 'review'.`,
        resultType: "failure" as const,
      };
    }

    const currentPass = (story.reviewPasses ?? 0) + 1;
    if (currentPass > config.reviewPassLimit) {
      return {
        textResultForLlm: [
          `⚠️ ESCALATION: Story ${args.story_id} has exceeded ${config.reviewPassLimit} review passes.`,
          `This story requires human intervention. Please review manually.`,
          `Review history: ${story.reviewPasses} passes completed.`,
        ].join("\n"),
        resultType: "failure" as const,
      };
    }

    // Read story file
    let storyContent: string;
    try {
      storyContent = await readFile(args.story_file_path, "utf-8");
    } catch {
      return {
        textResultForLlm: `Error: Could not read story file at '${args.story_file_path}'.`,
        resultType: "failure" as const,
      };
    }

    // Update review pass counter
    story.reviewPasses = currentPass;
    story.assigned = "bmad-code-reviewer";
    await writeSprintStatus(config.sprintStatusPath, sprintData);

    const fileList = args.files_to_review.split(",").map((f) => f.trim()).filter(Boolean);

    return {
      textResultForLlm: [
        `=== CODE REVIEW: ${args.story_id} (Pass ${currentPass}/${config.reviewPassLimit}) ===`,
        ``,
        `REVIEW PROTOCOL:`,
        `1. Read each file listed below`,
        `2. Check against story acceptance criteria`,
        `3. Rate each finding: LOW / MEDIUM / HIGH / CRITICAL`,
        `4. If HIGH/CRITICAL found → fix in-place, then call code_review_result with approved=false`,
        `5. If all clean → call code_review_result with approved=true`,
        ``,
        `FILES TO REVIEW (${fileList.length}):`,
        ...fileList.map((f) => `  • ${f}`),
        ``,
        `--- STORY CONTENT ---`,
        storyContent,
        `--- END STORY CONTENT ---`,
      ].join("\n"),
      resultType: "success" as const,
    };
  },
});

/**
 * Copilot SDK tool: code_review_result
 *
 * Records the outcome of a code review pass and transitions the story accordingly.
 */
export const codeReviewResultTool = defineTool("code_review_result", {
  description:
    "Record the result of a code review pass. If approved, moves story to 'done'. " +
    "If rejected with HIGH/CRITICAL findings, keeps in 'review' for the next pass. " +
    "If max passes exceeded, escalates to human.",
  parameters: z.object({
    story_id: z
      .string()
      .describe("The story identifier that was reviewed"),
    approved: z
      .boolean()
      .describe("Whether the code review passed (true) or found blocking issues (false)"),
    findings_summary: z
      .string()
      .describe("Summary of review findings and severity ratings"),
    high_critical_count: z
      .number()
      .default(0)
      .describe("Number of HIGH or CRITICAL severity findings"),
  }),
  handler: async (args) => {
    const config = loadConfig();
    const sprintData = await readSprintStatus(config.sprintStatusPath);
    const story = sprintData.sprint.stories.find((s) => s.id === args.story_id);

    if (!story) {
      return {
        textResultForLlm: `Error: Story ${args.story_id} not found.`,
        resultType: "failure" as const,
      };
    }

    if (args.approved) {
      story.status = "done";
      story.assigned = undefined;
      await writeSprintStatus(config.sprintStatusPath, sprintData);
      return {
        textResultForLlm: [
          `✅ Story ${args.story_id} APPROVED on pass ${story.reviewPasses}/${config.reviewPassLimit}.`,
          `Status: review → done`,
          `Findings: ${args.findings_summary}`,
        ].join("\n"),
        resultType: "success" as const,
      };
    }

    // Not approved
    const passesUsed = story.reviewPasses ?? 0;
    if (passesUsed >= config.reviewPassLimit) {
      return {
        textResultForLlm: [
          `⚠️ ESCALATION: Story ${args.story_id} REJECTED after ${passesUsed} passes.`,
          `HIGH/CRITICAL findings: ${args.high_critical_count}`,
          `Summary: ${args.findings_summary}`,
          `Action required: Human review needed.`,
        ].join("\n"),
        resultType: "failure" as const,
      };
    }

    await writeSprintStatus(config.sprintStatusPath, sprintData);
    return {
      textResultForLlm: [
        `❌ Story ${args.story_id} REJECTED on pass ${passesUsed}/${config.reviewPassLimit}.`,
        `HIGH/CRITICAL findings: ${args.high_critical_count}`,
        `Summary: ${args.findings_summary}`,
        `Next step: Fix the issues, then run code_review again for pass ${passesUsed + 1}.`,
      ].join("\n"),
      resultType: "success" as const,
    };
  },
});


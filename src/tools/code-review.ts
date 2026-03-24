/**
 * code-review tool — BMAD adversarial code review workflow (Paperclip-backed).
 *
 * Called by the Code Reviewer agent. Performs lifecycle bookkeeping:
 * - Verifies story is in the correct status via Paperclip issue
 * - Tracks review pass count via issue metadata
 * - Returns story + file list for the LLM to review
 * - On pass: updates issue status to 'done' (auto-wakes CEO)
 * - On fail after max passes: escalates to CEO via parent issue comment
 *
 * The actual code analysis is done by the LLM using built-in tools.
 * This tool manages the review lifecycle.
 *
 * Migration: Replaces YAML-based sprint-status.yaml tracking with
 * Paperclip issue metadata for review pass tracking.
 *
 * @module tools/code-review
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import { defineTool } from "./types.js";
import { tryGetToolContext } from "./tool-context.js";
import { loadConfig } from "../config/index.js";

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
    "the outcome. Max 3 review passes — escalates to CEO after that.",
  parameters: z.object({
    story_id: z
      .string()
      .optional()
      .describe("The story identifier to review. Auto-resolved from tool context if omitted."),
    story_file_path: z
      .string()
      .optional()
      .describe("Path to the story markdown file. Auto-resolved from issue metadata if omitted."),
    files_to_review: z
      .string()
      .describe("Comma-separated list of file paths changed by dev_story"),
  }),
  handler: async (args) => {
    const ctx = tryGetToolContext();
    const config = loadConfig();
    const storyId = args.story_id ?? (ctx?.issueId ? `issue-${ctx.issueId.slice(0, 8)}` : "unknown");

    // Resolve review pass count from Paperclip issue metadata
    let currentPass = 1;
    let storyFilePath = args.story_file_path;

    if (ctx) {
      try {
        const issue = await ctx.paperclipClient.getIssue(ctx.issueId);
        const meta = issue.metadata as Record<string, unknown> | undefined;

        // Read review passes from issue metadata
        const existingPasses = typeof meta?.reviewPasses === "number" ? meta.reviewPasses : 0;
        currentPass = existingPasses + 1;

        // Check pass limit
        if (currentPass > config.reviewPassLimit) {
          return {
            textResultForLlm: [
              `⚠️ ESCALATION: Story ${storyId} has exceeded ${config.reviewPassLimit} review passes.`,
              `This story requires CEO intervention. Escalating to parent issue.`,
              `Review history: ${existingPasses} passes completed.`,
            ].join("\n"),
            resultType: "failure" as const,
          };
        }

        // Resolve story file path from metadata if not provided
        if (!storyFilePath && meta?.storyFilePath) {
          storyFilePath = resolve(ctx.workspaceDir, String(meta.storyFilePath));
        }

        // Update review pass counter in issue metadata
        await ctx.paperclipClient.updateIssue(ctx.issueId, {
          metadata: {
            ...meta,
            reviewPasses: currentPass,
            lastReviewResult: "pending",
          },
        });
      } catch (err) {
        return {
          textResultForLlm: `Error: Failed to access issue from Paperclip: ${err instanceof Error ? err.message : String(err)}`,
          resultType: "failure" as const,
        };
      }
    }

    // Fallback to conventional path
    if (!storyFilePath && args.story_id) {
      storyFilePath = resolve(config.outputDir, "stories", `${args.story_id}.md`);
    }

    // Read story file
    let storyContent = "(Story file not available — review based on source files only)";
    if (storyFilePath) {
      try {
        storyContent = await readFile(storyFilePath, "utf-8");
      } catch {
        // Non-fatal — reviewer can still review the code files
        storyContent = `(Could not read story file at '${storyFilePath}' — review based on source files only)`;
      }
    }

    const fileList = args.files_to_review.split(",").map((f) => f.trim()).filter(Boolean);

    return {
      textResultForLlm: [
        `=== CODE REVIEW: ${storyId} (Pass ${currentPass}/${config.reviewPassLimit}) ===`,
        ``,
        `REVIEW PROTOCOL:`,
        `1. Read each file listed below`,
        `2. Check against story acceptance criteria`,
        `3. Rate each finding: LOW / MEDIUM / HIGH / CRITICAL`,
        `4. Collect ALL findings as structured objects`,
        `5. Call quality_gate_evaluate with your findings array for a formal verdict`,
        `   (Alternatively: call code_review_result for simple approved/rejected flow)`,
        ``,
        `FINDING FORMAT for quality_gate_evaluate:`,
        `  { id: "F-001", severity: "HIGH", category: "correctness",`,
        `    file_path: "src/foo.ts", line: 42, title: "Missing null check",`,
        `    description: "The function does not check for null input...",`,
        `    suggested_fix: "Add an early return if input is null", fixed: false }`,
        ``,
        `SEVERITY GUIDE:`,
        `  LOW     — Style nit, optional improvement (does NOT block)`,
        `  MEDIUM  — Code smell, minor bug risk (does NOT block)`,
        `  HIGH    — Bug, security issue, missing error handling (BLOCKS merge)`,
        `  CRITICAL — Data loss, auth bypass, crash (BLOCKS merge)`,
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
 * Records the outcome of a code review pass. If approved, updates issue
 * status to 'done' (Paperclip auto-wakes CEO). If rejected and passes
 * remain, reassigns to Dev for fixes. If max passes exceeded, escalates
 * to CEO via parent issue comment.
 */
export const codeReviewResultTool = defineTool("code_review_result", {
  description:
    "Record the result of a code review pass. If approved, marks issue as 'done' " +
    "(Paperclip auto-wakes CEO for re-evaluation). If rejected with HIGH/CRITICAL findings " +
    "and passes remain, the developer should fix and resubmit. " +
    "If max passes exceeded, escalates to CEO.",
  parameters: z.object({
    story_id: z
      .string()
      .optional()
      .describe("The story identifier that was reviewed. Auto-resolved from tool context if omitted."),
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
    const ctx = tryGetToolContext();
    const config = loadConfig();
    const storyId = args.story_id ?? (ctx?.issueId ? `issue-${ctx.issueId.slice(0, 8)}` : "unknown");

    // Read current pass count from Paperclip issue metadata
    let passesUsed = 0;

    if (ctx) {
      try {
        const issue = await ctx.paperclipClient.getIssue(ctx.issueId);
        const meta = issue.metadata as Record<string, unknown> | undefined;
        passesUsed = typeof meta?.reviewPasses === "number" ? meta.reviewPasses : 0;

        if (args.approved) {
          // Update issue metadata with approval
          await ctx.paperclipClient.updateIssue(ctx.issueId, {
            status: "done",
            metadata: {
              ...meta,
              lastReviewResult: "pass",
              lastReviewFindings: args.findings_summary.slice(0, 500),
            },
          });

          return {
            textResultForLlm: [
              `✅ Story ${storyId} APPROVED on pass ${passesUsed}/${config.reviewPassLimit}.`,
              `Status: → done (Paperclip will auto-wake CEO for re-evaluation)`,
              `Findings: ${args.findings_summary}`,
            ].join("\n"),
            resultType: "success" as const,
          };
        }

        // Not approved — check pass limit
        if (passesUsed >= config.reviewPassLimit) {
          // Escalate to CEO via parent issue comment
          const parentId = meta?.parentIssueId as string | undefined;
          if (parentId) {
            await ctx.paperclipClient.addIssueComment(
              parentId,
              `⚠️ **ESCALATION**: Story "${issue.title}" (${storyId}) REJECTED after ${passesUsed} review passes.\n` +
              `HIGH/CRITICAL findings: ${args.high_critical_count}\n` +
              `Summary: ${args.findings_summary}\n` +
              `CEO action needed: force-approve, reassign, or investigate.`,
            );
          }

          // Update metadata
          await ctx.paperclipClient.updateIssue(ctx.issueId, {
            metadata: {
              ...meta,
              lastReviewResult: "escalated",
              lastReviewFindings: args.findings_summary.slice(0, 500),
            },
          });

          return {
            textResultForLlm: [
              `⚠️ ESCALATION: Story ${storyId} REJECTED after ${passesUsed} passes.`,
              `HIGH/CRITICAL findings: ${args.high_critical_count}`,
              `Summary: ${args.findings_summary}`,
              `Action: Escalated to CEO via parent issue comment.`,
            ].join("\n"),
            resultType: "failure" as const,
          };
        }

        // Rejected but passes remain — update metadata
        await ctx.paperclipClient.updateIssue(ctx.issueId, {
          metadata: {
            ...meta,
            lastReviewResult: "fail",
            lastReviewFindings: args.findings_summary.slice(0, 500),
          },
        });

        return {
          textResultForLlm: [
            `❌ Story ${storyId} REJECTED on pass ${passesUsed}/${config.reviewPassLimit}.`,
            `HIGH/CRITICAL findings: ${args.high_critical_count}`,
            `Summary: ${args.findings_summary}`,
            `Next step: Use issue_status tool with action='reassign' and target_role='bmad-dev'`,
            `to send back for fixes. Then re-review on the next pass.`,
          ].join("\n"),
          resultType: "success" as const,
        };
      } catch (err) {
        return {
          textResultForLlm: `Error: Failed to update issue in Paperclip: ${err instanceof Error ? err.message : String(err)}`,
          resultType: "failure" as const,
        };
      }
    }

    // Fallback: no tool context (legacy mode)
    if (args.approved) {
      return {
        textResultForLlm: [
          `✅ Story ${storyId} APPROVED (no Paperclip context — manual status update needed).`,
          `Findings: ${args.findings_summary}`,
        ].join("\n"),
        resultType: "success" as const,
      };
    }

    return {
      textResultForLlm: [
        `❌ Story ${storyId} REJECTED (no Paperclip context — manual follow-up needed).`,
        `HIGH/CRITICAL findings: ${args.high_critical_count}`,
        `Summary: ${args.findings_summary}`,
      ].join("\n"),
      resultType: "success" as const,
    };
  },
});


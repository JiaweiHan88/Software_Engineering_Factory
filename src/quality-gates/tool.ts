/**
 * quality_gate_evaluate tool — Copilot SDK tool for quality gate evaluation.
 *
 * Called by the Code Reviewer agent after analyzing files. Accepts structured
 * findings and runs them through the quality gate engine to produce a verdict.
 *
 * This tool replaces the simple approved/rejected flow in code_review_result
 * with a proper gate evaluation that tracks findings, computes severity scores,
 * and determines the correct next action.
 *
 * @module quality-gates/tool
 */

import { z } from "zod";
import { defineTool } from "../tools/types.js";
import { loadConfig } from "../config/index.js";
import { tryGetToolContext } from "../tools/tool-context.js";
import { evaluateGate, formatGateReport } from "./engine.js";
import { loadReviewHistory, saveReviewHistory } from "./review-orchestrator.js";
import type { ReviewFinding, FindingCategory, Severity } from "./types.js";

/**
 * Zod schema for a single finding submitted by the reviewer agent.
 */
const findingSchema = z.object({
  id: z.string().describe("Finding ID (e.g., 'F-001')"),
  severity: z
    .enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"])
    .describe("Severity rating"),
  category: z
    .enum([
      "correctness",
      "security",
      "performance",
      "error-handling",
      "type-safety",
      "maintainability",
      "testing",
      "documentation",
      "style",
    ])
    .describe("Finding category"),
  file_path: z.string().describe("File where the issue was found"),
  line: z.number().optional().describe("Line number (1-based, approximate)"),
  title: z.string().describe("Short description of the issue"),
  description: z.string().describe("Detailed explanation of the problem"),
  suggested_fix: z
    .string()
    .optional()
    .describe("Suggested fix (code or prose)"),
  fixed: z
    .boolean()
    .optional()
    .default(false)
    .describe("Whether the reviewer already fixed this in-place"),
});

/**
 * Copilot SDK tool: quality_gate_evaluate
 *
 * Evaluates code review findings against BMAD quality gates.
 * Returns a structured verdict with severity scores and next-step guidance.
 */
export const qualityGateEvaluateTool = defineTool("quality_gate_evaluate", {
  description:
    "Evaluate code review findings against BMAD quality gates. Submit all findings from your review " +
    "and receive a verdict (PASS/FAIL/ESCALATE) with severity scores. " +
    "Use this INSTEAD of code_review_result for structured quality gate enforcement. " +
    "PASS = story moves to done. FAIL = blocking issues need fixing, then re-review. " +
    "ESCALATE = max review passes exceeded, needs human intervention.",
  parameters: z.object({
    story_id: z.string().describe("The story identifier under review"),
    findings: z
      .array(findingSchema)
      .describe("Array of structured findings from the code review"),
    reviewer_notes: z
      .string()
      .optional()
      .describe("General notes from the reviewer about code quality"),
  }),
  handler: async (args) => {
    const config = loadConfig();
    const ctx = tryGetToolContext();

    // Validate story is in a reviewable state via Paperclip
    if (ctx) {
      try {
        const issue = await ctx.paperclipClient.getIssue(ctx.issueId);
        const meta = issue.metadata as Record<string, unknown> | undefined;

        // Warn if storyId in args doesn't match the checked-out issue
        if (meta?.storyId && meta.storyId !== args.story_id) {
          return {
            textResultForLlm: `Error: story_id "${args.story_id}" does not match checked-out issue storyId "${meta.storyId}". Verify you are reviewing the correct story.`,
            resultType: "failure" as const,
          };
        }

        const actionableStatuses = new Set(["review", "in_progress", "in-progress", "todo"]);
        if (!actionableStatuses.has(issue.status)) {
          return {
            textResultForLlm: `Error: Issue "${issue.title}" has status '${issue.status}'. Quality gate evaluation expects 'review' or 'in_progress' status.`,
            resultType: "failure" as const,
          };
        }
      } catch (err) {
        return {
          textResultForLlm: `Error: Failed to read issue from Paperclip: ${err instanceof Error ? err.message : String(err)}`,
          resultType: "failure" as const,
        };
      }
    } else {
      return {
        textResultForLlm: `Error: No Paperclip tool context available. quality_gate_evaluate requires a heartbeat context with an active issue checkout.`,
        resultType: "failure" as const,
      };
    }

    // Convert tool findings to internal format
    const findings: ReviewFinding[] = args.findings.map((f) => ({
      id: f.id,
      severity: f.severity as Severity,
      category: f.category as FindingCategory,
      filePath: f.file_path,
      line: f.line,
      title: f.title,
      description: f.description,
      suggestedFix: f.suggested_fix,
      fixed: f.fixed,
    }));

    // Load review history
    const history = await loadReviewHistory(config, args.story_id);
    const passNumber = history.passes.length + 1;

    // Evaluate gate
    const gateResult = evaluateGate({
      storyId: args.story_id,
      passNumber,
      maxPasses: config.reviewPassLimit,
      findings,
    });

    // Record this pass in history
    history.passes.push({
      passNumber,
      result: gateResult,
      reviewerAgent: "bmad-qa",
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
    });

    // Update issue status via Paperclip based on verdict
    try {
      const currentMeta = ((await ctx.paperclipClient.getIssue(ctx.issueId)).metadata ?? {}) as Record<string, unknown>;
      if (gateResult.verdict === "PASS") {
        await ctx.paperclipClient.updateIssue(ctx.issueId, {
          status: "done",
          metadata: { ...currentMeta, reviewPasses: passNumber, lastReviewVerdict: "PASS" },
        });
        history.status = "approved";
        history.finalVerdict = "PASS";
      } else if (gateResult.verdict === "ESCALATE") {
        history.status = "escalated";
        history.finalVerdict = "ESCALATE";
        history.escalationReason = gateResult.summary;
        await ctx.paperclipClient.updateIssue(ctx.issueId, {
          metadata: { ...currentMeta, reviewPasses: passNumber, lastReviewVerdict: "ESCALATE" },
        });
      } else {
        // FAIL — increment pass count in metadata
        await ctx.paperclipClient.updateIssue(ctx.issueId, {
          metadata: { ...currentMeta, reviewPasses: passNumber, lastReviewVerdict: "FAIL" },
        });
      }
    } catch (err) {
      return {
        textResultForLlm: `Error: Failed to update issue in Paperclip: ${err instanceof Error ? err.message : String(err)}`,
        resultType: "failure" as const,
      };
    }

    await saveReviewHistory(config, history);

    // Build response
    const report = formatGateReport(gateResult);

    const nextSteps =
      gateResult.verdict === "PASS"
        ? "Story moved to 'done'. No further action needed."
        : gateResult.verdict === "ESCALATE"
          ? "Story requires human intervention. Review history saved."
          : [
              `Fix the ${gateResult.blockingCount} blocking finding(s) listed above.`,
              `Then move the story back to 'review' status and run another code review pass.`,
              `Remaining passes: ${config.reviewPassLimit - passNumber}.`,
            ].join(" ");

    return {
      textResultForLlm: [
        report,
        ``,
        `Next steps: ${nextSteps}`,
        args.reviewer_notes ? `\nReviewer notes: ${args.reviewer_notes}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
      resultType: gateResult.verdict === "PASS" ? ("success" as const) : ("failure" as const),
    };
  },
});

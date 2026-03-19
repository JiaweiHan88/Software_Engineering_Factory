import type { BmadToolDefinition } from "./types.js";

/**
 * code-review tool — BMAD adversarial code review workflow.
 *
 * Called by the Code Reviewer agent. Runs up to 3 passes.
 * HIGH/CRITICAL issues are fixed in-place, then re-reviewed.
 *
 * TODO (Phase 3): Implement handler with actual review logic.
 */
export const codeReviewTool: BmadToolDefinition = {
  name: "code_review",
  description:
    "Perform adversarial code review on implemented story. Rate issues by severity (LOW/MEDIUM/HIGH/CRITICAL). Fix HIGH/CRITICAL in-place. Max 3 review passes.",
  parameters: {
    type: "object",
    properties: {
      story_id: {
        type: "string",
        description: "The story identifier to review",
      },
      review_pass: {
        type: "string",
        description: "Current review pass number (1, 2, or 3)",
      },
      files_to_review: {
        type: "string",
        description:
          "Comma-separated list of file paths changed by dev-story",
      },
    },
    required: ["story_id", "review_pass"],
  },
  handler: async (args) => {
    // TODO: Phase 3 — Implement code review
    // 1. Read story file for ACs
    // 2. Read all changed files
    // 3. Review each file against ACs and quality standards
    // 4. Rate issues: LOW / MEDIUM / HIGH / CRITICAL
    // 5. If HIGH/CRITICAL: fix in-place, return needs_re_review=true
    // 6. If clean: return approved=true, advance story to "done"
    // 7. If pass 3: advance regardless
    const pass = Number(args.review_pass) || 1;
    console.log(
      `[code_review] Reviewing story ${args.story_id} (pass ${pass}/3)`
    );
    return {
      status: "reviewed",
      story_id: args.story_id,
      review_pass: pass,
      issues_found: [],
      high_critical_count: 0,
      approved: true,
      needs_re_review: false,
      new_status: "done",
    };
  },
};

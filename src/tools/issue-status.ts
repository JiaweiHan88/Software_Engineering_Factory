/**
 * issue-status tool — Paperclip-backed issue lifecycle management.
 *
 * Replacement for sprint-status.ts. All state is stored in Paperclip issues
 * rather than sprint-status.yaml. Supports read, update, and reassign actions.
 *
 * @module tools/issue-status
 */

import { z } from "zod";
import { defineTool } from "./types.js";
import { tryGetToolContext } from "./tool-context.js";
import { resolveAgentId } from "../adapter/ceo-orchestrator.js";

/**
 * Copilot SDK tool: issue_status
 *
 * Actions:
 * - `read`     — List all child issues of the parent planning issue.
 *                Returns: [{id, title, status, assignee, reviewPasses}]
 * - `update`   — Update a specific issue's status/metadata.
 * - `reassign` — Change assigneeAgentId on an issue (Paperclip auto-wakes the new assignee).
 */
export const issueStatusTool = defineTool("issue_status", {
  description:
    "Read or update Paperclip issue status. " +
    "Use action='read' to list all sibling issues and their statuses. " +
    "Use action='update' to change an issue's status. " +
    "Use action='reassign' to hand off an issue to another agent (triggers auto-wake).",
  parameters: z.object({
    action: z
      .enum(["read", "update", "reassign"])
      .describe("Action to perform on the issue"),
    issue_id: z
      .string()
      .optional()
      .describe("Issue ID to update/reassign. Defaults to current issue from tool context."),
    new_status: z
      .string()
      .optional()
      .describe("New status value for 'update' action (e.g., 'todo', 'done', 'blocked')"),
    target_role: z
      .string()
      .optional()
      .describe("BMAD role to reassign to (e.g., 'bmad-dev', 'bmad-qa', 'bmad-sm')"),
    comment: z
      .string()
      .optional()
      .describe("Optional handoff comment to post on the issue"),
    metadata_updates: z
      .string()
      .optional()
      .describe("JSON string of metadata fields to merge (e.g., '{\"workPhase\": \"code-review\"}')"),
  }),
  handler: async (args) => {
    const ctx = tryGetToolContext();

    if (!ctx) {
      return {
        textResultForLlm:
          "Error: No tool context available — issue_status can only be used " +
          "during a Paperclip heartbeat processing cycle.",
        resultType: "failure" as const,
      };
    }

    const client = ctx.paperclipClient;

    // ── READ action ─────────────────────────────────────────────────
    if (args.action === "read") {
      try {
        // Find the parent issue to list all siblings
        const currentIssue = await client.getIssue(args.issue_id ?? ctx.issueId);
        const parentId = currentIssue.parentId ?? (currentIssue.metadata as Record<string, unknown>)?.parentIssueId as string | undefined;

        if (!parentId) {
          // No parent — return just this issue's info
          return {
            textResultForLlm: [
              `=== ISSUE STATUS ===`,
              `Current issue: ${currentIssue.title}`,
              `Status: ${currentIssue.status}`,
              `Assignee: ${currentIssue.assigneeAgentId ?? "unassigned"}`,
              `No parent issue — cannot list siblings.`,
            ].join("\n"),
            resultType: "success" as const,
          };
        }

        const siblings = await client.listIssues({ parentId });
        const summary = siblings
          .filter((s) => s.status !== "cancelled")
          .map((s) => {
            const meta = s.metadata as Record<string, unknown> | undefined;
            const reviewPasses = meta?.reviewPasses ?? 0;
            const storyId = meta?.storyId ?? s.id.slice(0, 8);
            const phase = meta?.workPhase ?? meta?.bmadPhase ?? "unknown";
            return `  - [${storyId}] "${s.title}" — status: ${s.status}, phase: ${phase}, reviewPasses: ${reviewPasses}`;
          })
          .join("\n");

        const doneCount = siblings.filter((s) => s.status === "done").length;
        const totalCount = siblings.filter((s) => s.status !== "cancelled").length;

        return {
          textResultForLlm: [
            `=== ISSUE STATUS (${doneCount}/${totalCount} done) ===`,
            summary || "  (no issues found)",
          ].join("\n"),
          resultType: "success" as const,
        };
      } catch (err) {
        return {
          textResultForLlm: `Error reading issues: ${err instanceof Error ? err.message : String(err)}`,
          resultType: "failure" as const,
        };
      }
    }

    // ── UPDATE action ───────────────────────────────────────────────
    if (args.action === "update") {
      const issueId = args.issue_id ?? ctx.issueId;

      if (!args.new_status && !args.metadata_updates) {
        return {
          textResultForLlm: "Error: 'update' action requires new_status or metadata_updates.",
          resultType: "failure" as const,
        };
      }

      try {
        // Build update payload
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const updatePayload: Record<string, any> = {};

        if (args.new_status) {
          updatePayload.status = args.new_status;
        }

        if (args.metadata_updates) {
          try {
            const currentIssue = await client.getIssue(issueId);
            const existingMeta = currentIssue.metadata as Record<string, unknown> | undefined;
            const newMeta = JSON.parse(args.metadata_updates) as Record<string, unknown>;
            updatePayload.metadata = { ...existingMeta, ...newMeta };
          } catch (parseErr) {
            return {
              textResultForLlm: `Error parsing metadata_updates JSON: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`,
              resultType: "failure" as const,
            };
          }
        }

        await client.updateIssue(issueId, updatePayload);

        // Post comment if provided
        if (args.comment) {
          await client.addIssueComment(issueId, args.comment);
        }

        return {
          textResultForLlm: `Issue ${issueId} updated: ${args.new_status ? `status → ${args.new_status}` : "metadata updated"}${args.comment ? " (comment posted)" : ""}.`,
          resultType: "success" as const,
        };
      } catch (err) {
        return {
          textResultForLlm: `Error updating issue: ${err instanceof Error ? err.message : String(err)}`,
          resultType: "failure" as const,
        };
      }
    }

    // ── REASSIGN action ─────────────────────────────────────────────
    if (args.action === "reassign") {
      if (!args.target_role) {
        return {
          textResultForLlm: "Error: 'reassign' action requires target_role (e.g., 'bmad-dev', 'bmad-qa').",
          resultType: "failure" as const,
        };
      }

      const issueId = args.issue_id ?? ctx.issueId;

      try {
        // Resolve target agent ID from role name
        const targetAgentId = await resolveAgentId(args.target_role, client);

        if (!targetAgentId) {
          return {
            textResultForLlm: `Error: Could not find an active agent with role '${args.target_role}'.`,
            resultType: "failure" as const,
          };
        }

        // Release current checkout (current agent is done with the issue)
        try {
          await client.releaseIssue(issueId);
        } catch {
          // OK if not checked out — may have already been released
        }

        // Build metadata update — auto-set workPhase based on target role.
        // When dev→QA, set workPhase to "code-review".
        // When QA→dev (rejection), set workPhase back to "dev-story".
        // This ensures the heartbeat handler dispatches to the correct phase config.
        const ROLE_TO_WORK_PHASE: Record<string, string> = {
          "bmad-qa": "code-review",
          "bmad-dev": "dev-story",
        };
        const autoWorkPhase = ROLE_TO_WORK_PHASE[args.target_role.toLowerCase()];

        let metadataUpdate: Record<string, unknown> | undefined;
        try {
          const currentIssue = await client.getIssue(issueId);
          const existingMeta = currentIssue.metadata as Record<string, unknown> | undefined;

          // Start with existing metadata
          const mergedMeta: Record<string, unknown> = { ...(existingMeta ?? {}) };

          // Apply auto workPhase if applicable
          if (autoWorkPhase) {
            mergedMeta.workPhase = autoWorkPhase;
          }

          // Apply explicit metadata_updates on top (if provided)
          if (args.metadata_updates) {
            try {
              const newMeta = JSON.parse(args.metadata_updates) as Record<string, unknown>;
              Object.assign(mergedMeta, newMeta);
            } catch {
              // Non-fatal — proceed with auto-update only
            }
          }

          metadataUpdate = mergedMeta;
        } catch {
          // Non-fatal — proceed without metadata update
        }

        // Update assignee (Paperclip auto-wakes the new agent)
        await client.updateIssue(issueId, {
          assigneeAgentId: targetAgentId,
          ...(metadataUpdate ? { metadata: metadataUpdate } : {}),
        });

        // Post handoff comment
        const handoffComment = args.comment ?? `📋 Issue reassigned to ${args.target_role}.`;
        await client.addIssueComment(issueId, handoffComment);

        return {
          textResultForLlm: `Issue ${issueId} reassigned to ${args.target_role} (agent ${targetAgentId.slice(0, 8)}...). Paperclip will auto-wake the agent.`,
          resultType: "success" as const,
        };
      } catch (err) {
        return {
          textResultForLlm: `Error reassigning issue: ${err instanceof Error ? err.message : String(err)}`,
          resultType: "failure" as const,
        };
      }
    }

    return {
      textResultForLlm: `Unknown action: ${args.action}`,
      resultType: "failure" as const,
    };
  },
});

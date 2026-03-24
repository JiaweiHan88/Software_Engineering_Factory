/**
 * Issue Reassignment Helper — SM→Dev→QA handoff protocol.
 *
 * When an agent completes its step in the story lifecycle,
 * it reassigns the issue to the next agent and posts a handoff comment.
 * Paperclip auto-wakes the new assignee.
 *
 * @module adapter/issue-reassignment
 */

import type { PaperclipClient } from "./paperclip-client.js";
import { resolveAgentId, clearAgentIdCache } from "./ceo-orchestrator.js";
import { Logger } from "../observability/logger.js";

const log = Logger.child("issue-reassignment");

/**
 * Reassign an issue from the current agent to a target BMAD role.
 *
 * Steps:
 * 1. Resolve target agent UUID from BMAD role name
 * 2. Release current checkout (current agent is done with the issue)
 * 3. Update issue: new assignee + optional metadata changes
 * 4. Post handoff comment
 *
 * Paperclip auto-wakes the new assignee when assigneeAgentId changes.
 *
 * @param client - Paperclip API client
 * @param issueId - Issue to reassign
 * @param toRole - Target BMAD role (e.g., 'bmad-dev', 'bmad-qa', 'bmad-sm')
 * @param handoffComment - Comment to post explaining the handoff
 * @param metadata - Optional metadata fields to merge into the issue
 * @throws Error if the target agent cannot be resolved
 */
export async function reassignIssue(
  client: PaperclipClient,
  issueId: string,
  toRole: string,
  handoffComment: string,
  metadata?: Record<string, unknown>,
): Promise<void> {
  // 1. Resolve target agent ID from role
  const targetId = await resolveAgentId(toRole, client);

  if (!targetId) {
    // Try clearing cache and retrying once (agent may have been created recently)
    clearAgentIdCache();
    const retryId = await resolveAgentId(toRole, client);

    if (!retryId) {
      throw new Error(
        `Cannot reassign issue ${issueId}: no active agent with role '${toRole}'. ` +
        `Ensure an agent with this BMAD role exists and is not terminated.`,
      );
    }

    await doReassign(client, issueId, retryId, toRole, handoffComment, metadata);
    return;
  }

  await doReassign(client, issueId, targetId, toRole, handoffComment, metadata);
}

/**
 * Internal: perform the actual reassignment.
 */
async function doReassign(
  client: PaperclipClient,
  issueId: string,
  targetAgentId: string,
  toRole: string,
  handoffComment: string,
  metadata?: Record<string, unknown>,
): Promise<void> {
  // 2. Release current checkout (current agent is done with the issue)
  try {
    await client.releaseIssue(issueId);
  } catch {
    // OK if not checked out — may have already been released
    log.debug("Release before reassign failed (non-fatal)", { issueId });
  }

  // 3. Build update payload
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const updatePayload: Record<string, any> = {
    assigneeAgentId: targetAgentId,
  };

  if (metadata) {
    // Merge with existing metadata
    try {
      const currentIssue = await client.getIssue(issueId);
      const existingMeta = currentIssue.metadata as Record<string, unknown> | undefined;
      updatePayload.metadata = { ...existingMeta, ...metadata };
    } catch {
      // If we can't read existing metadata, just set the new metadata
      updatePayload.metadata = metadata;
    }
  }

  await client.updateIssue(issueId, updatePayload);

  // 4. Post handoff comment
  try {
    await client.addIssueComment(issueId, handoffComment);
  } catch (err) {
    // Non-fatal — the reassignment already happened
    log.warn("Failed to post handoff comment", {
      issueId,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  log.info("Issue reassigned", {
    issueId,
    toRole,
    targetAgentId: targetAgentId.slice(0, 8),
  });
}

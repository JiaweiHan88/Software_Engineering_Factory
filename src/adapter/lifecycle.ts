/**
 * Issue Lifecycle — Central Transition Engine
 *
 * Single source of truth for ALL deterministic issue state transitions.
 * Every file that needs to change issue status, assignee, or workPhase
 * MUST go through this module instead of calling updateIssue() directly.
 *
 * This prevents the race condition where reporter.ts marked issues "done"
 * after heartbeat-handler.ts had already reassigned them to the next agent.
 *
 * Exceptions (allowed to bypass lifecycle):
 * - Issue CREATION (create-story.ts, ceo-orchestrator.ts delegation)
 * - CEO LLM sanity fixes (intentional overrides)
 * - Metadata-only updates (reviewPasses counter, epic retro flags)
 * - Checkout/release mechanics
 *
 * @module adapter/lifecycle
 */

import type { PaperclipClient } from "./paperclip-client.js";
import type { WorkPhase } from "./agent-dispatcher.js";
import { reassignIssue } from "./issue-reassignment.js";
import { Logger } from "../observability/logger.js";

const log = Logger.child("lifecycle");

// ─────────────────────────────────────────────────────────────────────────────
// Transition Table — Single Source of Truth
// ─────────────────────────────────────────────────────────────────────────────

/** Defines what happens when a phase completes: reassign or terminal (done). */
interface PhaseTransition {
  /** Target BMAD role to hand off to. Undefined = terminal (mark done). */
  nextRole?: string;
  /** WorkPhase to set on the issue after reassignment. */
  nextPhase?: WorkPhase;
  /** Handoff comment template. */
  comment?: string;
}

/**
 * Story lifecycle transitions. Phases not listed here are terminal — on
 * completion they mark the issue as "done" and wake the parent.
 */
const PHASE_TRANSITIONS: Partial<Record<WorkPhase, PhaseTransition>> = {
  "create-story": {
    nextRole: "bmad-dev",
    nextPhase: "dev-story",
    comment: "📋 Story detail created. Ready for implementation.",
  },
  "dev-story": {
    nextRole: "bmad-qa",
    nextPhase: "code-review",
    comment: "💻 Implementation complete. Ready for code review.",
  },
};

/**
 * Maps a BMAD agent role to the workPhase it handles.
 * Used for auto-setting workPhase on reassignment and sequential story promotion.
 *
 * Replaces:
 * - ROLE_TO_WORK_PHASE in issue-status.ts
 * - PHASE_AGENT_MAP in ceo-orchestrator.ts (inverse direction)
 */
export const ROLE_TO_PHASE: Record<string, WorkPhase> = {
  "bmad-sm": "create-story",
  "bmad-dev": "dev-story",
  "bmad-qa": "code-review",
};

/**
 * Maps a workPhase to the BMAD agent role that handles it.
 * Inverse of ROLE_TO_PHASE. Used by CEO orchestrator for sequential promotion.
 *
 * Replaces PHASE_AGENT_MAP in ceo-orchestrator.ts.
 */
export const PHASE_TO_ROLE: Record<string, string> = {
  "create-story": "bmad-sm",
  "dev-story": "bmad-dev",
  "code-review": "bmad-qa",
  "sprint-planning": "bmad-sm",
};

// ─────────────────────────────────────────────────────────────────────────────
// Transition Result
// ─────────────────────────────────────────────────────────────────────────────

/** Outcome of a lifecycle transition. */
export interface TransitionResult {
  /** What action was taken. */
  action: "reassigned" | "done" | "blocked" | "escalated";
  /** Target role (only for "reassigned"). */
  targetRole?: string;
  /** New workPhase (only for "reassigned"). */
  workPhase?: WorkPhase;
  /** Whether the parent was notified. */
  parentWoken: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Core Lifecycle Functions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Complete a phase and apply the correct transition.
 *
 * Consults PHASE_TRANSITIONS:
 * - If the phase has a next step → reassign to the next agent role
 * - If terminal → mark done and wake the parent
 *
 * @param client - Paperclip API client
 * @param issueId - The issue that just completed its phase
 * @param phase - The WorkPhase that was just completed
 * @param extraMetadata - Optional metadata to merge into the issue
 * @returns TransitionResult describing what happened
 */
export async function completePhase(
  client: PaperclipClient,
  issueId: string,
  phase: WorkPhase,
  extraMetadata?: Record<string, unknown>,
): Promise<TransitionResult> {
  const transition = PHASE_TRANSITIONS[phase];

  if (transition?.nextRole && transition?.nextPhase) {
    // Non-terminal: reassign to the next agent
    const metadata: Record<string, unknown> = {
      workPhase: transition.nextPhase,
      ...extraMetadata,
    };

    await reassignIssue(
      client,
      issueId,
      transition.nextRole,
      transition.comment ?? `Phase ${phase} complete. Handing off to ${transition.nextRole}.`,
      metadata,
    );

    log.info("Phase completed — reassigned", {
      issueId: issueId.slice(0, 8),
      fromPhase: phase,
      toRole: transition.nextRole,
      toPhase: transition.nextPhase,
    });

    return {
      action: "reassigned",
      targetRole: transition.nextRole,
      workPhase: transition.nextPhase,
      parentWoken: false,
    };
  }

  // Terminal: mark done and wake parent
  await markDone(client, issueId, extraMetadata);

  log.info("Phase completed — done", {
    issueId: issueId.slice(0, 8),
    phase,
  });

  return { action: "done", parentWoken: true };
}

/**
 * Record a passing code review and mark the issue done.
 *
 * @param client - Paperclip API client
 * @param issueId - The reviewed issue
 * @param extraMetadata - Review metadata (reviewPasses, findings summary, etc.)
 */
export async function passReview(
  client: PaperclipClient,
  issueId: string,
  extraMetadata?: Record<string, unknown>,
): Promise<TransitionResult> {
  const meta = await mergeMetadata(client, issueId, {
    lastReviewResult: "pass",
    ...extraMetadata,
  });
  await client.updateIssue(issueId, { status: "done", metadata: meta });
  await wakeParent(client, issueId);

  log.info("Review passed — done", { issueId: issueId.slice(0, 8) });
  return { action: "done", parentWoken: true };
}

/**
 * Record a failing code review and reassign to Dev for fixes.
 *
 * @param client - Paperclip API client
 * @param issueId - The reviewed issue
 * @param comment - Handoff comment with findings
 * @param extraMetadata - Review metadata (findings, pass count, etc.)
 */
export async function failReview(
  client: PaperclipClient,
  issueId: string,
  comment: string,
  extraMetadata?: Record<string, unknown>,
): Promise<TransitionResult> {
  const metadata: Record<string, unknown> = {
    workPhase: "dev-story",
    lastReviewResult: "fail",
    reviewFixMode: true,
    ...extraMetadata,
  };

  await reassignIssue(client, issueId, "bmad-dev", comment, metadata);

  log.info("Review failed — reassigned to dev", { issueId: issueId.slice(0, 8) });
  return {
    action: "reassigned",
    targetRole: "bmad-dev",
    workPhase: "dev-story",
    parentWoken: false,
  };
}

/**
 * Escalate a review to CEO / human intervention.
 *
 * @param client - Paperclip API client
 * @param issueId - The reviewed issue
 * @param reason - Escalation reason
 * @param parentId - Parent issue ID for CEO notification
 * @param extraMetadata - Review metadata
 */
export async function escalateReview(
  client: PaperclipClient,
  issueId: string,
  reason: string,
  parentId?: string,
  extraMetadata?: Record<string, unknown>,
): Promise<TransitionResult> {
  const meta = await mergeMetadata(client, issueId, {
    lastReviewResult: "escalated",
    ...extraMetadata,
  });
  await client.updateIssue(issueId, { metadata: meta });

  // Notify parent (CEO) if possible
  if (parentId) {
    try {
      await client.addIssueComment(parentId, reason);
    } catch {
      log.warn("Failed to post escalation to parent (non-fatal)", { issueId: issueId.slice(0, 8) });
    }
  }

  log.info("Review escalated", { issueId: issueId.slice(0, 8) });
  return { action: "escalated", parentWoken: false };
}

/**
 * Promote a backlog issue to todo with the correct assignee and workPhase.
 *
 * Used by CEO orchestrator for sequential story promotion.
 *
 * @param client - Paperclip API client
 * @param issue - The issue to promote (needs id, metadata)
 * @param workPhase - Target workPhase (determines agent role via PHASE_TO_ROLE)
 */
export async function promoteToTodo(
  client: PaperclipClient,
  issueId: string,
  existingMetadata: Record<string, unknown> | undefined,
  workPhase: string,
  resolveAgentIdFn: (role: string, client: PaperclipClient) => Promise<string | undefined>,
): Promise<void> {
  const agentRole = PHASE_TO_ROLE[workPhase] ?? "bmad-dev";
  const assigneeId = await resolveAgentIdFn(agentRole, client);

  log.info("Promoting to todo", {
    issueId: issueId.slice(0, 8),
    workPhase,
    agentRole,
    assigneeId: assigneeId?.slice(0, 8),
  });

  await client.updateIssue(issueId, {
    status: "todo",
    ...(assigneeId ? { assigneeAgentId: assigneeId } : {}),
    metadata: {
      ...existingMetadata,
      workPhase,
    },
  });
}

/**
 * Close a parent issue when all children are done.
 *
 * @param client - Paperclip API client
 * @param issueId - The parent issue to close
 * @param comment - Optional completion comment
 */
export async function closeParent(
  client: PaperclipClient,
  issueId: string,
  comment?: string,
): Promise<void> {
  await client.updateIssue(issueId, { status: "done" });
  if (comment) {
    await client.addIssueComment(issueId, comment);
  }
  log.info("Parent closed", { issueId: issueId.slice(0, 8) });
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Mark an issue as done and wake its parent.
 */
async function markDone(
  client: PaperclipClient,
  issueId: string,
  extraMetadata?: Record<string, unknown>,
): Promise<void> {
  if (extraMetadata) {
    const meta = await mergeMetadata(client, issueId, extraMetadata);
    await client.updateIssue(issueId, { status: "done", metadata: meta });
  } else {
    await client.updateIssue(issueId, { status: "done" });
  }
  await wakeParent(client, issueId);
}

/**
 * Post a completion notice on the parent issue and promote unblocked siblings.
 *
 * When a child completes:
 * 1. Posts an audit-trail comment on the parent
 * 2. Checks all siblings under the same parent for dependency satisfaction
 * 3. Promotes any backlog siblings whose deps are now met → `todo`
 *    (Paperclip fires a heartbeat on backlog→todo, waking the assignee)
 */
export async function wakeParent(
  client: PaperclipClient,
  issueId: string,
): Promise<void> {
  try {
    const issue = await client.getIssue(issueId);
    if (!issue.parentId) return;

    const identifier = issue.identifier ?? issue.id.slice(0, 8);
    await client.addIssueComment(
      issue.parentId,
      `📋 Sub-task **${identifier}** ("${issue.title.slice(0, 60)}") completed.`,
    );
    log.info("Woke parent", { issueId: issueId.slice(0, 8), parentId: issue.parentId.slice(0, 8) });

    // Promote any siblings whose dependencies are now satisfied
    const promoted = await checkSiblingDependencies(client, issue.parentId);
    if (promoted > 0) {
      await client.addIssueComment(
        issue.parentId,
        `🔓 Promoted **${promoted}** sibling(s) from backlog → todo (deps unblocked by ${identifier}).`,
      );
    }
  } catch (err) {
    log.warn("Failed to wake parent (non-fatal)", {
      issueId: issueId.slice(0, 8),
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Merge new metadata fields into existing issue metadata.
 */
async function mergeMetadata(
  client: PaperclipClient,
  issueId: string,
  newFields: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  try {
    const issue = await client.getIssue(issueId);
    const existing = (issue.metadata as Record<string, unknown>) ?? {};
    return { ...existing, ...newFields };
  } catch {
    return { ...newFields };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Dependency-Based Promotion
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Check sibling issues under the same parent and promote any whose
 * dependencies are now satisfied from `backlog` → `todo`.
 *
 * This is called automatically when a child issue completes (via wakeParent).
 * Paperclip fires an agent heartbeat on backlog→todo transitions, so promoted
 * siblings will be picked up immediately — no CEO re-eval cycle needed.
 *
 * @param client - Paperclip API client
 * @param parentId - The parent issue ID whose children should be checked
 * @returns Number of siblings promoted
 */
export async function checkSiblingDependencies(
  client: PaperclipClient,
  parentId: string,
): Promise<number> {
  let siblings: import("./paperclip-client.js").PaperclipIssue[];
  try {
    siblings = await client.listIssues({ parentId });
  } catch (err) {
    log.warn("Failed to fetch siblings for dependency check", {
      parentId: parentId.slice(0, 8),
      error: err instanceof Error ? err.message : String(err),
    });
    return 0;
  }

  // Build taskIndex → status map
  const statusByIndex = new Map<number, string>();
  for (const sib of siblings) {
    const meta = sib.metadata as Record<string, unknown> | undefined;
    const idx = meta?.taskIndex;
    if (typeof idx === "number") {
      statusByIndex.set(idx, sib.status);
    }
  }

  let promoted = 0;
  for (const sib of siblings) {
    if (sib.status !== "backlog") continue;

    const meta = sib.metadata as Record<string, unknown> | undefined;

    // Skip refined stories (those with storySequence) — they use
    // sequential promotion logic in ceo-orchestrator, not dependency-based.
    if (typeof meta?.storySequence === "number") continue;

    const rawDeps = Array.isArray(meta?.dependsOn) ? meta.dependsOn : [];
    const dependsOn = rawDeps.filter((v): v is number => typeof v === "number");
    if (dependsOn.length !== rawDeps.length) {
      log.warn("Ignoring non-numeric dependsOn entries", {
        issueId: sib.id.slice(0, 8),
        raw: rawDeps,
      });
    }

    // No deps — should already be todo, but promote as safety net
    if (dependsOn.length === 0) {
      await client.updateIssue(sib.id, { status: "todo" });
      promoted++;
      log.info("Promoted sibling (no deps)", {
        issueId: sib.id.slice(0, 8),
        identifier: sib.identifier,
      });
      continue;
    }

    // Check for deps referencing non-existent taskIndex values
    const missingDeps = dependsOn.filter((d) => !statusByIndex.has(d));
    if (missingDeps.length > 0) {
      log.warn("Dependency references non-existent taskIndex — skipping promotion", {
        issueId: sib.id.slice(0, 8),
        identifier: sib.identifier,
        missingDeps,
      });
      continue;
    }

    const allDepsDone = dependsOn.every((depIdx) => {
      return statusByIndex.get(depIdx) === "done";
    });

    if (allDepsDone) {
      await client.updateIssue(sib.id, { status: "todo" });
      promoted++;
      log.info("Promoted sibling (deps met)", {
        issueId: sib.id.slice(0, 8),
        identifier: sib.identifier,
        dependsOn,
      });
    }
  }

  // Wake agents for `todo` siblings whose deps just became met.
  // These were promoted earlier but skipped by the heartbeat prereq guard
  // because their deps weren't done yet. Now they are — post a comment on
  // the sibling issue to trigger Paperclip's `issue_commented` wakeup.
  let woken = 0;
  for (const sib of siblings) {
    if (sib.status !== "todo") continue;
    if (!sib.assigneeAgentId) continue;

    const meta = sib.metadata as Record<string, unknown> | undefined;
    if (typeof meta?.storySequence === "number") continue;

    const rawDeps2 = Array.isArray(meta?.dependsOn) ? meta.dependsOn : [];
    const dependsOn = rawDeps2.filter((v): v is number => typeof v === "number");
    if (dependsOn.length === 0) continue;

    const allDepsDone = dependsOn.every((depIdx) => {
      return statusByIndex.get(depIdx) === "done";
    });

    if (allDepsDone) {
      try {
        const depLabels = dependsOn.map((d) => {
          const dep = siblings.find((s) => {
            const m = s.metadata as Record<string, unknown> | undefined;
            return m?.taskIndex === d;
          });
          return dep?.identifier ?? `task-${d}`;
        });
        await client.addIssueComment(
          sib.id,
          `🔓 Dependencies met (${depLabels.join(", ")} done). Ready to proceed.`,
        );
        woken++;
        log.info("Woke todo sibling (deps now met)", {
          issueId: sib.id.slice(0, 8),
          identifier: sib.identifier,
          dependsOn,
        });
      } catch (err) {
        log.warn("Failed to wake todo sibling (non-fatal)", {
          issueId: sib.id.slice(0, 8),
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  if (promoted > 0 || woken > 0) {
    log.info("Dependency check complete", {
      parentId: parentId.slice(0, 8),
      promoted,
      woken,
      totalSiblings: siblings.length,
    });
  }

  return promoted;
}

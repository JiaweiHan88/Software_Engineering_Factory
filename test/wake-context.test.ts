/**
 * Phase A — Wake Context & Heartbeat Routing — Unit Tests
 *
 * Tests the heartbeat entrypoint changes:
 * - A3: Full wake context environment variables (PaperclipEnv)
 * - A4: Wake-reason routing (approval handling, task prioritization)
 * - A5: Run ID env var acceptance (both names)
 * - A7: Blocked-task dedup (isBlockedStatusComment helper)
 *
 * These tests focus on the extracted/exported utility functions and
 * env parsing logic. Full integration tests require the complete
 * heartbeat pipeline (covered in e2e tests).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ─────────────────────────────────────────────────────────────────────────────
// Since heartbeat-entrypoint.ts has module-level side effects (dotenv, main()),
// we test the logic by extracting the testable functions. For unit tests,
// we re-implement the pure functions here to verify the logic, then verify
// the integrated behavior via the actual module in e2e.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Re-implementation of isBlockedStatusComment for testing.
 * Must match the implementation in heartbeat-entrypoint.ts.
 */
function isBlockedStatusComment(body: string): boolean {
  if (!body) return false;
  const lower = body.toLowerCase();
  return (
    lower.includes("blocked") &&
    (lower.includes("status") ||
      lower.includes("waiting") ||
      lower.includes("⏸") ||
      lower.includes("🚫") ||
      lower.startsWith("⛔"))
  );
}

/**
 * Re-implementation of PaperclipEnv extraction for testing.
 * Must match the interface and extraction logic in heartbeat-entrypoint.ts.
 */
interface PaperclipEnv {
  agentApiKey: string | undefined;
  url: string;
  companyId: string;
  agentId: string;
  heartbeatRunId: string | undefined;
  taskId: string | undefined;
  wakeReason: string | undefined;
  wakeCommentId: string | undefined;
  approvalId: string | undefined;
  approvalStatus: string | undefined;
  linkedIssueIds: string[] | undefined;
}

function extractPaperclipEnv(): PaperclipEnv {
  const agentApiKey = process.env.PAPERCLIP_AGENT_API_KEY || undefined;
  const url = process.env.PAPERCLIP_API_URL || process.env.PAPERCLIP_URL || "http://localhost:3100";
  const companyId = process.env.PAPERCLIP_COMPANY_ID;
  const agentId = process.env.PAPERCLIP_AGENT_ID;
  const heartbeatRunId =
    process.env.PAPERCLIP_RUN_ID ||
    process.env.PAPERCLIP_HEARTBEAT_RUN_ID ||
    undefined;

  if (!companyId) {
    throw new Error("Missing PAPERCLIP_COMPANY_ID — required for company-scoped API calls");
  }
  if (!agentId) {
    throw new Error("Missing PAPERCLIP_AGENT_ID — required to identify the agent");
  }

  const linkedIssueIdsRaw = process.env.PAPERCLIP_LINKED_ISSUE_IDS;

  return {
    agentApiKey,
    url,
    companyId,
    agentId,
    heartbeatRunId,
    taskId: process.env.PAPERCLIP_TASK_ID || undefined,
    wakeReason: process.env.PAPERCLIP_WAKE_REASON || undefined,
    wakeCommentId: process.env.PAPERCLIP_WAKE_COMMENT_ID || undefined,
    approvalId: process.env.PAPERCLIP_APPROVAL_ID || undefined,
    approvalStatus: process.env.PAPERCLIP_APPROVAL_STATUS || undefined,
    linkedIssueIds: linkedIssueIdsRaw
      ? linkedIssueIdsRaw.split(",").filter(Boolean)
      : undefined,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("Phase A — Wake Context", () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    // Reset env to a clean state with required vars
    process.env = {
      ...ORIGINAL_ENV,
      PAPERCLIP_COMPANY_ID: "bmad-factory",
      PAPERCLIP_AGENT_ID: "agent-123",
    };
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
  });

  // ─── A3: Environment variables ───────────────────────────────────────

  describe("extractPaperclipEnv — base fields", () => {
    it("extracts required fields (companyId, agentId)", () => {
      const env = extractPaperclipEnv();
      expect(env.companyId).toBe("bmad-factory");
      expect(env.agentId).toBe("agent-123");
    });

    it("throws when PAPERCLIP_COMPANY_ID is missing", () => {
      delete process.env.PAPERCLIP_COMPANY_ID;
      expect(() => extractPaperclipEnv()).toThrow("Missing PAPERCLIP_COMPANY_ID");
    });

    it("throws when PAPERCLIP_AGENT_ID is missing", () => {
      delete process.env.PAPERCLIP_AGENT_ID;
      expect(() => extractPaperclipEnv()).toThrow("Missing PAPERCLIP_AGENT_ID");
    });

    it("uses PAPERCLIP_API_URL over PAPERCLIP_URL", () => {
      process.env.PAPERCLIP_API_URL = "http://api-url:3100";
      process.env.PAPERCLIP_URL = "http://url:3100";
      const env = extractPaperclipEnv();
      expect(env.url).toBe("http://api-url:3100");
    });

    it("falls back to PAPERCLIP_URL if PAPERCLIP_API_URL is not set", () => {
      process.env.PAPERCLIP_URL = "http://url:3100";
      const env = extractPaperclipEnv();
      expect(env.url).toBe("http://url:3100");
    });

    it("defaults to http://localhost:3100 if no URL env is set", () => {
      const env = extractPaperclipEnv();
      expect(env.url).toBe("http://localhost:3100");
    });

    it("extracts agentApiKey when present", () => {
      process.env.PAPERCLIP_AGENT_API_KEY = "secret-key";
      const env = extractPaperclipEnv();
      expect(env.agentApiKey).toBe("secret-key");
    });

    it("returns undefined agentApiKey when not set", () => {
      const env = extractPaperclipEnv();
      expect(env.agentApiKey).toBeUndefined();
    });
  });

  // ─── A5: Run ID env var ──────────────────────────────────────────────

  describe("extractPaperclipEnv — run ID (A5)", () => {
    it("reads PAPERCLIP_RUN_ID as primary", () => {
      process.env.PAPERCLIP_RUN_ID = "run-from-new-var";
      const env = extractPaperclipEnv();
      expect(env.heartbeatRunId).toBe("run-from-new-var");
    });

    it("falls back to PAPERCLIP_HEARTBEAT_RUN_ID", () => {
      process.env.PAPERCLIP_HEARTBEAT_RUN_ID = "run-from-old-var";
      const env = extractPaperclipEnv();
      expect(env.heartbeatRunId).toBe("run-from-old-var");
    });

    it("prefers PAPERCLIP_RUN_ID over PAPERCLIP_HEARTBEAT_RUN_ID", () => {
      process.env.PAPERCLIP_RUN_ID = "run-new";
      process.env.PAPERCLIP_HEARTBEAT_RUN_ID = "run-old";
      const env = extractPaperclipEnv();
      expect(env.heartbeatRunId).toBe("run-new");
    });

    it("returns undefined when neither run ID var is set", () => {
      const env = extractPaperclipEnv();
      expect(env.heartbeatRunId).toBeUndefined();
    });
  });

  // ─── A3: Wake context env vars ──────────────────────────────────────

  describe("extractPaperclipEnv — wake context (A3)", () => {
    it("extracts taskId from PAPERCLIP_TASK_ID", () => {
      process.env.PAPERCLIP_TASK_ID = "issue-42";
      const env = extractPaperclipEnv();
      expect(env.taskId).toBe("issue-42");
    });

    it("extracts wakeReason from PAPERCLIP_WAKE_REASON", () => {
      process.env.PAPERCLIP_WAKE_REASON = "assignment";
      const env = extractPaperclipEnv();
      expect(env.wakeReason).toBe("assignment");
    });

    it("extracts wakeCommentId from PAPERCLIP_WAKE_COMMENT_ID", () => {
      process.env.PAPERCLIP_WAKE_COMMENT_ID = "comment-99";
      const env = extractPaperclipEnv();
      expect(env.wakeCommentId).toBe("comment-99");
    });

    it("extracts approvalId from PAPERCLIP_APPROVAL_ID", () => {
      process.env.PAPERCLIP_APPROVAL_ID = "approval-1";
      const env = extractPaperclipEnv();
      expect(env.approvalId).toBe("approval-1");
    });

    it("extracts approvalStatus from PAPERCLIP_APPROVAL_STATUS", () => {
      process.env.PAPERCLIP_APPROVAL_STATUS = "approved";
      const env = extractPaperclipEnv();
      expect(env.approvalStatus).toBe("approved");
    });

    it("parses PAPERCLIP_LINKED_ISSUE_IDS as comma-separated array", () => {
      process.env.PAPERCLIP_LINKED_ISSUE_IDS = "id-1,id-2,id-3";
      const env = extractPaperclipEnv();
      expect(env.linkedIssueIds).toEqual(["id-1", "id-2", "id-3"]);
    });

    it("filters empty strings from linked issue IDs", () => {
      process.env.PAPERCLIP_LINKED_ISSUE_IDS = "id-1,,id-2,";
      const env = extractPaperclipEnv();
      expect(env.linkedIssueIds).toEqual(["id-1", "id-2"]);
    });

    it("returns undefined for unset wake context vars", () => {
      const env = extractPaperclipEnv();
      expect(env.taskId).toBeUndefined();
      expect(env.wakeReason).toBeUndefined();
      expect(env.wakeCommentId).toBeUndefined();
      expect(env.approvalId).toBeUndefined();
      expect(env.approvalStatus).toBeUndefined();
      expect(env.linkedIssueIds).toBeUndefined();
    });

    it("extracts all wake context vars together", () => {
      process.env.PAPERCLIP_TASK_ID = "issue-42";
      process.env.PAPERCLIP_WAKE_REASON = "comment";
      process.env.PAPERCLIP_WAKE_COMMENT_ID = "comment-99";
      process.env.PAPERCLIP_APPROVAL_ID = "approval-1";
      process.env.PAPERCLIP_APPROVAL_STATUS = "denied";
      process.env.PAPERCLIP_LINKED_ISSUE_IDS = "linked-1,linked-2";

      const env = extractPaperclipEnv();
      expect(env.taskId).toBe("issue-42");
      expect(env.wakeReason).toBe("comment");
      expect(env.wakeCommentId).toBe("comment-99");
      expect(env.approvalId).toBe("approval-1");
      expect(env.approvalStatus).toBe("denied");
      expect(env.linkedIssueIds).toEqual(["linked-1", "linked-2"]);
    });
  });
});

// ─── A4: Wake-Reason Routing Logic ─────────────────────────────────────

describe("Phase A — Wake-Reason Routing", () => {
  describe("task prioritization", () => {
    it("moves triggered task to front of inbox", () => {
      const inbox = [
        { id: "issue-1", title: "First" },
        { id: "issue-2", title: "Second" },
        { id: "issue-3", title: "Third" },
      ];
      const taskId = "issue-3";

      // Re-implement the inbox prioritization logic from heartbeat-entrypoint
      if (taskId && inbox.length > 1) {
        const triggeredIdx = inbox.findIndex((i) => i.id === taskId);
        if (triggeredIdx > 0) {
          const [triggered] = inbox.splice(triggeredIdx, 1);
          inbox.unshift(triggered);
        }
      }

      expect(inbox[0].id).toBe("issue-3");
      expect(inbox[1].id).toBe("issue-1");
      expect(inbox[2].id).toBe("issue-2");
    });

    it("does not reorder if triggered task is already first", () => {
      const inbox = [
        { id: "issue-1", title: "First" },
        { id: "issue-2", title: "Second" },
      ];
      const taskId = "issue-1";

      if (taskId && inbox.length > 1) {
        const triggeredIdx = inbox.findIndex((i) => i.id === taskId);
        if (triggeredIdx > 0) {
          const [triggered] = inbox.splice(triggeredIdx, 1);
          inbox.unshift(triggered);
        }
      }

      expect(inbox[0].id).toBe("issue-1");
      expect(inbox[1].id).toBe("issue-2");
    });

    it("does not modify inbox if triggered task is not found", () => {
      const inbox = [
        { id: "issue-1", title: "First" },
        { id: "issue-2", title: "Second" },
      ];
      const taskId = "nonexistent";

      if (taskId && inbox.length > 1) {
        const triggeredIdx = inbox.findIndex((i) => i.id === taskId);
        if (triggeredIdx > 0) {
          const [triggered] = inbox.splice(triggeredIdx, 1);
          inbox.unshift(triggered);
        }
      }

      expect(inbox).toHaveLength(2);
      expect(inbox[0].id).toBe("issue-1");
    });

    it("skips reordering for single-issue inbox", () => {
      const inbox = [{ id: "issue-1", title: "Only" }];
      const taskId = "issue-1";
      const originalLength = inbox.length;

      // The condition inbox.length > 1 prevents this
      if (taskId && inbox.length > 1) {
        const triggeredIdx = inbox.findIndex((i) => i.id === taskId);
        if (triggeredIdx > 0) {
          const [triggered] = inbox.splice(triggeredIdx, 1);
          inbox.unshift(triggered);
        }
      }

      expect(inbox).toHaveLength(originalLength);
      expect(inbox[0].id).toBe("issue-1");
    });
  });
});

// ─── A7: Blocked-Task Dedup ────────────────────────────────────────────

describe("Phase A — Blocked-Task Dedup", () => {
  describe("isBlockedStatusComment", () => {
    it("detects 'blocked' + 'status' as blocked comment", () => {
      expect(isBlockedStatusComment("⏸ **BLOCKED** — Status: waiting for dependency")).toBe(true);
    });

    it("detects 'blocked' + 'waiting' as blocked comment", () => {
      expect(isBlockedStatusComment("Task is blocked, waiting for review")).toBe(true);
    });

    it("detects 'blocked' + ⏸ emoji as blocked comment", () => {
      expect(isBlockedStatusComment("⏸ Blocked on upstream")).toBe(true);
    });

    it("detects 'blocked' + 🚫 emoji as blocked comment", () => {
      expect(isBlockedStatusComment("🚫 Blocked — missing credentials")).toBe(true);
    });

    it("detects ⛔ prefix with blocked as blocked comment", () => {
      expect(isBlockedStatusComment("⛔ Blocked by policy gate")).toBe(true);
    });

    it("rejects regular comments that happen to mention 'blocked'", () => {
      // "blocked" alone without status/waiting/emoji is not enough
      // Actually per our implementation, "blocked" needs to combine with
      // one of the secondary markers. "I blocked the merge" without
      // status/waiting/⏸/🚫 or ⛔ prefix would be:
      expect(isBlockedStatusComment("I blocked the merge request")).toBe(false);
    });

    it("rejects normal status updates without 'blocked'", () => {
      expect(isBlockedStatusComment("✅ Task completed successfully")).toBe(false);
    });

    it("rejects empty string", () => {
      expect(isBlockedStatusComment("")).toBe(false);
    });

    it("is case-insensitive", () => {
      expect(isBlockedStatusComment("BLOCKED — Status update")).toBe(true);
      expect(isBlockedStatusComment("Blocked — Waiting for input")).toBe(true);
    });
  });
});

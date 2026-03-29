/**
 * Reporter — Unit Tests (BUGFIX-002, BUGFIX-004)
 *
 * Tests agent display name attribution in comments posted by PaperclipReporter.
 * Tests single-comment artifact merging, dedup, and filename format (BUGFIX-004).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PaperclipReporter, resolveAgentDisplayName } from "../../src/adapter/reporter.js";
import type { PaperclipClient } from "../../src/adapter/paperclip-client.js";
import type { HeartbeatResult } from "../../src/adapter/heartbeat-handler.js";
import type { DispatchResult } from "../../src/adapter/agent-dispatcher.js";
import type { SprintEvent } from "../../src/adapter/sprint-runner.js";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ─────────────────────────────────────────────────────────────────────────────
// Mocks
// ─────────────────────────────────────────────────────────────────────────────

function createMockClient(): PaperclipClient {
  return {
    addIssueComment: vi.fn().mockResolvedValue(undefined),
  } as unknown as PaperclipClient;
}

// ─────────────────────────────────────────────────────────────────────────────
// resolveAgentDisplayName
// ─────────────────────────────────────────────────────────────────────────────

describe("resolveAgentDisplayName", () => {
  it("resolves bmad-dev to Amelia - Dev", () => {
    expect(resolveAgentDisplayName("bmad-dev")).toBe("Amelia - Dev");
  });

  it("resolves bmad-sm to Bob - SM", () => {
    expect(resolveAgentDisplayName("bmad-sm")).toBe("Bob - SM");
  });

  it("resolves bmad-pm to John - PM", () => {
    expect(resolveAgentDisplayName("bmad-pm")).toBe("John - PM");
  });

  it("resolves ceo via ROLE_MAPPING fallback", () => {
    // 'ceo' is not in the BMAD agent registry, but is in ROLE_MAPPING
    expect(resolveAgentDisplayName("ceo")).toBe("CEO - Chief Executive");
  });

  it("resolves bmad-ceo via ROLE_MAPPING alias", () => {
    expect(resolveAgentDisplayName("bmad-ceo")).toBe("CEO - Chief Executive");
  });

  it("returns raw agentId for unknown agents", () => {
    expect(resolveAgentDisplayName("unknown-agent-xyz")).toBe("unknown-agent-xyz");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PaperclipReporter — Comment Attribution
// ─────────────────────────────────────────────────────────────────────────────

describe("PaperclipReporter", () => {
  let mockClient: PaperclipClient;
  let reporter: PaperclipReporter;

  beforeEach(() => {
    mockClient = createMockClient();
    reporter = new PaperclipReporter(mockClient);
  });

  describe("reportHeartbeatResult", () => {
    it("includes agent display name in comment", async () => {
      const result: HeartbeatResult = {
        status: "completed",
        message: "Story implemented successfully.",
      };

      await reporter.reportHeartbeatResult("bmad-dev", "issue-1", result);

      const addComment = mockClient.addIssueComment as ReturnType<typeof vi.fn>;
      expect(addComment).toHaveBeenCalledOnce();
      const [issueId, comment] = addComment.mock.calls[0];
      expect(issueId).toBe("issue-1");
      expect(comment).toContain("**Amelia - Dev:**");
      expect(comment).toContain("**COMPLETED**");
    });

    it("includes agent display name for stalled status", async () => {
      const result: HeartbeatResult = {
        status: "stalled",
        message: "Blocked on missing dependency.",
      };

      await reporter.reportHeartbeatResult("bmad-sm", "issue-2", result);

      const addComment = mockClient.addIssueComment as ReturnType<typeof vi.fn>;
      const [, comment] = addComment.mock.calls[0];
      expect(comment).toContain("**Bob - SM:**");
      expect(comment).toContain("**STALLED**");
    });

    it("falls back to raw agentId for unknown agents", async () => {
      const result: HeartbeatResult = {
        status: "working",
        message: "Processing...",
      };

      await reporter.reportHeartbeatResult("custom-agent", "issue-3", result);

      const addComment = mockClient.addIssueComment as ReturnType<typeof vi.fn>;
      const [, comment] = addComment.mock.calls[0];
      expect(comment).toContain("**custom-agent:**");
    });
  });

  describe("reportDispatchResult", () => {
    it("includes agent display name in success comment", async () => {
      const result: DispatchResult = {
        success: true,
        response: "Done",
        agentName: "bmad-dev",
        sessionId: "s1",
      };

      await reporter.reportDispatchResult("bmad-dev", "issue-1", result);

      const addComment = mockClient.addIssueComment as ReturnType<typeof vi.fn>;
      const [, comment] = addComment.mock.calls[0];
      expect(comment).toContain("**Amelia - Dev:**");
      expect(comment).toContain("**COMPLETED**");
    });

    it("includes agent display name in failure comment", async () => {
      const result: DispatchResult = {
        success: false,
        response: "",
        agentName: "bmad-qa",
        sessionId: "s2",
        error: "Tests failed",
      };

      await reporter.reportDispatchResult("bmad-qa", "issue-2", result);

      const addComment = mockClient.addIssueComment as ReturnType<typeof vi.fn>;
      const [, comment] = addComment.mock.calls[0];
      expect(comment).toContain("**Quinn - QA:**");
      expect(comment).toContain("**FAILED**");
    });
  });

  describe("reportSprintEvent", () => {
    it("includes agent display name in story-complete event", async () => {
      const event: SprintEvent = {
        type: "story-complete",
        storyId: "story-1",
        phase: "dev-story",
        result: {
          success: true,
          response: "Done",
          agentName: "bmad-dev",
          sessionId: "s1",
        },
      };

      await reporter.reportSprintEvent(event, "bmad-dev");

      const addComment = mockClient.addIssueComment as ReturnType<typeof vi.fn>;
      const [, comment] = addComment.mock.calls[0];
      expect(comment).toContain("**Amelia - Dev:**");
    });

    it("includes agent display name in story-escalated event", async () => {
      const event: SprintEvent = {
        type: "story-escalated",
        storyId: "story-2",
        reason: "Missing API endpoint",
      };

      await reporter.reportSprintEvent(event, "bmad-pm");

      const addComment = mockClient.addIssueComment as ReturnType<typeof vi.fn>;
      const [, comment] = addComment.mock.calls[0];
      expect(comment).toContain("**John - PM:**");
      expect(comment).toContain("ESCALATED");
    });

    it("includes agent display name in story-failed event", async () => {
      const event: SprintEvent = {
        type: "story-failed",
        storyId: "story-3",
        error: "Compilation error",
      };

      await reporter.reportSprintEvent(event, "bmad-architect");

      const addComment = mockClient.addIssueComment as ReturnType<typeof vi.fn>;
      const [, comment] = addComment.mock.calls[0];
      expect(comment).toContain("**Winston - Architect:**");
      expect(comment).toContain("FAILED");
    });

    it("does not post comment when no agentId provided", async () => {
      const event: SprintEvent = {
        type: "story-complete",
        storyId: "story-4",
        phase: "dev-story",
        result: {
          success: true,
          response: "Done",
          agentName: "bmad-dev",
          sessionId: "s1",
        },
      };

      await reporter.reportSprintEvent(event);

      const addComment = mockClient.addIssueComment as ReturnType<typeof vi.fn>;
      expect(addComment).not.toHaveBeenCalled();
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// BUGFIX-004: Reporter Duplicate Artifact Comments
// ─────────────────────────────────────────────────────────────────────────────

describe("PaperclipReporter — BUGFIX-004", () => {
  let mockClient: PaperclipClient;
  let tmpDir: string;

  beforeEach(() => {
    mockClient = createMockClient();
    tmpDir = mkdtempSync(join(tmpdir(), "reporter-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("AC-1: single comment on completion", () => {
    it("posts exactly ONE comment containing both status and artifacts", async () => {
      writeFileSync(join(tmpDir, "architecture.md"), "# Architecture\nDesign doc");
      const reporter = new PaperclipReporter(mockClient, 500, tmpDir);
      const result: HeartbeatResult = {
        status: "completed",
        message: "Story implemented.",
      };

      await reporter.reportHeartbeatResult("bmad-dev", "issue-1", result);

      const addComment = mockClient.addIssueComment as ReturnType<typeof vi.fn>;
      expect(addComment).toHaveBeenCalledOnce();
      const [issueId, comment] = addComment.mock.calls[0];
      expect(issueId).toBe("issue-1");
      // Contains both status and artifacts
      expect(comment).toContain("**COMPLETED**");
      expect(comment).toContain("Workspace Artifacts");
      expect(comment).toContain("architecture.md");
    });

    it("posts one comment without artifacts when workspace is empty", async () => {
      const reporter = new PaperclipReporter(mockClient, 500, tmpDir);
      const result: HeartbeatResult = {
        status: "completed",
        message: "Done.",
      };

      await reporter.reportHeartbeatResult("bmad-dev", "issue-1", result);

      const addComment = mockClient.addIssueComment as ReturnType<typeof vi.fn>;
      expect(addComment).toHaveBeenCalledOnce();
      const [, comment] = addComment.mock.calls[0];
      expect(comment).toContain("**COMPLETED**");
      expect(comment).not.toContain("Workspace Artifacts");
    });
  });

  describe("AC-2: dedup prevents repeated artifact listing", () => {
    it("skips artifact section on second completion with same files", async () => {
      writeFileSync(join(tmpDir, "plan.md"), "# Plan\nContent here");
      const reporter = new PaperclipReporter(mockClient, 500, tmpDir);
      const result: HeartbeatResult = { status: "completed", message: "Done." };

      // First call — includes artifacts
      await reporter.reportHeartbeatResult("bmad-dev", "issue-1", result);
      // Second call — same files, should skip artifacts
      await reporter.reportHeartbeatResult("bmad-dev", "issue-1", result);

      const addComment = mockClient.addIssueComment as ReturnType<typeof vi.fn>;
      expect(addComment).toHaveBeenCalledTimes(2);

      const [, comment1] = addComment.mock.calls[0];
      const [, comment2] = addComment.mock.calls[1];
      expect(comment1).toContain("Workspace Artifacts");
      expect(comment2).not.toContain("Workspace Artifacts");
    });

    it("includes artifact section when files change between completions", async () => {
      writeFileSync(join(tmpDir, "plan.md"), "# Plan v1");
      const reporter = new PaperclipReporter(mockClient, 500, tmpDir);
      const result: HeartbeatResult = { status: "completed", message: "Done." };

      // First call
      await reporter.reportHeartbeatResult("bmad-dev", "issue-1", result);

      // Change file content (different size → different artifact listing)
      writeFileSync(join(tmpDir, "plan.md"), "# Plan v2\nWith more content added");
      writeFileSync(join(tmpDir, "extra.md"), "# Extra artifact");

      // Second call — files changed, should include artifacts again
      await reporter.reportHeartbeatResult("bmad-dev", "issue-1", result);

      const addComment = mockClient.addIssueComment as ReturnType<typeof vi.fn>;
      const [, comment1] = addComment.mock.calls[0];
      const [, comment2] = addComment.mock.calls[1];
      expect(comment1).toContain("Workspace Artifacts");
      expect(comment2).toContain("Workspace Artifacts");
      expect(comment2).toContain("extra.md");
    });
  });

  describe("AC-3: artifact filenames without backticks", () => {
    it("formats filenames as plain text, not backtick-wrapped", async () => {
      writeFileSync(join(tmpDir, "architecture.md"), "# Architecture\nDesign doc");
      const reporter = new PaperclipReporter(mockClient, 500, tmpDir);
      const result: HeartbeatResult = { status: "completed", message: "Done." };

      await reporter.reportHeartbeatResult("bmad-dev", "issue-1", result);

      const addComment = mockClient.addIssueComment as ReturnType<typeof vi.fn>;
      const [, comment] = addComment.mock.calls[0];
      // Should NOT have backtick-wrapped filename
      expect(comment).not.toMatch(/`architecture\.md`/);
      // Should have plain filename
      expect(comment).toMatch(/- architecture\.md \|/);
    });
  });

  describe("AC-4: non-completion posts status only", () => {
    it("does not include artifacts for working status", async () => {
      writeFileSync(join(tmpDir, "plan.md"), "# Plan");
      const reporter = new PaperclipReporter(mockClient, 500, tmpDir);
      const result: HeartbeatResult = { status: "working", message: "In progress." };

      await reporter.reportHeartbeatResult("bmad-dev", "issue-1", result);

      const addComment = mockClient.addIssueComment as ReturnType<typeof vi.fn>;
      expect(addComment).toHaveBeenCalledOnce();
      const [, comment] = addComment.mock.calls[0];
      expect(comment).toContain("**WORKING**");
      expect(comment).not.toContain("Workspace Artifacts");
    });

    it("does not include artifacts for stalled status", async () => {
      writeFileSync(join(tmpDir, "plan.md"), "# Plan");
      const reporter = new PaperclipReporter(mockClient, 500, tmpDir);
      const result: HeartbeatResult = { status: "stalled", message: "Blocked." };

      await reporter.reportHeartbeatResult("bmad-dev", "issue-1", result);

      const addComment = mockClient.addIssueComment as ReturnType<typeof vi.fn>;
      const [, comment] = addComment.mock.calls[0];
      expect(comment).not.toContain("Workspace Artifacts");
    });
  });
});

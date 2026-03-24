/**
 * issue-status Tool — Unit Tests
 *
 * Tests the Paperclip-backed issue_status tool:
 * - read: lists sibling issues
 * - update: changes status and/or metadata
 * - reassign: resolves agent ID, releases checkout, updates assignee
 * - Error handling for missing context, bad parameters, API failures
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Capture tool handler
type ToolHandler = (args: Record<string, unknown>) => Promise<{ textResultForLlm: string; resultType: string }>;
let capturedHandler: ToolHandler;

vi.mock("@github/copilot-sdk", () => ({
  CopilotClient: vi.fn(),
  approveAll: vi.fn(),
  defineTool: vi.fn((_name: string, opts: { handler: ToolHandler }) => {
    if (_name === "issue_status") capturedHandler = opts.handler;
    return { name: _name };
  }),
}));

vi.mock("../../src/observability/logger.js", () => ({
  Logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
}));

vi.mock("../../src/observability/tracing.js", () => ({
  traceAgentDispatch: vi.fn(),
}));

vi.mock("../../src/observability/metrics.js", () => ({
  recordDispatchDuration: vi.fn(),
  recordSessionOpen: vi.fn(),
  recordSessionClose: vi.fn(),
}));

import { setToolContext, clearToolContext } from "../../src/tools/tool-context.js";
import type { PaperclipClient } from "../../src/adapter/paperclip-client.js";

// Force module load
await import("../../src/tools/issue-status.js");

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

function makeMockClient(overrides?: Record<string, unknown>): PaperclipClient {
  return {
    getIssue: vi.fn().mockResolvedValue({
      id: "issue-1",
      title: "Current issue",
      status: "in_progress",
      parentId: "parent-1",
      metadata: { storyId: "S-001", workPhase: "dev-story" },
    }),
    createIssue: vi.fn(),
    updateIssue: vi.fn().mockResolvedValue(undefined),
    listIssues: vi.fn().mockResolvedValue([
      {
        id: "issue-1",
        title: "Story 1",
        status: "in_progress",
        metadata: { storyId: "S-001", workPhase: "dev-story", reviewPasses: 0 },
      },
      {
        id: "issue-2",
        title: "Story 2",
        status: "backlog",
        metadata: { storyId: "S-002", bmadPhase: "execute", reviewPasses: 0 },
      },
    ]),
    addIssueComment: vi.fn().mockResolvedValue(undefined),
    releaseIssue: vi.fn().mockResolvedValue(undefined),
    checkoutIssue: vi.fn(),
    listAgents: vi.fn().mockResolvedValue([
      { id: "agent-dev-uuid", name: "bmad-dev", metadata: { bmadRole: "bmad-dev" } },
      { id: "agent-qa-uuid", name: "bmad-qa", metadata: { bmadRole: "bmad-qa" } },
    ]),
    ...overrides,
  } as unknown as PaperclipClient;
}

function setCtx(client?: PaperclipClient) {
  setToolContext({
    paperclipClient: client ?? makeMockClient(),
    agentId: "agent-1",
    issueId: "issue-1",
    parentIssueId: "parent-1",
    workspaceDir: "/workspace",
    companyId: "co-1",
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("issue_status tool", () => {
  beforeEach(() => {
    clearToolContext();
  });

  afterEach(() => {
    clearToolContext();
  });

  it("returns failure when no tool context is available", async () => {
    const result = await capturedHandler({ action: "read" });

    expect(result.resultType).toBe("failure");
    expect(result.textResultForLlm).toContain("No tool context available");
  });

  // ─── READ action ──────────────────────────────────────────────────

  describe("action=read", () => {
    it("lists all sibling issues via parent", async () => {
      const client = makeMockClient();
      setCtx(client);

      const result = await capturedHandler({ action: "read" });

      expect(result.resultType).toBe("success");
      expect(result.textResultForLlm).toContain("ISSUE STATUS");
      expect(result.textResultForLlm).toContain("Story 1");
      expect(result.textResultForLlm).toContain("Story 2");
      expect(result.textResultForLlm).toContain("done");
    });

    it("returns current issue info when no parent exists", async () => {
      const client = makeMockClient({
        getIssue: vi.fn().mockResolvedValue({
          id: "issue-1",
          title: "Solo issue",
          status: "todo",
          assigneeAgentId: "agent-1",
          metadata: {},
        }),
      });
      setCtx(client);

      const result = await capturedHandler({ action: "read" });

      expect(result.resultType).toBe("success");
      expect(result.textResultForLlm).toContain("Solo issue");
      expect(result.textResultForLlm).toContain("No parent issue");
    });

    it("handles API failure gracefully", async () => {
      const client = makeMockClient({
        getIssue: vi.fn().mockRejectedValue(new Error("Connection refused")),
      });
      setCtx(client);

      const result = await capturedHandler({ action: "read" });

      expect(result.resultType).toBe("failure");
      expect(result.textResultForLlm).toContain("Connection refused");
    });
  });

  // ─── UPDATE action ────────────────────────────────────────────────

  describe("action=update", () => {
    it("updates issue status", async () => {
      const client = makeMockClient();
      setCtx(client);

      const result = await capturedHandler({
        action: "update",
        new_status: "done",
      });

      expect(result.resultType).toBe("success");
      expect(result.textResultForLlm).toContain("updated");
      expect(client.updateIssue).toHaveBeenCalledWith("issue-1", expect.objectContaining({
        status: "done",
      }));
    });

    it("updates issue metadata", async () => {
      const client = makeMockClient();
      setCtx(client);

      const result = await capturedHandler({
        action: "update",
        metadata_updates: '{"workPhase": "code-review"}',
      });

      expect(result.resultType).toBe("success");
      expect(client.updateIssue).toHaveBeenCalledWith("issue-1", expect.objectContaining({
        metadata: expect.objectContaining({ workPhase: "code-review" }),
      }));
    });

    it("posts comment when provided", async () => {
      const client = makeMockClient();
      setCtx(client);

      const result = await capturedHandler({
        action: "update",
        new_status: "blocked",
        comment: "Waiting for API spec",
      });

      expect(result.resultType).toBe("success");
      expect(client.addIssueComment).toHaveBeenCalledWith("issue-1", "Waiting for API spec");
    });

    it("returns failure when neither status nor metadata provided", async () => {
      setCtx();

      const result = await capturedHandler({ action: "update" });

      expect(result.resultType).toBe("failure");
      expect(result.textResultForLlm).toContain("requires new_status or metadata_updates");
    });

    it("handles invalid metadata JSON", async () => {
      setCtx();

      const result = await capturedHandler({
        action: "update",
        metadata_updates: "not-valid-json",
      });

      expect(result.resultType).toBe("failure");
      expect(result.textResultForLlm).toContain("parsing metadata_updates");
    });

    it("accepts explicit issue_id", async () => {
      const client = makeMockClient();
      setCtx(client);

      await capturedHandler({
        action: "update",
        issue_id: "other-issue-99",
        new_status: "todo",
      });

      expect(client.updateIssue).toHaveBeenCalledWith("other-issue-99", expect.anything());
    });
  });

  // ─── REASSIGN action ─────────────────────────────────────────────

  describe("action=reassign", () => {
    it("reassigns to target role", async () => {
      const client = makeMockClient();
      setCtx(client);

      const result = await capturedHandler({
        action: "reassign",
        target_role: "bmad-qa",
      });

      expect(result.resultType).toBe("success");
      expect(result.textResultForLlm).toContain("reassigned");
      expect(result.textResultForLlm).toContain("bmad-qa");
      // Should release checkout first
      expect(client.releaseIssue).toHaveBeenCalledWith("issue-1");
      // Should update assignee
      expect(client.updateIssue).toHaveBeenCalledWith("issue-1", expect.objectContaining({
        assigneeAgentId: "agent-qa-uuid",
      }));
    });

    it("returns failure when target_role is missing", async () => {
      setCtx();

      const result = await capturedHandler({ action: "reassign" });

      expect(result.resultType).toBe("failure");
      expect(result.textResultForLlm).toContain("target_role");
    });

    it("returns failure when target agent cannot be resolved", async () => {
      const client = makeMockClient({
        listAgents: vi.fn().mockResolvedValue([]),
      });
      setCtx(client);

      const result = await capturedHandler({
        action: "reassign",
        target_role: "bmad-nonexistent",
      });

      expect(result.resultType).toBe("failure");
      expect(result.textResultForLlm).toContain("Could not find");
    });

    it("posts default handoff comment", async () => {
      const client = makeMockClient();
      setCtx(client);

      await capturedHandler({
        action: "reassign",
        target_role: "bmad-dev",
      });

      expect(client.addIssueComment).toHaveBeenCalledWith(
        "issue-1",
        expect.stringContaining("reassigned"),
      );
    });

    it("posts custom handoff comment", async () => {
      const client = makeMockClient();
      setCtx(client);

      await capturedHandler({
        action: "reassign",
        target_role: "bmad-dev",
        comment: "Fix the null checks in auth.ts",
      });

      expect(client.addIssueComment).toHaveBeenCalledWith(
        "issue-1",
        "Fix the null checks in auth.ts",
      );
    });
  });

  // ─── Unknown action ───────────────────────────────────────────────

  it("returns failure for unknown action", async () => {
    setCtx();

    const result = await capturedHandler({ action: "delete" });

    expect(result.resultType).toBe("failure");
    expect(result.textResultForLlm).toContain("Unknown action");
  });
});

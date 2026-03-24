/**
 * Issue Reassignment — Unit Tests
 *
 * Tests the reassignIssue helper:
 * - Resolves agent UUID from BMAD role
 * - Releases current checkout
 * - Updates assignee + metadata
 * - Posts handoff comment
 * - Retry with cache clear on agent not found
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@github/copilot-sdk", () => ({
  CopilotClient: vi.fn(),
  approveAll: vi.fn(),
  defineTool: vi.fn((_name: string, _opts: unknown) => ({ name: _name })),
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

import { reassignIssue } from "../../src/adapter/issue-reassignment.js";
import { clearAgentIdCache } from "../../src/adapter/ceo-orchestrator.js";
import type { PaperclipClient } from "../../src/adapter/paperclip-client.js";

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

function makeMockClient(overrides?: Record<string, unknown>): PaperclipClient {
  return {
    getIssue: vi.fn().mockResolvedValue({
      id: "issue-1",
      title: "Test issue",
      status: "in_progress",
      metadata: { workPhase: "dev-story" },
    }),
    createIssue: vi.fn(),
    updateIssue: vi.fn().mockResolvedValue(undefined),
    listIssues: vi.fn().mockResolvedValue([]),
    addIssueComment: vi.fn().mockResolvedValue(undefined),
    releaseIssue: vi.fn().mockResolvedValue(undefined),
    checkoutIssue: vi.fn(),
    listAgents: vi.fn().mockResolvedValue([
      { id: "dev-uuid-001", name: "bmad-dev", title: "Developer", metadata: { bmadRole: "bmad-dev" } },
      { id: "qa-uuid-002", name: "bmad-qa", title: "QA", metadata: { bmadRole: "bmad-qa" } },
      { id: "sm-uuid-003", name: "bmad-sm", title: "Scrum Master", metadata: { bmadRole: "bmad-sm" } },
    ]),
    ...overrides,
  } as unknown as PaperclipClient;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("reassignIssue", () => {
  beforeEach(() => {
    clearAgentIdCache();
  });

  it("resolves agent ID from role and reassigns", async () => {
    const client = makeMockClient();

    await reassignIssue(client, "issue-1", "bmad-qa", "Ready for review");

    // Should release checkout first
    expect(client.releaseIssue).toHaveBeenCalledWith("issue-1");

    // Should update assignee
    expect(client.updateIssue).toHaveBeenCalledWith("issue-1", expect.objectContaining({
      assigneeAgentId: "qa-uuid-002",
    }));

    // Should post handoff comment
    expect(client.addIssueComment).toHaveBeenCalledWith("issue-1", "Ready for review");
  });

  it("merges metadata with existing issue metadata", async () => {
    const client = makeMockClient();

    await reassignIssue(client, "issue-1", "bmad-dev", "Fix bugs", {
      workPhase: "dev-story",
      reviewFixMode: true,
    });

    expect(client.updateIssue).toHaveBeenCalledWith("issue-1", expect.objectContaining({
      assigneeAgentId: "dev-uuid-001",
      metadata: expect.objectContaining({
        workPhase: "dev-story",
        reviewFixMode: true,
      }),
    }));
  });

  it("throws when agent role cannot be resolved", async () => {
    const client = makeMockClient({
      listAgents: vi.fn().mockResolvedValue([]),
    });

    await expect(
      reassignIssue(client, "issue-1", "bmad-nonexistent", "Handoff"),
    ).rejects.toThrow("Cannot reassign");
  });

  it("continues when release checkout fails (non-fatal)", async () => {
    const client = makeMockClient({
      releaseIssue: vi.fn().mockRejectedValue(new Error("Not checked out")),
    });

    // Should not throw
    await reassignIssue(client, "issue-1", "bmad-sm", "Plan sprint");

    expect(client.updateIssue).toHaveBeenCalled();
    expect(client.addIssueComment).toHaveBeenCalled();
  });

  it("continues when handoff comment fails (non-fatal)", async () => {
    const client = makeMockClient({
      addIssueComment: vi.fn().mockRejectedValue(new Error("Comment failed")),
    });

    // Should not throw — reassignment already happened
    await reassignIssue(client, "issue-1", "bmad-qa", "Handoff");

    expect(client.updateIssue).toHaveBeenCalled();
  });

  it("works without metadata parameter", async () => {
    const client = makeMockClient();

    await reassignIssue(client, "issue-1", "bmad-dev", "Simple handoff");

    // Should not include metadata in update
    const updateCall = (client.updateIssue as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(updateCall[1]).toEqual({ assigneeAgentId: "dev-uuid-001" });
  });
});

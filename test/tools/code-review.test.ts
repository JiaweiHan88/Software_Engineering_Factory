/**
 * code-review Tools — Unit Tests
 *
 * Tests for codeReviewTool and codeReviewResultTool:
 * - Review pass tracking via Paperclip issue metadata
 * - Pass limit enforcement and escalation
 * - Approval → issue status 'done'
 * - Rejection with passes remaining
 * - Fallback behavior without tool context
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Capture tool handlers
type ToolHandler = (args: Record<string, unknown>) => Promise<{ textResultForLlm: string; resultType: string }>;
let capturedCodeReviewHandler: ToolHandler;
let capturedCodeReviewResultHandler: ToolHandler;

vi.mock("@github/copilot-sdk", () => ({
  CopilotClient: vi.fn(),
  approveAll: vi.fn(),
  defineTool: vi.fn((_name: string, opts: { handler: ToolHandler }) => {
    if (_name === "code_review") capturedCodeReviewHandler = opts.handler;
    if (_name === "code_review_result") capturedCodeReviewResultHandler = opts.handler;
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

// Force module load to trigger defineTool mock capture
await import("../../src/tools/code-review.js");

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

function makeMockClient(overrides?: Record<string, unknown>): PaperclipClient {
  return {
    getIssue: vi.fn().mockResolvedValue({
      id: "issue-1",
      title: "Test story",
      status: "in_progress",
      metadata: { reviewPasses: 0, storyFilePath: "_bmad-output/stories/S-001.md" },
    }),
    createIssue: vi.fn(),
    updateIssue: vi.fn().mockResolvedValue(undefined),
    listIssues: vi.fn().mockResolvedValue([]),
    addIssueComment: vi.fn().mockResolvedValue(undefined),
    releaseIssue: vi.fn(),
    checkoutIssue: vi.fn(),
    listAgents: vi.fn().mockResolvedValue([]),
    ...overrides,
  } as unknown as PaperclipClient;
}

function setCtx(client?: PaperclipClient, tmpDir = "/workspace") {
  setToolContext({
    paperclipClient: client ?? makeMockClient(),
    agentId: "agent-qa",
    issueId: "issue-1",
    workspaceDir: tmpDir,
    companyId: "co-1",
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// code_review
// ─────────────────────────────────────────────────────────────────────────────

describe("code_review tool", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "code-review-test-"));
    clearToolContext();
  });

  afterEach(async () => {
    clearToolContext();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("increments review pass counter and returns review protocol", async () => {
    const client = makeMockClient();
    setCtx(client, tmpDir);

    const result = await capturedCodeReviewHandler({
      files_to_review: "src/foo.ts,src/bar.ts",
    });

    expect(result.resultType).toBe("success");
    expect(result.textResultForLlm).toContain("Pass 1/");
    expect(result.textResultForLlm).toContain("src/foo.ts");
    expect(result.textResultForLlm).toContain("src/bar.ts");
    // Verify updateIssue was called to increment pass counter
    expect(client.updateIssue).toHaveBeenCalledWith("issue-1", expect.objectContaining({
      metadata: expect.objectContaining({ reviewPasses: 1 }),
    }));
  });

  it("escalates when pass limit exceeded", async () => {
    const client = makeMockClient({
      getIssue: vi.fn().mockResolvedValue({
        id: "issue-1",
        title: "Test story",
        status: "in_progress",
        metadata: { reviewPasses: 3 }, // Already at limit (default 3)
      }),
    });
    setCtx(client, tmpDir);

    const result = await capturedCodeReviewHandler({
      files_to_review: "src/foo.ts",
    });

    expect(result.resultType).toBe("failure");
    expect(result.textResultForLlm).toContain("ESCALATION");
  });

  it("resolves story file path from metadata and reads content", async () => {
    const storyDir = join(tmpDir, "_bmad-output", "stories");
    await mkdir(storyDir, { recursive: true });
    await writeFile(join(storyDir, "S-001.md"), "# Story Content\nAC-1", "utf-8");

    const client = makeMockClient({
      getIssue: vi.fn().mockResolvedValue({
        id: "issue-1",
        title: "Test",
        status: "in_progress",
        metadata: { reviewPasses: 0, storyFilePath: "_bmad-output/stories/S-001.md" },
      }),
    });
    setCtx(client, tmpDir);

    const result = await capturedCodeReviewHandler({
      files_to_review: "src/app.ts",
    });

    expect(result.resultType).toBe("success");
    expect(result.textResultForLlm).toContain("Story Content");
  });

  it("returns failure when Paperclip getIssue fails", async () => {
    const client = makeMockClient({
      getIssue: vi.fn().mockRejectedValue(new Error("API down")),
    });
    setCtx(client, tmpDir);

    const result = await capturedCodeReviewHandler({
      files_to_review: "src/foo.ts",
    });

    expect(result.resultType).toBe("failure");
    expect(result.textResultForLlm).toContain("API down");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// code_review_result
// ─────────────────────────────────────────────────────────────────────────────

describe("code_review_result tool", () => {
  beforeEach(() => {
    clearToolContext();
  });

  afterEach(() => {
    clearToolContext();
  });

  it("marks issue as done when approved", async () => {
    const client = makeMockClient({
      getIssue: vi.fn().mockResolvedValue({
        id: "issue-1",
        title: "Test",
        status: "in_progress",
        metadata: { reviewPasses: 1 },
      }),
    });
    setCtx(client);

    const result = await capturedCodeReviewResultHandler({
      approved: true,
      findings_summary: "All checks passed",
      high_critical_count: 0,
    });

    expect(result.resultType).toBe("success");
    expect(result.textResultForLlm).toContain("APPROVED");
    expect(client.updateIssue).toHaveBeenCalledWith("issue-1", expect.objectContaining({
      status: "done",
    }));
  });

  it("returns rejection with instructions when passes remain", async () => {
    const client = makeMockClient({
      getIssue: vi.fn().mockResolvedValue({
        id: "issue-1",
        title: "Test",
        status: "in_progress",
        metadata: { reviewPasses: 1 },
      }),
    });
    setCtx(client);

    const result = await capturedCodeReviewResultHandler({
      approved: false,
      findings_summary: "Missing null checks",
      high_critical_count: 2,
    });

    expect(result.resultType).toBe("success");
    expect(result.textResultForLlm).toContain("REJECTED");
    expect(result.textResultForLlm).toContain("issue_status");
    expect(result.textResultForLlm).toContain("bmad-dev");
  });

  it("escalates to CEO when max passes exceeded on rejection", async () => {
    const client = makeMockClient({
      getIssue: vi.fn().mockResolvedValue({
        id: "issue-1",
        title: "Failing story",
        status: "in_progress",
        metadata: { reviewPasses: 3, parentIssueId: "parent-1" },
      }),
    });
    setCtx(client);

    const result = await capturedCodeReviewResultHandler({
      approved: false,
      findings_summary: "Critical bugs remain",
      high_critical_count: 3,
    });

    expect(result.resultType).toBe("failure");
    expect(result.textResultForLlm).toContain("ESCALATION");
    // Verify escalation comment was posted on parent issue
    expect(client.addIssueComment).toHaveBeenCalledWith(
      "parent-1",
      expect.stringContaining("ESCALATION"),
    );
  });

  it("falls back gracefully without tool context (approved)", async () => {
    // No tool context set
    const result = await capturedCodeReviewResultHandler({
      approved: true,
      findings_summary: "Looks good",
      high_critical_count: 0,
    });

    expect(result.resultType).toBe("success");
    expect(result.textResultForLlm).toContain("APPROVED");
    expect(result.textResultForLlm).toContain("no Paperclip context");
  });

  it("falls back gracefully without tool context (rejected)", async () => {
    const result = await capturedCodeReviewResultHandler({
      approved: false,
      findings_summary: "Issues found",
      high_critical_count: 1,
    });

    expect(result.resultType).toBe("success");
    expect(result.textResultForLlm).toContain("REJECTED");
    expect(result.textResultForLlm).toContain("no Paperclip context");
  });
});

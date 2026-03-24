/**
 * dev-story Tool — Unit Tests
 *
 * Tests the Paperclip-backed dev_story tool handler:
 * - Reads story from workspace file
 * - Resolves story path from issue metadata
 * - Validates issue status
 * - Handles missing context gracefully
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Capture tool handler via defineTool mock
let capturedDevStoryHandler: (args: Record<string, unknown>) => Promise<{ textResultForLlm: string; resultType: string }>;

vi.mock("@github/copilot-sdk", () => ({
  CopilotClient: vi.fn(),
  approveAll: vi.fn(),
  defineTool: vi.fn((_name: string, opts: { handler: typeof capturedDevStoryHandler }) => {
    if (_name === "dev_story") {
      capturedDevStoryHandler = opts.handler;
    }
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

// Force the module to load (triggers defineTool mock capture)
await import("../../src/tools/dev-story.js");

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

function makeMockClient(overrides?: Partial<PaperclipClient>): PaperclipClient {
  return {
    getIssue: vi.fn().mockResolvedValue({
      id: "issue-1",
      title: "Test story",
      status: "in_progress",
      metadata: { storyFilePath: "_bmad-output/stories/STORY-001.md" },
    }),
    createIssue: vi.fn(),
    updateIssue: vi.fn(),
    listIssues: vi.fn().mockResolvedValue([]),
    addIssueComment: vi.fn(),
    releaseIssue: vi.fn(),
    checkoutIssue: vi.fn(),
    listAgents: vi.fn().mockResolvedValue([]),
    ...overrides,
  } as unknown as PaperclipClient;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("dev_story tool", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "dev-story-test-"));
    clearToolContext();
  });

  afterEach(async () => {
    clearToolContext();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("reads story content from file resolved via issue metadata", async () => {
    const storyContent = "# My Story\n\n## Acceptance Criteria\n- [ ] AC-1";
    const storyDir = join(tmpDir, "_bmad-output", "stories");
    await writeFile(join(storyDir, "STORY-001.md"), storyContent, "utf-8").catch(async () => {
      const { mkdir } = await import("node:fs/promises");
      await mkdir(storyDir, { recursive: true });
      await writeFile(join(storyDir, "STORY-001.md"), storyContent, "utf-8");
    });

    // Re-create with mkdir
    const { mkdir } = await import("node:fs/promises");
    await mkdir(storyDir, { recursive: true });
    await writeFile(join(storyDir, "STORY-001.md"), storyContent, "utf-8");

    const client = makeMockClient({
      getIssue: vi.fn().mockResolvedValue({
        id: "issue-1",
        title: "Test story",
        status: "in_progress",
        metadata: { storyFilePath: "_bmad-output/stories/STORY-001.md" },
      }),
    });

    setToolContext({
      paperclipClient: client,
      agentId: "agent-1",
      issueId: "issue-1",
      workspaceDir: tmpDir,
      companyId: "co-1",
    });

    const result = await capturedDevStoryHandler({});

    expect(result.resultType).toBe("success");
    expect(result.textResultForLlm).toContain("DEV-STORY");
    expect(result.textResultForLlm).toContain("My Story");
    expect(result.textResultForLlm).toContain("AC-1");
  });

  it("returns failure when no story_id or story_file_path and no context", async () => {
    // No tool context set
    const result = await capturedDevStoryHandler({});

    expect(result.resultType).toBe("failure");
    expect(result.textResultForLlm).toContain("story_id or story_file_path is required");
  });

  it("returns failure when issue has non-actionable status", async () => {
    const client = makeMockClient({
      getIssue: vi.fn().mockResolvedValue({
        id: "issue-1",
        title: "Already done",
        status: "done",
        metadata: { storyFilePath: "stories/STORY-001.md" },
      }),
    });

    setToolContext({
      paperclipClient: client,
      agentId: "agent-1",
      issueId: "issue-1",
      workspaceDir: tmpDir,
      companyId: "co-1",
    });

    const result = await capturedDevStoryHandler({});

    expect(result.resultType).toBe("failure");
    expect(result.textResultForLlm).toContain("status");
    expect(result.textResultForLlm).toContain("done");
  });

  it("returns failure when Paperclip getIssue fails", async () => {
    const client = makeMockClient({
      getIssue: vi.fn().mockRejectedValue(new Error("Network timeout")),
    });

    setToolContext({
      paperclipClient: client,
      agentId: "agent-1",
      issueId: "issue-1",
      workspaceDir: tmpDir,
      companyId: "co-1",
    });

    const result = await capturedDevStoryHandler({});

    expect(result.resultType).toBe("failure");
    expect(result.textResultForLlm).toContain("Network timeout");
  });

  it("returns failure when story file does not exist", async () => {
    const client = makeMockClient({
      getIssue: vi.fn().mockResolvedValue({
        id: "issue-1",
        title: "Test",
        status: "in_progress",
        metadata: { storyFilePath: "_bmad-output/stories/NONEXISTENT.md" },
      }),
    });

    setToolContext({
      paperclipClient: client,
      agentId: "agent-1",
      issueId: "issue-1",
      workspaceDir: tmpDir,
      companyId: "co-1",
    });

    const result = await capturedDevStoryHandler({});

    expect(result.resultType).toBe("failure");
    expect(result.textResultForLlm).toContain("Could not read story file");
  });

  it("reads story from explicit story_file_path parameter", async () => {
    const storyPath = join(tmpDir, "custom-story.md");
    await writeFile(storyPath, "# Custom Story Path\n\nContent here", "utf-8");

    const result = await capturedDevStoryHandler({
      story_file_path: storyPath,
      story_id: "CUSTOM-001",
    });

    expect(result.resultType).toBe("success");
    expect(result.textResultForLlm).toContain("Custom Story Path");
  });

  it("includes reassignment instructions in response", async () => {
    const storyPath = join(tmpDir, "story.md");
    await writeFile(storyPath, "# Story\nContent", "utf-8");

    const result = await capturedDevStoryHandler({
      story_file_path: storyPath,
      story_id: "S-001",
    });

    expect(result.resultType).toBe("success");
    expect(result.textResultForLlm).toContain("issue_status");
    expect(result.textResultForLlm).toContain("reassign");
    expect(result.textResultForLlm).toContain("bmad-qa");
  });
});

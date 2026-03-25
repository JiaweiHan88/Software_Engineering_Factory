/**
 * create-story Tool — Unit Tests
 *
 * Tests the Paperclip-backed create_story tool:
 * - Writes story markdown file to workspace
 * - Creates Paperclip issue with correct metadata
 * - Handles missing Paperclip context gracefully
 * - Handles Paperclip API failure (still writes file)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Capture tool handler
type ToolHandler = (args: Record<string, unknown>) => Promise<{ textResultForLlm: string; resultType: string }>;
let capturedHandler: ToolHandler;

vi.mock("@github/copilot-sdk", () => ({
  CopilotClient: vi.fn(),
  approveAll: vi.fn(),
  defineTool: vi.fn((_name: string, opts: { handler: ToolHandler }) => {
    if (_name === "create_story") capturedHandler = opts.handler;
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

// Mock loadConfig to use temp dir for outputDir
let mockOutputDir = "/tmp/test";
vi.mock("../../src/config/index.js", () => ({
  loadConfig: () => ({
    outputDir: mockOutputDir,
    projectRoot: "/project",
    sprintStatusPath: "/project/sprint-status.yaml",
    model: "gpt-4o",
    reviewPassLimit: 3,
    logLevel: "info",
    targetProjectRoot: "/project",
    paperclip: { enabled: false, url: "", agentApiKey: "", companyId: "" },
    observability: { enabled: false },
  }),
}));

import { setToolContext, clearToolContext } from "../../src/tools/tool-context.js";
import type { PaperclipClient } from "../../src/adapter/paperclip-client.js";

// Force module load
await import("../../src/tools/create-story.js");

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

function makeMockClient(overrides?: Record<string, unknown>): PaperclipClient {
  return {
    getIssue: vi.fn(),
    createIssue: vi.fn().mockResolvedValue({
      id: "new-issue-uuid",
      identifier: "BMAD-42",
      title: "Test story",
      status: "backlog",
    }),
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

describe("create_story tool", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "create-story-test-"));
    mockOutputDir = tmpDir;
    clearToolContext();
  });

  afterEach(async () => {
    clearToolContext();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("writes story markdown file to workspace", async () => {
    const result = await capturedHandler({
      epic_id: "epic-1",
      story_id: "STORY-001",
      story_title: "Implement Login",
      story_description: "Build OAuth2 login flow",
    });

    expect(result.resultType).toBe("success");

    // Verify file was written
    const filePath = join(tmpDir, "stories", "STORY-001.md");
    const content = await readFile(filePath, "utf-8");
    expect(content).toContain("# Implement Login");
    expect(content).toContain("STORY-001");
    expect(content).toContain("epic-1");
    expect(content).toContain("Build OAuth2 login flow");
  });

  it("creates Paperclip issue with correct metadata when context is available", async () => {
    const client = makeMockClient();
    setToolContext({
      paperclipClient: client,
      agentId: "agent-sm",
      issueId: "parent-issue",
      parentIssueId: "grandparent-issue",
      workspaceDir: tmpDir,
      companyId: "co-1",
    });

    const result = await capturedHandler({
      epic_id: "epic-2",
      story_id: "STORY-010",
      story_title: "Build API",
      story_description: "REST endpoints",
      story_sequence: 3,
    });

    expect(result.resultType).toBe("success");
    expect(result.textResultForLlm).toContain("BMAD-42");
    expect(result.textResultForLlm).toContain("backlog");

    // Verify createIssue was called with correct payload
    expect(client.createIssue).toHaveBeenCalledWith(expect.objectContaining({
      title: "Build API",
      status: "backlog",
      parentId: "grandparent-issue",
      metadata: expect.objectContaining({
        bmadPhase: "execute",
        storyId: "STORY-010",
        epicId: "epic-2",
        storySequence: 3,
        workPhase: "create-story",
        reviewPasses: 0,
      }),
    }));
  });

  it("uses issueId as parentId when parentIssueId is not set", async () => {
    const client = makeMockClient();
    setToolContext({
      paperclipClient: client,
      agentId: "agent-sm",
      issueId: "current-issue",
      workspaceDir: tmpDir,
      companyId: "co-1",
    });

    await capturedHandler({
      epic_id: "epic-1",
      story_id: "S-001",
      story_title: "Test",
      story_description: "Desc",
    });

    expect(client.createIssue).toHaveBeenCalledWith(expect.objectContaining({
      parentId: "current-issue",
    }));
  });

  it("still writes file when Paperclip issue creation fails", async () => {
    const client = makeMockClient({
      createIssue: vi.fn().mockRejectedValue(new Error("Quota exceeded")),
    });
    setToolContext({
      paperclipClient: client,
      agentId: "agent-sm",
      issueId: "parent",
      workspaceDir: tmpDir,
      companyId: "co-1",
    });

    const result = await capturedHandler({
      epic_id: "epic-1",
      story_id: "STORY-ERR",
      story_title: "Error Story",
      story_description: "This will fail",
    });

    expect(result.resultType).toBe("success");
    expect(result.textResultForLlm).toContain("Quota exceeded");
    expect(result.textResultForLlm).toContain("not tracked in Paperclip");

    // File should still exist
    const filePath = join(tmpDir, "stories", "STORY-ERR.md");
    const s = await stat(filePath);
    expect(s.isFile()).toBe(true);
  });

  it("works without Paperclip context (local-only mode)", async () => {
    // No tool context
    const result = await capturedHandler({
      epic_id: "epic-1",
      story_id: "LOCAL-001",
      story_title: "Local Story",
      story_description: "No Paperclip",
    });

    expect(result.resultType).toBe("success");
    expect(result.textResultForLlm).toContain("locally only");

    // File should exist
    const filePath = join(tmpDir, "stories", "LOCAL-001.md");
    const content = await readFile(filePath, "utf-8");
    expect(content).toContain("Local Story");
  });

  it("defaults story_sequence to 0 when not provided", async () => {
    const client = makeMockClient();
    setToolContext({
      paperclipClient: client,
      agentId: "agent-sm",
      issueId: "parent",
      workspaceDir: tmpDir,
      companyId: "co-1",
    });

    await capturedHandler({
      epic_id: "epic-1",
      story_id: "S-001",
      story_title: "Test",
      story_description: "Desc",
    });

    expect(client.createIssue).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({ storySequence: 0 }),
    }));
  });

  it("includes story file path in issue metadata", async () => {
    const client = makeMockClient();
    setToolContext({
      paperclipClient: client,
      agentId: "agent-sm",
      issueId: "parent",
      workspaceDir: tmpDir,
      companyId: "co-1",
    });

    await capturedHandler({
      epic_id: "epic-1",
      story_id: "S-PATHS",
      story_title: "Path Test",
      story_description: "Desc",
    });

    expect(client.createIssue).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({
        storyFilePath: "_bmad-output/stories/S-PATHS.md",
      }),
    }));
  });
});

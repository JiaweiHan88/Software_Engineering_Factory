/**
 * quality_gate_evaluate tool — Unit Tests (P1-1)
 *
 * Verifies the Paperclip-backed gate evaluation:
 * - Rejects when no tool context is available
 * - Validates story ID matches checked-out issue metadata
 * - Updates issue status to 'done' on PASS
 * - Increments reviewPasses metadata on FAIL
 * - Persists escalation metadata on ESCALATE
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

let capturedHandler: (args: Record<string, unknown>) => Promise<{ textResultForLlm: string; resultType: string }>;

vi.mock("@github/copilot-sdk", () => ({
  CopilotClient: vi.fn(),
  approveAll: vi.fn(),
  defineTool: vi.fn((_name: string, opts: { handler: typeof capturedHandler }) => {
    capturedHandler = opts.handler;
    return { name: _name };
  }),
}));

vi.mock("../src/observability/logger.js", () => ({
  Logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
}));

vi.mock("../src/observability/tracing.js", () => ({ traceQualityGate: vi.fn() }));
vi.mock("../src/observability/metrics.js", () => ({
  recordReviewPass: vi.fn(),
  recordGateVerdict: vi.fn(),
}));

import { setToolContext, clearToolContext } from "../src/tools/tool-context.js";
import type { ToolContext } from "../src/tools/tool-context.js";
import type { PaperclipClient } from "../src/adapter/paperclip-client.js";

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

function makeMockClient(overrides: Partial<{
  status: string;
  storyId: string;
}> = {}): PaperclipClient {
  const status = overrides.status ?? "in_progress";
  const storyId = overrides.storyId ?? "STORY-001";

  return {
    getIssue: vi.fn().mockResolvedValue({
      id: "issue-abc",
      title: "Implement login",
      status,
      metadata: { storyId, reviewPasses: 0 },
      identifier: "TEST-1",
    }),
    updateIssue: vi.fn().mockResolvedValue({}),
  } as unknown as PaperclipClient;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("quality_gate_evaluate — P1-1 Paperclip integration", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "qg-tool-test-"));
    process.env.BMAD_OUTPUT_DIR = tmpDir;
    process.env.BMAD_SPRINT_STATUS_PATH = join(tmpDir, "sprint-status.yaml");
    clearToolContext();

    // Trigger module to register the tool via defineTool mock
    await import("../src/quality-gates/tool.js");
  });

  afterEach(async () => {
    clearToolContext();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("returns failure when no tool context is set", async () => {
    const result = await capturedHandler({
      story_id: "STORY-001",
      findings: [],
    });

    expect(result.resultType).toBe("failure");
    expect(result.textResultForLlm).toContain("No Paperclip tool context");
  });

  it("returns failure when storyId metadata does not match args.story_id", async () => {
    const client = makeMockClient({ storyId: "STORY-999" });
    setToolContext({
      paperclipClient: client,
      agentId: "agent-qa",
      issueId: "issue-abc",
      workspaceDir: tmpDir,
      companyId: "co-1",
    });

    const result = await capturedHandler({
      story_id: "STORY-001",
      findings: [],
    });

    expect(result.resultType).toBe("failure");
    expect(result.textResultForLlm).toContain("does not match checked-out issue storyId");
  });

  it("passes when storyId metadata matches args.story_id (PASS verdict — empty findings)", async () => {
    const client = makeMockClient({ storyId: "STORY-001", status: "in_progress" });
    setToolContext({
      paperclipClient: client,
      agentId: "agent-qa",
      issueId: "issue-abc",
      workspaceDir: tmpDir,
      companyId: "co-1",
    });

    const result = await capturedHandler({
      story_id: "STORY-001",
      findings: [],
    });

    // No blocking findings → PASS
    expect(result.resultType).toBe("success");
    expect(result.textResultForLlm).toContain("PASS");

    // status should be updated to 'done' in Paperclip
    const updateCall = (client.updateIssue as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(updateCall[0]).toBe("issue-abc");
    expect(updateCall[1].status).toBe("done");
    expect(updateCall[1].metadata.lastReviewVerdict).toBe("PASS");
  });

  it("returns failure verdict and updates metadata on FAIL (blocking findings)", async () => {
    const client = makeMockClient({ storyId: "STORY-001", status: "review" });
    setToolContext({
      paperclipClient: client,
      agentId: "agent-qa",
      issueId: "issue-abc",
      workspaceDir: tmpDir,
      companyId: "co-1",
    });

    const result = await capturedHandler({
      story_id: "STORY-001",
      findings: [
        {
          id: "F-001",
          severity: "HIGH",
          category: "security",
          file_path: "src/auth.ts",
          line: 10,
          title: "SQL injection",
          description: "User input concatenated into SQL.",
          fixed: false,
        },
      ],
    });

    expect(result.resultType).toBe("failure");
    expect(result.textResultForLlm).toContain("FAIL");

    // Metadata should have reviewPasses incremented and FAIL verdict
    const updateCall = (client.updateIssue as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(updateCall[1].metadata.lastReviewVerdict).toBe("FAIL");
    expect(updateCall[1].metadata.reviewPasses).toBe(1);
    // Status should NOT change to 'done' on FAIL
    expect(updateCall[1].status).toBeUndefined();
  });

  it("does not use sprint-status.yaml at all", async () => {
    const client = makeMockClient({ storyId: "STORY-001" });
    setToolContext({
      paperclipClient: client,
      agentId: "agent-qa",
      issueId: "issue-abc",
      workspaceDir: tmpDir,
      companyId: "co-1",
    });

    await capturedHandler({ story_id: "STORY-001", findings: [] });

    // No sprint-status.yaml file should be created
    const { existsSync } = await import("node:fs");
    expect(existsSync(join(tmpDir, "sprint-status.yaml"))).toBe(false);
  });
});

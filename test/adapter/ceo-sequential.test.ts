/**
 * CEO Sequential Promotion — Unit Tests
 *
 * Tests the M1 sequential story promotion logic and M3 epic completion
 * detection in reEvaluateDelegation():
 * - Promotes only the first non-done story in sequence order
 * - Promotes non-story tasks based on dependency graph
 * - Detects epic completion and creates retro sub-issues
 * - Closes parent when all children are done
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

import {
  reEvaluateDelegation,
  clearAgentIdCache,
} from "../../src/adapter/ceo-orchestrator.js";
import type { PaperclipClient, PaperclipIssue } from "../../src/adapter/paperclip-client.js";
import type { SessionManager } from "../../src/adapter/session-manager.js";
import type { BmadConfig } from "../../src/config/config.js";

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

function makeParentIssue(overrides?: Partial<PaperclipIssue>): PaperclipIssue {
  return {
    id: "parent-1",
    title: "Epic: Build Auth System",
    description: "Build the authentication system",
    status: "in_progress",
    ...overrides,
  } as PaperclipIssue;
}

function makeChild(overrides: Partial<PaperclipIssue> & { id: string }): PaperclipIssue {
  return {
    title: "Child task",
    description: "Description",
    status: "backlog",
    ...overrides,
  } as PaperclipIssue;
}

function makeMockClient(children: PaperclipIssue[], overrides?: Record<string, unknown>): PaperclipClient {
  return {
    getIssue: vi.fn().mockResolvedValue(makeParentIssue()),
    createIssue: vi.fn().mockResolvedValue({ id: "new-retro-issue" }),
    updateIssue: vi.fn().mockResolvedValue(undefined),
    listIssues: vi.fn().mockResolvedValue(children),
    addIssueComment: vi.fn().mockResolvedValue(undefined),
    releaseIssue: vi.fn(),
    checkoutIssue: vi.fn(),
    listAgents: vi.fn().mockResolvedValue([
      { id: "sm-uuid", name: "bmad-sm", metadata: { bmadRole: "bmad-sm" } },
      { id: "dev-uuid", name: "bmad-dev", metadata: { bmadRole: "bmad-dev" } },
      { id: "qa-uuid", name: "bmad-qa", metadata: { bmadRole: "bmad-qa" } },
    ]),
    ...overrides,
  } as unknown as PaperclipClient;
}

function makeMockSessionManager(): SessionManager {
  return {
    createAgentSession: vi.fn().mockResolvedValue("session-1"),
    sendAndWait: vi.fn().mockResolvedValue('{"actions":[]}'),
    close: vi.fn(),
    closeSession: vi.fn(),
  } as unknown as SessionManager;
}

function makeMockConfig(): BmadConfig {
  return {
    gheHost: undefined,
    model: "gpt-4o",
    outputDir: "/output",
    sprintStatusPath: "/sprint.yaml",
    reviewPassLimit: 3,
    logLevel: "info",
    projectRoot: "/project",
    targetProjectRoot: "/target",
    paperclip: {
      enabled: true,
      url: "http://localhost:3100",
      agentApiKey: "key",
      companyId: "co-1",
      inboxCheckIntervalMs: 5000,
      timeoutMs: 30000,
      mode: "inbox-polling",
      webhookPort: 3200,
    },
    observability: {
      logLevel: "info",
      logFormat: "json",
      otelEnabled: false,
      otelEndpoint: "",
      otelServiceName: "test",
      stallCheckIntervalMs: 30000,
      stallAutoEscalate: false,
    },
  } as unknown as BmadConfig;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("reEvaluateDelegation — sequential promotion", () => {
  beforeEach(() => {
    clearAgentIdCache();
  });

  it("returns allDone=true and closes parent when all children are done", async () => {
    const children = [
      makeChild({ id: "c-1", status: "done", metadata: { taskIndex: 0 } }),
      makeChild({ id: "c-2", status: "done", metadata: { taskIndex: 1 } }),
    ];
    const client = makeMockClient(children);

    const result = await reEvaluateDelegation(
      makeParentIssue(),
      client,
      makeMockSessionManager(),
      makeMockConfig(),
    );

    expect(result.allDone).toBe(true);
    expect(client.updateIssue).toHaveBeenCalledWith("parent-1", { status: "done" });
  });

  it("returns idle when no active children", async () => {
    const client = makeMockClient([]);

    const result = await reEvaluateDelegation(
      makeParentIssue(),
      client,
      makeMockSessionManager(),
      makeMockConfig(),
    );

    expect(result.allDone).toBe(true);
    expect(result.promoted).toBe(0);
  });

  it("promotes non-story backlog task with no dependencies", async () => {
    const children = [
      makeChild({
        id: "c-1",
        status: "backlog",
        metadata: { taskIndex: 0, dependsOn: [] },
      }),
    ];
    const client = makeMockClient(children);

    const result = await reEvaluateDelegation(
      makeParentIssue(),
      client,
      makeMockSessionManager(),
      makeMockConfig(),
    );

    expect(result.promoted).toBe(1);
    expect(client.updateIssue).toHaveBeenCalledWith("c-1", { status: "todo" });
  });

  it("promotes non-story backlog task when dependencies are met", async () => {
    const children = [
      makeChild({
        id: "c-1",
        status: "done",
        metadata: { taskIndex: 0 },
      }),
      makeChild({
        id: "c-2",
        status: "backlog",
        metadata: { taskIndex: 1, dependsOn: [0] },
      }),
    ];
    const client = makeMockClient(children);

    const result = await reEvaluateDelegation(
      makeParentIssue(),
      client,
      makeMockSessionManager(),
      makeMockConfig(),
    );

    expect(result.promoted).toBe(1);
    expect(client.updateIssue).toHaveBeenCalledWith("c-2", { status: "todo" });
  });

  it("does NOT promote non-story task when dependencies are not met", async () => {
    const children = [
      makeChild({
        id: "c-1",
        status: "in_progress",
        metadata: { taskIndex: 0 },
      }),
      makeChild({
        id: "c-2",
        status: "backlog",
        metadata: { taskIndex: 1, dependsOn: [0] },
      }),
    ];
    const client = makeMockClient(children);

    const result = await reEvaluateDelegation(
      makeParentIssue(),
      client,
      makeMockSessionManager(),
      makeMockConfig(),
    );

    expect(result.promoted).toBe(0);
  });

  it("promotes only the first backlog story in sequence order", async () => {
    const children = [
      makeChild({
        id: "story-1",
        status: "done",
        metadata: { bmadPhase: "execute", storySequence: 1, epicId: "E1" },
      }),
      makeChild({
        id: "story-2",
        status: "backlog",
        metadata: { bmadPhase: "execute", storySequence: 2, epicId: "E1" },
      }),
      makeChild({
        id: "story-3",
        status: "backlog",
        metadata: { bmadPhase: "execute", storySequence: 3, epicId: "E1" },
      }),
    ];
    const client = makeMockClient(children);

    const result = await reEvaluateDelegation(
      makeParentIssue(),
      client,
      makeMockSessionManager(),
      makeMockConfig(),
    );

    expect(result.promoted).toBe(1);
    // story-2 (sequence 2) should be promoted, not story-3
    expect(client.updateIssue).toHaveBeenCalledWith("story-2", expect.objectContaining({
      status: "todo",
      metadata: expect.objectContaining({ workPhase: "create-story" }),
    }));
    // story-3 should NOT be promoted
    const updateCalls = (client.updateIssue as ReturnType<typeof vi.fn>).mock.calls;
    const story3Updated = updateCalls.some(
      (call: unknown[]) => call[0] === "story-3" && (call[1] as Record<string, unknown>).status === "todo",
    );
    expect(story3Updated).toBe(false);
  });

  it("does NOT promote story when the first non-done is in_progress", async () => {
    const children = [
      makeChild({
        id: "story-1",
        status: "in_progress",
        metadata: { bmadPhase: "execute", storySequence: 1, epicId: "E1" },
      }),
      makeChild({
        id: "story-2",
        status: "backlog",
        metadata: { bmadPhase: "execute", storySequence: 2, epicId: "E1" },
      }),
    ];
    const client = makeMockClient(children);

    const result = await reEvaluateDelegation(
      makeParentIssue(),
      client,
      makeMockSessionManager(),
      makeMockConfig(),
    );

    // story-1 is in_progress (not backlog), so story-2 can't be promoted yet
    expect(result.promoted).toBe(0);
  });

  it("assigns promoted story to SM with workPhase create-story", async () => {
    const children = [
      makeChild({
        id: "story-1",
        status: "backlog",
        metadata: { bmadPhase: "execute", storySequence: 1, epicId: "E1" },
      }),
    ];
    const client = makeMockClient(children);

    await reEvaluateDelegation(
      makeParentIssue(),
      client,
      makeMockSessionManager(),
      makeMockConfig(),
    );

    expect(client.updateIssue).toHaveBeenCalledWith("story-1", expect.objectContaining({
      assigneeAgentId: "sm-uuid",
      metadata: expect.objectContaining({ workPhase: "create-story" }),
    }));
  });

  it("skips cancelled children", async () => {
    const children = [
      makeChild({ id: "c-1", status: "cancelled", metadata: { taskIndex: 0 } }),
      makeChild({ id: "c-2", status: "done", metadata: { taskIndex: 1 } }),
    ];
    const client = makeMockClient(children);

    const result = await reEvaluateDelegation(
      makeParentIssue(),
      client,
      makeMockSessionManager(),
      makeMockConfig(),
    );

    // Only c-2 is active and it's done → allDone
    expect(result.allDone).toBe(true);
  });
});

describe("reEvaluateDelegation — epic completion detection (M3)", () => {
  beforeEach(() => {
    clearAgentIdCache();
  });

  it("creates retro sub-issue when all epic stories are done", async () => {
    const children = [
      makeChild({
        id: "story-1",
        status: "done",
        metadata: { bmadPhase: "execute", epicId: "epic-auth", storySequence: 1 },
      }),
      makeChild({
        id: "story-2",
        status: "done",
        metadata: { bmadPhase: "execute", epicId: "epic-auth", storySequence: 2 },
      }),
      // A non-story task still in progress — prevents early "allDone" return
      makeChild({
        id: "docs-1",
        status: "in_progress",
        metadata: { taskIndex: 5, bmadPhase: "review" },
      }),
    ];
    const client = makeMockClient(children);

    await reEvaluateDelegation(
      makeParentIssue(),
      client,
      makeMockSessionManager(),
      makeMockConfig(),
    );

    expect(client.createIssue).toHaveBeenCalledWith(expect.objectContaining({
      title: expect.stringContaining("Retrospective"),
      status: "todo",
      metadata: expect.objectContaining({
        isRetrospective: true,
        epicId: "epic-auth",
      }),
    }));
  });

  it("does NOT create retro if one already exists", async () => {
    const children = [
      makeChild({
        id: "story-1",
        status: "done",
        metadata: { bmadPhase: "execute", epicId: "epic-auth", storySequence: 1 },
      }),
      // Existing retro
      makeChild({
        id: "retro-1",
        status: "in_progress",
        metadata: { isRetrospective: true, epicId: "epic-auth" },
      }),
    ];
    const client = makeMockClient(children);

    await reEvaluateDelegation(
      makeParentIssue(),
      client,
      makeMockSessionManager(),
      makeMockConfig(),
    );

    expect(client.createIssue).not.toHaveBeenCalled();
  });

  it("does NOT create retro when some epic stories are not done", async () => {
    const children = [
      makeChild({
        id: "story-1",
        status: "done",
        metadata: { bmadPhase: "execute", epicId: "epic-auth", storySequence: 1 },
      }),
      makeChild({
        id: "story-2",
        status: "in_progress",
        metadata: { bmadPhase: "execute", epicId: "epic-auth", storySequence: 2 },
      }),
    ];
    const client = makeMockClient(children);

    await reEvaluateDelegation(
      makeParentIssue(),
      client,
      makeMockSessionManager(),
      makeMockConfig(),
    );

    expect(client.createIssue).not.toHaveBeenCalled();
  });
});

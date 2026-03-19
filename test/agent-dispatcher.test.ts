/**
 * Agent Dispatcher — Unit Tests
 *
 * Tests phase-to-agent mapping, tool selection, model strategy integration,
 * dispatch flow, and error handling with a mocked SessionManager.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the Copilot SDK
vi.mock("@github/copilot-sdk", () => ({
  CopilotClient: vi.fn(),
  approveAll: vi.fn(),
  defineTool: vi.fn((_name: string, _opts: unknown) => ({ name: _name })),
}));

// Mock observability
vi.mock("../src/observability/logger.js", () => ({
  Logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
}));

vi.mock("../src/observability/tracing.js", () => ({
  traceAgentDispatch: vi.fn(
    async (_agent: string, _phase: string, _story: string, fn: (span: { setAttribute: () => void }) => Promise<unknown>) =>
      fn({ setAttribute: vi.fn() } as unknown as { setAttribute: () => void }),
  ),
}));

vi.mock("../src/observability/metrics.js", () => ({
  recordDispatchDuration: vi.fn(),
  recordSessionOpen: vi.fn(),
  recordSessionClose: vi.fn(),
}));

import { AgentDispatcher } from "../src/adapter/agent-dispatcher.js";
import type { WorkItem } from "../src/adapter/agent-dispatcher.js";
import type { SessionManager } from "../src/adapter/session-manager.js";
import type { BmadConfig } from "../src/config/config.js";

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

function makeConfig(): BmadConfig {
  return {
    gheHost: undefined,
    model: "test-model",
    outputDir: "/tmp/test",
    sprintStatusPath: "/tmp/test/sprint-status.yaml",
    reviewPassLimit: 3,
    logLevel: "warning",
    projectRoot: "/tmp/test",
    targetProjectRoot: "/tmp/test",
    paperclip: {
      url: "http://localhost:3100",
      agentApiKey: "",
      companyId: "test",
      inboxCheckIntervalMs: 15000,
      timeoutMs: 10000,
      enabled: false,
      mode: "inbox-polling" as const,
      webhookPort: 3200,
    },
    observability: {
      logLevel: "info",
      logFormat: "human",
      otelEnabled: false,
      otelEndpoint: "http://localhost:4317",
      otelServiceName: "test",
      stallCheckIntervalMs: 60000,
      stallAutoEscalate: false,
    },
  };
}

function makeMockSessionManager(): SessionManager {
  return {
    start: vi.fn(),
    stop: vi.fn(),
    createAgentSession: vi.fn().mockResolvedValue("session-test-123"),
    sendAndWait: vi.fn().mockResolvedValue("Agent completed the task."),
    closeSession: vi.fn(),
    setSessionStory: vi.fn(),
    getSessionInfo: vi.fn(),
    isReady: true,
    activeSessionCount: 0,
  } as unknown as SessionManager;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("AgentDispatcher", () => {
  let mockMgr: SessionManager;
  let dispatcher: AgentDispatcher;

  beforeEach(() => {
    vi.clearAllMocks();
    mockMgr = makeMockSessionManager();
    dispatcher = new AgentDispatcher(mockMgr, makeConfig());
  });

  describe("phase-to-agent routing", () => {
    it("routes create-story to bmad-pm", async () => {
      const item: WorkItem = { id: "w-1", phase: "create-story", storyId: "S-001", storyTitle: "Test Story" };
      const result = await dispatcher.dispatch(item);

      expect(result.success).toBe(true);
      expect(result.agentName).toBe("bmad-pm");
    });

    it("routes dev-story to bmad-dev", async () => {
      const item: WorkItem = { id: "w-2", phase: "dev-story", storyId: "S-001" };
      const result = await dispatcher.dispatch(item);

      expect(result.success).toBe(true);
      expect(result.agentName).toBe("bmad-dev");
    });

    it("routes code-review to bmad-qa", async () => {
      const item: WorkItem = { id: "w-3", phase: "code-review", storyId: "S-001" };
      const result = await dispatcher.dispatch(item);

      expect(result.success).toBe(true);
      expect(result.agentName).toBe("bmad-qa");
    });

    it("routes sprint-planning to bmad-sm", async () => {
      const item: WorkItem = { id: "w-4", phase: "sprint-planning" };
      const result = await dispatcher.dispatch(item);

      expect(result.success).toBe(true);
      expect(result.agentName).toBe("bmad-sm");
    });

    it("routes sprint-status to bmad-sm", async () => {
      const item: WorkItem = { id: "w-5", phase: "sprint-status" };
      const result = await dispatcher.dispatch(item);

      expect(result.success).toBe(true);
      expect(result.agentName).toBe("bmad-sm");
    });
  });

  describe("dispatch flow", () => {
    it("creates a session, sends prompt, closes session", async () => {
      const item: WorkItem = { id: "w-1", phase: "dev-story", storyId: "S-001" };
      await dispatcher.dispatch(item);

      expect((mockMgr.createAgentSession as ReturnType<typeof vi.fn>)).toHaveBeenCalledOnce();
      expect((mockMgr.sendAndWait as ReturnType<typeof vi.fn>)).toHaveBeenCalledOnce();
      expect((mockMgr.closeSession as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith("session-test-123");
    });

    it("tracks story association on the session", async () => {
      const item: WorkItem = { id: "w-1", phase: "dev-story", storyId: "S-001" };
      await dispatcher.dispatch(item);

      expect((mockMgr.setSessionStory as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith("session-test-123", "S-001");
    });

    it("passes model selection from strategy config", async () => {
      const item: WorkItem = { id: "w-1", phase: "dev-story", storyId: "S-001" };
      await dispatcher.dispatch(item);

      const createOpts = (mockMgr.createAgentSession as ReturnType<typeof vi.fn>).mock.calls[0][0];
      // Model should be resolved from strategy — just check it exists
      expect(createOpts.model).toBeTruthy();
      expect(typeof createOpts.model).toBe("string");
    });

    it("passes streaming callback when provided", async () => {
      const deltas: string[] = [];
      const item: WorkItem = { id: "w-1", phase: "dev-story", storyId: "S-001" };
      await dispatcher.dispatch(item, (d) => deltas.push(d));

      // sendAndWait should be called with the callback
      const sendCall = (mockMgr.sendAndWait as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(sendCall[3]).toBeDefined(); // onDelta callback is 4th arg
    });

    it("includes extra context in the prompt", async () => {
      const item: WorkItem = {
        id: "w-1",
        phase: "dev-story",
        storyId: "S-001",
        extraContext: "Use React for the frontend.",
      };
      await dispatcher.dispatch(item);

      const sendCall = (mockMgr.sendAndWait as ReturnType<typeof vi.fn>).mock.calls[0];
      const prompt = sendCall[1] as string;
      expect(prompt).toContain("Use React for the frontend.");
    });

    it("returns the agent response in the result", async () => {
      const item: WorkItem = { id: "w-1", phase: "sprint-status" };
      const result = await dispatcher.dispatch(item);

      expect(result.response).toBe("Agent completed the task.");
      expect(result.sessionId).toBe("session-test-123");
    });
  });

  describe("error handling", () => {
    it("returns error for unknown phase", async () => {
      const item: WorkItem = { id: "w-1", phase: "unknown-phase" as WorkItem["phase"] };
      const result = await dispatcher.dispatch(item);

      expect(result.success).toBe(false);
      expect(result.error).toContain("Unknown phase");
    });

    it("handles session creation failure gracefully", async () => {
      (mockMgr.createAgentSession as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error("SDK connection failed"),
      );

      const item: WorkItem = { id: "w-1", phase: "dev-story", storyId: "S-001" };
      const result = await dispatcher.dispatch(item);

      expect(result.success).toBe(false);
      expect(result.error).toContain("SDK connection failed");
    });

    it("handles sendAndWait failure gracefully", async () => {
      (mockMgr.sendAndWait as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error("Timeout"),
      );

      const item: WorkItem = { id: "w-1", phase: "dev-story", storyId: "S-001" };
      const result = await dispatcher.dispatch(item);

      expect(result.success).toBe(false);
      expect(result.error).toContain("Timeout");
    });
  });

  describe("dispatchDirect", () => {
    it("dispatches a free-form prompt to a named agent", async () => {
      const result = await dispatcher.dispatchDirect("bmad-dev", "Explain the architecture.");

      expect(result.success).toBe(true);
      expect(result.agentName).toBe("bmad-dev");
      expect(result.response).toBe("Agent completed the task.");
    });

    it("returns error for unknown agent", async () => {
      const result = await dispatcher.dispatchDirect("bmad-nonexistent", "Hello");

      expect(result.success).toBe(false);
      expect(result.error).toContain("Agent not found");
    });

    it("prefixes prompt with @agent mention", async () => {
      await dispatcher.dispatchDirect("bmad-dev", "Explain this.");

      const sendCall = (mockMgr.sendAndWait as ReturnType<typeof vi.fn>).mock.calls[0];
      const prompt = sendCall[1] as string;
      expect(prompt).toContain("@bmad-dev Explain this.");
    });
  });
});

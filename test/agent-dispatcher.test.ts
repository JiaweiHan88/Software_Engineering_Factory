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

    // ── Research phase routing ────────────────────────────────────────
    it("routes research to bmad-analyst", async () => {
      const item: WorkItem = { id: "w-6", phase: "research", storyTitle: "Research APIs" };
      const result = await dispatcher.dispatch(item);

      expect(result.success).toBe(true);
      expect(result.agentName).toBe("bmad-analyst");
    });

    it("routes domain-research to bmad-analyst", async () => {
      const item: WorkItem = { id: "w-7", phase: "domain-research", storyTitle: "Study domain" };
      const result = await dispatcher.dispatch(item);

      expect(result.success).toBe(true);
      expect(result.agentName).toBe("bmad-analyst");
    });

    it("routes market-research to bmad-pm", async () => {
      const item: WorkItem = { id: "w-8", phase: "market-research", storyTitle: "Market study" };
      const result = await dispatcher.dispatch(item);

      expect(result.success).toBe(true);
      expect(result.agentName).toBe("bmad-pm");
    });

    it("routes technical-research to bmad-architect", async () => {
      const item: WorkItem = { id: "w-9", phase: "technical-research", storyTitle: "Tech eval" };
      const result = await dispatcher.dispatch(item);

      expect(result.success).toBe(true);
      expect(result.agentName).toBe("bmad-architect");
    });

    // ── Define phase routing ──────────────────────────────────────────
    it("routes create-prd to bmad-pm", async () => {
      const item: WorkItem = { id: "w-10", phase: "create-prd", storyTitle: "Write PRD" };
      const result = await dispatcher.dispatch(item);

      expect(result.success).toBe(true);
      expect(result.agentName).toBe("bmad-pm");
    });

    it("routes create-architecture to bmad-architect", async () => {
      const item: WorkItem = { id: "w-11", phase: "create-architecture", storyTitle: "Design arch" };
      const result = await dispatcher.dispatch(item);

      expect(result.success).toBe(true);
      expect(result.agentName).toBe("bmad-architect");
    });

    it("routes create-ux-design to bmad-ux-designer", async () => {
      const item: WorkItem = { id: "w-12", phase: "create-ux-design", storyTitle: "Design UI" };
      const result = await dispatcher.dispatch(item);

      expect(result.success).toBe(true);
      expect(result.agentName).toBe("bmad-ux-designer");
    });

    it("routes create-product-brief to bmad-pm", async () => {
      const item: WorkItem = { id: "w-13", phase: "create-product-brief", storyTitle: "Brief" };
      const result = await dispatcher.dispatch(item);

      expect(result.success).toBe(true);
      expect(result.agentName).toBe("bmad-pm");
    });

    // ── Plan phase routing ────────────────────────────────────────────
    it("routes create-epics to bmad-pm", async () => {
      const item: WorkItem = { id: "w-14", phase: "create-epics", storyTitle: "Create epics" };
      const result = await dispatcher.dispatch(item);

      expect(result.success).toBe(true);
      expect(result.agentName).toBe("bmad-pm");
    });

    it("routes check-implementation-readiness to bmad-pm", async () => {
      const item: WorkItem = { id: "w-15", phase: "check-implementation-readiness", storyTitle: "Check" };
      const result = await dispatcher.dispatch(item);

      expect(result.success).toBe(true);
      expect(result.agentName).toBe("bmad-pm");
    });

    // ── Execute phase extensions ──────────────────────────────────────
    it("routes e2e-tests to bmad-qa", async () => {
      const item: WorkItem = { id: "w-16", phase: "e2e-tests", storyTitle: "E2E tests" };
      const result = await dispatcher.dispatch(item);

      expect(result.success).toBe(true);
      expect(result.agentName).toBe("bmad-qa");
    });

    it("routes documentation to bmad-tech-writer", async () => {
      const item: WorkItem = { id: "w-17", phase: "documentation", storyTitle: "Write docs" };
      const result = await dispatcher.dispatch(item);

      expect(result.success).toBe(true);
      expect(result.agentName).toBe("bmad-tech-writer");
    });

    it("routes quick-dev to bmad-quick-flow-solo-dev", async () => {
      const item: WorkItem = { id: "w-18", phase: "quick-dev", storyTitle: "Quick task" };
      const result = await dispatcher.dispatch(item);

      expect(result.success).toBe(true);
      expect(result.agentName).toBe("bmad-quick-flow-solo-dev");
    });

    // ── Review phase extensions ───────────────────────────────────────
    it("routes editorial-review to bmad-tech-writer", async () => {
      const item: WorkItem = { id: "w-19", phase: "editorial-review", storyTitle: "Review prose" };
      const result = await dispatcher.dispatch(item);

      expect(result.success).toBe(true);
      expect(result.agentName).toBe("bmad-tech-writer");
    });

    // ── Generic delegated task ────────────────────────────────────────
    it("routes delegated-task to bmad-dev by default", async () => {
      const item: WorkItem = { id: "w-20", phase: "delegated-task", storyTitle: "CEO task" };
      const result = await dispatcher.dispatch(item);

      expect(result.success).toBe(true);
      expect(result.agentName).toBe("bmad-dev");
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

  describe("agentOverride", () => {
    it("uses agentOverride instead of phase default when provided", async () => {
      const item: WorkItem = {
        id: "w-1",
        phase: "research",
        storyTitle: "Research APIs",
        agentOverride: "bmad-architect",
      };
      const result = await dispatcher.dispatch(item);

      // Phase default is bmad-analyst, but override says bmad-architect
      expect(result.success).toBe(true);
      expect(result.agentName).toBe("bmad-architect");
    });

    it("returns error when agentOverride points to unknown agent", async () => {
      const item: WorkItem = {
        id: "w-1",
        phase: "research",
        storyTitle: "Research",
        agentOverride: "bmad-nonexistent",
      };
      const result = await dispatcher.dispatch(item);

      expect(result.success).toBe(false);
      expect(result.error).toContain("Agent not found: bmad-nonexistent");
    });
  });

  describe("context-driven prompts", () => {
    it("uses issue title and description in expanded phase prompts", async () => {
      const item: WorkItem = {
        id: "w-1",
        phase: "create-architecture",
        storyTitle: "Design microservice architecture",
        storyDescription: "Create a scalable architecture for the payment service.",
      };
      await dispatcher.dispatch(item);

      const sendCall = (mockMgr.sendAndWait as ReturnType<typeof vi.fn>).mock.calls[0];
      const prompt = sendCall[1] as string;
      expect(prompt).toContain("Design microservice architecture");
      expect(prompt).toContain("Create a scalable architecture for the payment service.");
      expect(prompt).toContain("@bmad-architect");
    });

    it("includes extra context in expanded phase prompts", async () => {
      const item: WorkItem = {
        id: "w-1",
        phase: "documentation",
        storyTitle: "Write API docs",
        storyDescription: "Document the REST API endpoints.",
        extraContext: "Use OpenAPI 3.0 format.",
      };
      await dispatcher.dispatch(item);

      const sendCall = (mockMgr.sendAndWait as ReturnType<typeof vi.fn>).mock.calls[0];
      const prompt = sendCall[1] as string;
      expect(prompt).toContain("Use OpenAPI 3.0 format.");
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

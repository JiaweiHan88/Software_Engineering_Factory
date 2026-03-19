/**
 * Session Manager — Unit Tests
 *
 * Tests SessionManager lifecycle, session creation, tracking,
 * model override, and error handling with a mocked CopilotClient.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ─────────────────────────────────────────────────────────────────────────────
// Mocks
// ─────────────────────────────────────────────────────────────────────────────

const mockSetModel = vi.fn();
const mockDisconnect = vi.fn();
const mockOn = vi.fn();
const mockSendAndWait = vi.fn();

const mockSession = {
  sessionId: "session-123",
  setModel: mockSetModel,
  disconnect: mockDisconnect,
  on: mockOn,
  sendAndWait: mockSendAndWait,
};

const mockStart = vi.fn();
const mockStop = vi.fn();
const mockPing = vi.fn().mockResolvedValue({ timestamp: Date.now() });
const mockCreateSession = vi.fn().mockResolvedValue(mockSession);

vi.mock("@github/copilot-sdk", () => ({
  CopilotClient: vi.fn().mockImplementation(() => ({
    start: mockStart,
    stop: mockStop,
    ping: mockPing,
    createSession: mockCreateSession,
  })),
  approveAll: vi.fn(),
  defineTool: vi.fn((_name: string, _opts: unknown) => ({ name: _name })),
}));

vi.mock("../src/observability/logger.js", () => ({
  Logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
}));

vi.mock("../src/observability/metrics.js", () => ({
  recordSessionOpen: vi.fn(),
  recordSessionClose: vi.fn(),
  recordDispatchDuration: vi.fn(),
}));

import { SessionManager } from "../src/adapter/session-manager.js";
import type { BmadConfig } from "../src/config/config.js";
import type { BmadAgent } from "../src/agents/types.js";

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
    paperclip: {
      url: "http://localhost:3100",
      apiKey: "",
      orgId: "test",
      pollIntervalMs: 5000,
      timeoutMs: 10000,
      enabled: false,
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

const testAgent: BmadAgent = {
  name: "bmad-dev",
  displayName: "BMAD Developer",
  description: "Test developer agent",
  prompt: "You are a developer.",
};

const testAgent2: BmadAgent = {
  name: "bmad-pm",
  displayName: "BMAD PM",
  description: "Test PM agent",
  prompt: "You are a PM.",
};

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("SessionManager", () => {
  let mgr: SessionManager;

  beforeEach(() => {
    vi.clearAllMocks();
    mgr = new SessionManager(makeConfig());
    mockSendAndWait.mockResolvedValue({ data: { content: "Agent response" } });
  });

  describe("lifecycle", () => {
    it("starts the CopilotClient and pings", async () => {
      await mgr.start();

      expect(mockStart).toHaveBeenCalledOnce();
      expect(mockPing).toHaveBeenCalledWith("bmad-session-manager");
      expect(mgr.isReady).toBe(true);
    });

    it("is idempotent — multiple start() calls only start once", async () => {
      await mgr.start();
      await mgr.start();

      expect(mockStart).toHaveBeenCalledOnce();
    });

    it("stops the client and cleans up", async () => {
      await mgr.start();

      // Create a session first
      await mgr.createAgentSession({
        agent: testAgent,
        allAgents: [testAgent],
        tools: [],
      });

      await mgr.stop();

      expect(mockDisconnect).toHaveBeenCalledOnce();
      expect(mockStop).toHaveBeenCalledOnce();
      expect(mgr.isReady).toBe(false);
      expect(mgr.activeSessionCount).toBe(0);
    });
  });

  describe("createAgentSession", () => {
    it("throws if manager not started", async () => {
      await expect(
        mgr.createAgentSession({
          agent: testAgent,
          allAgents: [testAgent],
          tools: [],
        }),
      ).rejects.toThrow("SessionManager not started");
    });

    it("creates a session and returns session ID", async () => {
      await mgr.start();

      const sessionId = await mgr.createAgentSession({
        agent: testAgent,
        allAgents: [testAgent, testAgent2],
        tools: [],
      });

      expect(sessionId).toBe("session-123");
      expect(mgr.activeSessionCount).toBe(1);
      expect(mockCreateSession).toHaveBeenCalledOnce();
    });

    it("passes custom agents for @mention support", async () => {
      await mgr.start();

      await mgr.createAgentSession({
        agent: testAgent,
        allAgents: [testAgent, testAgent2],
        tools: [],
      });

      const sessionConfig = mockCreateSession.mock.calls[0][0];
      expect(sessionConfig.customAgents).toHaveLength(2);
      expect(sessionConfig.customAgents[0].name).toBe("bmad-dev");
      expect(sessionConfig.customAgents[1].name).toBe("bmad-pm");
    });

    it("sets model when model option is provided", async () => {
      await mgr.start();

      await mgr.createAgentSession({
        agent: testAgent,
        allAgents: [testAgent],
        tools: [],
        model: "gpt-4o",
      });

      expect(mockSetModel).toHaveBeenCalledWith("gpt-4o");
    });

    it("does not set model when model option is omitted", async () => {
      await mgr.start();

      await mgr.createAgentSession({
        agent: testAgent,
        allAgents: [testAgent],
        tools: [],
      });

      expect(mockSetModel).not.toHaveBeenCalled();
    });

    it("includes skill directories when provided", async () => {
      await mgr.start();

      await mgr.createAgentSession({
        agent: testAgent,
        allAgents: [testAgent],
        tools: [],
        skillDirectories: ["/skills/bmad"],
      });

      const sessionConfig = mockCreateSession.mock.calls[0][0];
      expect(sessionConfig.skillDirectories).toEqual(["/skills/bmad"]);
    });

    it("includes system message when provided", async () => {
      await mgr.start();

      await mgr.createAgentSession({
        agent: testAgent,
        allAgents: [testAgent],
        tools: [],
        systemMessage: "Sprint 1 context: build the factory.",
      });

      const sessionConfig = mockCreateSession.mock.calls[0][0];
      expect(sessionConfig.systemMessage).toEqual({
        mode: "append",
        content: "Sprint 1 context: build the factory.",
      });
    });
  });

  describe("sendAndWait", () => {
    it("sends prompt and returns response", async () => {
      await mgr.start();
      const sessionId = await mgr.createAgentSession({
        agent: testAgent,
        allAgents: [testAgent],
        tools: [],
      });

      const response = await mgr.sendAndWait(sessionId, "Hello!");

      expect(response).toBe("Agent response");
      expect(mockSendAndWait).toHaveBeenCalledWith(
        { prompt: "Hello!" },
        120_000,
      );
    });

    it("throws for unknown session ID", async () => {
      await mgr.start();

      await expect(mgr.sendAndWait("nonexistent", "Hello!")).rejects.toThrow(
        "Session nonexistent not found",
      );
    });

    it("returns empty string when response is null", async () => {
      mockSendAndWait.mockResolvedValueOnce(null);

      await mgr.start();
      const sessionId = await mgr.createAgentSession({
        agent: testAgent,
        allAgents: [testAgent],
        tools: [],
      });

      const response = await mgr.sendAndWait(sessionId, "Hello!");
      expect(response).toBe("");
    });

    it("wires up streaming delta callback", async () => {
      await mgr.start();
      const sessionId = await mgr.createAgentSession({
        agent: testAgent,
        allAgents: [testAgent],
        tools: [],
      });

      const deltas: string[] = [];
      await mgr.sendAndWait(sessionId, "Hello!", 120_000, (d) => deltas.push(d));

      // The on() method should have been called to register the delta listener
      expect(mockOn).toHaveBeenCalledWith("assistant.message_delta", expect.any(Function));
    });
  });

  describe("session tracking", () => {
    it("tracks session info (agent name, message count)", async () => {
      await mgr.start();
      const sessionId = await mgr.createAgentSession({
        agent: testAgent,
        allAgents: [testAgent],
        tools: [],
      });

      const info = mgr.getSessionInfo(sessionId);
      expect(info?.agentName).toBe("bmad-dev");
      expect(info?.messageCount).toBe(0);
      expect(info?.storyId).toBeUndefined();

      // Send a message to increment count
      await mgr.sendAndWait(sessionId, "Test");
      expect(mgr.getSessionInfo(sessionId)?.messageCount).toBe(1);
    });

    it("associates story ID with session", async () => {
      await mgr.start();
      const sessionId = await mgr.createAgentSession({
        agent: testAgent,
        allAgents: [testAgent],
        tools: [],
      });

      mgr.setSessionStory(sessionId, "STORY-001");
      expect(mgr.getSessionInfo(sessionId)?.storyId).toBe("STORY-001");
    });

    it("returns undefined for unknown session info", () => {
      expect(mgr.getSessionInfo("nonexistent")).toBeUndefined();
    });
  });

  describe("closeSession", () => {
    it("disconnects and removes from tracking", async () => {
      await mgr.start();
      const sessionId = await mgr.createAgentSession({
        agent: testAgent,
        allAgents: [testAgent],
        tools: [],
      });

      expect(mgr.activeSessionCount).toBe(1);
      await mgr.closeSession(sessionId);
      expect(mgr.activeSessionCount).toBe(0);
      expect(mockDisconnect).toHaveBeenCalledOnce();
    });

    it("silently handles closing unknown sessions", async () => {
      await mgr.start();
      await mgr.closeSession("nonexistent"); // should not throw
    });
  });
});

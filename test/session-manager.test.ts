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
const mockResumeSession = vi.fn();

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
    resumeSession: mockResumeSession,
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

// ─────────────────────────────────────────────────────────────────────────────
// fs mocks — must be declared before importing SessionManager
// ─────────────────────────────────────────────────────────────────────────────

const mockReadFile = vi.fn();
const mockWriteFile = vi.fn().mockResolvedValue(undefined);
const mockMkdir = vi.fn().mockResolvedValue(undefined);
const mockExistsSync = vi.fn();

vi.mock("node:fs/promises", () => ({
  readFile: (...args: unknown[]) => mockReadFile(...args),
  writeFile: (...args: unknown[]) => mockWriteFile(...args),
  mkdir: (...args: unknown[]) => mockMkdir(...args),
}));

vi.mock("node:fs", () => ({
  existsSync: (...args: unknown[]) => mockExistsSync(...args),
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

    it("removes session from index when removeFromIndex is true", async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFile.mockResolvedValue(
        JSON.stringify({ "bmad-dev:STORY-001": "session-123" }),
      );

      await mgr.start();

      // Create a session with storyId so the tracked record has it
      const sessionId = await mgr.createAgentSession({
        agent: testAgent,
        allAgents: [testAgent],
        tools: [],
        storyId: "STORY-001",
      });

      await mgr.closeSession(sessionId, true);

      // writeFile should have been called with an empty index
      expect(mockWriteFile).toHaveBeenCalledOnce();
      const written = JSON.parse(mockWriteFile.mock.calls[0][1] as string) as Record<string, string>;
      expect(written["bmad-dev:STORY-001"]).toBeUndefined();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // loadSessionIndex
  // ─────────────────────────────────────────────────────────────────────────

  describe("loadSessionIndex (via getOrCreateAgentSession)", () => {
    it("returns empty object when file does not exist", async () => {
      mockExistsSync.mockReturnValue(false);

      await mgr.start();
      // Trigger index load by calling getOrCreateAgentSession with storyId
      // (no existing entry → will call createAgentSession)
      const sessionId = await mgr.getOrCreateAgentSession({
        agent: testAgent,
        allAgents: [testAgent],
        tools: [],
        storyId: "NEW-001",
      });

      expect(mockReadFile).not.toHaveBeenCalled();
      expect(sessionId).toBe("session-123");
    });

    it("loads and caches session index from disk", async () => {
      const existingIndex = { "bmad-pm:STORY-X": "old-session-id" };
      mockExistsSync.mockReturnValue(true);
      mockReadFile.mockResolvedValue(JSON.stringify(existingIndex));

      await mgr.start();
      // First call — loads from disk
      await mgr.getOrCreateAgentSession({
        agent: testAgent,
        allAgents: [testAgent],
        tools: [],
        storyId: "STORY-NEW",
      });
      // Second call — should hit cache (readFile called only once)
      await mgr.getOrCreateAgentSession({
        agent: testAgent,
        allAgents: [testAgent],
        tools: [],
        storyId: "STORY-NEW2",
      });

      expect(mockReadFile).toHaveBeenCalledOnce();
    });

    it("returns empty object on parse error", async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFile.mockResolvedValue("not-valid-json{{{{");

      await mgr.start();
      // Should not throw; falls back to empty index → creates new session
      const sessionId = await mgr.getOrCreateAgentSession({
        agent: testAgent,
        allAgents: [testAgent],
        tools: [],
        storyId: "STORY-ERR",
      });

      expect(sessionId).toBe("session-123");
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // getOrCreateAgentSession
  // ─────────────────────────────────────────────────────────────────────────

  describe("getOrCreateAgentSession", () => {
    it("creates new session when no storyId provided", async () => {
      await mgr.start();

      const sessionId = await mgr.getOrCreateAgentSession({
        agent: testAgent,
        allAgents: [testAgent],
        tools: [],
      });

      expect(mockCreateSession).toHaveBeenCalledOnce();
      expect(mockResumeSession).not.toHaveBeenCalled();
      expect(sessionId).toBe("session-123");
    });

    it("creates new session when no index entry exists", async () => {
      mockExistsSync.mockReturnValue(false);

      await mgr.start();

      const sessionId = await mgr.getOrCreateAgentSession({
        agent: testAgent,
        allAgents: [testAgent],
        tools: [],
        storyId: "STORY-001",
      });

      expect(mockResumeSession).not.toHaveBeenCalled();
      expect(mockCreateSession).toHaveBeenCalledOnce();
      expect(sessionId).toBe("session-123");
    });

    it("resumes existing session when index entry found", async () => {
      const resumedSession = { ...mockSession, sessionId: "resumed-session-456" };
      mockResumeSession.mockResolvedValueOnce(resumedSession);
      mockExistsSync.mockReturnValue(true);
      mockReadFile.mockResolvedValue(
        JSON.stringify({ "bmad-dev:STORY-001": "old-session-id" }),
      );

      await mgr.start();

      const sessionId = await mgr.getOrCreateAgentSession({
        agent: testAgent,
        allAgents: [testAgent],
        tools: [],
        storyId: "STORY-001",
      });

      expect(mockResumeSession).toHaveBeenCalledOnce();
      expect(mockResumeSession).toHaveBeenCalledWith("old-session-id", expect.objectContaining({
        workingDirectory: "/tmp/test",
      }));
      expect(mockCreateSession).not.toHaveBeenCalled();
      expect(sessionId).toBe("resumed-session-456");
    });

    it("falls back to new session when resume fails", async () => {
      mockResumeSession.mockRejectedValueOnce(new Error("session expired"));
      mockExistsSync.mockReturnValue(true);
      mockReadFile.mockResolvedValue(
        JSON.stringify({ "bmad-dev:STORY-001": "dead-session-id" }),
      );

      await mgr.start();

      const sessionId = await mgr.getOrCreateAgentSession({
        agent: testAgent,
        allAgents: [testAgent],
        tools: [],
        storyId: "STORY-001",
      });

      expect(mockResumeSession).toHaveBeenCalledOnce();
      expect(mockCreateSession).toHaveBeenCalledOnce();
      expect(sessionId).toBe("session-123");
    });

    it("persists session mapping after creating new session", async () => {
      mockExistsSync.mockReturnValue(false);

      await mgr.start();

      await mgr.getOrCreateAgentSession({
        agent: testAgent,
        allAgents: [testAgent],
        tools: [],
        storyId: "STORY-PERSIST",
      });

      expect(mockWriteFile).toHaveBeenCalledOnce();
      const writtenContent = JSON.parse(mockWriteFile.mock.calls[0][1] as string) as Record<string, string>;
      expect(writtenContent["bmad-dev:STORY-PERSIST"]).toBe("session-123");
    });

    it("updates index when SDK returns a new session ID on resume", async () => {
      // The Copilot SDK may return a session with a different ID than the stored one.
      // The index must be updated so the next process restart resumes the correct session.
      const resumedSession = { ...mockSession, sessionId: "new-sdk-session-789" };
      mockResumeSession.mockResolvedValueOnce(resumedSession);
      mockExistsSync.mockReturnValue(true);
      mockReadFile.mockResolvedValue(
        JSON.stringify({ "bmad-dev:STORY-001": "old-session-id" }),
      );

      await mgr.start();

      const sessionId = await mgr.getOrCreateAgentSession({
        agent: testAgent,
        allAgents: [testAgent],
        tools: [],
        storyId: "STORY-001",
      });

      expect(sessionId).toBe("new-sdk-session-789");
      // Index should now point to the new session ID
      expect(mockWriteFile).toHaveBeenCalledOnce();
      const written = JSON.parse(mockWriteFile.mock.calls[0][1] as string) as Record<string, string>;
      expect(written["bmad-dev:STORY-001"]).toBe("new-sdk-session-789");
    });

    it("does not write index when SDK returns the same session ID on resume", async () => {
      // No write needed when the session ID is unchanged — avoids unnecessary disk I/O.
      const resumedSession = { ...mockSession, sessionId: "same-session-id" };
      mockResumeSession.mockResolvedValueOnce(resumedSession);
      mockExistsSync.mockReturnValue(true);
      mockReadFile.mockResolvedValue(
        JSON.stringify({ "bmad-dev:STORY-001": "same-session-id" }),
      );

      await mgr.start();

      await mgr.getOrCreateAgentSession({
        agent: testAgent,
        allAgents: [testAgent],
        tools: [],
        storyId: "STORY-001",
      });

      expect(mockResumeSession).toHaveBeenCalledOnce();
      expect(mockWriteFile).not.toHaveBeenCalled();
    });
  });
});

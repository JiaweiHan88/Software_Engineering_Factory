/**
 * Session Manager — Copilot SDK Session Lifecycle
 *
 * Manages a single CopilotClient and creates/tracks sessions for BMAD agents.
 * Each agent gets its own session context so persona prompts stay isolated.
 *
 * Key responsibilities:
 * - Single CopilotClient instance (one CLI process)
 * - Session creation with agent persona + tools + skills
 * - Session caching for multi-turn within same story
 * - Session resume across process restarts and Paperclip heartbeats
 * - Graceful shutdown
 *
 * @module adapter/session-manager
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { CopilotClient, approveAll } from "@github/copilot-sdk";
import type { CopilotSession, CustomAgentConfig, ResumeSessionConfig, SessionConfig } from "@github/copilot-sdk";
import type { Tool } from "../tools/types.js";
import type { BmadAgent } from "../agents/types.js";
import type { BmadConfig } from "../config/config.js";
import { buildClientEnv } from "../config/config.js";
import { Logger } from "../observability/logger.js";
import { recordSessionOpen, recordSessionClose } from "../observability/metrics.js";

const log = Logger.child("session-manager");

/** Filename for the persisted session index stored in outputDir. */
const SESSION_INDEX_FILE = "session-index.json";

/**
 * Persisted map of `${agentName}:${storyId}` → Copilot session ID.
 * Written to disk so sessions can be resumed after process restarts.
 */
type SessionIndexMap = Record<string, string>;

/**
 * Options for creating a new agent session.
 */
export interface AgentSessionOptions {
  /** The BMAD agent to activate in this session */
  agent: BmadAgent;
  /** All BMAD agents to register (for @mentions across roles) */
  allAgents: BmadAgent[];
  /** Tools available to this session */
  tools: Tool<unknown>[];
  /** Copilot SDK skill directories to load */
  skillDirectories?: string[];
  /** Override the default model for this session */
  model?: string;
  /** System message to append (e.g., sprint context) */
  systemMessage?: string;
  /**
   * Story ID to associate with this session.
   * Used by getOrCreateAgentSession() to attempt session resume.
   */
  storyId?: string;
}

/**
 * Tracked session metadata.
 */
interface TrackedSession {
  session: CopilotSession;
  agentName: string;
  storyId?: string;
  createdAt: Date;
  messageCount: number;
}

/**
 * SessionManager wraps CopilotClient with BMAD-aware session management.
 *
 * Usage:
 * ```ts
 * const mgr = new SessionManager(config);
 * await mgr.start();
 * const session = await mgr.createAgentSession({ agent: pm, allAgents, tools });
 * const response = await mgr.sendAndWait(session, "@bmad-pm Create a story...");
 * await mgr.stop();
 * ```
 */
export class SessionManager {
  private client: CopilotClient | null = null;
  private sessions = new Map<string, TrackedSession>();
  private config: BmadConfig;
  private started = false;
  /** Lazy-loaded in-memory cache of the on-disk session index. */
  private sessionIndexCache: SessionIndexMap | null = null;

  constructor(config: BmadConfig) {
    this.config = config;
  }

  /**
   * Start the CopilotClient (launches Copilot CLI process).
   * Must be called before creating sessions.
   */
  async start(): Promise<void> {
    if (this.started) return;

    const env = buildClientEnv(this.config);

    this.client = new CopilotClient({
      logLevel: this.config.logLevel,
      ...(env ? { env } : {}),
    });

    await this.client.start();
    this.started = true;

    // Verify connectivity
    const ping = await this.client.ping("bmad-session-manager");
    log.info("Copilot CLI started", { pingTimestamp: new Date(ping.timestamp).toISOString() });
  }

  /**
   * Load the session index from disk (or return cached copy).
   *
   * @returns Map of `${agentName}:${storyId}` → Copilot session ID
   */
  private async loadSessionIndex(): Promise<SessionIndexMap> {
    if (this.sessionIndexCache !== null) return this.sessionIndexCache;

    const filePath = join(this.config.outputDir, SESSION_INDEX_FILE);
    if (!existsSync(filePath)) {
      this.sessionIndexCache = {};
      return this.sessionIndexCache;
    }

    try {
      const raw = await readFile(filePath, "utf-8");
      this.sessionIndexCache = JSON.parse(raw) as SessionIndexMap;
      return this.sessionIndexCache;
    } catch (err) {
      log.warn("Failed to parse session index, starting fresh", { error: String(err) });
      this.sessionIndexCache = {};
      return this.sessionIndexCache;
    }
  }

  /**
   * Persist the session index to disk.
   *
   * @param index - Updated session index map to write
   */
  private async saveSessionIndex(index: SessionIndexMap): Promise<void> {
    this.sessionIndexCache = index;
    const dir = this.config.outputDir;
    const filePath = join(dir, SESSION_INDEX_FILE);
    try {
      await mkdir(dir, { recursive: true });
      await writeFile(filePath, JSON.stringify(index, null, 2), "utf-8");
    } catch (err) {
      log.warn("Failed to persist session index", { error: String(err) });
    }
  }

  /**
   * Create a new Copilot session for a BMAD agent.
   *
   * @param opts - Agent, tools, skills, and optional overrides
   * @returns Session ID for tracking
   */
  async createAgentSession(opts: AgentSessionOptions): Promise<string> {
    if (!this.client) throw new Error("SessionManager not started — call start() first");

    const { agent, allAgents, tools, skillDirectories, model, systemMessage } = opts;

    // Build custom agent configs for all agents (so they can @mention each other)
    const customAgents: CustomAgentConfig[] = allAgents.map((a) => ({
      name: a.name,
      displayName: a.displayName,
      description: a.description,
      prompt: a.prompt,
    }));

    // Build session config
    const sessionConfig: SessionConfig = {
      onPermissionRequest: approveAll,
      streaming: true,
      customAgents,
      tools,
      infiniteSessions: { enabled: false },
      workingDirectory: this.config.targetProjectRoot,
    };

    // Add skill directories if provided
    if (skillDirectories && skillDirectories.length > 0) {
      sessionConfig.skillDirectories = skillDirectories;
    }

    // Add system message if provided (e.g., sprint context)
    if (systemMessage) {
      sessionConfig.systemMessage = {
        mode: "append",
        content: systemMessage,
      };
    }

    const session = await this.client.createSession(sessionConfig);

    // Set model if specified
    if (model) {
      await session.setModel(model);
    }

    // Track the session
    const tracked: TrackedSession = {
      session,
      agentName: agent.name,
      createdAt: new Date(),
      messageCount: 0,
    };

    // Propagate storyId onto the tracked record when provided directly
    if (opts.storyId) {
      tracked.storyId = opts.storyId;
    }

    this.sessions.set(session.sessionId, tracked);

    log.info("Session created", { sessionId: session.sessionId, agent: agent.displayName });
    recordSessionOpen(agent.name);
    return session.sessionId;
  }

  /**
   * Resume-aware session creation.
   *
   * If `opts.storyId` is provided the method checks the persisted session index
   * for an existing Copilot session ID and attempts to resume it.  On failure
   * (or when no prior session exists) a fresh session is created and its ID is
   * saved to the index for future restarts.
   *
   * When `opts.storyId` is absent the call delegates directly to
   * `createAgentSession`.
   *
   * @param opts - Agent, tools, skills, and optional resume hints
   * @returns Session ID for tracking
   */
  async getOrCreateAgentSession(opts: AgentSessionOptions): Promise<string> {
    if (!opts.storyId) {
      return this.createAgentSession(opts);
    }

    const key = `${opts.agent.name}:${opts.storyId}`;
    const index = await this.loadSessionIndex();
    const existingId = index[key];

    // Build shared resume-config pieces up front
    const customAgents: CustomAgentConfig[] = opts.allAgents.map((a) => ({
      name: a.name,
      displayName: a.displayName,
      description: a.description,
      prompt: a.prompt,
    }));

    if (existingId) {
      try {
        const resumeConfig: ResumeSessionConfig = {
          onPermissionRequest: approveAll,
          customAgents,
          tools: opts.tools,
          workingDirectory: this.config.targetProjectRoot,
          ...(opts.skillDirectories ? { skillDirectories: opts.skillDirectories } : {}),
          ...(opts.systemMessage ? { systemMessage: { mode: "append", content: opts.systemMessage } } : {}),
        };

        const session = await this.client!.resumeSession(existingId, resumeConfig);

        if (opts.model) await session.setModel(opts.model);

        const tracked: TrackedSession = {
          session,
          agentName: opts.agent.name,
          storyId: opts.storyId,
          createdAt: new Date(),
          messageCount: 0,
        };
        this.sessions.set(session.sessionId, tracked);

        // The SDK may assign a new session ID upon resume — keep the index current.
        if (session.sessionId !== existingId) {
          index[key] = session.sessionId;
          await this.saveSessionIndex(index);
        }

        log.info("Session resumed", {
          sessionId: session.sessionId,
          agent: opts.agent.displayName,
          storyId: opts.storyId,
        });
        recordSessionOpen(opts.agent.name);
        return session.sessionId;
      } catch (err) {
        log.warn("Session resume failed, creating new session", {
          existingId,
          error: String(err),
        });
        // Fall through to create a new session below
      }
    }

    // Create a brand-new session and persist the mapping
    const newSessionId = await this.createAgentSession(opts);
    index[key] = newSessionId;
    await this.saveSessionIndex(index);
    return newSessionId;
  }

  /**
   * Send a prompt to a session and wait for the full response.
   *
   * @param sessionId - Session ID from createAgentSession
   * @param prompt - The prompt to send (can include @agent mentions)
   * @param timeoutMs - Timeout in milliseconds (default 900s / 15 min)
   * @param onDelta - Optional callback for streaming deltas
   * @returns Full response content
   */
  async sendAndWait(
    sessionId: string,
    prompt: string,
    timeoutMs = 900_000,
    onDelta?: (delta: string) => void,
  ): Promise<string> {
    const tracked = this.sessions.get(sessionId);
    if (!tracked) throw new Error(`Session ${sessionId} not found`);

    // Wire up streaming if callback provided
    if (onDelta) {
      tracked.session.on("assistant.message_delta", (event) => {
        onDelta(event.data.deltaContent);
      });
    }

    const response = await tracked.session.sendAndWait({ prompt }, timeoutMs);
    tracked.messageCount++;
    return response?.data.content ?? "";
  }

  /**
   * Associate a story ID with a session for tracking.
   */
  setSessionStory(sessionId: string, storyId: string): void {
    const tracked = this.sessions.get(sessionId);
    if (tracked) tracked.storyId = storyId;
  }

  /**
   * Get metadata about a session.
   */
  getSessionInfo(sessionId: string): { agentName: string; storyId?: string; messageCount: number } | undefined {
    const tracked = this.sessions.get(sessionId);
    if (!tracked) return undefined;
    return {
      agentName: tracked.agentName,
      storyId: tracked.storyId,
      messageCount: tracked.messageCount,
    };
  }

  /**
   * Close a specific session.
   *
   * @param sessionId - Session ID to close
   * @param removeFromIndex - When true, removes the session mapping from the
   *   persisted index so it will not be resumed on next startup.
   */
  async closeSession(sessionId: string, removeFromIndex = false): Promise<void> {
    const tracked = this.sessions.get(sessionId);
    if (!tracked) return;

    await tracked.session.disconnect();
    this.sessions.delete(sessionId);
    log.info("Session closed", { sessionId, agent: tracked.agentName, messageCount: tracked.messageCount });
    recordSessionClose(tracked.agentName);

    if (removeFromIndex && tracked.storyId) {
      const index = await this.loadSessionIndex();
      const key = `${tracked.agentName}:${tracked.storyId}`;
      delete index[key];
      await this.saveSessionIndex(index);
    }
  }

  /**
   * Close all sessions and stop the CopilotClient.
   */
  async stop(): Promise<void> {
    // Close all sessions
    for (const [id] of this.sessions) {
      await this.closeSession(id);
    }

    // Stop the client
    if (this.client) {
      await this.client.stop();
      this.client = null;
    }
    this.started = false;
    log.info("Session manager stopped");
  }

  /**
   * Whether the manager is started and ready.
   */
  get isReady(): boolean {
    return this.started;
  }

  /**
   * Number of active sessions.
   */
  get activeSessionCount(): number {
    return this.sessions.size;
  }
}

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
 * - Graceful shutdown
 *
 * @module adapter/session-manager
 */

import { CopilotClient, approveAll } from "@github/copilot-sdk";
import type { CopilotSession, CustomAgentConfig, SessionConfig } from "@github/copilot-sdk";
import type { Tool } from "../tools/types.js";
import type { BmadAgent } from "../agents/types.js";
import type { BmadConfig } from "../config/config.js";
import { buildClientEnv } from "../config/config.js";

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
    console.log(`[session-mgr] Copilot CLI started (ping: ${new Date(ping.timestamp).toISOString()})`);
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
      customAgents,
      tools,
      infiniteSessions: { enabled: false },
      workingDirectory: this.config.projectRoot,
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
    this.sessions.set(session.sessionId, tracked);

    console.log(`[session-mgr] Session ${session.sessionId} created for ${agent.displayName}`);
    return session.sessionId;
  }

  /**
   * Send a prompt to a session and wait for the full response.
   *
   * @param sessionId - Session ID from createAgentSession
   * @param prompt - The prompt to send (can include @agent mentions)
   * @param timeoutMs - Timeout in milliseconds (default 120s)
   * @param onDelta - Optional callback for streaming deltas
   * @returns Full response content
   */
  async sendAndWait(
    sessionId: string,
    prompt: string,
    timeoutMs = 120_000,
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
   */
  async closeSession(sessionId: string): Promise<void> {
    const tracked = this.sessions.get(sessionId);
    if (!tracked) return;

    await tracked.session.disconnect();
    this.sessions.delete(sessionId);
    console.log(`[session-mgr] Session ${sessionId} closed (${tracked.agentName}, ${tracked.messageCount} messages)`);
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
    console.log("[session-mgr] Stopped.");
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

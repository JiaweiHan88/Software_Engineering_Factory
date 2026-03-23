#!/usr/bin/env npx tsx
/**
 * Webhook Server — HTTP Entrypoint for Paperclip Push-Model Heartbeats
 *
 * Alternative to the process adapter: instead of Paperclip spawning a
 * child process per heartbeat, this server runs continuously and receives
 * heartbeat push events via HTTP POST.
 *
 * Endpoints:
 *   POST /heartbeat     — Receive a heartbeat invocation from Paperclip
 *   GET  /health        — Health check for load balancers / Paperclip probes
 *   GET  /status        — Current server status (active heartbeats, uptime)
 *
 * Paperclip configuration:
 *   adapterType: "http"
 *   adapterConfig:
 *     url: "http://localhost:4200/heartbeat"
 *     method: "POST"
 *     timeoutSec: 600
 *
 * Environment variables:
 *   WEBHOOK_PORT         — Port to listen on (default: 4200)
 *   PAPERCLIP_URL        — Paperclip server URL (for API calls back)
 *   PAPERCLIP_COMPANY_ID — Company scope
 *
 * @module webhook-server
 */

import "dotenv/config";

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { PaperclipClient } from "./adapter/paperclip-client.js";
import type { PaperclipAgent, PaperclipIssue } from "./adapter/paperclip-client.js";
import { PaperclipReporter } from "./adapter/reporter.js";
import { SessionManager } from "./adapter/session-manager.js";
import { AgentDispatcher } from "./adapter/agent-dispatcher.js";
import { handlePaperclipIssue } from "./adapter/heartbeat-handler.js";
import { orchestrateCeoIssue, reEvaluateDelegation } from "./adapter/ceo-orchestrator.js";
import { withRetry, isPaperclipRetryable } from "./adapter/retry.js";
import { resolveRoleMapping, PAPERCLIP_SKILLS } from "./config/role-mapping.js";
import type { RoleMappingEntry } from "./config/role-mapping.js";
import { loadConfig } from "./config/config.js";
import { allTools } from "./tools/index.js";
import { Logger } from "./observability/logger.js";

const log = Logger.child("webhook-server");

// ─────────────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.WEBHOOK_PORT ?? "4200", 10);
const PAPERCLIP_URL = process.env.PAPERCLIP_URL ?? "http://localhost:3100";
const COMPANY_ID = process.env.PAPERCLIP_COMPANY_ID;

if (!COMPANY_ID) {
  log.error("PAPERCLIP_COMPANY_ID is required");
  process.exit(1);
}

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Heartbeat payload sent by Paperclip's http adapter.
 *
 * The http adapter POSTs a JSON body with agent context and optional
 * task information. The exact shape depends on Paperclip version — we
 * accept a superset and extract what we need.
 */
interface HeartbeatPayload {
  agentId: string;
  companyId?: string;
  runId?: string;
  wakeReason?: string;
  taskId?: string;
  /** Agent API key for scoped access (optional) */
  agentApiKey?: string;
}

/**
 * Active heartbeat tracking.
 */
interface ActiveHeartbeat {
  agentId: string;
  startedAt: Date;
  runId?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Server State
// ─────────────────────────────────────────────────────────────────────────────

const activeHeartbeats = new Map<string, ActiveHeartbeat>();
let sessionManager: SessionManager | null = null;
let serverStartedAt: Date;
let heartbeatCount = 0;

// ─────────────────────────────────────────────────────────────────────────────
// Heartbeat Handler
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Process a heartbeat invocation — same logic as heartbeat-entrypoint.ts
 * but reuses the long-lived SessionManager instead of starting/stopping
 * per invocation.
 */
async function processHeartbeat(payload: HeartbeatPayload): Promise<{ success: boolean; message: string }> {
  const { agentId, runId } = payload;
  heartbeatCount++;

  // Guard: don't run two heartbeats for the same agent concurrently
  if (activeHeartbeats.has(agentId)) {
    return { success: false, message: `Agent ${agentId} already has an active heartbeat` };
  }

  activeHeartbeats.set(agentId, { agentId, startedAt: new Date(), runId });

  try {
    const config = loadConfig();
    config.paperclip.url = PAPERCLIP_URL;
    config.paperclip.companyId = COMPANY_ID!;
    config.paperclip.enabled = true;

    const paperclipClient = new PaperclipClient({
      baseUrl: PAPERCLIP_URL,
      agentApiKey: payload.agentApiKey,
      agentId,
      companyId: COMPANY_ID!,
      heartbeatRunId: runId,
    });

    const reporter = new PaperclipReporter(paperclipClient, 500, config.targetProjectRoot);

    // Identify agent
    const { value: agentSelf } = await withRetry(
      () => paperclipClient.getAgent(agentId),
      { maxAttempts: 3, label: "identify-agent", isRetryable: isPaperclipRetryable },
    );

    // Resolve BMAD role
    const mapping = resolveRoleMapping({
      role: agentSelf.title ?? agentSelf.name,
      title: agentSelf.title,
      metadata: agentSelf.metadata,
    });

    if (!mapping) {
      return { success: false, message: `No BMAD role mapping for agent ${agentSelf.name}` };
    }

    // Check inbox
    const TERMINAL_STATUSES = new Set(["done", "cancelled"]);
    const SKIP_FOR_ORCHESTRATOR = new Set(["done", "cancelled", "in_progress"]);
    const skipSet = mapping.isOrchestrator ? SKIP_FOR_ORCHESTRATOR : TERMINAL_STATUSES;

    const { value: allIssues } = await withRetry(
      () => paperclipClient.listIssues({ assigneeAgentId: agentId }),
      { maxAttempts: 3, label: "check-inbox", isRetryable: isPaperclipRetryable },
    );
    const inbox = allIssues.filter((i: PaperclipIssue) => !skipSet.has(i.status));

    if (inbox.length === 0) {
      return { success: true, message: `${mapping.displayName}: idle (no assigned work)` };
    }

    // Load agent config files
    const projectRoot = resolve(import.meta.dirname ?? process.cwd(), ".");
    const configDir = resolve(projectRoot, "agents", mapping.agentConfigDir);
    let agentSystemMessage: string | undefined;

    if (existsSync(configDir)) {
      const files = ["AGENTS.md", "SOUL.md", "HEARTBEAT.md", "TOOLS.md"];
      const contents = files
        .map((f) => {
          const path = resolve(configDir, f);
          return existsSync(path) ? readFileSync(path, "utf-8") : "";
        })
        .filter((c) => c.length > 0);
      agentSystemMessage = contents.join("\n\n---\n\n")
        .replace(/\$AGENT_HOME/g, configDir);
      config.agentSystemMessage = agentSystemMessage;
    }

    // Ensure SessionManager is running
    if (!sessionManager || !sessionManager.isReady) {
      sessionManager = new SessionManager(config);
      await sessionManager.start();
    }

    const dispatcher = new AgentDispatcher(sessionManager, config);
    const bmadRole = mapping.bmadAgentName ?? "ceo";

    // Process each issue
    let processed = 0;
    for (const issue of inbox) {
      try {
        if (mapping.isOrchestrator) {
          const existingChildren = await paperclipClient.listIssues({ parentId: issue.id });
          const activeChildren = existingChildren.filter((c: PaperclipIssue) => c.status !== "cancelled");

          if (activeChildren.length > 0) {
            // Sub-issues exist → re-evaluate: promote backlog tasks whose deps are met
            await reEvaluateDelegation(
              issue, paperclipClient, sessionManager, config,
            );
          } else {
            // No sub-issues yet → first-time delegation
            await orchestrateCeoIssue(
              issue, agentSelf, paperclipClient, reporter,
              sessionManager, config, mapping,
            );
          }
        } else {
          await handlePaperclipIssue(issue, agentId, bmadRole, dispatcher, reporter);
        }
        processed++;
      } catch (err) {
        log.error("Failed to process issue in webhook heartbeat", {
          issueId: issue.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return { success: true, message: `${mapping.displayName}: processed ${processed}/${inbox.length} issues` };
  } finally {
    activeHeartbeats.delete(agentId);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// HTTP Handlers
// ─────────────────────────────────────────────────────────────────────────────

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = req.url ?? "/";
  const method = req.method ?? "GET";

  // ── POST /heartbeat ─────────────────────────────────────────────────
  if (method === "POST" && url === "/heartbeat") {
    try {
      const body = await readBody(req);
      const payload = JSON.parse(body) as HeartbeatPayload;

      if (!payload.agentId) {
        sendJson(res, 400, { error: "Missing agentId in payload" });
        return;
      }

      log.info("Heartbeat received", { agentId: payload.agentId, runId: payload.runId });

      // Respond immediately with 202 Accepted (async processing)
      sendJson(res, 202, { accepted: true, agentId: payload.agentId });

      // Process in background (don't await — the response is already sent)
      processHeartbeat(payload).then((result) => {
        log.info("Heartbeat completed", {
          agentId: payload.agentId,
          success: result.success,
          message: result.message,
        });
      }).catch((err) => {
        log.error("Heartbeat failed", {
          agentId: payload.agentId,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    } catch (err) {
      sendJson(res, 400, { error: "Invalid JSON payload" });
    }
    return;
  }

  // ── GET /health ─────────────────────────────────────────────────────
  if (method === "GET" && url === "/health") {
    sendJson(res, 200, { status: "ok", timestamp: new Date().toISOString() });
    return;
  }

  // ── GET /status ─────────────────────────────────────────────────────
  if (method === "GET" && url === "/status") {
    const uptimeMs = Date.now() - serverStartedAt.getTime();
    sendJson(res, 200, {
      status: "running",
      uptime: `${Math.round(uptimeMs / 1000)}s`,
      heartbeatsProcessed: heartbeatCount,
      activeHeartbeats: Array.from(activeHeartbeats.values()).map((h) => ({
        agentId: h.agentId,
        runningFor: `${Math.round((Date.now() - h.startedAt.getTime()) / 1000)}s`,
      })),
      sessionManagerReady: sessionManager?.isReady ?? false,
      activeSessions: sessionManager?.activeSessionCount ?? 0,
    });
    return;
  }

  // ── 404 ─────────────────────────────────────────────────────────────
  sendJson(res, 404, { error: "Not Found" });
}

// ─────────────────────────────────────────────────────────────────────────────
// Server Start
// ─────────────────────────────────────────────────────────────────────────────

const server = createServer((req, res) => {
  handleRequest(req, res).catch((err) => {
    log.error("Unhandled request error", {}, err instanceof Error ? err : undefined);
    sendJson(res, 500, { error: "Internal Server Error" });
  });
});

server.listen(PORT, () => {
  serverStartedAt = new Date();
  log.info(`Webhook server listening on port ${PORT}`, {
    port: PORT,
    paperclipUrl: PAPERCLIP_URL,
    companyId: COMPANY_ID,
    endpoints: ["POST /heartbeat", "GET /health", "GET /status"],
  });
  console.log(`\n🚀 BMAD Webhook Server running at http://localhost:${PORT}`);
  console.log(`   POST /heartbeat — Receive Paperclip heartbeat pushes`);
  console.log(`   GET  /health    — Health check`);
  console.log(`   GET  /status    — Server status\n`);
});

// Graceful shutdown
async function shutdown(signal: string): Promise<void> {
  log.info(`Shutting down (${signal})...`);
  server.close();
  if (sessionManager) {
    await sessionManager.stop();
  }
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

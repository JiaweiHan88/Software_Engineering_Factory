#!/usr/bin/env npx tsx
/**
 * Heartbeat Entrypoint — Universal Process Adapter Target
 *
 * This is the script that Paperclip's `process` adapter spawns for every agent.
 * Paperclip injects environment variables (PAPERCLIP_AGENT_API_KEY, PAPERCLIP_URL,
 * PAPERCLIP_COMPANY_ID, etc.) and executes this entrypoint.
 *
 * Lifecycle:
 * 1. Read PAPERCLIP_* env vars (injected by process adapter)
 * 2. GET /api/agents/me → identify self
 * 3. Resolve BMAD role via role-mapping.ts
 * 4. GET /api/agents/me/inbox-lite → check assigned work
 * 5. If work exists: create Copilot SDK session → dispatch → report result
 * 6. If no work: report idle and exit
 * 7. Exit cleanly (process adapter expects finite lifetime)
 *
 * Environment variables set by Paperclip process adapter:
 * - PAPERCLIP_AGENT_API_KEY — Bearer token for this agent
 * - PAPERCLIP_URL — Paperclip server base URL
 * - PAPERCLIP_COMPANY_ID — Company ID for scoping
 * - PAPERCLIP_AGENT_ID — This agent's UUID
 * - PAPERCLIP_HEARTBEAT_RUN_ID — Current heartbeat run ID (for transcripts)
 *
 * Additional env (from .env or inherited):
 * - COPILOT_GHE_HOST — GHE hostname for Copilot SDK
 * - COPILOT_MODEL — Default model override
 * - TARGET_PROJECT_ROOT — Workspace for agents to operate in
 *
 * @module heartbeat-entrypoint
 */

import "dotenv/config";

import { resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { PaperclipClient } from "./adapter/paperclip-client.js";
import type { PaperclipAgent, PaperclipIssue } from "./adapter/paperclip-client.js";
import { PaperclipReporter } from "./adapter/reporter.js";
import { SessionManager } from "./adapter/session-manager.js";
import { AgentDispatcher } from "./adapter/agent-dispatcher.js";
import { handlePaperclipIssue } from "./adapter/heartbeat-handler.js";
import { orchestrateCeoIssue } from "./adapter/ceo-orchestrator.js";
import { withRetry, isPaperclipRetryable } from "./adapter/retry.js";
import { resolveRoleMapping, PAPERCLIP_SKILLS } from "./config/role-mapping.js";
import type { RoleMappingEntry } from "./config/role-mapping.js";
import { loadConfig } from "./config/config.js";
import { allTools } from "./tools/index.js";
import { Logger } from "./observability/logger.js";
import { CostTracker, inferProvider } from "./observability/cost-tracker.js";
import { initTracing, shutdownTracing } from "./observability/tracing.js";
import { initMetrics, shutdownMetrics } from "./observability/metrics.js";

const log = Logger.child("heartbeat-entrypoint");

// ─────────────────────────────────────────────────────────────────────────────
// Utilities
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Detect if a comment body is a blocked-status update posted by this agent.
 *
 * Used for blocked-task dedup (Phase A7): if the agent's last comment is a
 * "blocked" status update and no new comments have arrived, skip re-processing.
 *
 * @param body - Comment text to inspect
 * @returns true if the comment matches blocked-status patterns
 */
function isBlockedStatusComment(body: string): boolean {
  if (!body) return false;
  const lower = body.toLowerCase();
  return (
    lower.includes("blocked") &&
    (lower.includes("status") ||
      lower.includes("waiting") ||
      lower.includes("⏸") ||
      lower.includes("🚫") ||
      lower.startsWith("⛔"))
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Environment Extraction
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Environment variables injected by Paperclip's process adapter.
 *
 * The process adapter injects via `buildPaperclipEnv()`:
 *   PAPERCLIP_AGENT_ID, PAPERCLIP_COMPANY_ID, PAPERCLIP_API_URL
 *
 * It does NOT inject PAPERCLIP_AGENT_API_KEY — that's only used by
 * standalone polling mode. In process adapter mode, auth is handled
 * by Paperclip's deployment mode (local_trusted = board access).
 *
 * Phase A3: Extended with full wake context env vars from Paperclip SKILL.md.
 */
interface PaperclipEnv {
  /** Agent API key for Bearer auth (optional — not set by process adapter) */
  agentApiKey: string | undefined;
  /** Paperclip server URL */
  url: string;
  /** Company ID */
  companyId: string;
  /** Agent UUID */
  agentId: string;
  /** Current heartbeat run ID (Phase A5: accepts both env var names) */
  heartbeatRunId: string | undefined;

  // ── Wake Context (Phase A3) ───────────────────────────────────────

  /** Issue that triggered this wake — prioritize this task first */
  taskId: string | undefined;
  /** Why this run was triggered: timer | assignment | on_demand | comment */
  wakeReason: string | undefined;
  /** Specific comment that triggered wake — read this first */
  wakeCommentId: string | undefined;
  /** Approval that needs handling */
  approvalId: string | undefined;
  /** Approval outcome: approved | denied */
  approvalStatus: string | undefined;
  /** Comma-separated linked issue IDs (parsed into array) */
  linkedIssueIds: string[] | undefined;
}

/**
 * Extract and validate Paperclip env vars injected by the process adapter.
 *
 * Accepts both process adapter env vars (PAPERCLIP_API_URL) and
 * standalone env vars (PAPERCLIP_URL, PAPERCLIP_AGENT_API_KEY) for flexibility.
 *
 * Phase A3: Also reads wake context env vars (PAPERCLIP_TASK_ID, WAKE_REASON, etc.)
 * Phase A5: Accepts both PAPERCLIP_RUN_ID and PAPERCLIP_HEARTBEAT_RUN_ID.
 *
 * @throws Error if required env vars are missing
 */
function extractPaperclipEnv(): PaperclipEnv {
  // Agent API key is optional — process adapter doesn't inject it,
  // but standalone polling mode (or .env) might set it
  const agentApiKey = process.env.PAPERCLIP_AGENT_API_KEY || undefined;

  // Process adapter sets PAPERCLIP_API_URL; .env may set PAPERCLIP_URL
  const url = process.env.PAPERCLIP_API_URL || process.env.PAPERCLIP_URL || "http://localhost:3100";

  const companyId = process.env.PAPERCLIP_COMPANY_ID;
  const agentId = process.env.PAPERCLIP_AGENT_ID;

  // Phase A5: Accept both PAPERCLIP_RUN_ID and PAPERCLIP_HEARTBEAT_RUN_ID
  const heartbeatRunId =
    process.env.PAPERCLIP_RUN_ID ||
    process.env.PAPERCLIP_HEARTBEAT_RUN_ID ||
    undefined;

  if (!companyId) {
    throw new Error("Missing PAPERCLIP_COMPANY_ID — required for company-scoped API calls");
  }

  if (!agentId) {
    throw new Error("Missing PAPERCLIP_AGENT_ID — required to identify the agent");
  }

  // Phase A3: Wake context env vars
  const linkedIssueIdsRaw = process.env.PAPERCLIP_LINKED_ISSUE_IDS;

  return {
    agentApiKey,
    url,
    companyId,
    agentId,
    heartbeatRunId,

    // Wake context
    taskId: process.env.PAPERCLIP_TASK_ID || undefined,
    wakeReason: process.env.PAPERCLIP_WAKE_REASON || undefined,
    wakeCommentId: process.env.PAPERCLIP_WAKE_COMMENT_ID || undefined,
    approvalId: process.env.PAPERCLIP_APPROVAL_ID || undefined,
    approvalStatus: process.env.PAPERCLIP_APPROVAL_STATUS || undefined,
    linkedIssueIds: linkedIssueIdsRaw
      ? linkedIssueIdsRaw.split(",").filter(Boolean)
      : undefined,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Skill Directory Resolution
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build the list of Copilot SDK skill directories for this agent.
 *
 * Combines:
 * 1. Agent-specific BMAD skill directories (from role mapping)
 * 2. Paperclip coordination skills (loaded from Paperclip repo if available)
 * 3. Global skill directories (src/skills, .github/skills)
 *
 * @param mapping - The resolved role mapping entry
 * @param projectRoot - Factory project root
 * @returns Array of absolute paths to skill directories that exist on disk
 */
function resolveSkillDirectories(mapping: RoleMappingEntry, projectRoot: string): string[] {
  const dirs: string[] = [];

  // 1. Agent-specific BMAD skills (from _bmad/skills/ directory)
  for (const skillName of mapping.bmadSkills) {
    const skillDir = resolve(projectRoot, "_bmad/skills", skillName);
    if (existsSync(skillDir)) {
      dirs.push(skillDir);
    } else {
      log.warn("Skill directory not found, skipping", { skillName, expected: skillDir });
    }
  }

  // 2. Paperclip coordination skills (if Paperclip repo skills are locally available)
  //    These would typically be in the Paperclip workspace's skills/ directory
  const paperclipSkillsBase = process.env.PAPERCLIP_SKILLS_DIR;
  if (paperclipSkillsBase) {
    for (const skillName of PAPERCLIP_SKILLS) {
      const skillDir = resolve(paperclipSkillsBase, skillName);
      if (existsSync(skillDir)) {
        dirs.push(skillDir);
      }
    }
  }

  // 3. Global skill search paths (factory-level)
  const globalDirs = [
    resolve(projectRoot, "src/skills"),
    resolve(projectRoot, ".github/skills"),
  ];
  for (const dir of globalDirs) {
    if (existsSync(dir) && !dirs.includes(dir)) {
      dirs.push(dir);
    }
  }

  return dirs;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool Resolution
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolve the Copilot SDK tools available to this agent based on its role mapping.
 *
 * Filters allTools to only include tools named in the mapping's `tools` array.
 * Falls back to all tools if no filtering is specified.
 *
 * @param mapping - The resolved role mapping entry
 * @returns Array of Tool instances for session creation
 */
function resolveTools(mapping: RoleMappingEntry): typeof allTools {
  if (mapping.tools.length === 0) {
    return allTools;
  }

  // Filter to only the tools named in the mapping
  const filtered = allTools.filter((tool) => {
    // Tool name is typically the function name from defineTool()
    const toolName = (tool as { name?: string }).name ?? "";
    return mapping.tools.includes(toolName);
  });

  // If filtering produced nothing (tool name mismatch), fall back to all tools
  if (filtered.length === 0) {
    log.warn("No tools matched role mapping filter, falling back to all tools", {
      expected: mapping.tools,
    });
    return allTools;
  }

  return filtered;
}

// ─────────────────────────────────────────────────────────────────────────────
// Agent 4-File Configuration Loading
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The 4-file Paperclip agent configuration set.
 *
 * Following the official `paperclipai/companies` pattern, every agent has:
 * - AGENTS.md — Entry point: identity, role, memory refs, safety rules
 * - SOUL.md — Persona: strategic posture + voice & tone
 * - HEARTBEAT.md — Execution checklist run every heartbeat
 * - TOOLS.md — Available skills and tools inventory
 */
interface AgentConfigFiles {
  agents: string;
  soul: string;
  heartbeat: string;
  tools: string;
}

/**
 * Load the 4-file agent configuration set from disk.
 *
 * Reads AGENTS.md, SOUL.md, HEARTBEAT.md, TOOLS.md from the
 * `_bmad/agents/{agentConfigDir}/` directory. These are injected as the
 * system message for the Copilot SDK session, giving the agent its
 * identity, persona, heartbeat protocol, and tool awareness.
 *
 * @param mapping - Role mapping entry with agentConfigDir
 * @param projectRoot - Factory project root
 * @returns The 4-file content, or null if the config dir doesn't exist
 */
function loadAgentConfigFiles(mapping: RoleMappingEntry, projectRoot: string): AgentConfigFiles | null {
  const configDir = resolve(projectRoot, "_bmad/agents", mapping.agentConfigDir);

  if (!existsSync(configDir)) {
    log.warn("Agent config directory not found", {
      dir: configDir,
      agentConfigDir: mapping.agentConfigDir,
    });
    return null;
  }

  const files: Record<keyof AgentConfigFiles, string> = {
    agents: "AGENTS.md",
    soul: "SOUL.md",
    heartbeat: "HEARTBEAT.md",
    tools: "TOOLS.md",
  };

  const result: Partial<AgentConfigFiles> = {};
  let loadedCount = 0;

  for (const [key, filename] of Object.entries(files)) {
    const filePath = resolve(configDir, filename);
    if (existsSync(filePath)) {
      result[key as keyof AgentConfigFiles] = readFileSync(filePath, "utf-8");
      loadedCount++;
    } else {
      log.warn("Agent config file missing", { file: filePath });
      result[key as keyof AgentConfigFiles] = "";
    }
  }

  log.info("Agent config files loaded", {
    agentConfigDir: mapping.agentConfigDir,
    filesLoaded: loadedCount,
    totalFiles: Object.keys(files).length,
  });

  return result as AgentConfigFiles;
}

/**
 * Build the system message from the 4-file agent configuration.
 *
 * Concatenates AGENTS.md + SOUL.md + HEARTBEAT.md + TOOLS.md into a
 * single string suitable for injection as Copilot SDK systemMessage.
 * Resolves `$AGENT_HOME` placeholder to the actual agent config directory.
 *
 * @param configFiles - The loaded 4-file set
 * @param mapping - Role mapping entry
 * @param projectRoot - Factory project root
 * @returns Combined system message string
 */
function buildAgentSystemMessage(
  configFiles: AgentConfigFiles,
  mapping: RoleMappingEntry,
  projectRoot: string,
): string {
  const agentHome = resolve(projectRoot, "agents", mapping.agentConfigDir);

  const parts = [
    configFiles.agents,
    configFiles.soul,
    configFiles.heartbeat,
    configFiles.tools,
  ];

  // Resolve $AGENT_HOME placeholders
  return parts
    .filter((p) => p.length > 0)
    .join("\n\n---\n\n")
    .replace(/\$AGENT_HOME/g, agentHome);
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Heartbeat Flow
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Main heartbeat execution flow.
 *
 * This is the core logic that runs every time Paperclip spawns this process.
 * It follows the heartbeat protocol: identify → check inbox → do work → report.
 */
async function main(): Promise<void> {
  const startTime = Date.now();

  // ── Step 1: Extract Paperclip env ───────────────────────────────────
  log.info("Heartbeat entrypoint starting...");
  const env = extractPaperclipEnv();

  log.info("Paperclip env loaded", {
    agentId: env.agentId,
    url: env.url,
    companyId: env.companyId,
    heartbeatRunId: env.heartbeatRunId ?? "n/a",
    wakeReason: env.wakeReason ?? "none",
    taskId: env.taskId ?? "none",
    approvalId: env.approvalId ?? "none",
  });

  // ── Step 1b: Initialize OpenTelemetry (if enabled) ──────────────────
  // OTel env vars are injected by setup-paperclip-company.ts into each
  // agent's adapterConfig.env. Each heartbeat process is short-lived, so
  // we init at startup and flush+shutdown at exit.
  const otelEnabled = process.env.OTEL_ENABLED === "true";
  if (otelEnabled) {
    const otelServiceName = `bmad-heartbeat-${env.agentId.slice(0, 8)}`;
    initTracing({ enabled: true, serviceName: otelServiceName });
    initMetrics({ enabled: true, serviceName: otelServiceName });
    log.info("OpenTelemetry initialized for heartbeat", {
      endpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? "http://localhost:4318",
      serviceName: otelServiceName,
    });
  }

  // ── Step 2: Create Paperclip client ──────────────────────────────────
  // In local_trusted mode (process adapter), we use board-level access
  // (no auth header). Agent API keys are per-agent and using a mismatched
  // key causes ownership conflicts. Only send the agent API key in
  // authenticated mode where each agent has its own key.
  const deploymentMode = process.env.PAPERCLIP_DEPLOYMENT_MODE;
  const useAgentKey = deploymentMode !== "local_trusted" && !!env.agentApiKey;

  const paperclipClient = new PaperclipClient({
    baseUrl: env.url,
    agentApiKey: useAgentKey ? env.agentApiKey : undefined,
    agentId: env.agentId,
    companyId: env.companyId,
    // Phase A6: Always send heartbeat run ID when available, regardless of auth mode.
    // The run ID enables audit trail correlation across all API calls.
    // In local_trusted mode with MANUAL invocation (e.g., scripts), the env var
    // won't be set, so this naturally becomes undefined (no header sent).
    heartbeatRunId: env.heartbeatRunId,
  });

  log.info("Paperclip client created", {
    authMode: useAgentKey ? "agent-key" : "board-access",
    deploymentMode: deploymentMode ?? "unknown",
  });

  const reporter = new PaperclipReporter(paperclipClient);

  // ── Step 3: Identify self ─────────────────────────────────────────
  // In board-access mode, use GET /api/agents/:id (no auth needed).
  // With agent-key auth, /api/agents/me resolves the agent from the key.
  let agentSelf: PaperclipAgent;
  try {
    const { value } = await withRetry(
      () => useAgentKey
        ? paperclipClient.getAgentSelf()
        : paperclipClient.getAgent(env.agentId),
      { maxAttempts: 3, label: "identify-agent", isRetryable: isPaperclipRetryable },
    );
    agentSelf = value;
    log.info("Agent identified", {
      name: agentSelf.name,
      title: agentSelf.title,
      status: agentSelf.status,
      role: agentSelf.title, // title often holds the role key
    });
  } catch (err) {
    log.error("Failed to identify agent", { agentId: env.agentId }, err instanceof Error ? err : undefined);
    process.exit(1);
  }

  // ── Step 4: Resolve BMAD role mapping ───────────────────────────────
  const mapping = resolveRoleMapping({
    role: agentSelf.title ?? agentSelf.name,
    title: agentSelf.title,
    metadata: agentSelf.metadata,
  });

  if (!mapping) {
    log.error("No BMAD role mapping found for agent", {
      name: agentSelf.name,
      title: agentSelf.title,
      metadata: agentSelf.metadata,
    });
    process.exit(1);
  }

  log.info("BMAD role resolved", {
    displayName: mapping.displayName,
    bmadAgent: mapping.bmadAgentName ?? "orchestrator",
    isOrchestrator: mapping.isOrchestrator,
    skillCount: mapping.bmadSkills.length,
    toolCount: mapping.tools.length,
  });

  // ── Step 5: Check inbox for assigned work ───────────────────────────
  // In board-access mode, /agents/me/inbox-lite doesn't work (no agent key).
  // Use listIssues with assignee filter instead.
  // Filter to actionable statuses only — skip done/cancelled issues.
  //
  // NOTE: We do NOT skip in_progress for the orchestrator here. Paperclip's
  // /heartbeat/invoke automatically checks out the triggered issue (setting
  // it to in_progress) before our entrypoint runs. If we skipped in_progress,
  // the CEO would never process any invoked work. Instead, the delegation
  // dedup guard in Step 8 (checking for existing child sub-issues) prevents
  // double-delegation.
  const TERMINAL_STATUSES = new Set(["done", "cancelled"]);
  let inbox: PaperclipIssue[];
  try {
    const { value } = await withRetry(
      async () => {
        if (useAgentKey) {
          return paperclipClient.getAgentInbox();
        }
        const allIssues = await paperclipClient.listIssues({ assigneeAgentId: env.agentId });
        return allIssues.filter((i) => !TERMINAL_STATUSES.has(i.status));
      },
      { maxAttempts: 3, label: "check-inbox", isRetryable: isPaperclipRetryable },
    );
    inbox = value;
    log.info("Inbox checked", { issueCount: inbox.length });

    // Heartbeat Protocol Step 4: "Work on in_progress first, then todo.
    // Skip blocked unless you can unblock it." Paperclip returns results
    // sorted by priority, but we additionally sort by status so in_progress
    // issues are processed before todo/backlog.
    const STATUS_PRIORITY: Record<string, number> = {
      in_progress: 0,
      in_review: 1,
      todo: 2,
      backlog: 3,
      blocked: 4,
    };
    inbox.sort((a, b) => {
      const ap = STATUS_PRIORITY[a.status] ?? 5;
      const bp = STATUS_PRIORITY[b.status] ?? 5;
      return ap - bp;
    });
  } catch (err) {
    log.error("Failed to check inbox", {}, err instanceof Error ? err : undefined);
    process.exit(1);
  }

  // ── Step 5a: Approval follow-up (Phase A4) ─────────────────────────
  // If this heartbeat was triggered for an approval, handle it and exit.
  if (env.approvalId) {
    log.info("Handling approval wake", {
      approvalId: env.approvalId,
      approvalStatus: env.approvalStatus ?? "unknown",
    });
    // Approval handling is a dedicated heartbeat — report result and exit.
    // The approval is logged; the related task will be picked up on the next
    // regular heartbeat via the inbox.
    try {
      if (env.taskId) {
        await paperclipClient.addIssueComment(
          env.taskId,
          `🔔 **Approval received** — ID: \`${env.approvalId}\`, Status: **${env.approvalStatus ?? "unknown"}**`,
        );
      }
    } catch (approvalErr) {
      log.warn("Failed to post approval notification", {
        error: approvalErr instanceof Error ? approvalErr.message : String(approvalErr),
      });
    }
    // Don't exit early — let the triggered task be processed below
    // (the approval context will inform the agent's behavior)
  }

  // ── Step 5b: Prioritize triggered task (Phase A4) ──────────────────
  // If PAPERCLIP_TASK_ID is set, move the triggered task to the front
  // of the queue so it's processed first.
  if (env.taskId && inbox.length > 1) {
    const triggeredIdx = inbox.findIndex((i) => i.id === env.taskId);
    if (triggeredIdx > 0) {
      const [triggered] = inbox.splice(triggeredIdx, 1);
      inbox.unshift(triggered);
      log.info("Prioritized triggered task to front of inbox", {
        taskId: env.taskId,
        wakeReason: env.wakeReason ?? "unknown",
      });
    } else if (triggeredIdx === -1) {
      log.warn("Triggered task not found in inbox — it may have been resolved or reassigned", {
        taskId: env.taskId,
      });
    }
  }

  if (inbox.length === 0) {
    log.info("No work assigned — heartbeat complete (idle)");
    const elapsed = Date.now() - startTime;
    log.info("Heartbeat finished", { durationMs: elapsed, outcome: "idle" });
    return;
  }

  // ── Step 6: Load agent 4-file configuration ────────────────────────
  const projectRoot = resolve(import.meta.dirname ?? process.cwd(), "..");
  const agentConfig = loadAgentConfigFiles(mapping, projectRoot);
  let agentSystemMessage: string | undefined;

  if (agentConfig) {
    agentSystemMessage = buildAgentSystemMessage(agentConfig, mapping, projectRoot);
    log.info("Agent system message built", {
      length: agentSystemMessage.length,
      agentConfigDir: mapping.agentConfigDir,
    });
  } else {
    log.warn("No agent config files — falling back to BMAD persona prompt only");
  }

  // ── Step 7: Bootstrap Copilot SDK (SessionManager + Dispatcher) ─────
  const config = loadConfig();

  // Override Paperclip config with env from process adapter
  config.paperclip.url = env.url;
  config.paperclip.agentApiKey = env.agentApiKey;
  config.paperclip.companyId = env.companyId;
  config.paperclip.enabled = true;

  // Inject agent 4-file system message into config for session creation
  if (agentSystemMessage) {
    config.agentSystemMessage = agentSystemMessage;
  }

  const sessionManager = new SessionManager(config);
  await sessionManager.start();

  const costTracker = new CostTracker();
  const dispatcher = new AgentDispatcher(sessionManager, config, costTracker);

  // ── Step 8: Process each assigned issue ─────────────────────────────
  // Phase A2: Checkout before work, release on error.
  // Paperclip SKILL.md Step 5: "You MUST checkout before doing any work."
  const bmadRole = mapping.bmadAgentName ?? "ceo";

  for (const issue of inbox) {
    log.info("Processing issue", {
      issueId: issue.id,
      title: issue.title,
      storyId: issue.storyId ?? "n/a",
    });

    // ── Phase A7: Blocked-task dedup ──────────────────────────────────
    // Before re-engaging a blocked task, check if our last comment was a
    // blocked-status update AND no new comments from other agents since.
    if (issue.status === "blocked") {
      try {
        const comments = await paperclipClient.getIssueComments(issue.id, { order: "asc" });
        const lastComment = comments.length > 0 ? comments[comments.length - 1] : null;
        if (lastComment?.authorId === env.agentId && isBlockedStatusComment(lastComment.body)) {
          log.info("Skipping blocked task — no new context since our last blocked update", {
            issueId: issue.id,
            lastCommentId: lastComment.id,
          });
          continue;
        }
      } catch (dedupErr) {
        // Non-fatal: if we can't check dedup, proceed with normal processing
        log.warn("Blocked-task dedup check failed, proceeding", {
          issueId: issue.id,
          error: dedupErr instanceof Error ? dedupErr.message : String(dedupErr),
        });
      }
    }

    // ── Phase A2: Checkout issue before processing ────────────────────
    // Prevents concurrent agents from processing the same issue.
    // expectedStatuses per Paperclip docs: checkout accepts issues in
    // todo, backlog, or blocked. in_progress is included for the case
    // where Paperclip's invoke already set executionRunId (our checkout
    // 409-fallback recognizes we own it via assigneeAgentId).
    let lockedIssue: PaperclipIssue | null;
    try {
      lockedIssue = await paperclipClient.checkoutIssue(
        issue.id,
        ["todo", "backlog", "in_progress", "blocked"],
      );
    } catch (checkoutErr) {
      log.error("Checkout failed for issue", {
        issueId: issue.id,
        error: checkoutErr instanceof Error ? checkoutErr.message : String(checkoutErr),
      });
      continue;
    }

    if (!lockedIssue) {
      // 409 — another agent already has this task checked out
      log.info("Skipping issue — already checked out by another agent", {
        issueId: issue.id,
      });
      continue;
    }

    try {
      if (mapping.isOrchestrator) {
        // ── Guard: skip if CEO already delegated this issue ────────────
        // Defense-in-depth: if sub-issues exist, another heartbeat already
        // ran delegation. Skip to avoid duplicates.
        const existingChildren = await paperclipClient.listIssues({ parentId: lockedIssue.id });
        const activeChildren = existingChildren.filter(
          (c) => c.status !== "cancelled",
        );
        if (activeChildren.length > 0) {
          log.info("Skipping already-delegated issue (has active sub-issues)", {
            issueId: lockedIssue.id,
            childCount: activeChildren.length,
          });
          continue;
        }

        // CEO orchestrator: use Copilot SDK session to analyze issue,
        // produce a structured delegation plan, and create sub-issues
        const result = await orchestrateCeoIssue(
          lockedIssue,
          agentSelf,
          paperclipClient,
          reporter,
          sessionManager,
          config,
          mapping,
          costTracker,
        );
        log.info("CEO orchestration result", {
          issueId: lockedIssue.id,
          success: result.success,
          subtasksCreated: result.subtasksCreated,
        });
      } else {
        // Domain agent: process the issue directly
        await handlePaperclipIssue(lockedIssue, env.agentId, bmadRole, dispatcher, reporter);
      }
      // On success: don't release — checkout holds until status change
    } catch (err) {
      log.error("Failed to process issue", { issueId: lockedIssue.id }, err instanceof Error ? err : undefined);

      // Phase A2: Release checkout lock on failure
      try {
        await paperclipClient.releaseIssue(lockedIssue.id);
        log.info("Released checkout lock after failure", { issueId: lockedIssue.id });
      } catch (releaseErr) {
        log.warn("Failed to release issue checkout", {
          issueId: lockedIssue.id,
          error: releaseErr instanceof Error ? releaseErr.message : String(releaseErr),
        });
      }

      // Report failure back to Paperclip
      try {
        await paperclipClient.addIssueComment(
          lockedIssue.id,
          `❌ **FAILED** — ${mapping.displayName} encountered an error: ${err instanceof Error ? err.message : String(err)}`,
        );
      } catch (reportErr) {
        log.error("Failed to report error to Paperclip", {}, reportErr instanceof Error ? reportErr : undefined);
      }
    }
  }

  // ── Step 9: Report cost tracking data to Paperclip ────────────────
  const costSummary = costTracker.getSummary();
  const costRecords = costTracker.getRecords();
  log.info("Cost summary", {
    interactions: costSummary.interactionCount,
    inputTokens: costSummary.totalInputTokens,
    outputTokens: costSummary.totalOutputTokens,
    estimatedCostUsd: costSummary.totalCostUsd.toFixed(4),
  });

  // 9a. Report each LLM interaction as a native Paperclip cost event
  //     POST /api/companies/:companyId/cost-events — feeds the /costs dashboard,
  //     budget enforcement, and per-agent/per-model spend analytics.
  const firstIssue = inbox[0];
  let costEventsPosted = 0;

  for (const record of costRecords) {
    try {
      await paperclipClient.reportCostEvent({
        agentId: env.agentId,
        issueId: firstIssue?.id ?? null,
        projectId: firstIssue?.projectId ?? null,
        heartbeatRunId: env.heartbeatRunId ?? null,
        provider: inferProvider(record.model),
        biller: "github_copilot",
        billingType: "subscription_included",
        model: record.model,
        inputTokens: record.inputTokens,
        outputTokens: record.outputTokens,
        costCents: Math.round(record.estimatedCostUsd * 100),
        occurredAt: record.timestamp,
      });
      costEventsPosted++;
    } catch (err) {
      log.warn("Failed to post cost event to Paperclip", {
        model: record.model,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (costEventsPosted > 0) {
    log.info("Cost events posted to Paperclip", { count: costEventsPosted });
  }

  // NOTE: Cost tracking is reported exclusively via Paperclip's native
  // cost-events API (Step 9a above). We do NOT post cost summary comments
  // to issues — the /costs dashboard is the single source of truth for
  // spend analytics, budget enforcement, and per-agent cost breakdowns.

  // ── Step 10: Cleanup ────────────────────────────────────────────────
  await sessionManager.stop();

  // Flush and shut down OpenTelemetry exporters so all spans/metrics
  // are delivered before the short-lived heartbeat process exits.
  if (otelEnabled) {
    try {
      await shutdownTracing();
      await shutdownMetrics();
    } catch (err) {
      log.warn("OTel shutdown error (non-fatal)", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const elapsed = Date.now() - startTime;
  log.info("Heartbeat finished", {
    durationMs: elapsed,
    outcome: "completed",
    issuesProcessed: inbox.length,
    estimatedCostUsd: costSummary.totalCostUsd,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Process Entry
// ─────────────────────────────────────────────────────────────────────────────

main().catch((err) => {
  log.error("Heartbeat entrypoint crashed", {}, err instanceof Error ? err : undefined);
  console.error("💥 Heartbeat entrypoint fatal error:", err);
  process.exit(1);
});

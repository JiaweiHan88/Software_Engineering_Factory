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
 * - PAPERCLIP_RUN_ID — Current heartbeat run ID (for transcripts)
 * - PAPERCLIP_WORKSPACE_CWD — Resolved workspace directory (aa27db4 parity)
 *
 * Additional env (from .env or inherited):
 * - COPILOT_GHE_HOST — GHE hostname for Copilot SDK
 * - COPILOT_MODEL — Default model override
 * - TARGET_PROJECT_ROOT — Workspace for agents to operate in (fallback when PAPERCLIP_WORKSPACE_CWD not set)
 *
 * @module heartbeat-entrypoint
 */

import "dotenv/config";

import { resolve } from "node:path";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { PaperclipClient } from "./adapter/paperclip-client.js";
import type { PaperclipAgent, PaperclipIssue, IssueHeartbeatContext } from "./adapter/paperclip-client.js";
import { PaperclipReporter } from "./adapter/reporter.js";
import { SessionManager } from "./adapter/session-manager.js";
import { AgentDispatcher } from "./adapter/agent-dispatcher.js";
import { handlePaperclipIssue } from "./adapter/heartbeat-handler.js";
import { orchestrateCeoIssue, reEvaluateDelegation, handleApprovalDecision } from "./adapter/ceo-orchestrator.js";
import { withRetry, isPaperclipRetryable } from "./adapter/retry.js";
import { resolveRoleMapping, PAPERCLIP_SKILLS } from "./config/role-mapping.js";
import type { RoleMappingEntry } from "./config/role-mapping.js";
import { loadConfig } from "./config/config.js";
import { allTools, setToolContext, clearToolContext } from "./tools/index.js";
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
 *   PAPERCLIP_AGENT_ID, PAPERCLIP_COMPANY_ID, PAPERCLIP_API_URL, PAPERCLIP_API_KEY
 *
 * PAPERCLIP_API_KEY is a JWT that encodes the agent's identity.
 * Using it as a Bearer token ensures all API calls (comments, checkouts,
 * cost events) are attributed to the agent rather than the board user.
 *
 * Phase A3: Extended with full wake context env vars from Paperclip SKILL.md.
 * Parity: Extended with workspace context env vars from Paperclip execute.ts (aa27db4).
 */
interface PaperclipEnv {
  /** Agent API key (JWT) for Bearer auth — injected by process adapter as PAPERCLIP_API_KEY */
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

  // ── Workspace Context (Parity with execute.ts aa27db4) ────────────

  /** Resolved workspace CWD — canonical working directory for this agent run */
  workspaceCwd: string | undefined;
  /** Workspace source: project_primary | task_session | agent_home */
  workspaceSource: string | undefined;
  /** Workspace strategy: per_task | shared | etc. */
  workspaceStrategy: string | undefined;
  /** Workspace ID (Paperclip-managed workspace identity) */
  workspaceId: string | undefined;
  /** Git repo URL for workspace */
  workspaceRepoUrl: string | undefined;
  /** Git ref for workspace */
  workspaceRepoRef: string | undefined;
  /** Git branch name */
  workspaceBranch: string | undefined;
  /** Git worktree path (if using worktree strategy) */
  workspaceWorktreePath: string | undefined;
}

/**
 * Extract and validate Paperclip env vars injected by the process adapter.
 *
 * Accepts both process adapter env vars (PAPERCLIP_API_URL) and
 * standalone env vars (PAPERCLIP_URL, PAPERCLIP_AGENT_API_KEY) for flexibility.
 *
 * Phase A3: Also reads wake context env vars (PAPERCLIP_TASK_ID, WAKE_REASON, etc.)
 * Phase A5: Primary var is PAPERCLIP_RUN_ID (injected by process adapter).
 * PAPERCLIP_HEARTBEAT_RUN_ID is kept as a deprecated fallback for local scripts.
 *
 * @throws Error if required env vars are missing
 */
function extractPaperclipEnv(): PaperclipEnv {
  // Agent API key: Paperclip's process adapter injects PAPERCLIP_API_KEY (JWT)
  // with the agent's identity. This is a per-agent, per-run token.
  //
  // IMPORTANT: Do NOT fall back to PAPERCLIP_AGENT_API_KEY here.
  // That's a static shared key from .env loaded by dotenv into ALL heartbeat
  // processes — using it would make all agents authenticate as the same agent,
  // causing wrong comment attribution and potential 401 errors.
  const agentApiKey = process.env.PAPERCLIP_API_KEY || undefined;

  // Process adapter sets PAPERCLIP_API_URL; .env may set PAPERCLIP_URL
  const url = process.env.PAPERCLIP_API_URL || process.env.PAPERCLIP_URL || "http://localhost:3100";

  const companyId = process.env.PAPERCLIP_COMPANY_ID;
  const agentId = process.env.PAPERCLIP_AGENT_ID;

  // PAPERCLIP_RUN_ID is the canonical name injected by the process adapter.
  // PAPERCLIP_HEARTBEAT_RUN_ID is a deprecated alias kept for local/test scripts.
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

    // Workspace context (parity with execute.ts aa27db4)
    workspaceCwd: process.env.PAPERCLIP_WORKSPACE_CWD || undefined,
    workspaceSource: process.env.PAPERCLIP_WORKSPACE_SOURCE || undefined,
    workspaceStrategy: process.env.PAPERCLIP_WORKSPACE_STRATEGY || undefined,
    workspaceId: process.env.PAPERCLIP_WORKSPACE_ID || undefined,
    workspaceRepoUrl: process.env.PAPERCLIP_WORKSPACE_REPO_URL || undefined,
    workspaceRepoRef: process.env.PAPERCLIP_WORKSPACE_REPO_REF || undefined,
    workspaceBranch: process.env.PAPERCLIP_WORKSPACE_BRANCH || undefined,
    workspaceWorktreePath: process.env.PAPERCLIP_WORKSPACE_WORKTREE_PATH || undefined,
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

  // 1. Agent-specific BMAD skills (from bmad_res/skills/ directory)
  for (const skillName of mapping.bmadSkills) {
    const skillDir = resolve(projectRoot, "bmad_res/skills", skillName);
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
  // NOTE: .github/skills is excluded — it contains interactive BMAD skills (bmad-init,
  // bmad-agent-* persona SKILL.md files) that conflict with autonomous headless sessions.
  const globalDirs = [
    resolve(projectRoot, "src/skills"),
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
 * `bmad_res/agents/{agentConfigDir}/` directory. These are injected as the
 * system message for the Copilot SDK session, giving the agent its
 * identity, persona, heartbeat protocol, and tool awareness.
 *
 * @param mapping - Role mapping entry with agentConfigDir
 * @param projectRoot - Factory project root
 * @returns The 4-file content, or null if the config dir doesn't exist
 */
function loadAgentConfigFiles(mapping: RoleMappingEntry, projectRoot: string): AgentConfigFiles | null {
  const configDir = resolve(projectRoot, "bmad_res/agents", mapping.agentConfigDir);

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
  // Always use agent API key when available — the JWT encodes the agent's
  // identity so Paperclip attributes comments, checkouts, and cost events
  // to the correct agent. Without it, all actions appear as "board" user.
  // In local_trusted mode the auth middleware accepts both JWT and no-auth,
  // so sending the key never causes ownership conflicts.
  const deploymentMode = process.env.PAPERCLIP_DEPLOYMENT_MODE;
  const useAgentKey = !!env.agentApiKey;

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

  // Resolve workspace CWD: Paperclip's workspace runtime (PAPERCLIP_WORKSPACE_CWD)
  // takes precedence, then TARGET_PROJECT_ROOT from .env, then undefined.
  const resolvedWorkspaceCwd = env.workspaceCwd || process.env.TARGET_PROJECT_ROOT || undefined;
  if (env.workspaceCwd) {
    log.info("Workspace context from Paperclip", {
      cwd: env.workspaceCwd,
      source: env.workspaceSource ?? "unknown",
      strategy: env.workspaceStrategy ?? "unknown",
      branch: env.workspaceBranch ?? "n/a",
      repoUrl: env.workspaceRepoUrl ?? "n/a",
    });
  }

  const reporter = new PaperclipReporter(paperclipClient, 500, resolvedWorkspaceCwd);

  // ── Step 2b: Budget check ─────────────────────────────────────────────
  // Check agent budget utilization before doing any work. Paperclip will
  // auto-pause agents that hit 100%, but we check early to avoid starting
  // work we can't finish and to log a clear warning above 80%.
  try {
    const agentBudgetCheck = useAgentKey
      ? await paperclipClient.getAgentSelf()
      : await paperclipClient.getAgent(env.agentId);

    const budgetMonthly = (agentBudgetCheck.metadata?.budgetMonthlyCents as number | undefined) ?? agentBudgetCheck.monthlyBudget;
    const spentMonthly = agentBudgetCheck.metadata?.spentMonthlyCents as number | undefined;

    if (typeof budgetMonthly === "number" && budgetMonthly > 0 && typeof spentMonthly === "number") {
      const utilizationPct = (spentMonthly / budgetMonthly) * 100;
      if (utilizationPct >= 100) {
        log.error("Agent budget hard-stop reached — aborting heartbeat", {
          spentMonthlyCents: spentMonthly,
          budgetMonthlyCents: budgetMonthly,
          utilizationPct: utilizationPct.toFixed(1),
        });
        process.exit(0); // Clean exit — this is expected behavior, not a crash
      } else if (utilizationPct >= 80) {
        log.warn("Agent budget critical threshold — proceeding with caution", {
          spentMonthlyCents: spentMonthly,
          budgetMonthlyCents: budgetMonthly,
          utilizationPct: utilizationPct.toFixed(1),
        });
      } else {
        log.info("Agent budget OK", {
          utilizationPct: utilizationPct.toFixed(1),
        });
      }
    }
  } catch (budgetErr) {
    // Non-fatal — budget check failure should not block the heartbeat
    log.warn("Budget check failed (non-fatal)", {
      error: budgetErr instanceof Error ? budgetErr.message : String(budgetErr),
    });
  }
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

  // ── Step 5a: Approval follow-up (P2-7) ─────────────────────────────
  // When woken by an approval decision, CEO agents handle it explicitly.
  // Non-CEO agents just note it and continue — the approval context informs behavior.
  if (env.approvalId && env.approvalStatus) {
    log.info("Handling approval wake", {
      approvalId: env.approvalId,
      approvalStatus: env.approvalStatus,
    });
    if (mapping.isOrchestrator && env.taskId) {
      // CEO: fetch the triggering issue and run the approval decision handler
      try {
        const approvalIssue = await paperclipClient.getIssue(env.taskId);
        await handleApprovalDecision(
          env.approvalId,
          env.approvalStatus,
          approvalIssue,
          paperclipClient,
        );
      } catch (approvalErr) {
        log.warn("Approval decision handling failed (non-fatal, continuing)", {
          approvalId: env.approvalId,
          error: approvalErr instanceof Error ? approvalErr.message : String(approvalErr),
        });
      }
    } else if (env.taskId) {
      // Non-CEO: log the approval context; agent sees it via task description
      log.info("Approval wake for non-CEO agent — approval context will inform task", {
        taskId: env.taskId,
        approvalStatus: env.approvalStatus,
      });
    }
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

  // ── Step 5c: Wake-reason routing (P1-6) ────────────────────────────
  // Route behavior based on WHY this heartbeat was triggered.
  // This shapes which issue gets priority and what context is pre-loaded.
  if (env.wakeReason) {
    switch (env.wakeReason) {
      case "comment":
        // A comment was posted — the triggering comment is critical context.
        // Log it now; it will be fetched via heartbeat-context in Step 8.
        log.info("Woke on comment — will prioritize wake comment context", {
          taskId: env.taskId ?? "n/a",
          wakeCommentId: env.wakeCommentId ?? "n/a",
        });
        break;

      case "assignment":
        // A new task was assigned — this is the normal dev path.
        log.info("Woke on assignment", { taskId: env.taskId ?? "n/a" });
        break;

      case "on_demand":
        // Manually triggered (board user or test script) — treat as assignment.
        log.info("Woke on demand", { taskId: env.taskId ?? "n/a" });
        break;

      case "timer":
      default:
        // Scheduled heartbeat — process inbox normally.
        log.info("Woke on timer (scheduled heartbeat)");
        break;
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

  // ── Step 6.5: Load agent memory (PARA system) ────────────────────────
  if (mapping.isOrchestrator && agentSystemMessage) {
    const memoryDir = resolve(resolvedWorkspaceCwd ?? process.cwd(), '_bmad-output/memory');
    const learningsDir = resolve(memoryDir, 'learnings');

    if (existsSync(learningsDir)) {
      const memoryFiles = readdirSync(learningsDir)
        .filter((f: string) => f.endsWith('.md'))
        .sort(); // chronological by filename

      if (memoryFiles.length > 0) {
        const memoryContent = memoryFiles
          .map((f: string) => readFileSync(resolve(learningsDir, f), 'utf-8'))
          .join('\n\n---\n\n');

        if (memoryContent.length > 0) {
          agentSystemMessage += '\n\n## Learnings from Previous Epics\n\n' + memoryContent;
          log.info("Loaded PARA learnings into system message", {
            fileCount: memoryFiles.length,
            contentLength: memoryContent.length,
          });
        }
      }
    }
  }

  // ── Step 7: Bootstrap Copilot SDK (SessionManager + Dispatcher) ─────
  const config = loadConfig();

  // Override Paperclip config with env from process adapter
  config.paperclip.url = env.url;
  config.paperclip.agentApiKey = env.agentApiKey;
  config.paperclip.companyId = env.companyId;
  config.paperclip.enabled = true;

  // Inject workspace context from process adapter env vars into config
  // so AgentDispatcher can prepend it to all dispatch prompts.
  if (env.workspaceRepoUrl || env.workspaceBranch || env.workspaceStrategy || env.workspaceWorktreePath) {
    config.workspaceContext = {
      repoUrl: env.workspaceRepoUrl,
      branch: env.workspaceBranch,
      strategy: env.workspaceStrategy,
      worktreePath: env.workspaceWorktreePath,
    };
  }

  // Inject agent 4-file system message into config for session creation
  if (agentSystemMessage) {
    config.agentSystemMessage = agentSystemMessage;
  }

  const sessionManager = new SessionManager(config);
  await sessionManager.start();

  const costTracker = new CostTracker();
  const dispatcher = new AgentDispatcher(sessionManager, config, costTracker);

  // M2: Create ReviewOrchestrator for code-review phase routing
  const { ReviewOrchestrator } = await import("./quality-gates/review-orchestrator.js");
  const reviewOrchestrator = new ReviewOrchestrator(dispatcher, config);

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

    // ── Prerequisite guard: skip issues whose dependencies aren't done ──
    // The CEO creates sub-issues with metadata.dependsOn (array of task
    // indices that must complete first). If any dependency is not done,
    // skip this issue — the CEO's re-evaluation will promote it later.
    const meta = issue.metadata as Record<string, unknown> | undefined;
    const dependsOn = Array.isArray(meta?.dependsOn) ? (meta.dependsOn as number[]) : [];
    const parentIssueId = meta?.parentIssueId as string | undefined;

    if (dependsOn.length > 0 && parentIssueId) {
      try {
        const siblings = await paperclipClient.listIssues({ parentId: parentIssueId });
        const siblingsByIndex = new Map<number, PaperclipIssue>();
        for (const sib of siblings) {
          const sibMeta = sib.metadata as Record<string, unknown> | undefined;
          const sibIdx = sibMeta?.taskIndex;
          if (typeof sibIdx === "number") {
            siblingsByIndex.set(sibIdx, sib);
          }
        }

        const unmetDeps = dependsOn.filter((depIdx) => {
          const dep = siblingsByIndex.get(depIdx);
          return !dep || dep.status !== "done";
        });

        if (unmetDeps.length > 0) {
          const unmetLabels = unmetDeps.map((d) => {
            const dep = siblingsByIndex.get(d);
            return dep?.identifier ?? `task-${d}`;
          });
          log.info("Skipping issue — prerequisites not met", {
            issueId: issue.id,
            identifier: issue.identifier,
            unmetDeps: unmetLabels,
          });
          continue;
        }
      } catch (depErr) {
        // Non-fatal: if we can't check deps, proceed with processing
        // (better to attempt than silently skip)
        log.warn("Prerequisite check failed, proceeding", {
          issueId: issue.id,
          error: depErr instanceof Error ? depErr.message : String(depErr),
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
      // ── M0: Set tool context before dispatching ─────────────────────
      const issueMeta = lockedIssue.metadata as Record<string, unknown> | undefined;
      setToolContext({
        paperclipClient: paperclipClient,
        agentId: env.agentId,
        issueId: lockedIssue.id,
        parentIssueId: lockedIssue.parentId ?? (issueMeta?.parentIssueId as string | undefined),
        workspaceDir: resolvedWorkspaceCwd ?? process.cwd(),
        companyId: env.companyId,
      });

      // ── P1-8: Fetch rich heartbeat context (single round-trip) ──────
      // Replaces separate getIssue() + getIssueComments() calls.
      // Provides ancestors, project/goal linkage, comment cursor, and
      // (for comment-wakes) the specific triggering comment.
      let heartbeatCtx: IssueHeartbeatContext | undefined;
      try {
        const wakeCommentId = issue.id === env.taskId ? env.wakeCommentId : undefined;
        heartbeatCtx = await paperclipClient.getHeartbeatContext(lockedIssue.id, wakeCommentId);
        log.info("Heartbeat context loaded", {
          issueId: lockedIssue.id,
          ancestorCount: heartbeatCtx.ancestors.length,
          hasProject: !!heartbeatCtx.project,
          hasGoal: !!heartbeatCtx.goal,
          hasWakeComment: !!heartbeatCtx.wakeComment,
          commentCursor: heartbeatCtx.commentCursor ?? "n/a",
        });
      } catch (ctxErr) {
        // Non-fatal — fall back to the minimal issue data from inbox
        log.warn("Failed to load heartbeat context, using inbox data", {
          issueId: lockedIssue.id,
          error: ctxErr instanceof Error ? ctxErr.message : String(ctxErr),
        });
      }

      if (mapping.isOrchestrator) {
        // ── CEO routing: initial delegation vs re-evaluation ──────────
        // If sub-issues already exist → re-evaluate (promote backlog tasks
        // whose prerequisites are now met).
        // If no sub-issues → fresh delegation (decompose and create plan).
        const existingChildren = await paperclipClient.listIssues({ parentId: lockedIssue.id });
        const activeChildren = existingChildren.filter(
          (c) => c.status !== "cancelled",
        );

        if (activeChildren.length > 0) {
          // Re-evaluation mode: check deps, promote ready backlog tasks
          log.info("CEO re-evaluation mode (existing sub-issues)", {
            issueId: lockedIssue.id,
            childCount: activeChildren.length,
          });
          const reEvalResult = await reEvaluateDelegation(
            lockedIssue,
            paperclipClient,
            sessionManager,
            config,
            costTracker,
          );
          log.info("CEO re-evaluation result", {
            issueId: lockedIssue.id,
            promoted: reEvalResult.promoted,
            allDone: reEvalResult.allDone,
          });
        } else {
          // Initial delegation mode: decompose issue into sub-tasks
          const result = await orchestrateCeoIssue(
            lockedIssue,
            agentSelf,
            paperclipClient,
            reporter,
            sessionManager,
            config,
            mapping,
            costTracker,
            heartbeatCtx,
          );
          log.info("CEO orchestration result", {
            issueId: lockedIssue.id,
            success: result.success,
            subtasksCreated: result.subtasksCreated,
          });
        }
      } else {
        // Domain agent: process the issue directly
        await handlePaperclipIssue(lockedIssue, env.agentId, bmadRole, dispatcher, reporter, reviewOrchestrator, heartbeatCtx);
      }
      // On success: don't release — checkout holds until status change
      // ── M0: Clear tool context after processing ─────────────────────
      clearToolContext();
    } catch (err) {
      // ── M0: Clear tool context on error ─────────────────────────────
      clearToolContext();
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
        issueId: record.issueId ?? firstIssue?.id ?? null,
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

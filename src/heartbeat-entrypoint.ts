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

const log = Logger.child("heartbeat-entrypoint");

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
  /** Current heartbeat run ID */
  heartbeatRunId: string | undefined;
}

/**
 * Extract and validate Paperclip env vars injected by the process adapter.
 *
 * Accepts both process adapter env vars (PAPERCLIP_API_URL) and
 * standalone env vars (PAPERCLIP_URL, PAPERCLIP_AGENT_API_KEY) for flexibility.
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
  const heartbeatRunId = process.env.PAPERCLIP_HEARTBEAT_RUN_ID;

  if (!companyId) {
    throw new Error("Missing PAPERCLIP_COMPANY_ID — required for company-scoped API calls");
  }

  if (!agentId) {
    throw new Error("Missing PAPERCLIP_AGENT_ID — required to identify the agent");
  }

  return { agentApiKey, url, companyId, agentId, heartbeatRunId };
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

  // 1. Agent-specific BMAD skills (from skills/ directory in project root)
  for (const skillName of mapping.bmadSkills) {
    const skillDir = resolve(projectRoot, "skills", skillName);
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
 * `agents/{agentConfigDir}/` directory. These are injected as the
 * system message for the Copilot SDK session, giving the agent its
 * identity, persona, heartbeat protocol, and tool awareness.
 *
 * @param mapping - Role mapping entry with agentConfigDir
 * @param projectRoot - Factory project root
 * @returns The 4-file content, or null if the config dir doesn't exist
 */
function loadAgentConfigFiles(mapping: RoleMappingEntry, projectRoot: string): AgentConfigFiles | null {
  const configDir = resolve(projectRoot, "agents", mapping.agentConfigDir);

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
  });

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
    companyId: env.companyId,
    // Only send heartbeat run ID when Paperclip created the run (non-local_trusted).
    // In local_trusted mode with manual invocation, the run ID doesn't exist in the
    // heartbeat_runs table, causing FK constraint violations on activity_log writes.
    heartbeatRunId: useAgentKey ? env.heartbeatRunId : undefined,
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
  // For orchestrator (CEO): also skip in_progress — that means delegation
  // already happened and sub-tasks are being worked on.
  const TERMINAL_STATUSES = new Set(["done", "cancelled"]);
  const SKIP_FOR_ORCHESTRATOR = new Set(["done", "cancelled", "in_progress"]);
  let inbox: PaperclipIssue[];
  try {
    const { value } = await withRetry(
      async () => {
        if (useAgentKey) {
          return paperclipClient.getAgentInbox();
        }
        const skipSet = mapping.isOrchestrator ? SKIP_FOR_ORCHESTRATOR : TERMINAL_STATUSES;
        const allIssues = await paperclipClient.listIssues({ assigneeAgentId: env.agentId });
        return allIssues.filter((i) => !skipSet.has(i.status));
      },
      { maxAttempts: 3, label: "check-inbox", isRetryable: isPaperclipRetryable },
    );
    inbox = value;
    log.info("Inbox checked", { issueCount: inbox.length });
  } catch (err) {
    log.error("Failed to check inbox", {}, err instanceof Error ? err : undefined);
    process.exit(1);
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
  const bmadRole = mapping.bmadAgentName ?? "ceo";

  for (const issue of inbox) {
    log.info("Processing issue", {
      issueId: issue.id,
      title: issue.title,
      storyId: issue.storyId ?? "n/a",
    });

    try {
      if (mapping.isOrchestrator) {
        // ── Guard: skip if CEO already delegated this issue ────────────
        // Defense-in-depth: if sub-issues exist, another heartbeat already
        // ran delegation. Skip to avoid duplicates.
        const existingChildren = await paperclipClient.listIssues({ parentId: issue.id });
        const activeChildren = existingChildren.filter(
          (c) => c.status !== "cancelled",
        );
        if (activeChildren.length > 0) {
          log.info("Skipping already-delegated issue (has active sub-issues)", {
            issueId: issue.id,
            childCount: activeChildren.length,
          });
          continue;
        }

        // CEO orchestrator: use Copilot SDK session to analyze issue,
        // produce a structured delegation plan, and create sub-issues
        const result = await orchestrateCeoIssue(
          issue,
          agentSelf,
          paperclipClient,
          reporter,
          sessionManager,
          config,
          mapping,
          costTracker,
        );
        log.info("CEO orchestration result", {
          issueId: issue.id,
          success: result.success,
          subtasksCreated: result.subtasksCreated,
        });
      } else {
        // Domain agent: process the issue directly
        await handlePaperclipIssue(issue, env.agentId, bmadRole, dispatcher, reporter);
      }
    } catch (err) {
      log.error("Failed to process issue", { issueId: issue.id }, err instanceof Error ? err : undefined);

      // Report failure back to Paperclip
      try {
        await paperclipClient.addIssueComment(
          issue.id,
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

  // 9b. Post human-readable cost summary as issue comment
  if (firstIssue) {
    try {
      const costMarkdown = costSummary.interactionCount > 0
        ? costTracker.formatSummaryMarkdown()
        : [
            "📊 **Cost Tracker** — No LLM interactions recorded",
            "",
            "The heartbeat completed without any tracked LLM calls.",
            `This may indicate the agent used a code path that bypasses the dispatcher.`,
          ].join("\n");
      await paperclipClient.addIssueComment(firstIssue.id, costMarkdown);
    } catch (costReportErr) {
      log.warn("Failed to post cost summary comment to Paperclip", {
        error: costReportErr instanceof Error ? costReportErr.message : String(costReportErr),
      });
    }
  }

  // ── Step 10: Cleanup ────────────────────────────────────────────────
  await sessionManager.stop();

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

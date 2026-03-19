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
import { existsSync } from "node:fs";
import { PaperclipClient } from "./adapter/paperclip-client.js";
import type { PaperclipAgent, PaperclipIssue } from "./adapter/paperclip-client.js";
import { PaperclipReporter } from "./adapter/reporter.js";
import { SessionManager } from "./adapter/session-manager.js";
import { AgentDispatcher } from "./adapter/agent-dispatcher.js";
import { handlePaperclipIssue } from "./adapter/heartbeat-handler.js";
import { resolveRoleMapping, PAPERCLIP_SKILLS } from "./config/role-mapping.js";
import type { RoleMappingEntry } from "./config/role-mapping.js";
import { loadConfig } from "./config/config.js";
import { getAgent, allAgents } from "./agents/registry.js";
import { allTools } from "./tools/index.js";
import { Logger } from "./observability/logger.js";

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

  // ── Step 2: Create Paperclip client (with this agent's API key) ─────
  const paperclipClient = new PaperclipClient({
    baseUrl: env.url,
    agentApiKey: env.agentApiKey,
    companyId: env.companyId,
  });

  const reporter = new PaperclipReporter(paperclipClient);

  // ── Step 3: Identify self ─────────────────────────────────────────
  // In process adapter mode (local_trusted), we use GET /api/agents/:id
  // because /api/agents/me requires agent-key auth which the process
  // adapter doesn't inject. With an agent API key, we try /me first.
  let agentSelf: PaperclipAgent;
  try {
    if (env.agentApiKey) {
      agentSelf = await paperclipClient.getAgentSelf();
    } else {
      agentSelf = await paperclipClient.getAgent(env.agentId);
    }
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
  // In process adapter mode (local_trusted), /agents/me/inbox-lite requires
  // agent-key auth. Use listIssues with assignee filter instead.
  let inbox: PaperclipIssue[];
  try {
    if (env.agentApiKey) {
      inbox = await paperclipClient.getAgentInbox();
    } else {
      inbox = await paperclipClient.listIssues({ assigneeId: env.agentId });
    }
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

  // ── Step 6: Bootstrap Copilot SDK (SessionManager + Dispatcher) ─────
  const config = loadConfig();

  // Override Paperclip config with env from process adapter
  config.paperclip.url = env.url;
  config.paperclip.agentApiKey = env.agentApiKey;
  config.paperclip.companyId = env.companyId;
  config.paperclip.enabled = true;

  const sessionManager = new SessionManager(config);
  await sessionManager.start();

  const dispatcher = new AgentDispatcher(sessionManager, config);

  // ── Step 7: Process each assigned issue ─────────────────────────────
  const bmadRole = mapping.bmadAgentName ?? "ceo";

  for (const issue of inbox) {
    log.info("Processing issue", {
      issueId: issue.id,
      title: issue.title,
      storyId: issue.storyId ?? "n/a",
    });

    try {
      if (mapping.isOrchestrator) {
        // CEO orchestrator: delegate the issue to appropriate sub-agent
        await handleOrchestratorIssue(issue, agentSelf, paperclipClient, reporter, dispatcher);
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

  // ── Step 8: Cleanup ─────────────────────────────────────────────────
  await sessionManager.stop();

  const elapsed = Date.now() - startTime;
  log.info("Heartbeat finished", {
    durationMs: elapsed,
    outcome: "completed",
    issuesProcessed: inbox.length,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Orchestrator (CEO) Issue Handling
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Handle an issue as the CEO orchestrator.
 *
 * The CEO doesn't do domain work itself — it analyzes the issue,
 * determines which BMAD agent should handle it, and delegates by
 * either creating a sub-issue or reassigning.
 *
 * For now, the CEO uses a simple heuristic to delegate. In future,
 * this will be a full Copilot SDK session where the CEO agent reasons
 * about the issue and decides the delegation plan.
 *
 * @param issue - The issue from the CEO's inbox
 * @param ceoAgent - The CEO's Paperclip agent record
 * @param client - Paperclip API client
 * @param reporter - Reporter for issue comments
 * @param dispatcher - Agent dispatcher (for fallback direct dispatch)
 */
async function handleOrchestratorIssue(
  issue: PaperclipIssue,
  ceoAgent: PaperclipAgent,
  client: PaperclipClient,
  reporter: PaperclipReporter,
  dispatcher: AgentDispatcher,
): Promise<void> {
  log.info("CEO orchestrator processing issue", {
    issueId: issue.id,
    title: issue.title,
  });

  // Determine the appropriate agent based on issue labels/phase/content
  const targetRole = inferTargetRole(issue);

  if (targetRole) {
    // Post delegation comment on the issue
    await client.addIssueComment(
      issue.id,
      `🎯 **CEO** — Delegating to **${targetRole}** for processing.`,
    );

    // Reassign the issue to the target agent (by updating assignee)
    // In a full implementation, CEO would create sub-issues or use
    // the Copilot SDK to reason about the delegation.
    log.info("CEO delegating issue", { targetRole, issueId: issue.id });

    // For now, dispatch directly through our existing dispatcher
    const result = await dispatcher.dispatchDirect(
      targetRole,
      `Process this issue:\n\nTitle: ${issue.title}\nDescription: ${issue.description}\n\nStory ID: ${issue.storyId ?? "N/A"}`,
    );

    await reporter.reportDispatchResult(ceoAgent.id, issue.id, result);
  } else {
    // Can't determine target — report back for human review
    await client.addIssueComment(
      issue.id,
      `⚠️ **CEO** — Unable to determine which agent should handle this issue. Requesting human guidance.`,
    );

    log.warn("CEO couldn't determine target role for issue", {
      issueId: issue.id,
      title: issue.title,
    });
  }
}

/**
 * Infer which BMAD agent should handle an issue based on its content.
 *
 * Simple heuristic for Phase 1. Future versions will use a full
 * Copilot SDK session where the CEO reasons about delegation.
 *
 * @param issue - The Paperclip issue to analyze
 * @returns BMAD agent name, or null if uncertain
 */
function inferTargetRole(issue: PaperclipIssue): string | null {
  const text = `${issue.title} ${issue.description}`.toLowerCase();
  const phase = issue.phase?.toLowerCase();
  const labels = (issue.labels ?? []).map((l) => l.toLowerCase());

  // Explicit phase label
  if (phase === "create-story" || labels.includes("story-creation")) return "bmad-pm";
  if (phase === "dev-story" || labels.includes("development")) return "bmad-dev";
  if (phase === "code-review" || labels.includes("review")) return "bmad-qa";
  if (phase === "sprint-planning" || labels.includes("planning")) return "bmad-sm";
  if (phase === "sprint-status" || labels.includes("status")) return "bmad-sm";

  // Content heuristic
  if (text.includes("prd") || text.includes("product requirement")) return "bmad-pm";
  if (text.includes("architecture") || text.includes("tech design")) return "bmad-architect";
  if (text.includes("implement") || text.includes("develop") || text.includes("code")) return "bmad-dev";
  if (text.includes("test") || text.includes("review") || text.includes("qa")) return "bmad-qa";
  if (text.includes("sprint") || text.includes("planning")) return "bmad-sm";
  if (text.includes("ux") || text.includes("design") || text.includes("wireframe")) return "bmad-ux-designer";
  if (text.includes("document") || text.includes("doc")) return "bmad-tech-writer";
  if (text.includes("research") || text.includes("analysis")) return "bmad-analyst";

  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Process Entry
// ─────────────────────────────────────────────────────────────────────────────

main().catch((err) => {
  log.error("Heartbeat entrypoint crashed", {}, err instanceof Error ? err : undefined);
  console.error("💥 Heartbeat entrypoint fatal error:", err);
  process.exit(1);
});

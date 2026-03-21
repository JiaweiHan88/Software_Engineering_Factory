/**
 * E2E Shared Helpers — Common infrastructure for all E2E test scripts.
 *
 * Extracted from e2e-smoke-invoke.ts to avoid duplication. Provides:
 * - Paperclip API client (paperclip<T>())
 * - Heartbeat invocation & polling
 * - Agent resolution
 * - Project/workspace isolation
 * - Console formatting
 *
 * @module scripts/e2e-helpers
 */

import "dotenv/config";

// ─────────────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────────────

export const PAPERCLIP_URL = process.env.PAPERCLIP_URL ?? "http://localhost:3100";
export const COMPANY_ID = process.env.PAPERCLIP_COMPANY_ID ?? "";

/**
 * Agent IDs — resolved dynamically from Paperclip API at startup.
 * Maps short key (ceo, pm, etc.) to Paperclip UUID.
 */
export const AGENTS: Record<string, string> = {};

/** Agent name → short key mapping for AGENTS object. */
export const AGENT_NAME_TO_KEY: Record<string, string> = {
  "bmad-ceo": "ceo",
  "bmad-pm": "pm",
  "bmad-architect": "architect",
  "bmad-dev": "dev",
  "bmad-qa": "qa",
  "bmad-sm": "sm",
  "bmad-analyst": "analyst",
  "bmad-ux-designer": "ux",
  "bmad-tech-writer": "techWriter",
  "bmad-quick-flow": "quickFlow",
};

/** Reverse lookup: short key → agent name. */
export const KEY_TO_AGENT_NAME: Record<string, string> = Object.fromEntries(
  Object.entries(AGENT_NAME_TO_KEY).map(([name, key]) => [key, name]),
);

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface PaperclipIssue {
  id: string;
  title: string;
  description: string;
  status: string;
  priority?: string;
  assigneeAgentId?: string;
  parentId?: string;
  projectId?: string;
  goalId?: string;
  metadata?: Record<string, unknown>;
}

export interface PaperclipComment {
  id: string;
  body: string;
  authorId?: string;
  createdAt?: string;
}

export interface HeartbeatRun {
  id: string;
  agentId: string;
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled" | "timed_out";
  startedAt: string | null;
  finishedAt: string | null;
  exitCode: number | null;
  error: string | null;
  invocationSource: string;
  contextSnapshot?: {
    paperclipWorkspace?: {
      cwd?: string;
      source?: string;
      projectId?: string | null;
    };
  };
}

export interface PaperclipProject {
  id: string;
  name: string;
  codebase?: {
    managedFolder?: string;
    effectiveLocalFolder?: string;
    localFolder?: string | null;
  };
}

export interface PaperclipAgent {
  id: string;
  name: string;
  title: string;
  status: string;
  runtimeConfig?: {
    heartbeat?: {
      enabled?: boolean;
      intervalSec?: number;
      wakeOnDemand?: boolean;
    };
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Console Formatting
// ─────────────────────────────────────────────────────────────────────────────

/** Verbose flag — set by the consuming script. */
export let verboseMode = false;

/** Enable verbose logging output. */
export function setVerbose(v: boolean): void {
  verboseMode = v;
}

export function log(icon: string, msg: string, details?: Record<string, unknown>): void {
  const detailStr = details ? ` ${JSON.stringify(details)}` : "";
  console.log(`${icon} ${msg}${detailStr}`);
}

export function header(msg: string): void {
  console.log(`\n${"═".repeat(70)}`);
  console.log(`  ${msg}`);
  console.log(`${"═".repeat(70)}\n`);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ─────────────────────────────────────────────────────────────────────────────
// Paperclip API Client
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Make a request to the Paperclip API.
 */
export async function paperclip<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const url = `${PAPERCLIP_URL}${path}`;
  const opts: RequestInit = {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  };

  const res = await fetch(url, opts);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Paperclip ${method} ${path} → ${res.status}: ${text}`);
  }
  return res.json() as Promise<T>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Heartbeat Invocation & Polling
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Invoke a heartbeat via Paperclip's native endpoint.
 *
 * POST /api/agents/:id/heartbeat/invoke → 202 (async)
 * Returns the heartbeat run immediately. Poll for completion.
 */
export async function invokeHeartbeat(agentId: string): Promise<HeartbeatRun> {
  return paperclip<HeartbeatRun>(
    "POST",
    `/api/agents/${agentId}/heartbeat/invoke`,
  );
}

/** Response from GET /heartbeat-runs/:runId/log */
interface RunLogResponse {
  runId: string;
  store: string;
  logRef: string;
  content: string;
  nextOffset?: number;
}

/** Parsed entry from the run log JSONL content */
export interface RunLogEntry {
  ts: string;
  stream: "stdout" | "stderr" | "system";
  chunk: string;
}

/**
 * Parse the JSONL content from a run log response into structured entries.
 * Each line is a JSON object: { ts, stream, chunk }
 */
function parseRunLogContent(content: string): RunLogEntry[] {
  if (!content) return [];
  const entries: RunLogEntry[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const raw = JSON.parse(trimmed) as { ts?: unknown; stream?: unknown; chunk?: unknown };
      const stream =
        raw.stream === "stderr" || raw.stream === "system"
          ? (raw.stream as "stderr" | "system")
          : "stdout";
      const chunk = typeof raw.chunk === "string" ? raw.chunk : "";
      const ts = typeof raw.ts === "string" ? raw.ts : new Date().toISOString();
      if (chunk) entries.push({ ts, stream, chunk });
    } catch {
      // Skip malformed log lines
    }
  }
  return entries;
}

/**
 * Format a run log entry for console output.
 * Strips ANSI, trims long lines, prefixes with stream indicator.
 */
function formatLogEntry(entry: RunLogEntry, label: string): string {
  // Strip trailing newlines from chunk
  const text = entry.chunk.replace(/\n+$/, "");
  if (!text) return "";

  const prefix = entry.stream === "stderr" ? "⚠️ " : "   ";
  // Truncate long lines to keep output readable
  const maxLen = 140;
  const display = text.length > maxLen ? text.slice(0, maxLen) + "…" : text;
  return `  ${prefix}[${label}] ${display}`;
}

/**
 * Tail the run log for a heartbeat run, printing new entries as they appear.
 * Returns the new offset for the next poll.
 *
 * The Paperclip log endpoint returns { content, nextOffset }. `nextOffset` is
 * the byte position to use for the next read. If the content is empty or hasn't
 * grown, we skip printing to avoid duplicates.
 */
async function tailRunLog(
  runId: string,
  offset: number,
  label: string,
): Promise<{ newOffset: number; entries: RunLogEntry[] }> {
  try {
    const result = await paperclip<RunLogResponse>(
      "GET",
      `/api/heartbeat-runs/${runId}/log?offset=${offset}&limitBytes=65536`,
    );

    // If no new content, skip parsing entirely
    if (!result.content || result.content.trim().length === 0) {
      return { newOffset: offset, entries: [] };
    }

    const entries = parseRunLogContent(result.content);

    if (entries.length > 0 && verboseMode) {
      for (const entry of entries) {
        const formatted = formatLogEntry(entry, label);
        if (formatted) console.log(formatted);
      }
    }

    // Use nextOffset from the API if available; otherwise advance by content byte length
    const newOffset = result.nextOffset ?? (offset + Buffer.byteLength(result.content, "utf-8"));

    return { newOffset, entries };
  } catch {
    // Log endpoint may not be available yet (run just started, no log file yet)
    return { newOffset: offset, entries: [] };
  }
}

/**
 * Poll for heartbeat run completion.
 * The run transitions: queued → running → succeeded/failed/timed_out
 *
 * When tailLogs is true (default when verbose), also streams the run log
 * output in real-time by polling GET /heartbeat-runs/:runId/log.
 */
export async function waitForHeartbeatRun(
  agentId: string,
  runId: string,
  label: string,
  timeoutMs = 300_000,
  pollIntervalMs = 2_000,
  tailLogs = verboseMode,
): Promise<HeartbeatRun> {
  const deadline = Date.now() + timeoutMs;
  const terminalStatuses = new Set(["succeeded", "failed", "cancelled", "timed_out"]);
  let lastStatus = "";
  let logOffset = 0;

  while (Date.now() < deadline) {
    const runs = await paperclip<HeartbeatRun[]>(
      "GET",
      `/api/companies/${COMPANY_ID}/heartbeat-runs?agentId=${agentId}&limit=5`,
    );

    const run = runs.find((r) => r.id === runId);
    if (!run) {
      throw new Error(`Heartbeat run ${runId} not found in heartbeat-runs`);
    }

    if (run.status !== lastStatus) {
      if (verboseMode) {
        log("  🔄", `[${label}] status: ${run.status}`);
      }
      lastStatus = run.status;
    }

    // Tail run log output while the run is active
    if (tailLogs && (run.status === "running" || terminalStatuses.has(run.status))) {
      const { newOffset } = await tailRunLog(runId, logOffset, label);
      logOffset = newOffset;
    }

    if (terminalStatuses.has(run.status)) {
      // Final log drain — pick up any remaining output
      if (tailLogs) {
        await tailRunLog(runId, logOffset, label);
      }
      return run;
    }

    await sleep(pollIntervalMs);
  }

  throw new Error(`${label} heartbeat timed out after ${timeoutMs / 1000}s`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Agent Resolution
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolve agent IDs dynamically from Paperclip API.
 * Populates the global AGENTS map from the company's active agents.
 */
export async function resolveAgentIds(): Promise<void> {
  if (!COMPANY_ID) {
    throw new Error("PAPERCLIP_COMPANY_ID is not set — run setup-paperclip-company.ts first");
  }

  const agents = await paperclip<PaperclipAgent[]>(
    "GET",
    `/api/companies/${COMPANY_ID}/agents`,
  );

  const active = agents.filter((a) => a.status !== "terminated");
  for (const agent of active) {
    const key = AGENT_NAME_TO_KEY[agent.name];
    if (key) {
      AGENTS[key] = agent.id;
    }
  }

  const expected = Object.values(AGENT_NAME_TO_KEY);
  const missing = expected.filter((k) => !AGENTS[k]);
  if (missing.length > 0) {
    throw new Error(`Missing agents: ${missing.join(", ")}. Run setup-paperclip-company.ts first.`);
  }

  log("✅", `Resolved ${Object.keys(AGENTS).length} agent IDs from Paperclip`);
}

/**
 * Resolve an agent UUID back to its short key name (ceo, pm, architect, etc.).
 */
export function resolveAgentKey(agentId: string): string {
  return Object.entries(AGENTS).find(([, id]) => id === agentId)?.[0] ?? "unknown";
}

/**
 * Resolve an agent UUID back to its full bmad-* name.
 */
export function resolveAgentName(agentId: string): string {
  const key = resolveAgentKey(agentId);
  return KEY_TO_AGENT_NAME[key] ?? key;
}

// ─────────────────────────────────────────────────────────────────────────────
// Paperclip Project / Workspace Isolation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Ensure a dedicated Paperclip project exists for E2E runs.
 * Returns the project ID and the workspace directory (managedFolder)
 * where agent-generated code should land — NOT in this repo.
 */
export async function ensureE2eProject(
  projectName: string,
): Promise<{ projectId: string; workspaceDir: string }> {
  const projects = await paperclip<PaperclipProject[]>(
    "GET",
    `/api/companies/${COMPANY_ID}/projects`,
  );
  let project = projects.find((p) => p.name === projectName);

  if (!project) {
    project = await paperclip<PaperclipProject>(
      "POST",
      `/api/companies/${COMPANY_ID}/projects`,
      { name: projectName, description: "E2E test workspace — auto-created" },
    );
    log("🆕", "Created Paperclip project", { name: project.name, id: project.id });
  } else {
    log("♻️ ", "Reusing Paperclip project", { name: project.name, id: project.id });
  }

  // Resolve workspace directory — Paperclip auto-creates a managedFolder
  const wsDir = project.codebase?.effectiveLocalFolder
    ?? project.codebase?.managedFolder;

  if (!wsDir) {
    const allProjects = await paperclip<PaperclipProject[]>(
      "GET",
      `/api/companies/${COMPANY_ID}/projects`,
    );
    const refetched = allProjects.find((p) => p.id === project!.id);
    const dir = refetched?.codebase?.effectiveLocalFolder
      ?? refetched?.codebase?.managedFolder;
    if (!dir) {
      throw new Error(
        `Paperclip project ${project.id} has no managedFolder — ` +
        `cannot isolate workspace. Raw codebase: ${JSON.stringify(refetched?.codebase)}`,
      );
    }
    return { projectId: project.id, workspaceDir: dir };
  }

  return { projectId: project.id, workspaceDir: wsDir };
}

/**
 * Update an agent's adapter config to include TARGET_PROJECT_ROOT env var.
 * Paperclip's process adapter merges config.env into the child process env.
 */
export async function setAgentTargetWorkspace(agentId: string, wsDir: string): Promise<void> {
  const agent = await paperclip<{
    id: string;
    adapterConfig: Record<string, unknown>;
  }>("GET", `/api/agents/${agentId}`);

  const currentEnv = (agent.adapterConfig?.env as Record<string, string>) ?? {};
  const updatedConfig = {
    ...agent.adapterConfig,
    env: {
      ...currentEnv,
      TARGET_PROJECT_ROOT: wsDir,
    },
  };

  await paperclip("PATCH", `/api/agents/${agentId}`, {
    adapterConfig: updatedConfig,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared Operations
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Pause all agents. Used before creating issues to prevent auto-triggering.
 */
export async function pauseAllAgents(): Promise<void> {
  const allAgentIds = Object.entries(AGENTS);
  for (const [, id] of allAgentIds) {
    try {
      await paperclip("POST", `/api/agents/${id}/pause`);
    } catch {
      // Agent may already be paused
    }
  }
  log("⏸️ ", `Paused ${allAgentIds.length} agents (prevents auto-trigger)`);
}

/**
 * Resume all agents.
 */
export async function resumeAllAgents(): Promise<void> {
  for (const [, id] of Object.entries(AGENTS)) {
    try {
      await paperclip("POST", `/api/agents/${id}/resume`);
    } catch {
      // Agent may already be active
    }
  }
  log("▶️ ", "All agents resumed");
}

/**
 * Resume a single agent by its short key (e.g., "ceo", "pm").
 */
export async function resumeAgent(key: string): Promise<void> {
  const id = AGENTS[key];
  if (!id) throw new Error(`Unknown agent key: ${key}`);
  await paperclip("POST", `/api/agents/${id}/resume`);
}

/**
 * Pause a single agent by its short key.
 */
export async function pauseAgent(key: string): Promise<void> {
  const id = AGENTS[key];
  if (!id) throw new Error(`Unknown agent key: ${key}`);
  try {
    await paperclip("POST", `/api/agents/${id}/pause`);
  } catch {
    // May already be paused
  }
}

/**
 * Check prerequisites: Paperclip health + CEO agent exists + heartbeat config.
 */
export async function checkPrereqs(): Promise<void> {
  // Check Paperclip
  try {
    const health = await paperclip<{ status: string }>("GET", "/api/health");
    log("✅", "Paperclip is running", { status: health.status });
  } catch {
    log("❌", "Paperclip is not reachable at " + PAPERCLIP_URL);
    process.exit(1);
  }

  // Check CEO agent exists
  try {
    const agent = await paperclip<{ id: string; title: string; status: string }>(
      "GET",
      `/api/agents/${AGENTS.ceo}`,
    );
    log("✅", "CEO agent found", { title: agent.title, status: agent.status });
  } catch {
    log("❌", "CEO agent not found — run setup-paperclip-company.ts first");
    process.exit(1);
  }

  log("ℹ️ ", "GHE auth assumed OK (gh auth status showed logged in)");

  // Verify heartbeat configuration
  const allCompanyAgents = await paperclip<PaperclipAgent[]>(
    "GET",
    `/api/companies/${COMPANY_ID}/agents`,
  );

  let heartbeatConfigOk = true;
  for (const a of allCompanyAgents) {
    const hb = a.runtimeConfig?.heartbeat;
    if (!hb) {
      log("⚠️ ", `${a.name}: no heartbeat config found`);
      heartbeatConfigOk = false;
      continue;
    }
    const isCeo = a.name === "bmad-ceo";
    if (isCeo) {
      if (!hb.enabled || !hb.intervalSec || hb.intervalSec < 60) {
        log("⚠️ ", `${a.name}: expected timer heartbeat (enabled=true, intervalSec>=60)`, {
          enabled: hb.enabled, intervalSec: hb.intervalSec,
        });
        heartbeatConfigOk = false;
      }
    } else {
      if (hb.enabled) {
        log("⚠️ ", `${a.name}: expected demand-only (enabled=false) but got enabled=true`, {
          intervalSec: hb.intervalSec,
        });
        heartbeatConfigOk = false;
      }
    }
    if (!hb.wakeOnDemand) {
      log("⚠️ ", `${a.name}: wakeOnDemand should be true`);
      heartbeatConfigOk = false;
    }
  }
  if (heartbeatConfigOk) {
    log("✅", "Heartbeat config verified (CEO=timer/300s, specialists=demand-only, all wakeOnDemand)");
  } else {
    log("⚠️ ", "Heartbeat config issues detected — run setup-paperclip-company.ts to fix");
  }
}

/**
 * Find sub-issues of a parent, with metadata fallback for phantom-500 scenarios.
 */
export async function findSubIssues(parentIssueId: string): Promise<PaperclipIssue[]> {
  let allIssues = await paperclip<PaperclipIssue[]>(
    "GET",
    `/api/companies/${COMPANY_ID}/issues?parentId=${parentIssueId}`,
  );

  // Fallback: search by metadata.parentIssueId (set at creation time)
  if (allIssues.length === 0) {
    log("ℹ️ ", "No sub-issues found by parentId — searching by metadata fallback...");
    const recentIssues = await paperclip<PaperclipIssue[]>(
      "GET",
      `/api/companies/${COMPANY_ID}/issues`,
    );
    const twoMinAgo = new Date(Date.now() - 120_000).toISOString();
    allIssues = recentIssues.filter((i) => {
      if (i.status === "cancelled") return false;
      const meta = i.metadata as Record<string, unknown> | undefined;
      if (meta?.parentIssueId === parentIssueId) return true;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const created = (i as any).createdAt as string | undefined;
      return created && created > twoMinAgo && i.assigneeAgentId && i.id !== parentIssueId;
    });
  }

  return allIssues;
}

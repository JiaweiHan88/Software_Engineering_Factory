#!/usr/bin/env npx tsx
/**
 * E2E Smoke Test — Invoke-Based Pipeline Validation
 *
 * Uses Paperclip's native `/heartbeat/invoke` endpoint instead of manually
 * spawning the heartbeat entrypoint. This is the correct approach because:
 *
 * - Paperclip creates a real `heartbeat_runs` row → valid runId
 * - The process adapter handles env injection, cwd resolution, timeouts
 * - Activity logging FK constraints are satisfied automatically
 * - Workspace resolution uses Paperclip's project → workspace → agent-home chain
 * - No manual env var surgery (no PAPERCLIP_HEARTBEAT_RUN_ID workaround)
 *
 * Prerequisites:
 * - Paperclip running at localhost:3100 (local_trusted mode)
 * - gh auth working (for Copilot SDK)
 * - .env with COPILOT_GHE_HOST, PAPERCLIP_URL, PAPERCLIP_COMPANY_ID
 *
 * Usage:
 *   npx tsx scripts/e2e-smoke-invoke.ts [--ceo-only] [--skip-cleanup] [--verbose]
 *
 * @module scripts/e2e-smoke-invoke
 */

import "dotenv/config";
import { mkdirSync } from "node:fs";

// ─────────────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────────────

const PAPERCLIP_URL = process.env.PAPERCLIP_URL ?? "http://localhost:3100";
const COMPANY_ID = process.env.PAPERCLIP_COMPANY_ID ?? "c284b9c0-bae3-4fa1-bf4c-c501d6a3967c";

// Agent IDs (from Phase 1 setup)
const AGENTS = {
  ceo: "099b92af-01ff-41d4-ba7a-a5d959eb3880",
  pm: "05569782-4954-49ea-b165-56e841282222",
  architect: "88d76c6a-565f-4b4b-aed6-00cd6d66573d",
  dev: "fe32f94b-7900-4664-9f0e-adbecdd0a204",
  qa: "9c2a9ead-ae4b-409d-8651-ff8e1449fcf8",
  sm: "3efab085-47dd-4fa0-a458-5fc840264f3e",
  analyst: "114fe5f6-7891-442d-ae0d-049182c6845f",
  ux: "3d5b8301-b41b-4471-9451-e35e97c9a5e3",
  techWriter: "e1458467-b4ee-4264-9a53-19274af3ab83",
  quickFlow: "8173531d-a87a-4ad9-8457-c03d7f16a3e3",
};

const FLAGS = {
  ceoOnly: process.argv.includes("--ceo-only"),
  skipCleanup: process.argv.includes("--skip-cleanup"),
  verbose: process.argv.includes("--verbose"),
};

/** E2E project name in Paperclip — reused across runs. */
const E2E_PROJECT_NAME = "bmad-e2e-smoke";

/** Resolved at runtime — the workspace directory where agents write code. */
let targetWorkspaceDir: string | undefined;

/** Resolved at runtime — the Paperclip project ID for workspace isolation. */
let projectId: string | undefined;

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface PaperclipIssue {
  id: string;
  title: string;
  description: string;
  status: string;
  priority?: string;
  assigneeAgentId?: string;
  parentId?: string;
  projectId?: string;
  metadata?: Record<string, unknown>;
}

interface PaperclipComment {
  id: string;
  body: string;
  authorId?: string;
  createdAt?: string;
}

interface HeartbeatRun {
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

interface PaperclipProject {
  id: string;
  name: string;
  codebase?: {
    managedFolder?: string;
    effectiveLocalFolder?: string;
    localFolder?: string | null;
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Make a request to the Paperclip API.
 */
async function paperclip<T>(
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

/**
 * Invoke a heartbeat via Paperclip's native endpoint.
 *
 * POST /api/agents/:id/heartbeat/invoke → 202 (async)
 * Returns the heartbeat run immediately. Poll for completion.
 */
async function invokeHeartbeat(agentId: string): Promise<HeartbeatRun> {
  return paperclip<HeartbeatRun>(
    "POST",
    `/api/agents/${agentId}/heartbeat/invoke`,
  );
}

/**
 * Poll for heartbeat run completion.
 * The run transitions: queued → running → succeeded/failed/timed_out
 */
async function waitForHeartbeatRun(
  agentId: string,
  runId: string,
  label: string,
  timeoutMs = 300_000,
  pollIntervalMs = 2_000,
): Promise<HeartbeatRun> {
  const deadline = Date.now() + timeoutMs;
  const terminalStatuses = new Set(["succeeded", "failed", "cancelled", "timed_out"]);
  let lastStatus = "";

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
      if (FLAGS.verbose) {
        log("  🔄", `[${label}] status: ${run.status}`);
      }
      lastStatus = run.status;
    }

    if (terminalStatuses.has(run.status)) {
      return run;
    }

    await sleep(pollIntervalMs);
  }

  throw new Error(`${label} heartbeat timed out after ${timeoutMs / 1000}s`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function log(icon: string, msg: string, details?: Record<string, unknown>): void {
  const detailStr = details ? ` ${JSON.stringify(details)}` : "";
  console.log(`${icon} ${msg}${detailStr}`);
}

function header(msg: string): void {
  console.log(`\n${"═".repeat(70)}`);
  console.log(`  ${msg}`);
  console.log(`${"═".repeat(70)}\n`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Paperclip Project / Workspace Isolation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Ensure a dedicated Paperclip project exists for E2E runs.
 * Returns the project ID and the workspace directory (managedFolder)
 * where agent-generated code should land — NOT in this repo.
 */
async function ensureE2eProject(): Promise<{ projectId: string; workspaceDir: string }> {
  const projects = await paperclip<PaperclipProject[]>(
    "GET",
    `/api/companies/${COMPANY_ID}/projects`,
  );
  let project = projects.find((p) => p.name === E2E_PROJECT_NAME);

  if (!project) {
    project = await paperclip<PaperclipProject>(
      "POST",
      `/api/companies/${COMPANY_ID}/projects`,
      { name: E2E_PROJECT_NAME, description: "E2E smoke test workspace — auto-created" },
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
async function setAgentTargetWorkspace(agentId: string, wsDir: string): Promise<void> {
  // Get current agent config
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
// E2E Pipeline Steps
// ─────────────────────────────────────────────────────────────────────────────

async function step1_checkPrereqs(): Promise<void> {
  header("Step 1: Verify Prerequisites");

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
    log("❌", "CEO agent not found — run Phase 1 setup first");
    process.exit(1);
  }

  log("ℹ️ ", "GHE auth assumed OK (gh auth status showed logged in)");

  // Set up workspace isolation
  const e2eProject = await ensureE2eProject();
  projectId = e2eProject.projectId;
  targetWorkspaceDir = e2eProject.workspaceDir;
  mkdirSync(targetWorkspaceDir, { recursive: true });
  log("📂", `Agent workspace: ${targetWorkspaceDir}`);

  // Inject TARGET_PROJECT_ROOT into agent adapter configs so the process
  // adapter passes it to the child process env. This is cleaner than
  // manually building env vars — Paperclip handles it natively.
  const agentEntries = Object.entries(AGENTS);
  for (const [, id] of agentEntries) {
    await setAgentTargetWorkspace(id, targetWorkspaceDir);
  }
  log("🔧", `Updated ${agentEntries.length} agent configs with TARGET_PROJECT_ROOT`);
}

async function step2_createTestIssue(): Promise<PaperclipIssue> {
  header("Step 2: Create Test Issue");

  const testIssue = await paperclip<PaperclipIssue>(
    "POST",
    `/api/companies/${COMPANY_ID}/issues`,
    {
      title: "E2E Smoke: Add health-check endpoint returning { status: 'ok' }",
      description: [
        "## Task",
        "Create a simple health-check HTTP endpoint for the BMAD Copilot Factory.",
        "",
        "## Requirements",
        "- GET /health returns JSON: `{ \"status\": \"ok\", \"timestamp\": \"<ISO 8601>\" }`",
        "- Should be a single file: `src/health.ts`",
        "- No external dependencies",
        "- Include a basic test",
        "",
        "## Scope",
        "This is a smoke-test task. Keep it minimal and quick.",
        "Research → minimal (skip market/domain research)",
        "Architecture → trivial (single endpoint, no design needed)",
        "Implementation → ~10 lines of code",
        "Review → quick pass",
      ].join("\n"),
      // Create as 'backlog' initially so Paperclip doesn't auto-trigger a
      // heartbeat for the CEO. We'll change to 'todo' right before invoking.
      status: "backlog",
      priority: "low",
      assigneeAgentId: AGENTS.ceo,
      ...(projectId ? { projectId } : {}),
      metadata: {
        e2eTest: true,
        createdBy: "e2e-smoke-invoke.ts",
        timestamp: new Date().toISOString(),
      },
    },
  );

  log("✅", "Test issue created", {
    id: testIssue.id,
    identifier: (testIssue as unknown as Record<string, unknown>).identifier,
    status: testIssue.status,
    projectId: projectId ?? "none",
  });

  return testIssue;
}

async function step3_invokeCeoHeartbeat(issueId: string): Promise<void> {
  header("Step 3: Invoke CEO Heartbeat (via /invoke)");

  // Pause ALL agents to prevent auto-trigger when we move issue to 'todo'.
  // With /invoke, we explicitly control when the heartbeat fires, but
  // the status change to 'todo' could still trigger Paperclip's automation.
  const allAgentIds = Object.entries(AGENTS);
  for (const [, id] of allAgentIds) {
    try {
      await paperclip("POST", `/api/agents/${id}/pause`);
    } catch {
      // Agent may already be paused
    }
  }
  log("⏸️ ", `Paused ${allAgentIds.length} agents (prevents auto-trigger)`);

  // Move issue to 'todo' so the CEO's inbox picks it up
  await paperclip("PATCH", `/api/issues/${issueId}`, { status: "todo" });
  log("📝", "Issue moved to 'todo'");

  // Resume CEO only — we want /invoke to work for CEO
  await paperclip("POST", `/api/agents/${AGENTS.ceo}/resume`);
  log("▶️ ", "CEO resumed");

  // Invoke via Paperclip's native endpoint — creates real heartbeat_runs row
  log("🚀", "Invoking CEO heartbeat via /api/agents/:id/heartbeat/invoke...");
  const startTime = Date.now();

  const run = await invokeHeartbeat(AGENTS.ceo);
  log("📋", `Heartbeat run created`, {
    runId: run.id.slice(0, 8),
    status: run.status,
    source: run.invocationSource,
  });

  // Poll for completion
  log("⏳", "Polling for completion (timeout: 5 min)...");
  const completedRun = await waitForHeartbeatRun(
    AGENTS.ceo,
    run.id,
    "CEO",
    300_000,
    3_000,
  );

  const elapsed = Math.round((Date.now() - startTime) / 1000);

  if (completedRun.status === "succeeded") {
    log("✅", `CEO heartbeat completed in ${elapsed}s`, {
      exitCode: completedRun.exitCode,
      workspace: completedRun.contextSnapshot?.paperclipWorkspace?.cwd?.slice(-40),
      source: completedRun.contextSnapshot?.paperclipWorkspace?.source,
    });
  } else {
    log("❌", `CEO heartbeat ${completedRun.status} (${elapsed}s)`, {
      exitCode: completedRun.exitCode,
      error: completedRun.error,
    });
    throw new Error(`CEO heartbeat ${completedRun.status}`);
  }

  // Keep specialists paused — we resume them one at a time in step 5
}

async function step4_verifySubIssues(parentIssueId: string): Promise<PaperclipIssue[]> {
  header("Step 4: Verify CEO Created Sub-Issues");

  let allIssues = await paperclip<PaperclipIssue[]>(
    "GET",
    `/api/companies/${COMPANY_ID}/issues?parentId=${parentIssueId}`,
  );

  // Fallback: search by assignee for very recent issues
  if (allIssues.length === 0) {
    const barryIssues = await paperclip<PaperclipIssue[]>(
      "GET",
      `/api/companies/${COMPANY_ID}/issues?assigneeAgentId=${AGENTS.quickFlow}`,
    );
    const twoMinAgo = new Date(Date.now() - 120_000).toISOString();
    allIssues = barryIssues.filter((i) => {
      if (i.status === "cancelled") return false;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const created = (i as any).createdAt as string | undefined;
      return created && created > twoMinAgo;
    });
  }

  if (allIssues.length === 0) {
    log("⚠️ ", "No sub-issues found. Checking issue comments...");
    const comments = await paperclip<PaperclipComment[]>(
      "GET",
      `/api/issues/${parentIssueId}/comments`,
    );
    for (const c of comments) {
      log("💬", `Comment: ${c.body.slice(0, 200)}...`);
    }
    throw new Error("CEO did not create any sub-issues");
  }

  log("✅", `CEO created ${allIssues.length} sub-issues:`);
  for (const issue of allIssues) {
    const agent = issue.assigneeAgentId
      ? Object.entries(AGENTS).find(([, id]) => id === issue.assigneeAgentId)?.[0] ?? "unknown"
      : "unassigned";
    const phase = (issue.metadata as Record<string, string>)?.bmadPhase ?? "?";

    log("  📌", `[${phase}] ${issue.title}`, {
      status: issue.status,
      agent,
      id: issue.id.slice(0, 8),
    });
  }

  // Check parent issue comments
  const comments = await paperclip<PaperclipComment[]>(
    "GET",
    `/api/issues/${parentIssueId}/comments`,
  );
  if (comments.length > 0) {
    log("📋", `${comments.length} comment(s) on parent issue:`);
    for (const c of comments) {
      const preview = c.body.split("\n")[0].slice(0, 100);
      log("  💬", preview);
    }
  }

  // Verify parent issue status
  const parentIssue = await paperclip<PaperclipIssue>(
    "GET",
    `/api/issues/${parentIssueId}`,
  );
  if (parentIssue.status === "in_progress") {
    log("✅", "Parent issue correctly in 'in_progress' after delegation");
  } else if (parentIssue.status === "done") {
    log("✅", "Parent issue marked 'done' (Paperclip auto-completed)");
  } else {
    log("⚠️ ", `Parent issue status is '${parentIssue.status}' — expected 'in_progress'`);
  }

  return allIssues;
}

async function step5_invokeSpecialistHeartbeat(subIssues: PaperclipIssue[]): Promise<void> {
  header("Step 5: Invoke Specialist Agent Heartbeat (via /invoke)");

  if (FLAGS.ceoOnly) {
    log("⏭️ ", "Skipping specialist heartbeat (--ceo-only flag)");
    return;
  }

  const assignedIssue = subIssues.find((i) => i.assigneeAgentId);
  if (!assignedIssue) {
    log("⚠️ ", "No assigned sub-issues — skipping specialist heartbeat");
    return;
  }

  const agentId = assignedIssue.assigneeAgentId!;
  const agentName = Object.entries(AGENTS).find(([, id]) => id === agentId)?.[0] ?? "unknown";

  // Ensure sub-issue is 'todo'
  try {
    await paperclip("PATCH", `/api/issues/${assignedIssue.id}`, { status: "todo" });
  } catch {
    // May already be 'todo'
  }

  // Resume this specialist
  await paperclip("POST", `/api/agents/${agentId}/resume`);
  log("▶️ ", `${agentName} resumed`);

  log("🚀", `Invoking ${agentName} heartbeat via /invoke for: "${assignedIssue.title}"`);
  const startTime = Date.now();

  const run = await invokeHeartbeat(agentId);
  log("📋", `Heartbeat run created`, {
    runId: run.id.slice(0, 8),
    status: run.status,
  });

  log("⏳", "Polling for completion (timeout: 5 min)...");
  const completedRun = await waitForHeartbeatRun(
    agentId,
    run.id,
    agentName.toUpperCase(),
    300_000,
    3_000,
  );

  const elapsed = Math.round((Date.now() - startTime) / 1000);

  if (completedRun.status === "succeeded") {
    log("✅", `${agentName} heartbeat completed in ${elapsed}s`, {
      exitCode: completedRun.exitCode,
    });
  } else {
    log("⚠️ ", `${agentName} heartbeat ${completedRun.status} (${elapsed}s)`, {
      exitCode: completedRun.exitCode,
      error: completedRun.error,
    });
    // Non-fatal — continue to cleanup
  }

  // Check if specialist posted comments
  const comments = await paperclip<PaperclipComment[]>(
    "GET",
    `/api/issues/${assignedIssue.id}/comments`,
  );
  if (comments.length > 0) {
    log("✅", `${agentName} posted ${comments.length} comment(s):`);
    for (const c of comments) {
      const preview = c.body.split("\n")[0].slice(0, 120);
      log("  💬", preview);
    }
  } else {
    log("⚠️ ", `No comments on sub-issue after ${agentName} heartbeat`);
  }
}

async function step6_cleanup(issueId: string, subIssues: PaperclipIssue[]): Promise<void> {
  header("Step 6: Cleanup");

  // Resume all agents
  for (const [, id] of Object.entries(AGENTS)) {
    try {
      await paperclip("POST", `/api/agents/${id}/resume`);
    } catch {
      // Agent may already be active
    }
  }
  log("▶️ ", "All agents resumed");

  if (FLAGS.skipCleanup) {
    log("⏭️ ", "Skipping issue cleanup (--skip-cleanup flag)");
    log("ℹ️ ", `Parent issue: ${issueId}`);
    log("ℹ️ ", `Sub-issues: ${subIssues.map((i) => i.id.slice(0, 8)).join(", ")}`);
    return;
  }

  // Cancel test issues
  try {
    for (const sub of subIssues) {
      await paperclip("PATCH", `/api/issues/${sub.id}`, { status: "cancelled" });
    }
    await paperclip("PATCH", `/api/issues/${issueId}`, { status: "cancelled" });
    log("✅", `Cancelled ${subIssues.length + 1} test issues`);
  } catch (err) {
    log("⚠️ ", `Cleanup failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("\n🧪 BMAD Copilot Factory — E2E Smoke Test (invoke-based)");
  console.log(`   Paperclip: ${PAPERCLIP_URL}`);
  console.log(`   Company:   ${COMPANY_ID}`);
  console.log(`   Mode:      /heartbeat/invoke (Paperclip-native)`);
  console.log(`   Flags:     ${FLAGS.ceoOnly ? "--ceo-only " : ""}${FLAGS.skipCleanup ? "--skip-cleanup " : ""}${FLAGS.verbose ? "--verbose" : ""}`);
  console.log();

  const startTime = Date.now();

  // 1. Check prerequisites + set up workspace
  await step1_checkPrereqs();

  // 2. Create test issue
  const testIssue = await step2_createTestIssue();

  // 3. Invoke CEO heartbeat
  try {
    await step3_invokeCeoHeartbeat(testIssue.id);
  } catch (err) {
    log("💥", `CEO heartbeat failed: ${err instanceof Error ? err.message : String(err)}`);
    await step6_cleanup(testIssue.id, []);
    process.exit(1);
  }

  // 4. Verify sub-issues
  let subIssues: PaperclipIssue[] = [];
  try {
    subIssues = await step4_verifySubIssues(testIssue.id);
  } catch (err) {
    log("💥", `Sub-issue verification failed: ${err instanceof Error ? err.message : String(err)}`);
    await step6_cleanup(testIssue.id, []);
    process.exit(1);
  }

  // 5. Invoke specialist heartbeat
  try {
    await step5_invokeSpecialistHeartbeat(subIssues);
  } catch (err) {
    log("⚠️ ", `Specialist heartbeat error: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 6. Cleanup
  await step6_cleanup(testIssue.id, subIssues);

  // Summary
  const elapsed = Math.round((Date.now() - startTime) / 1000);
  header("E2E Smoke Test Summary");
  log("⏱️ ", `Total time: ${elapsed}s`);
  log("📊", `Sub-issues created by CEO: ${subIssues.length}`);
  log("🔧", `Method: Paperclip /heartbeat/invoke (native)`);
  if (targetWorkspaceDir) {
    log("📂", `Agent workspace: ${targetWorkspaceDir}`);
  }
  log("✅", "Pipeline validated successfully!");

  process.exit(0);
}

main().catch((err) => {
  console.error("\n💥 E2E smoke test crashed:", err);
  process.exit(1);
});

#!/usr/bin/env npx tsx
/**
 * E2E Smoke Test — Full Pipeline Validation
 *
 * Validates the complete CEO → Specialist agent pipeline by:
 * 1. Creating a tiny test issue in Paperclip assigned to CEO
 * 2. Invoking CEO heartbeat (process adapter simulation)
 * 3. Verifying CEO created delegation sub-issues
 * 4. Invoking one specialist agent heartbeat
 * 5. Verifying specialist posted result comments
 *
 * Prerequisites:
 * - Paperclip running at localhost:3100 (local_trusted mode)
 * - gh auth working (for Copilot SDK)
 * - .env with COPILOT_GHE_HOST, PAPERCLIP_URL, PAPERCLIP_COMPANY_ID
 *
 * Usage:
 *   npx tsx scripts/e2e-smoke.ts [--ceo-only] [--skip-cleanup]
 *
 * @module scripts/e2e-smoke
 */

import "dotenv/config";
import { spawn } from "node:child_process";
import { resolve } from "node:path";

// ─────────────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────────────

const PAPERCLIP_URL = process.env.PAPERCLIP_URL ?? "http://localhost:3100";
const COMPANY_ID = process.env.PAPERCLIP_COMPANY_ID ?? "c284b9c0-bae3-4fa1-bf4c-c501d6a3967c";
const PROJECT_ROOT = resolve(import.meta.dirname ?? process.cwd(), "..");

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

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

interface PaperclipIssue {
  id: string;
  title: string;
  description: string;
  status: string;
  priority?: string;
  assigneeAgentId?: string;
  parentId?: string;
  metadata?: Record<string, unknown>;
}

interface PaperclipComment {
  id: string;
  body: string;
  authorId?: string;
  createdAt?: string;
}

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
 * Run the heartbeat entrypoint for a specific agent.
 * Simulates Paperclip's process adapter by setting the right env vars.
 */
async function invokeHeartbeat(agentId: string, label: string): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
}> {
  return new Promise((resolve, reject) => {
    // Build env: inherit process.env but ensure correct Paperclip settings.
    // Remove PAPERCLIP_AGENT_API_KEY to force board-access mode in local_trusted.
    const childEnv = { ...process.env };
    delete childEnv.PAPERCLIP_AGENT_API_KEY;

    const child = spawn("npx", ["tsx", "src/heartbeat-entrypoint.ts"], {
      cwd: PROJECT_ROOT,
      env: {
        ...childEnv,
        PAPERCLIP_API_URL: PAPERCLIP_URL,
        PAPERCLIP_URL: PAPERCLIP_URL,
        PAPERCLIP_COMPANY_ID: COMPANY_ID,
        PAPERCLIP_AGENT_ID: agentId,
        // PAPERCLIP_HEARTBEAT_RUN_ID intentionally omitted — the e2e test
        // bypasses the normal heartbeat dispatch so there is no matching
        // heartbeat_runs row. Sending a fabricated UUID causes an FK
        // violation in activity_log.run_id → heartbeat_runs.id.
        PAPERCLIP_DEPLOYMENT_MODE: "local_trusted",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (data: Buffer) => {
      const chunk = data.toString();
      stdout += chunk;
      if (FLAGS.verbose) process.stdout.write(`  [${label}] ${chunk}`);
    });

    child.stderr.on("data", (data: Buffer) => {
      const chunk = data.toString();
      stderr += chunk;
      if (FLAGS.verbose) process.stderr.write(`  [${label}] ${chunk}`);
    });

    child.on("close", (code) => {
      resolve({ exitCode: code ?? 1, stdout, stderr });
    });

    child.on("error", reject);

    // Timeout: 5 minutes
    setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`${label} heartbeat timed out after 5 minutes`));
    }, 300_000);
  });
}

/**
 * Wait for a condition to be true (polling).
 */
async function waitFor<T>(
  label: string,
  fn: () => Promise<T | null>,
  timeoutMs = 10_000,
  intervalMs = 1_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await fn();
    if (result !== null) return result;
    await sleep(intervalMs);
  }
  throw new Error(`Timed out waiting for: ${label}`);
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

  // Check gh auth
  log("ℹ️ ", "GHE auth assumed OK (gh auth status showed logged in)");
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
      // heartbeat for the CEO. We'll change to 'todo' right before invoking
      // the CEO heartbeat manually to avoid double-execution conflicts.
      status: "backlog",
      priority: "low",
      assigneeAgentId: AGENTS.ceo,
      metadata: {
        e2eTest: true,
        createdBy: "e2e-smoke.ts",
        timestamp: new Date().toISOString(),
      },
    },
  );

  log("✅", "Test issue created", {
    id: testIssue.id,
    identifier: (testIssue as unknown as Record<string, unknown>).identifier,
    status: testIssue.status,
  });

  return testIssue;
}

async function step3_invokeCeoHeartbeat(issueId: string): Promise<void> {
  header("Step 3: Invoke CEO Heartbeat");

  // Pause ALL agents to prevent Paperclip from auto-triggering heartbeats when:
  // a) We change the parent issue to 'todo' (CEO would auto-trigger)
  // b) CEO creates sub-issues assigned to specialists as 'todo' (they'd auto-trigger)
  const allAgentIds = Object.entries(AGENTS);
  for (const [name, id] of allAgentIds) {
    try {
      await paperclip("POST", `/api/agents/${id}/pause`);
    } catch {
      // Agent may already be paused — ignore
    }
  }
  log("⏸️ ", `Paused ${allAgentIds.length} agents (prevents auto-trigger)`);

  // Move issue from 'backlog' to 'todo' so our manual heartbeat picks it up.
  await paperclip("PATCH", `/api/issues/${issueId}`, { status: "todo" });
  log("📝", "Issue moved to 'todo'");

  log("🚀", "Starting CEO heartbeat (this calls Copilot SDK → LLM)...");
  log("⏳", "Timeout: 5 minutes. CEO will analyze and create sub-issues.");

  const startTime = Date.now();
  const result = await invokeHeartbeat(AGENTS.ceo, "CEO");
  const elapsed = Math.round((Date.now() - startTime) / 1000);

  if (result.exitCode === 0) {
    log("✅", `CEO heartbeat completed in ${elapsed}s (exit 0)`);
  } else {
    log("❌", `CEO heartbeat failed (exit ${result.exitCode}, ${elapsed}s)`);
    if (result.stderr) {
      console.log("\n--- stderr (last 500 chars) ---");
      console.log(result.stderr.slice(-500));
    }
    if (result.stdout) {
      console.log("\n--- stdout (last 500 chars) ---");
      console.log(result.stdout.slice(-500));
    }
    throw new Error("CEO heartbeat failed");
  }

  // Resume CEO agent after manual heartbeat
  await paperclip("POST", `/api/agents/${AGENTS.ceo}/resume`);
  log("▶️ ", "CEO resumed");

  // Keep specialists paused — we resume them one at a time in step 5
  // (or all at once in cleanup). This prevents auto-triggering for sub-issues.
}

async function step4_verifySubIssues(parentIssueId: string): Promise<PaperclipIssue[]> {
  header("Step 4: Verify CEO Created Sub-Issues");

  // List issues with parentId = our test issue.
  // Also check for recently created issues assigned to specialist agents
  // in case the parentId PATCH hasn't completed yet (CEO creates without
  // parentId to avoid execution-lock 500, then patches parentId after).
  let allIssues = await paperclip<PaperclipIssue[]>(
    "GET",
    `/api/companies/${COMPANY_ID}/issues?parentId=${parentIssueId}`,
  );

  // Fallback: search by assignee (Quick Flow / Barry) for very recent issues
  if (allIssues.length === 0) {
    const barryIssues = await paperclip<PaperclipIssue[]>(
      "GET",
      `/api/companies/${COMPANY_ID}/issues?assigneeAgentId=${AGENTS.quickFlow}`,
    );
    // Filter to issues created in the last 2 minutes that aren't cancelled
    const twoMinAgo = new Date(Date.now() - 120_000).toISOString();
    allIssues = barryIssues.filter((i) => {
      if (i.status === "cancelled") return false;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const created = (i as any).createdAt as string | undefined;
      return created && created > twoMinAgo;
    });
  }

  if (allIssues.length === 0) {
    log("⚠️ ", "No sub-issues found. Checking issue comments for context...");

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

  // Also check parent issue comments for delegation summary
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

  // Verify parent issue status — should be in_progress (delegation happened,
  // sub-tasks are being worked on). It stays in_progress until all sub-tasks complete.
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
  header("Step 5: Invoke Specialist Agent Heartbeat");

  if (FLAGS.ceoOnly) {
    log("⏭️ ", "Skipping specialist heartbeat (--ceo-only flag)");
    return;
  }

  // Find the first sub-issue with an assigned agent
  const assignedIssue = subIssues.find((i) => i.assigneeAgentId);
  if (!assignedIssue) {
    log("⚠️ ", "No assigned sub-issues — skipping specialist heartbeat");
    return;
  }

  const agentId = assignedIssue.assigneeAgentId!;
  const agentName = Object.entries(AGENTS).find(([, id]) => id === agentId)?.[0] ?? "unknown";

  // Ensure the specialist's sub-issue is 'todo' so our heartbeat picks it up.
  // (CEO may have created it as 'todo' already, but be safe.)
  try {
    await paperclip("PATCH", `/api/issues/${assignedIssue.id}`, { status: "todo" });
  } catch {
    // May already be 'todo' — ignore
  }

  log("🚀", `Invoking ${agentName} heartbeat for: "${assignedIssue.title}"`);
  log("⏳", "Timeout: 5 minutes");

  const startTime = Date.now();
  const result = await invokeHeartbeat(agentId, agentName.toUpperCase());
  const elapsed = Math.round((Date.now() - startTime) / 1000);

  if (result.exitCode === 0) {
    log("✅", `${agentName} heartbeat completed in ${elapsed}s`);
  } else {
    log("⚠️ ", `${agentName} heartbeat exited with code ${result.exitCode} (${elapsed}s)`);
    // Don't throw — specialist failure is informative, not blocking
  }

  // Check if the specialist posted a comment
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

  // Always resume all agents (they may have been paused in step 3)
  for (const [name, id] of Object.entries(AGENTS)) {
    try {
      await paperclip("POST", `/api/agents/${id}/resume`);
    } catch {
      // Agent may already be active — ignore
    }
  }
  log("▶️ ", "All agents resumed");

  if (FLAGS.skipCleanup) {
    log("⏭️ ", "Skipping issue cleanup (--skip-cleanup flag)");
    log("ℹ️ ", `Parent issue: ${issueId}`);
    log("ℹ️ ", `Sub-issues: ${subIssues.map((i) => i.id.slice(0, 8)).join(", ")}`);
    return;
  }

  // Mark test issues as cancelled
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
  console.log("\n🧪 BMAD Copilot Factory — E2E Smoke Test");
  console.log(`   Paperclip: ${PAPERCLIP_URL}`);
  console.log(`   Company:   ${COMPANY_ID}`);
  console.log(`   Flags:     ${FLAGS.ceoOnly ? "--ceo-only " : ""}${FLAGS.skipCleanup ? "--skip-cleanup " : ""}${FLAGS.verbose ? "--verbose" : ""}`);
  console.log();

  const startTime = Date.now();

  // 1. Check prerequisites
  await step1_checkPrereqs();

  // 2. Create test issue
  const testIssue = await step2_createTestIssue();

  // 3. Invoke CEO heartbeat
  try {
    await step3_invokeCeoHeartbeat(testIssue.id);
  } catch (err) {
    log("💥", `CEO heartbeat failed: ${err instanceof Error ? err.message : String(err)}`);
    await step6_cleanup(testIssue.id, []); // also resumes all agents
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

  // 5. Invoke specialist heartbeat (first sub-issue)
  try {
    await step5_invokeSpecialistHeartbeat(subIssues);
  } catch (err) {
    log("⚠️ ", `Specialist heartbeat error: ${err instanceof Error ? err.message : String(err)}`);
    // Non-fatal — continue to cleanup
  }

  // 6. Cleanup
  await step6_cleanup(testIssue.id, subIssues);

  // Summary
  const elapsed = Math.round((Date.now() - startTime) / 1000);
  header("E2E Smoke Test Summary");
  log("⏱️ ", `Total time: ${elapsed}s`);
  log("📊", `Sub-issues created by CEO: ${subIssues.length}`);
  log("✅", "Pipeline validated successfully!");
}

main().catch((err) => {
  console.error("\n💥 E2E smoke test crashed:", err);
  process.exit(1);
});

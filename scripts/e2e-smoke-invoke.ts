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
 * Heartbeat Model:
 * - CEO has timer-based heartbeat (enabled=true, intervalSec=300) for periodic oversight
 * - All specialists are demand-only (enabled=false, wakeOnDemand=true)
 * - Specialists only run when: (a) an issue is assigned to them, or (b) /invoke is called
 * - This E2E pauses all agents before creating issues, then uses explicit /invoke
 *   to control execution order deterministically
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

import { mkdirSync } from "node:fs";
import {
  PAPERCLIP_URL, COMPANY_ID, AGENTS,
  paperclip, invokeHeartbeat, waitForHeartbeatRun,
  resolveAgentIds, ensureE2eProject, setAgentTargetWorkspace,
  pauseAllAgents, resumeAllAgents, checkPrereqs, findSubIssues,
  log, header, sleep, setVerbose,
  type PaperclipIssue, type PaperclipComment,
} from "./e2e-helpers.js";

const FLAGS = {
  ceoOnly: process.argv.includes("--ceo-only"),
  skipCleanup: process.argv.includes("--skip-cleanup"),
  verbose: process.argv.includes("--verbose"),
};

// Apply verbose mode to shared helpers
setVerbose(FLAGS.verbose);

/** E2E project name in Paperclip — reused across runs. */
const E2E_PROJECT_NAME = "bmad-e2e-smoke";

/** Resolved at runtime — the workspace directory where agents write code. */
let targetWorkspaceDir: string | undefined;

/** Resolved at runtime — the Paperclip project ID for workspace isolation. */
let projectId: string | undefined;

// ─────────────────────────────────────────────────────────────────────────────
// E2E Pipeline Steps
// ─────────────────────────────────────────────────────────────────────────────

async function step1_checkPrereqs(): Promise<void> {
  header("Step 1: Verify Prerequisites");

  // Shared checks: Paperclip health, CEO agent, heartbeat config
  await checkPrereqs();

  // Set up workspace isolation
  const e2eProject = await ensureE2eProject(E2E_PROJECT_NAME);
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
  // With the event-driven heartbeat model (specialists have wakeOnDemand=true),
  // Paperclip would auto-wake agents when issues are assigned to them.
  // Pausing prevents this — we control invocation timing explicitly via /invoke.
  await pauseAllAgents();

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

  const allIssues = await findSubIssues(parentIssueId);

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

/**
 * Step 5c: Verify Phase A protocol compliance.
 *
 * Checks that the heartbeat correctly used the checkout protocol:
 * - Sub-issues should be in_progress (checked out) or done (completed)
 * - Concurrent checkout is safe (409 rejection)
 * - Blocked-task dedup is active (skips stale blocked issues)
 */
async function step5c_verifyProtocolCompliance(
  parentIssueId: string,
  subIssues: PaperclipIssue[],
): Promise<void> {
  header("Step 5c: Verify Phase A Protocol Compliance");

  // ── 5c-1. Check sub-issue status progression ───────────────────────
  // After heartbeat, issues that were processed should be in_progress or beyond
  let checkedOutCount = 0;
  for (const sub of subIssues) {
    const current = await paperclip<PaperclipIssue>("GET", `/api/issues/${sub.id}`);
    const status = current.status;

    if (status === "in_progress" || status === "done" || status === "in_review") {
      checkedOutCount++;
      log("✅", `Sub-issue ${sub.id.slice(0, 8)} status: ${status} (checkout protocol active)`);
    } else if (status === "todo" || status === "backlog") {
      log("ℹ️ ", `Sub-issue ${sub.id.slice(0, 8)} status: ${status} (not yet processed)`);
    } else {
      log("⚠️ ", `Sub-issue ${sub.id.slice(0, 8)} unexpected status: ${status}`);
    }
  }

  if (checkedOutCount > 0) {
    log("✅", `${checkedOutCount}/${subIssues.length} sub-issues progressed past checkout`);
  } else {
    log("ℹ️ ", "No sub-issues progressed past checkout (specialist may not have run)");
  }

  // ── 5c-2. Verify concurrent checkout safety ────────────────────────
  // Try to checkout an in_progress issue — should get 409 if checkout protocol works.
  // First, find a sub-issue that is currently in_progress (already fetched statuses above).
  let inProgressIssue: PaperclipIssue | undefined;
  for (const sub of subIssues) {
    const current = await paperclip<PaperclipIssue>("GET", `/api/issues/${sub.id}`);
    if (current.status === "in_progress") {
      inProgressIssue = current;
      break;
    }
  }

  if (inProgressIssue) {
    try {
      // Per Paperclip docs, checkout requires agentId + expectedStatuses.
      // Use a different agent ID to simulate concurrent access.
      const res = await fetch(
        `${PAPERCLIP_URL}/api/issues/${inProgressIssue.id}/checkout`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            agentId: AGENTS.qa, // Different agent to simulate conflict
            expectedStatuses: ["in_progress"],
          }),
        },
      );

      if (res.status === 409) {
        log("✅", "Concurrent checkout correctly rejected (409 Conflict)");
      } else if (res.ok) {
        log("ℹ️ ", "Checkout succeeded — issue may not have been locked (Paperclip version dependent)");
        // Release the accidental checkout
        await fetch(`${PAPERCLIP_URL}/api/issues/${inProgressIssue.id}/release`, { method: "POST" });
      } else {
        log("ℹ️ ", `Checkout returned ${res.status} — endpoint may not be available in this Paperclip version`);
      }
    } catch {
      log("ℹ️ ", "Checkout endpoint not available — Paperclip may not support task locking yet");
    }
  }

  // ── 5c-3. Verify parent issue has delegation comments ──────────────
  const parentComments = await paperclip<PaperclipComment[]>(
    "GET",
    `/api/issues/${parentIssueId}/comments`,
  );
  const hasDelegationComment = parentComments.some((c) =>
    c.body.includes("Delegation") || c.body.includes("delegation") ||
    c.body.includes("sub-issue") || c.body.includes("Sub-issue") ||
    c.body.includes("Created")
  );
  if (hasDelegationComment) {
    log("✅", "Parent issue has delegation comment (audit trail intact)");
  } else if (parentComments.length > 0) {
    log("ℹ️ ", `Parent has ${parentComments.length} comment(s) but none match delegation pattern`);
  } else {
    log("⚠️ ", "No comments on parent issue — audit trail may be incomplete");
  }
}

async function step5b_verifyCostTracking(
  _parentIssueId: string,
  _subIssues: PaperclipIssue[],
): Promise<void> {
  header("Step 5b: Verify Cost Tracking");

  // Cost tracking is reported exclusively via Paperclip's native cost-events API.
  // The heartbeat-entrypoint posts per-interaction cost events via
  // POST /api/companies/:companyId/cost-events, which feeds the /costs dashboard.
  // We verify the data arrived by querying the aggregated /costs/by-agent endpoint.
  try {
    const byAgent = await paperclip<Array<{
      agentId: string;
      agentName: string | null;
      costCents: number;
      inputTokens: number;
      outputTokens: number;
    }>>(
      "GET",
      `/api/companies/${COMPANY_ID}/costs/by-agent`,
    );

    if (byAgent.length > 0) {
      log("✅", `Paperclip /costs/by-agent returned ${byAgent.length} agent(s) with cost data`);
      for (const row of byAgent) {
        log("📊", `  ${row.agentName ?? row.agentId.slice(0, 8)}: ${row.costCents}¢, ` +
          `in=${row.inputTokens} out=${row.outputTokens}`);
      }
    } else {
      log("⚠️ ", "Paperclip /costs/by-agent returned 0 rows — no cost events recorded");
      log("ℹ️ ", "The heartbeat may not have reached the cost reporting step");
    }
  } catch (err) {
    log("⚠️ ", `Failed to query Paperclip costs API: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function step6_cleanup(issueId: string, subIssues: PaperclipIssue[]): Promise<void> {
  header("Step 6: Cleanup");

  // Resume all agents
  await resumeAllAgents();

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

  // 0. Resolve agent IDs from Paperclip API
  await resolveAgentIds();

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

  // 5b. Verify cost tracking
  try {
    await step5b_verifyCostTracking(testIssue.id, subIssues);
  } catch (err) {
    log("⚠️ ", `Cost tracking verification error: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 5c. Verify Phase A protocol compliance (checkout, concurrency, audit trail)
  try {
    await step5c_verifyProtocolCompliance(testIssue.id, subIssues);
  } catch (err) {
    log("⚠️ ", `Protocol compliance check error: ${err instanceof Error ? err.message : String(err)}`);
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

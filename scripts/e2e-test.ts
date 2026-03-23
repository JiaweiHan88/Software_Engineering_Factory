#!/usr/bin/env npx tsx
/**
 * E2E Test — Unified BMAD Copilot Factory Pipeline Validation
 *
 * Three modes:
 *   --smoke       Quick validation: CEO heartbeat → 1 specialist → protocol checks → costs
 *   --full        Full spec pipeline: CEO delegation → multi-phase (research→define→plan) with invariants
 *   --autonomous  Self-driving pipeline: resume all agents, create seed issue, let wakeOnDemand drive
 *
 * All modes use Paperclip's native `/heartbeat/invoke` endpoint.
 *
 * Prerequisites:
 * - Paperclip running at localhost:3100 (local_trusted mode)
 * - gh auth working (for Copilot SDK)
 * - .env with COPILOT_GHE_HOST, PAPERCLIP_URL, PAPERCLIP_COMPANY_ID
 *
 * Usage:
 *   npx tsx scripts/e2e-test.ts --smoke                          # Quick smoke test
 *   npx tsx scripts/e2e-test.ts --smoke --ceo-only               # CEO only (no specialist)
 *   npx tsx scripts/e2e-test.ts --full                            # Full spec pipeline (default)
 *   npx tsx scripts/e2e-test.ts --full --stop-after=research      # Stop after research phase
 *   npx tsx scripts/e2e-test.ts --autonomous --timeout=30         # Autonomous self-driving pipeline
 *   npx tsx scripts/e2e-test.ts --skip-cleanup --verbose          # Keep test data, verbose output
 *
 * @module scripts/e2e-test
 */

import { mkdirSync } from "node:fs";
import {
  PAPERCLIP_URL, COMPANY_ID, AGENTS,
  paperclip, invokeHeartbeat, waitForHeartbeatRun,
  resolveAgentIds, ensureE2eProject, setAgentTargetWorkspace,
  pauseAllAgents, resumeAllAgents, resumeAgent, pauseAgent,
  checkPrereqs, findSubIssues, resolveAgentKey, resolveAgentName,
  log, header, setVerbose,
  type PaperclipIssue, type PaperclipComment,
} from "./e2e-helpers.js";

// ═════════════════════════════════════════════════════════════════════════════
// CLI Flags
// ═════════════════════════════════════════════════════════════════════════════

const FLAGS = {
  smoke: process.argv.includes("--smoke"),
  full: process.argv.includes("--full"),
  autonomous: process.argv.includes("--autonomous"),
  ceoOnly: process.argv.includes("--ceo-only"),
  skipCleanup: process.argv.includes("--skip-cleanup"),
  verbose: process.argv.includes("--verbose"),
  stopAfter: (() => {
    const arg = process.argv.find((a) => a.startsWith("--stop-after="));
    return arg ? arg.split("=")[1] as BmadPhase : null;
  })(),
  timeout: (() => {
    const arg = process.argv.find((a) => a.startsWith("--timeout="));
    return arg ? parseInt(arg.split("=")[1], 10) * 60_000 : 30 * 60_000;
  })(),
};

// Default to --full if no mode flag given
if (!FLAGS.smoke && !FLAGS.full && !FLAGS.autonomous) {
  FLAGS.full = true;
}

// ═════════════════════════════════════════════════════════════════════════════
// Types
// ═════════════════════════════════════════════════════════════════════════════

/** BMAD pipeline phases in execution order. */
type BmadPhase = "research" | "define" | "plan" | "execute" | "review";

/** Ordered list of phases for sequential execution. */
const PHASE_ORDER: BmadPhase[] = ["research", "define", "plan", "execute", "review"];

/** Phases we expect the spec pipeline to cover (stop before execute). */
const SPEC_PHASES: BmadPhase[] = ["research", "define", "plan"];

/** Structured trace of a single specialist invocation. */
interface PhaseTrace {
  issueId: string;
  title: string;
  phase: BmadPhase;
  agentKey: string;
  agentName: string;
  heartbeatStatus: string;
  issueStatus: string;
  durationSec: number;
  commentCount: number;
  totalCommentChars: number;
  commentPreviews: string[];
  error?: string;
}

/** Result of an invariant assertion. */
interface InvariantResult {
  id: string;
  label: string;
  passed: boolean;
  detail: string;
  soft?: boolean;
}

// ═════════════════════════════════════════════════════════════════════════════
// Seed Issues
// ═════════════════════════════════════════════════════════════════════════════

/** Simple smoke-test task. */
const SMOKE_ISSUE = {
  title: "E2E Smoke: Add health-check endpoint returning { status: 'ok' }",
  description: [
    "## Task",
    "Create a simple health-check HTTP endpoint for the BMAD Copilot Factory.",
    "",
    "## Requirements",
    '- GET /health returns JSON: `{ "status": "ok", "timestamp": "<ISO 8601>" }`',
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
  priority: "low" as const,
};

/** Complex spec-pipeline task that forces multi-phase delegation. */
const SPEC_ISSUE = {
  title: "Build a real-time vehicle telemetry dashboard for fleet managers",
  description: [
    "## Context",
    "A fleet management company wants a dashboard that provides real-time visibility",
    "into their vehicle fleet. This is a greenfield project with no existing infrastructure.",
    "",
    "## High-Level Requirements",
    "- Show live GPS positions, speed, fuel level, and engine diagnostics for each vehicle",
    "- Support 10,000+ simultaneous vehicles with < 2 second end-to-end latency",
    "- Role-based access control: fleet manager, driver, mechanic (different views)",
    "- Integration with existing OBD-II diagnostic dongles (various manufacturers)",
    "- Must work on mobile browsers (responsive) and desktop",
    "- Dashboard should support historical playback and route visualization",
    "",
    "## What Is NOT Decided Yet",
    "- Tech stack (frontend framework, backend language, database)",
    "- Communication protocol (WebSocket, SSE, MQTT, gRPC)",
    "- Data architecture (time-series DB, event streaming, etc.)",
    "- Deployment model (cloud provider, on-prem, hybrid)",
    "- Budget and timeline are unknown",
    "",
    "## Scope",
    "**This issue covers SPECIFICATION ONLY — do not implement anything.**",
    "Deliver the following artifacts:",
    "1. Research findings (market analysis + technical feasibility)",
    "2. Product Requirements Document (PRD)",
    "3. Architecture document (system design, data flow, technology choices)",
    "4. Epic breakdown with prioritized stories",
    "",
    "Do NOT create implementation tasks, write code, or assign development work.",
  ].join("\n"),
  priority: "medium" as const,
};

// ═════════════════════════════════════════════════════════════════════════════
// Shared Setup & Teardown
// ═════════════════════════════════════════════════════════════════════════════

let targetWorkspaceDir: string | undefined;
let projectId: string | undefined;

async function setup(projectName: string): Promise<void> {
  header("Setup: Prerequisites + Workspace");

  await checkPrereqs();

  const e2eProject = await ensureE2eProject(projectName);
  projectId = e2eProject.projectId;
  targetWorkspaceDir = e2eProject.workspaceDir;
  mkdirSync(targetWorkspaceDir, { recursive: true });
  log("📂", `Agent workspace: ${targetWorkspaceDir}`);

  const agentEntries = Object.entries(AGENTS);
  for (const [, id] of agentEntries) {
    await setAgentTargetWorkspace(id, targetWorkspaceDir);
  }
  log("🔧", `Updated ${agentEntries.length} agent configs with TARGET_PROJECT_ROOT`);
}

async function createIssue(
  seed: { title: string; description: string; priority: string },
  testType: string,
): Promise<PaperclipIssue> {
  header("Create Test Issue");

  const issue = await paperclip<PaperclipIssue>(
    "POST",
    `/api/companies/${COMPANY_ID}/issues`,
    {
      title: seed.title,
      description: seed.description,
      status: "backlog",
      priority: seed.priority,
      assigneeAgentId: AGENTS.ceo,
      ...(projectId ? { projectId } : {}),
      metadata: {
        e2eTest: true,
        testType,
        createdBy: "e2e-test.ts",
        timestamp: new Date().toISOString(),
      },
    },
  );

  log("✅", "Issue created", {
    id: issue.id,
    identifier: (issue as unknown as Record<string, unknown>).identifier,
    title: issue.title.slice(0, 60),
  });

  return issue;
}

async function invokeCeo(issueId: string): Promise<void> {
  header("Invoke CEO Heartbeat");

  await pauseAllAgents();
  await paperclip("PATCH", `/api/issues/${issueId}`, { status: "todo" });
  log("📝", "Issue moved to 'todo'");

  await resumeAgent("ceo");
  log("▶️ ", "CEO resumed");

  log("🚀", "Invoking CEO heartbeat via /api/agents/:id/heartbeat/invoke...");
  const startTime = Date.now();

  const run = await invokeHeartbeat(AGENTS.ceo);
  log("📋", `Heartbeat run created`, {
    runId: run.id.slice(0, 8),
    status: run.status,
    source: run.invocationSource,
  });

  log("⏳", "Polling for completion (timeout: 5 min)...");
  const completedRun = await waitForHeartbeatRun(AGENTS.ceo, run.id, "CEO", 300_000, 3_000);
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
}

async function verifyCosts(): Promise<InvariantResult> {
  header("Verify Cost Tracking");

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
      log("✅", `Paperclip /costs/by-agent returned ${byAgent.length} agent(s)`);
      for (const row of byAgent) {
        log("📊", `  ${row.agentName ?? row.agentId.slice(0, 8)}: ${row.costCents}¢, ` +
          `in=${row.inputTokens} out=${row.outputTokens}`);
      }
      return { id: "COST", label: "Cost data recorded", passed: true, detail: `${byAgent.length} agent(s)` };
    } else {
      log("⚠️ ", "Paperclip /costs/by-agent returned 0 rows");
      return { id: "COST", label: "Cost data recorded", passed: false, detail: "0 rows" };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log("⚠️ ", `Cost API error: ${msg}`);
    return { id: "COST", label: "Cost data recorded", passed: false, detail: `API error: ${msg}` };
  }
}

async function cleanup(issueId: string, subIssues: PaperclipIssue[]): Promise<void> {
  header("Cleanup");

  await resumeAllAgents();

  if (FLAGS.skipCleanup) {
    log("⏭️ ", "Skipping issue cleanup (--skip-cleanup flag)");
    log("ℹ️ ", `Parent issue: ${issueId}`);
    log("ℹ️ ", `Sub-issues: ${subIssues.map((i) => i.id.slice(0, 8)).join(", ")}`);
    return;
  }

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

// ═════════════════════════════════════════════════════════════════════════════
// SMOKE MODE — Quick pipeline validation
// ═════════════════════════════════════════════════════════════════════════════

async function runSmoke(): Promise<boolean> {
  const startTime = Date.now();

  await setup("bmad-e2e-smoke");
  const testIssue = await createIssue(SMOKE_ISSUE, "smoke");

  // Invoke CEO
  try {
    await invokeCeo(testIssue.id);
  } catch (err) {
    log("💥", `CEO heartbeat failed: ${err instanceof Error ? err.message : String(err)}`);
    await cleanup(testIssue.id, []);
    return false;
  }

  // Verify sub-issues
  let subIssues: PaperclipIssue[] = [];
  try {
    subIssues = await verifySubIssues(testIssue.id);
  } catch (err) {
    log("💥", `Sub-issue verification failed: ${err instanceof Error ? err.message : String(err)}`);
    await cleanup(testIssue.id, []);
    return false;
  }

  // Invoke one specialist (unless --ceo-only)
  if (!FLAGS.ceoOnly) {
    try {
      await invokeOneSpecialist(subIssues);
    } catch (err) {
      log("⚠️ ", `Specialist heartbeat error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Verify cost tracking
  try {
    await verifyCosts();
  } catch (err) {
    log("⚠️ ", `Cost tracking error: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Verify protocol compliance
  try {
    await verifyProtocolCompliance(testIssue.id, subIssues);
  } catch (err) {
    log("⚠️ ", `Protocol compliance error: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Cleanup
  await cleanup(testIssue.id, subIssues);

  // Summary
  const elapsed = Math.round((Date.now() - startTime) / 1000);
  header("Smoke Test Summary");
  log("⏱️ ", `Total time: ${elapsed}s`);
  log("📊", `Sub-issues created by CEO: ${subIssues.length}`);
  if (targetWorkspaceDir) log("📂", `Agent workspace: ${targetWorkspaceDir}`);
  log("✅", "Smoke test passed!");
  return true;
}

async function verifySubIssues(parentIssueId: string): Promise<PaperclipIssue[]> {
  header("Verify CEO Created Sub-Issues");

  const allIssues = await findSubIssues(parentIssueId);

  if (allIssues.length === 0) {
    log("⚠️ ", "No sub-issues found. Checking comments...");
    const comments = await paperclip<PaperclipComment[]>("GET", `/api/issues/${parentIssueId}/comments`);
    for (const c of comments) log("💬", `Comment: ${c.body.slice(0, 200)}...`);
    throw new Error("CEO did not create any sub-issues");
  }

  log("✅", `CEO created ${allIssues.length} sub-issues:`);
  for (const issue of allIssues) {
    const agent = issue.assigneeAgentId
      ? Object.entries(AGENTS).find(([, id]) => id === issue.assigneeAgentId)?.[0] ?? "unknown"
      : "unassigned";
    const phase = (issue.metadata as Record<string, string>)?.bmadPhase ?? "?";
    log("  📌", `[${phase}] ${issue.title}`, { status: issue.status, agent, id: issue.id.slice(0, 8) });
  }

  // Check parent comments
  const comments = await paperclip<PaperclipComment[]>("GET", `/api/issues/${parentIssueId}/comments`);
  if (comments.length > 0) {
    log("📋", `${comments.length} comment(s) on parent issue:`);
    for (const c of comments) {
      log("  💬", c.body.split("\n")[0].slice(0, 100));
    }
  }

  // Check parent status
  const parentIssue = await paperclip<PaperclipIssue>("GET", `/api/issues/${parentIssueId}`);
  if (parentIssue.status === "in_progress") {
    log("✅", "Parent issue correctly in 'in_progress' after delegation");
  } else if (parentIssue.status === "done") {
    log("✅", "Parent issue marked 'done' (Paperclip auto-completed)");
  } else {
    log("⚠️ ", `Parent issue status is '${parentIssue.status}' — expected 'in_progress'`);
  }

  return allIssues;
}

async function invokeOneSpecialist(subIssues: PaperclipIssue[]): Promise<void> {
  header("Invoke Specialist Heartbeat");

  const assignedIssue = subIssues.find((i) => i.assigneeAgentId);
  if (!assignedIssue) {
    log("⚠️ ", "No assigned sub-issues — skipping specialist");
    return;
  }

  const agentId = assignedIssue.assigneeAgentId!;
  const agentName = Object.entries(AGENTS).find(([, id]) => id === agentId)?.[0] ?? "unknown";

  try {
    await paperclip("PATCH", `/api/issues/${assignedIssue.id}`, { status: "todo" });
  } catch { /* may already be todo */ }

  await paperclip("POST", `/api/agents/${agentId}/resume`);
  log("▶️ ", `${agentName} resumed`);

  log("🚀", `Invoking ${agentName} heartbeat for: "${assignedIssue.title}"`);
  const startTime = Date.now();

  const run = await invokeHeartbeat(agentId);
  log("📋", `Heartbeat run created`, { runId: run.id.slice(0, 8) });

  log("⏳", "Polling for completion (timeout: 5 min)...");
  const completedRun = await waitForHeartbeatRun(agentId, run.id, agentName.toUpperCase(), 300_000, 3_000);
  const elapsed = Math.round((Date.now() - startTime) / 1000);

  if (completedRun.status === "succeeded") {
    log("✅", `${agentName} heartbeat completed in ${elapsed}s`);
  } else {
    log("⚠️ ", `${agentName} heartbeat ${completedRun.status} (${elapsed}s)`);
  }

  // Check specialist comments
  const comments = await paperclip<PaperclipComment[]>("GET", `/api/issues/${assignedIssue.id}/comments`);
  if (comments.length > 0) {
    log("✅", `${agentName} posted ${comments.length} comment(s):`);
    for (const c of comments) log("  💬", c.body.split("\n")[0].slice(0, 120));
  } else {
    log("⚠️ ", `No comments on sub-issue after ${agentName} heartbeat`);
  }
}

async function verifyProtocolCompliance(
  parentIssueId: string,
  subIssues: PaperclipIssue[],
): Promise<void> {
  header("Verify Phase A Protocol Compliance");

  // Check sub-issue status progression
  let checkedOutCount = 0;
  for (const sub of subIssues) {
    const current = await paperclip<PaperclipIssue>("GET", `/api/issues/${sub.id}`);
    if (current.status === "in_progress" || current.status === "done" || current.status === "in_review") {
      checkedOutCount++;
      log("✅", `Sub-issue ${sub.id.slice(0, 8)} status: ${current.status} (checkout protocol active)`);
    } else if (current.status === "todo" || current.status === "backlog") {
      log("ℹ️ ", `Sub-issue ${sub.id.slice(0, 8)} status: ${current.status} (not yet processed)`);
    } else {
      log("⚠️ ", `Sub-issue ${sub.id.slice(0, 8)} unexpected status: ${current.status}`);
    }
  }

  if (checkedOutCount > 0) {
    log("✅", `${checkedOutCount}/${subIssues.length} sub-issues progressed past checkout`);
  }

  // Verify concurrent checkout safety
  let inProgressIssue: PaperclipIssue | undefined;
  for (const sub of subIssues) {
    const current = await paperclip<PaperclipIssue>("GET", `/api/issues/${sub.id}`);
    if (current.status === "in_progress") { inProgressIssue = current; break; }
  }

  if (inProgressIssue) {
    try {
      const res = await fetch(
        `${PAPERCLIP_URL}/api/issues/${inProgressIssue.id}/checkout`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ agentId: AGENTS.qa, expectedStatuses: ["in_progress"] }),
        },
      );
      if (res.status === 409) {
        log("✅", "Concurrent checkout correctly rejected (409 Conflict)");
      } else if (res.ok) {
        log("ℹ️ ", "Checkout succeeded — may not be locked (version dependent)");
        await fetch(`${PAPERCLIP_URL}/api/issues/${inProgressIssue.id}/release`, { method: "POST" });
      } else {
        log("ℹ️ ", `Checkout returned ${res.status}`);
      }
    } catch {
      log("ℹ️ ", "Checkout endpoint not available");
    }
  }

  // Verify delegation comments on parent
  const parentComments = await paperclip<PaperclipComment[]>("GET", `/api/issues/${parentIssueId}/comments`);
  const hasDelegationComment = parentComments.some((c) =>
    /delegation|sub-issue|sub-task|created/i.test(c.body),
  );
  if (hasDelegationComment) {
    log("✅", "Parent issue has delegation comment (audit trail intact)");
  } else if (parentComments.length > 0) {
    log("ℹ️ ", `Parent has ${parentComments.length} comment(s) but none match delegation pattern`);
  } else {
    log("⚠️ ", "No comments on parent issue — audit trail may be incomplete");
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// FULL MODE — Observer-based multi-phase spec pipeline
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Group sub-issues by their bmadPhase metadata and sort by pipeline order.
 */
function groupByPhase(subIssues: PaperclipIssue[]): Map<BmadPhase, PaperclipIssue[]> {
  const groups = new Map<BmadPhase, PaperclipIssue[]>();
  for (const phase of PHASE_ORDER) groups.set(phase, []);

  for (const issue of subIssues) {
    const phase = (issue.metadata as Record<string, string>)?.bmadPhase as BmadPhase | undefined;
    if (phase && groups.has(phase)) {
      groups.get(phase)!.push(issue);
    } else {
      log("⚠️ ", `Sub-issue "${issue.title}" has unknown phase: ${phase ?? "none"}`);
      groups.get("execute")!.push(issue);
    }
  }

  for (const [phase, issues] of groups) {
    if (issues.length === 0) groups.delete(phase);
  }

  return groups;
}

// ── Invariant Validators ─────────────────────────────────────────────────────

function validateDelegationInvariants(
  subIssues: PaperclipIssue[],
  parentStatus: string,
  parentComments: PaperclipComment[],
  phaseGroups: Map<BmadPhase, PaperclipIssue[]>,
): InvariantResult[] {
  const results: InvariantResult[] = [];

  // D1: CEO creates ≥ 1 sub-issue
  results.push({ id: "D1", label: "CEO created sub-issues", passed: subIssues.length >= 1, detail: `${subIssues.length} sub-issue(s)` });

  // D2: Every sub-issue has metadata.bmadPhase
  const withPhase = subIssues.filter((i) => (i.metadata as Record<string, unknown>)?.bmadPhase);
  results.push({ id: "D2", label: "All sub-issues have bmadPhase metadata", passed: withPhase.length === subIssues.length, detail: `${withPhase.length}/${subIssues.length}` });

  // D3: Every sub-issue has an assignee
  const withAssignee = subIssues.filter((i) => i.assigneeAgentId);
  results.push({ id: "D3", label: "All sub-issues have assignees", passed: withAssignee.length === subIssues.length, detail: `${withAssignee.length}/${subIssues.length}` });

  // D4: CEO does not assign to itself
  const selfAssigned = subIssues.filter((i) => i.assigneeAgentId === AGENTS.ceo);
  results.push({ id: "D4", label: "CEO did not self-assign", passed: selfAssigned.length === 0, detail: selfAssigned.length === 0 ? "OK" : `${selfAssigned.length} self-assigned` });

  // D5: At least one research phase task
  results.push({ id: "D5", label: "Research phase present", passed: (phaseGroups.get("research")?.length ?? 0) > 0, detail: `${phaseGroups.get("research")?.length ?? 0} task(s)` });

  // D6: At least one define phase task
  results.push({ id: "D6", label: "Define phase present", passed: (phaseGroups.get("define")?.length ?? 0) > 0, detail: `${phaseGroups.get("define")?.length ?? 0} task(s)` });

  // D7: No execute phase tasks (spec-only)
  const execCount = phaseGroups.get("execute")?.length ?? 0;
  results.push({ id: "D7", label: "No execute phase tasks", passed: execCount === 0, detail: execCount === 0 ? "OK" : `${execCount} execute task(s)` });

  // D8: Parent issue progressed
  results.push({ id: "D8", label: "Parent issue in_progress", passed: parentStatus === "in_progress" || parentStatus === "done", detail: `status: ${parentStatus}` });

  // D9: Delegation summary comment exists
  const hasDelegation = parentComments.some((c) => /delegation|ceo|sub-task|sub-issue/i.test(c.body));
  results.push({ id: "D9", label: "Delegation summary comment exists", passed: hasDelegation, detail: hasDelegation ? "Found" : `${parentComments.length} comment(s) but no delegation summary` });

  // D10: All assignees are valid agents
  const allValid = subIssues.every((i) => !i.assigneeAgentId || resolveAgentKey(i.assigneeAgentId) !== "unknown");
  results.push({ id: "D10", label: "All assignees are valid agents", passed: allValid, detail: allValid ? "OK" : "Some assignees not in AGENTS map" });

  return results;
}

function validatePhaseInvariants(trace: PhaseTrace): InvariantResult[] {
  const results: InvariantResult[] = [];

  results.push({ id: "P1", label: `[${trace.phase}] Heartbeat succeeded (${trace.agentKey})`, passed: trace.heartbeatStatus === "succeeded", detail: trace.heartbeatStatus });

  const progressed = ["in_progress", "done", "in_review"].includes(trace.issueStatus);
  results.push({ id: "P2", label: `[${trace.phase}] Issue status progressed (${trace.agentKey})`, passed: progressed, detail: `status: ${trace.issueStatus}` });

  results.push({ id: "P3", label: `[${trace.phase}] Agent posted comments (${trace.agentKey})`, passed: trace.commentCount > 0, detail: `${trace.commentCount} comment(s)` });

  results.push({ id: "P4", label: `[${trace.phase}] Comments are substantive (${trace.agentKey})`, passed: trace.totalCommentChars > 100, detail: `${trace.totalCommentChars} chars` });

  const errorPatterns = ["❌", "Failed", "Error", "CRITICAL", "panic"];
  const hasErrors = trace.commentPreviews.some((p) => errorPatterns.some((pat) => p.includes(pat)));
  results.push({ id: "P5", label: `[${trace.phase}] No error markers in comments (${trace.agentKey})`, passed: !hasErrors, detail: hasErrors ? "Error markers found" : "OK" });

  return results;
}

function validateCrossPhaseInvariants(
  traces: PhaseTrace[],
  subIssues: PaperclipIssue[],
): InvariantResult[] {
  const results: InvariantResult[] = [];

  // C1: Phase ordering respected
  const executedPhases = [...new Set(traces.map((t) => t.phase))];
  const phaseIndices = executedPhases.map((p) => PHASE_ORDER.indexOf(p));
  const isOrdered = phaseIndices.every((v, i) => i === 0 || v >= phaseIndices[i - 1]);
  results.push({ id: "C1", label: "Phase ordering respected", passed: isOrdered, detail: `Phases: ${executedPhases.join(" → ")}` });

  // C2: Cost data — placeholder, replaced by real check
  results.push({ id: "C2", label: "Cost data for all agents", passed: true, detail: "Checked separately" });

  // C3: No orphan sub-issues in spec phases
  const processedIds = new Set(traces.map((t) => t.issueId));
  const specPhaseSet = new Set(SPEC_PHASES as string[]);
  const trueOrphans = subIssues.filter((i) => {
    if (processedIds.has(i.id)) return false;
    const phase = (i.metadata as Record<string, string>)?.bmadPhase;
    return phase && specPhaseSet.has(phase);
  });
  results.push({ id: "C3", label: "No orphan sub-issues in spec phases", passed: trueOrphans.length === 0, detail: trueOrphans.length === 0 ? "OK" : `${trueOrphans.length} unprocessed` });

  return results;
}

function runSoftAssertions(
  traces: PhaseTrace[],
  subIssues: PaperclipIssue[],
  totalTimeSec: number,
): InvariantResult[] {
  const results: InvariantResult[] = [];

  const commentsByPhase = new Map<string, string[]>();
  for (const t of traces) {
    if (!commentsByPhase.has(t.phase)) commentsByPhase.set(t.phase, []);
    commentsByPhase.get(t.phase)!.push(...t.commentPreviews);
  }

  // S1: Research mentions domain terms
  const domainTerms = ["telemetry", "fleet", "vehicle", "OBD", "GPS", "real-time", "dashboard"];
  const rc = commentsByPhase.get("research") ?? [];
  const s1 = rc.some((c) => domainTerms.some((t) => c.toLowerCase().includes(t.toLowerCase())));
  results.push({ id: "S1", label: "Research references domain terms", passed: s1 || rc.length === 0, detail: s1 ? "Found" : rc.length === 0 ? "No research comments" : "Missing", soft: true });

  // S2: Define mentions architecture patterns
  const archTerms = ["websocket", "pub/sub", "mqtt", "rest", "grpc", "streaming", "time-series", "database", "api", "microservice", "event", "architecture"];
  const dc = commentsByPhase.get("define") ?? [];
  const s2 = dc.some((c) => archTerms.some((t) => c.toLowerCase().includes(t.toLowerCase())));
  results.push({ id: "S2", label: "Define references architecture patterns", passed: s2 || dc.length === 0, detail: s2 ? "Found" : dc.length === 0 ? "No define comments" : "Missing", soft: true });

  // S3: Plan mentions epics/stories
  const planTerms = ["epic", "story", "sprint", "backlog", "milestone", "feature", "task"];
  const pc = commentsByPhase.get("plan") ?? [];
  const s3 = pc.some((c) => planTerms.some((t) => c.toLowerCase().includes(t.toLowerCase())));
  results.push({ id: "S3", label: "Plan references epics/stories", passed: s3 || pc.length === 0, detail: s3 ? "Found" : pc.length === 0 ? "No plan comments" : "Missing", soft: true });

  // S4: Specialist count ≤ 8
  results.push({ id: "S4", label: "Specialist count reasonable", passed: subIssues.length <= 8, detail: `${subIssues.length} sub-issue(s)`, soft: true });

  // S5: Total time < 15 min
  results.push({ id: "S5", label: "Total time < 15 minutes", passed: totalTimeSec < 900, detail: `${Math.floor(totalTimeSec / 60)}m${totalTimeSec % 60}s`, soft: true });

  return results;
}

// ── Specialist Invocation ────────────────────────────────────────────────────

async function invokeSpecialist(
  issue: PaperclipIssue,
  phase: BmadPhase,
  agentKey: string,
  agentName: string,
): Promise<PhaseTrace> {
  const agentId = issue.assigneeAgentId;
  if (!agentId) {
    return {
      issueId: issue.id, title: issue.title, phase, agentKey, agentName,
      heartbeatStatus: "skipped", issueStatus: issue.status,
      durationSec: 0, commentCount: 0, totalCommentChars: 0,
      commentPreviews: [], error: "No assignee — skipped",
    };
  }

  try {
    await paperclip("PATCH", `/api/issues/${issue.id}`, { status: "todo" });
  } catch { /* may already be todo */ }

  await resumeAgent(agentKey);

  const startTime = Date.now();
  let heartbeatStatus = "unknown";
  let error: string | undefined;

  try {
    const run = await invokeHeartbeat(agentId);
    log("  📋", `Run: ${run.id.slice(0, 8)}`);

    const completedRun = await waitForHeartbeatRun(agentId, run.id, `${agentName}/${phase}`, 300_000, 3_000);
    heartbeatStatus = completedRun.status;
    if (completedRun.status !== "succeeded") {
      error = completedRun.error ?? `Heartbeat ${completedRun.status}`;
    }
  } catch (err) {
    heartbeatStatus = "error";
    error = err instanceof Error ? err.message : String(err);
  }

  const durationSec = Math.round((Date.now() - startTime) / 1000);

  try { await pauseAgent(agentKey); } catch { /* non-critical */ }

  const updatedIssue = await paperclip<PaperclipIssue>("GET", `/api/issues/${issue.id}`);
  const comments = await paperclip<PaperclipComment[]>("GET", `/api/issues/${issue.id}/comments`);

  return {
    issueId: issue.id, title: issue.title, phase, agentKey, agentName,
    heartbeatStatus, issueStatus: updatedIssue.status, durationSec,
    commentCount: comments.length,
    totalCommentChars: comments.reduce((sum, c) => sum + c.body.length, 0),
    commentPreviews: comments.map((c) => c.body.split("\n")[0]),
    error,
  };
}

// ── Test Report ──────────────────────────────────────────────────────────────

function printTestReport(
  traces: PhaseTrace[],
  allInvariants: InvariantResult[],
  totalTimeSec: number,
  subIssueCount: number,
  phaseGroups: Map<BmadPhase, PaperclipIssue[]>,
): boolean {
  header("Spec Pipeline E2E — Test Report");

  const phaseSummary = [...phaseGroups.entries()]
    .map(([p, issues]) => `${p}(${issues.length})`)
    .join(" → ");
  log("📋", `Seed: "${SPEC_ISSUE.title.slice(0, 60)}..."`);
  log("📋", `CEO Plan: ${subIssueCount} tasks — ${phaseSummary}`);
  log("", "");

  // Phase trace table
  if (traces.length > 0) {
    log("🔷", "Phase Trace:");
    log("", "┌─────────────────────────────────────────────────────────────┐");
    for (const t of traces) {
      const icon = t.heartbeatStatus === "succeeded" ? "✅" : "❌";
      log("", `│ [${t.phase}] "${t.title.slice(0, 45)}"${" ".repeat(Math.max(0, 45 - t.title.length))}│`);
      log("", `│   Agent:   ${t.agentName.padEnd(48)}│`);
      log("", `│   Status:  ${icon} ${t.issueStatus} (${t.durationSec}s)${" ".repeat(Math.max(0, 43 - t.issueStatus.length - String(t.durationSec).length))}│`);
      log("", `│   Output:  ${t.commentCount} comment(s), ${t.totalCommentChars} chars${" ".repeat(Math.max(0, 36 - String(t.commentCount).length - String(t.totalCommentChars).length))}│`);
      if (t.error) {
        log("", `│   Error:   ${t.error.slice(0, 48)}│`);
      }
      log("", `│${" ".repeat(61)}│`);
    }
    log("", "└─────────────────────────────────────────────────────────────┘");
    log("", "");
  }

  // Invariant results
  log("🔷", "Invariant Results:");
  const hard = allInvariants.filter((i) => !i.soft);
  const soft = allInvariants.filter((i) => i.soft);

  for (const inv of hard) {
    const icon = inv.passed ? "✅" : "❌";
    log(`  ${icon}`, `${inv.id}  ${inv.label} — ${inv.detail}`);
  }

  if (soft.length > 0) {
    log("", "");
    log("🔶", "Soft Assertions:");
    for (const inv of soft) {
      const icon = inv.passed ? "✅" : "⚠️ ";
      log(`  ${icon}`, `${inv.id}  ${inv.label} — ${inv.detail}`);
    }
  }

  // Summary
  const hardPassed = hard.filter((i) => i.passed).length;
  const hardFailed = hard.filter((i) => !i.passed).length;
  const softWarnings = soft.filter((i) => !i.passed).length;

  log("", "");
  log("📊", `Hard assertions: ${hardPassed}/${hard.length} passed${hardFailed > 0 ? `, ${hardFailed} FAILED` : ""}`);
  if (soft.length > 0) {
    log("📊", `Soft assertions: ${soft.length - softWarnings}/${soft.length} passed${softWarnings > 0 ? `, ${softWarnings} warning(s)` : ""}`);
  }
  log("⏱️ ", `Total time: ${Math.floor(totalTimeSec / 60)}m${totalTimeSec % 60}s`);

  const allPassed = hardFailed === 0;
  log(allPassed ? "✅" : "❌", `Pipeline: ${allPassed ? "PASS" : "FAIL"}`);
  return allPassed;
}

// ── Full Pipeline ────────────────────────────────────────────────────────────

async function runFull(): Promise<boolean> {
  const startTime = Date.now();

  await setup("bmad-e2e-spec-pipeline");
  const seedIssue = await createIssue(SPEC_ISSUE, "spec-pipeline");

  // Invoke CEO for delegation
  try {
    await invokeCeo(seedIssue.id);
  } catch (err) {
    log("💥", `CEO heartbeat failed: ${err instanceof Error ? err.message : String(err)}`);
    await cleanup(seedIssue.id, []);
    return false;
  }

  // Observe delegation plan
  let subIssues: PaperclipIssue[] = [];
  let phaseGroups: Map<BmadPhase, PaperclipIssue[]>;
  let delegationInvariants: InvariantResult[];

  try {
    const allIssues = await findSubIssues(seedIssue.id);
    if (allIssues.length === 0) {
      const comments = await paperclip<PaperclipComment[]>("GET", `/api/issues/${seedIssue.id}/comments`);
      for (const c of comments) log("💬", `Comment: ${c.body.slice(0, 200)}`);
      throw new Error("CEO did not create any sub-issues");
    }

    subIssues = allIssues;
    log("📊", `CEO created ${subIssues.length} sub-issues:`);
    for (const issue of subIssues) {
      const agentKey = issue.assigneeAgentId ? resolveAgentKey(issue.assigneeAgentId) : "unassigned";
      const phase = (issue.metadata as Record<string, string>)?.bmadPhase ?? "?";
      log("  📌", `[${phase}] ${issue.title}`, { agent: agentKey, status: issue.status, id: issue.id.slice(0, 8) });
    }

    phaseGroups = groupByPhase(subIssues);
    log("📋", `Phases in plan: ${[...phaseGroups.keys()].join(" → ")}`);

    const parentIssue = await paperclip<PaperclipIssue>("GET", `/api/issues/${seedIssue.id}`);
    const parentComments = await paperclip<PaperclipComment[]>("GET", `/api/issues/${seedIssue.id}/comments`);

    if (parentComments.length > 0) {
      log("📋", `${parentComments.length} comment(s) on parent issue:`);
      for (const c of parentComments) log("  💬", c.body.split("\n")[0].slice(0, 120));
    }

    delegationInvariants = validateDelegationInvariants(subIssues, parentIssue.status, parentComments, phaseGroups);
    for (const inv of delegationInvariants) {
      log(inv.passed ? "✅" : "❌", `${inv.id}: ${inv.label} — ${inv.detail}`);
    }
  } catch (err) {
    log("💥", `Delegation observation failed: ${err instanceof Error ? err.message : String(err)}`);
    await cleanup(seedIssue.id, []);
    return false;
  }

  // Invoke specialists phase by phase
  header("Invoke Specialists (Phase by Phase)");

  const stopIdx = FLAGS.stopAfter
    ? PHASE_ORDER.indexOf(FLAGS.stopAfter)
    : PHASE_ORDER.indexOf("plan");
  const phasesToRun = PHASE_ORDER.slice(0, stopIdx + 1);

  let traces: PhaseTrace[] = [];
  try {
    for (const phase of phasesToRun) {
      const issues = phaseGroups.get(phase);
      if (!issues || issues.length === 0) continue;

      log("", "");
      log("🔷", `── Phase: ${phase.toUpperCase()} (${issues.length} task${issues.length > 1 ? "s" : ""}) ──`);

      for (let i = 0; i < issues.length; i++) {
        const issue = issues[i];
        const agentKey = issue.assigneeAgentId ? resolveAgentKey(issue.assigneeAgentId) : "unknown";
        const agentName = issue.assigneeAgentId ? resolveAgentName(issue.assigneeAgentId) : "unknown";

        log("", "");
        log("🔹", `[${phase} ${i + 1}/${issues.length}] "${issue.title}"  →  ${agentName}`);

        const trace = await invokeSpecialist(issue, phase, agentKey, agentName);
        traces.push(trace);

        const icon = trace.heartbeatStatus === "succeeded" ? "✅" : "❌";
        log(icon, `${agentName}: ${trace.heartbeatStatus} in ${trace.durationSec}s, ` +
          `${trace.commentCount} comment(s), status=${trace.issueStatus}`);

        if (trace.commentPreviews.length > 0) {
          for (const preview of trace.commentPreviews.slice(0, 3)) {
            log("  💬", preview.slice(0, 120));
          }
        }
      }
    }
  } catch (err) {
    log("⚠️ ", `Phase execution error: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Verify cost tracking
  let costInvariant: InvariantResult;
  try {
    costInvariant = await verifyCosts();
  } catch {
    costInvariant = { id: "C2", label: "Cost data", passed: false, detail: "Check failed" };
  }

  // Collect all invariants
  const phaseInvariants = traces.flatMap((t) => validatePhaseInvariants(t));
  const crossPhaseInvariants = validateCrossPhaseInvariants(traces, subIssues);
  const crossWithRealCost = crossPhaseInvariants.map((inv) =>
    inv.id === "C2" ? costInvariant : inv,
  );

  const totalTimeSec = Math.round((Date.now() - startTime) / 1000);
  const softAssertions = runSoftAssertions(traces, subIssues, totalTimeSec);

  const allInvariants = [
    ...delegationInvariants,
    ...phaseInvariants,
    ...crossWithRealCost,
    ...softAssertions,
  ];

  // Cleanup
  await cleanup(seedIssue.id, subIssues);

  // Print report
  return printTestReport(traces, allInvariants, totalTimeSec, subIssues.length, phaseGroups);
}

// ── Autonomous Pipeline ──────────────────────────────────────────────────────

/**
 * Autonomous mode: resume all agents, create a seed issue, and let Paperclip's
 * wakeOnDemand pipeline self-drive. Poll for completion instead of invoking
 * heartbeats explicitly.
 */
async function runAutonomous(): Promise<boolean> {
  const startTime = Date.now();
  await setup("bmad-e2e-autonomous");

  // 1. Resume ALL agents (critical — wakeOnDemand needs active agents)
  await resumeAllAgents();
  log("▶️", "All agents resumed — wakeOnDemand will drive the pipeline");

  // 2. Create seed issue assigned to CEO, status=todo
  //    This triggers Paperclip's issue.create wakeup on CEO
  const seedIssue = await createIssue(SPEC_ISSUE, "autonomous");
  await paperclip("PATCH", `/api/issues/${seedIssue.id}`, { status: "todo" });
  log("🚀", "Seed issue created and assigned to CEO — pipeline is self-driving now");

  // 3. Poll: wait for CEO to create sub-issues (timeout: 5 min)
  let subIssues: PaperclipIssue[] = [];
  const ceoPollDeadline = Date.now() + 5 * 60_000;
  while (Date.now() < ceoPollDeadline) {
    subIssues = await findSubIssues(seedIssue.id);
    if (subIssues.length > 0) break;
    log("⏳", "Waiting for CEO to create sub-issues...");
    await new Promise((r) => setTimeout(r, 10_000));
  }
  if (subIssues.length === 0) {
    log("💥", "CEO did not create sub-issues within 5 minutes");
    await cleanup(seedIssue.id, []);
    return false;
  }

  // Log delegation plan
  const phaseGroups = groupByPhase(subIssues);
  log("📊", `CEO created ${subIssues.length} sub-issues: ${[...phaseGroups.keys()].join(" → ")}`);
  for (const issue of subIssues) {
    const agentKey = issue.assigneeAgentId ? resolveAgentKey(issue.assigneeAgentId) : "?";
    const phase = (issue.metadata as Record<string, string>)?.bmadPhase ?? "?";
    log("  📌", `[${phase}] ${issue.title} → ${agentKey}`);
  }

  // 4. Poll: wait for all spec-phase sub-issues to reach "done" (or timeout)
  const specIssueIds = new Set(
    subIssues
      .filter((i) => {
        const phase = (i.metadata as Record<string, string>)?.bmadPhase;
        return phase && ["research", "define", "plan"].includes(phase);
      })
      .map((i) => i.id),
  );

  const pipelineDeadline = Date.now() + FLAGS.timeout;
  let lastStatusLog = "";
  while (Date.now() < pipelineDeadline) {
    // Re-fetch all sub-issues
    const current = await findSubIssues(seedIssue.id);
    const specCurrent = current.filter((i) => specIssueIds.has(i.id));

    const statusMap = specCurrent
      .map((i) => {
        const phase = (i.metadata as Record<string, string>)?.bmadPhase ?? "?";
        return `${phase}:${i.status}`;
      })
      .join(" | ");

    if (statusMap !== lastStatusLog) {
      log("📊", `Pipeline status: ${statusMap}`);
      lastStatusLog = statusMap;
    }

    const allDone = specCurrent.every(
      (i) => i.status === "done" || i.status === "cancelled",
    );
    if (allDone) {
      log("✅", "All spec-phase sub-issues completed!");
      break;
    }

    await new Promise((r) => setTimeout(r, 15_000));
  }

  // 5. Collect traces from completed sub-issues (comments, status)
  const traces: PhaseTrace[] = [];
  for (const issue of subIssues) {
    const phase =
      ((issue.metadata as Record<string, string>)?.bmadPhase as BmadPhase) ?? "execute";
    const agentKey = issue.assigneeAgentId
      ? resolveAgentKey(issue.assigneeAgentId)
      : "unknown";
    const agentName = issue.assigneeAgentId
      ? resolveAgentName(issue.assigneeAgentId)
      : "unknown";
    const updated = await paperclip<PaperclipIssue>(
      "GET",
      `/api/issues/${issue.id}`,
    );
    const comments = await paperclip<PaperclipComment[]>(
      "GET",
      `/api/issues/${issue.id}/comments`,
    );
    traces.push({
      issueId: issue.id,
      title: issue.title,
      phase,
      agentKey,
      agentName,
      heartbeatStatus: updated.status === "done" ? "succeeded" : updated.status,
      issueStatus: updated.status,
      durationSec: 0, // Can't measure per-agent in autonomous mode
      commentCount: comments.length,
      totalCommentChars: comments.reduce((sum, c) => sum + c.body.length, 0),
      commentPreviews: comments.map((c) => c.body.split("\n")[0]),
    });
  }

  // 6. Run invariants
  const parentIssue = await paperclip<PaperclipIssue>(
    "GET",
    `/api/issues/${seedIssue.id}`,
  );
  const parentComments = await paperclip<PaperclipComment[]>(
    "GET",
    `/api/issues/${seedIssue.id}/comments`,
  );
  const delegationInvariants = validateDelegationInvariants(
    subIssues,
    parentIssue.status,
    parentComments,
    phaseGroups,
  );
  const phaseInvariants = traces.flatMap((t) => validatePhaseInvariants(t));
  const crossPhaseInvariants = validateCrossPhaseInvariants(traces, subIssues);
  let costInvariant: InvariantResult;
  try {
    costInvariant = await verifyCosts();
  } catch {
    costInvariant = {
      id: "C2",
      label: "Cost data",
      passed: false,
      detail: "Check failed",
    };
  }
  const crossWithRealCost = crossPhaseInvariants.map((inv) =>
    inv.id === "C2" ? costInvariant : inv,
  );
  const totalTimeSec = Math.round((Date.now() - startTime) / 1000);
  const softAssertions = runSoftAssertions(traces, subIssues, totalTimeSec);
  const allInvariants = [
    ...delegationInvariants,
    ...phaseInvariants,
    ...crossWithRealCost,
    ...softAssertions,
  ];

  // 7. Cleanup + report
  await cleanup(seedIssue.id, subIssues);
  return printTestReport(
    traces,
    allInvariants,
    totalTimeSec,
    subIssues.length,
    phaseGroups,
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// Main
// ═════════════════════════════════════════════════════════════════════════════

async function main(): Promise<void> {
  const mode = FLAGS.smoke ? "smoke" : FLAGS.autonomous ? "autonomous" : "full";

  console.log("\n🧪 BMAD Copilot Factory — E2E Test");
  console.log(`   Paperclip: ${PAPERCLIP_URL}`);
  console.log(`   Company:   ${COMPANY_ID}`);
  console.log(`   Mode:      ${mode}${FLAGS.stopAfter ? ` (stop-after=${FLAGS.stopAfter})` : ""}`);
  console.log(`   Timeout:   ${FLAGS.timeout / 60_000} min`);
  console.log(`   Flags:     ${FLAGS.ceoOnly ? "--ceo-only " : ""}${FLAGS.skipCleanup ? "--skip-cleanup " : ""}${FLAGS.verbose ? "--verbose" : ""}`);
  console.log();

  setVerbose(FLAGS.verbose);
  await resolveAgentIds();

  const passed = FLAGS.smoke
    ? await runSmoke()
    : FLAGS.autonomous
      ? await runAutonomous()
      : await runFull();
  process.exit(passed ? 0 : 1);
}

main().catch((err) => {
  console.error("\n💥 E2E test crashed:", err);
  process.exit(1);
});

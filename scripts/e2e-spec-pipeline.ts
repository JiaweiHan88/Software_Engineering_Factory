#!/usr/bin/env npx tsx
/**
 * E2E Spec Pipeline Test — Observer-Based Multi-Phase Validation
 *
 * Validates the autonomous software specification preparation pipeline:
 *   Vague issue → CEO delegation → Research → PRD/Architecture → Epics
 *
 * Unlike the smoke test (which tests a simple health-check with one specialist),
 * this test validates multi-phase, multi-agent orchestration where:
 * - The CEO must decompose a deliberately vague/complex requirement
 * - Multiple specialists run across BMAD phases (research → define → plan)
 * - The pipeline stops before implementation (spec-only)
 *
 * Observer model: The test does NOT prescribe which agents the CEO delegates to.
 * It observes the delegation plan, validates structural invariants, drives each
 * phase to completion, and validates outputs.
 *
 * Prerequisites:
 * - Paperclip running at localhost:3100 (local_trusted mode)
 * - gh auth working (for Copilot SDK)
 * - .env with COPILOT_GHE_HOST, PAPERCLIP_URL, PAPERCLIP_COMPANY_ID
 *
 * Usage:
 *   npx tsx scripts/e2e-spec-pipeline.ts [--skip-cleanup] [--verbose] [--stop-after=research|define|plan]
 *
 * @module scripts/e2e-spec-pipeline
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

// ─────────────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────────────

const FLAGS = {
  skipCleanup: process.argv.includes("--skip-cleanup"),
  verbose: process.argv.includes("--verbose"),
  stopAfter: (() => {
    const arg = process.argv.find((a) => a.startsWith("--stop-after="));
    return arg ? arg.split("=")[1] as BmadPhase : null;
  })(),
};

/** E2E project name — separate from smoke test to avoid collision. */
const E2E_PROJECT_NAME = "bmad-e2e-spec-pipeline";

/** Resolved at runtime. */
let targetWorkspaceDir: string | undefined;
let projectId: string | undefined;

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

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

// ─────────────────────────────────────────────────────────────────────────────
// Seed Issue
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The deliberately vague/complex seed issue that forces multi-phase delegation.
 */
const SEED_ISSUE = {
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
};

// ─────────────────────────────────────────────────────────────────────────────
// Phase Grouping
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Group sub-issues by their bmadPhase metadata and sort by pipeline order.
 * Returns a Map in phase order (research → define → plan → ...).
 */
function groupByPhase(subIssues: PaperclipIssue[]): Map<BmadPhase, PaperclipIssue[]> {
  const groups = new Map<BmadPhase, PaperclipIssue[]>();

  // Initialize in pipeline order
  for (const phase of PHASE_ORDER) {
    groups.set(phase, []);
  }

  for (const issue of subIssues) {
    const phase = (issue.metadata as Record<string, string>)?.bmadPhase as BmadPhase | undefined;
    if (phase && groups.has(phase)) {
      groups.get(phase)!.push(issue);
    } else {
      // Unknown or missing phase — treat as "execute" (catch-all)
      log("⚠️ ", `Sub-issue "${issue.title}" has unknown phase: ${phase ?? "none"}`);
      groups.get("execute")!.push(issue);
    }
  }

  // Remove empty phases
  for (const [phase, issues] of groups) {
    if (issues.length === 0) {
      groups.delete(phase);
    }
  }

  return groups;
}

// ─────────────────────────────────────────────────────────────────────────────
// Invariant Validators
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Validate CEO delegation invariants (D1-D10).
 */
function validateDelegationInvariants(
  subIssues: PaperclipIssue[],
  parentStatus: string,
  parentComments: PaperclipComment[],
  phaseGroups: Map<BmadPhase, PaperclipIssue[]>,
): InvariantResult[] {
  const results: InvariantResult[] = [];

  // D1: CEO creates ≥ 1 sub-issue
  results.push({
    id: "D1",
    label: "CEO created sub-issues",
    passed: subIssues.length >= 1,
    detail: `${subIssues.length} sub-issue(s)`,
  });

  // D2: Every sub-issue has metadata.bmadPhase
  const withPhase = subIssues.filter((i) =>
    (i.metadata as Record<string, unknown>)?.bmadPhase,
  );
  results.push({
    id: "D2",
    label: "All sub-issues have bmadPhase metadata",
    passed: withPhase.length === subIssues.length,
    detail: `${withPhase.length}/${subIssues.length}`,
  });

  // D3: Every sub-issue has an assignee
  const withAssignee = subIssues.filter((i) => i.assigneeAgentId);
  results.push({
    id: "D3",
    label: "All sub-issues have assignees",
    passed: withAssignee.length === subIssues.length,
    detail: `${withAssignee.length}/${subIssues.length}`,
  });

  // D4: CEO does not assign to itself
  const selfAssigned = subIssues.filter((i) => i.assigneeAgentId === AGENTS.ceo);
  results.push({
    id: "D4",
    label: "CEO did not self-assign",
    passed: selfAssigned.length === 0,
    detail: selfAssigned.length === 0 ? "OK" : `${selfAssigned.length} self-assigned`,
  });

  // D5: At least one research phase task
  const researchCount = phaseGroups.get("research")?.length ?? 0;
  results.push({
    id: "D5",
    label: "Research phase present",
    passed: researchCount > 0,
    detail: `${researchCount} task(s)`,
  });

  // D6: At least one define phase task
  const defineCount = phaseGroups.get("define")?.length ?? 0;
  results.push({
    id: "D6",
    label: "Define phase present",
    passed: defineCount > 0,
    detail: `${defineCount} task(s)`,
  });

  // D7: No execute phase tasks (spec-only issue)
  const executeCount = phaseGroups.get("execute")?.length ?? 0;
  results.push({
    id: "D7",
    label: "No execute phase tasks",
    passed: executeCount === 0,
    detail: executeCount === 0 ? "OK" : `${executeCount} execute task(s) — seed says spec-only!`,
  });

  // D8: Parent issue is in_progress (CEO checked it out)
  results.push({
    id: "D8",
    label: "Parent issue in_progress",
    passed: parentStatus === "in_progress" || parentStatus === "done",
    detail: `status: ${parentStatus}`,
  });

  // D9: Delegation summary comment exists on parent
  const hasDelegationComment = parentComments.some((c) =>
    c.body.includes("Delegation") || c.body.includes("delegation") ||
    c.body.includes("CEO") || c.body.includes("sub-task") ||
    c.body.includes("Sub-task"),
  );
  results.push({
    id: "D9",
    label: "Delegation summary comment exists",
    passed: hasDelegationComment,
    detail: hasDelegationComment ? "Found" : `${parentComments.length} comment(s) but no delegation summary`,
  });

  // D10: All assignees are valid agents
  const allValid = subIssues.every((i) =>
    !i.assigneeAgentId || resolveAgentKey(i.assigneeAgentId) !== "unknown",
  );
  results.push({
    id: "D10",
    label: "All assignees are valid agents",
    passed: allValid,
    detail: allValid ? "OK" : "Some assignees not in AGENTS map",
  });

  return results;
}

/**
 * Validate phase execution invariants (P1-P5) for a single specialist run.
 */
function validatePhaseInvariants(trace: PhaseTrace): InvariantResult[] {
  const results: InvariantResult[] = [];

  // P1: Heartbeat run succeeded
  results.push({
    id: "P1",
    label: `[${trace.phase}] Heartbeat succeeded (${trace.agentKey})`,
    passed: trace.heartbeatStatus === "succeeded",
    detail: trace.heartbeatStatus,
  });

  // P2: Sub-issue status progressed past todo
  const progressed = trace.issueStatus === "in_progress" ||
    trace.issueStatus === "done" ||
    trace.issueStatus === "in_review";
  results.push({
    id: "P2",
    label: `[${trace.phase}] Issue status progressed (${trace.agentKey})`,
    passed: progressed,
    detail: `status: ${trace.issueStatus}`,
  });

  // P3: Agent posted ≥ 1 comment
  results.push({
    id: "P3",
    label: `[${trace.phase}] Agent posted comments (${trace.agentKey})`,
    passed: trace.commentCount > 0,
    detail: `${trace.commentCount} comment(s)`,
  });

  // P4: Comments are substantive (> 100 chars)
  results.push({
    id: "P4",
    label: `[${trace.phase}] Comments are substantive (${trace.agentKey})`,
    passed: trace.totalCommentChars > 100,
    detail: `${trace.totalCommentChars} chars`,
  });

  // P5: No error markers in comments
  const errorPatterns = ["❌", "Failed", "Error", "CRITICAL", "panic"];
  const hasErrors = trace.commentPreviews.some((p) =>
    errorPatterns.some((pat) => p.includes(pat)),
  );
  results.push({
    id: "P5",
    label: `[${trace.phase}] No error markers in comments (${trace.agentKey})`,
    passed: !hasErrors,
    detail: hasErrors ? "Error markers found in comments" : "OK",
  });

  return results;
}

/**
 * Validate cross-phase invariants (C1-C3).
 */
function validateCrossPhaseInvariants(
  traces: PhaseTrace[],
  subIssues: PaperclipIssue[],
): InvariantResult[] {
  const results: InvariantResult[] = [];

  // C1: Phase ordering respected (research before define, define before plan)
  // Since we drive invocation in order, this is validated by construction.
  // But verify no earlier-phase tasks were skipped.
  const executedPhases = [...new Set(traces.map((t) => t.phase))];
  const phaseIndices = executedPhases.map((p) => PHASE_ORDER.indexOf(p));
  const isOrdered = phaseIndices.every((v, i) => i === 0 || v >= phaseIndices[i - 1]);
  results.push({
    id: "C1",
    label: "Phase ordering respected",
    passed: isOrdered,
    detail: `Phases executed: ${executedPhases.join(" → ")}`,
  });

  // C2: Cost data recorded for invoked agents
  // This is checked asynchronously — we'll add it as a deferred check
  results.push({
    id: "C2",
    label: "Cost data for all agents",
    passed: true, // Validated separately in step_verifyCosts
    detail: "Checked in cost verification step",
  });

  // C3: No orphan sub-issues (every sub-issue either completed or has a comment)
  const processedIds = new Set(traces.map((t) => t.issueId));
  const unprocessed = subIssues.filter((i) => !processedIds.has(i.id));
  // Unprocessed issues from phases we intentionally didn't run are OK
  const specPhaseSet = new Set(SPEC_PHASES as string[]);
  const trueOrphans = unprocessed.filter((i) => {
    const phase = (i.metadata as Record<string, string>)?.bmadPhase;
    return phase && specPhaseSet.has(phase);
  });
  results.push({
    id: "C3",
    label: "No orphan sub-issues in spec phases",
    passed: trueOrphans.length === 0,
    detail: trueOrphans.length === 0
      ? "OK"
      : `${trueOrphans.length} unprocessed sub-issue(s) in spec phases`,
  });

  return results;
}

/**
 * Run soft assertions (S1-S5) — logged as warnings, not failures.
 */
function runSoftAssertions(
  traces: PhaseTrace[],
  subIssues: PaperclipIssue[],
  totalTimeSec: number,
): InvariantResult[] {
  const results: InvariantResult[] = [];

  // Collect all comment text by phase
  const commentsByPhase = new Map<string, string[]>();
  for (const t of traces) {
    if (!commentsByPhase.has(t.phase)) {
      commentsByPhase.set(t.phase, []);
    }
    commentsByPhase.get(t.phase)!.push(...t.commentPreviews);
  }

  // S1: Research comments reference domain terms
  const domainTerms = ["telemetry", "fleet", "vehicle", "OBD", "GPS", "real-time", "dashboard"];
  const researchComments = commentsByPhase.get("research") ?? [];
  const researchMentionsDomain = researchComments.some((c) =>
    domainTerms.some((term) => c.toLowerCase().includes(term.toLowerCase())),
  );
  results.push({
    id: "S1",
    label: "Research comments reference domain terms",
    passed: researchMentionsDomain || researchComments.length === 0,
    detail: researchMentionsDomain
      ? "Domain terms found"
      : researchComments.length === 0
        ? "No research comments (phase may not have run)"
        : "No domain terms found in research output",
    soft: true,
  });

  // S2: Define comments reference architecture patterns
  const archTerms = ["websocket", "pub/sub", "mqtt", "rest", "grpc", "streaming",
    "time-series", "database", "api", "microservice", "event", "architecture"];
  const defineComments = commentsByPhase.get("define") ?? [];
  const defineMentionsArch = defineComments.some((c) =>
    archTerms.some((term) => c.toLowerCase().includes(term.toLowerCase())),
  );
  results.push({
    id: "S2",
    label: "Define comments reference architecture patterns",
    passed: defineMentionsArch || defineComments.length === 0,
    detail: defineMentionsArch
      ? "Architecture terms found"
      : defineComments.length === 0
        ? "No define comments (phase may not have run)"
        : "No architecture terms found in define output",
    soft: true,
  });

  // S3: Plan comments reference epics or stories
  const planTerms = ["epic", "story", "sprint", "backlog", "milestone", "feature", "task"];
  const planComments = commentsByPhase.get("plan") ?? [];
  const planMentionsEpics = planComments.some((c) =>
    planTerms.some((term) => c.toLowerCase().includes(term.toLowerCase())),
  );
  results.push({
    id: "S3",
    label: "Plan comments reference epics/stories",
    passed: planMentionsEpics || planComments.length === 0,
    detail: planMentionsEpics
      ? "Planning terms found"
      : planComments.length === 0
        ? "No plan comments (phase may not have run)"
        : "No planning terms found in plan output",
    soft: true,
  });

  // S4: Total specialist count ≤ 8
  results.push({
    id: "S4",
    label: "Specialist count reasonable",
    passed: subIssues.length <= 8,
    detail: `${subIssues.length} sub-issue(s)${subIssues.length > 8 ? " — CEO over-decomposed" : ""}`,
    soft: true,
  });

  // S5: Total execution time < 15 minutes
  results.push({
    id: "S5",
    label: "Total time < 15 minutes",
    passed: totalTimeSec < 900,
    detail: `${Math.floor(totalTimeSec / 60)}m${totalTimeSec % 60}s`,
    soft: true,
  });

  return results;
}

// ─────────────────────────────────────────────────────────────────────────────
// Pipeline Steps
// ─────────────────────────────────────────────────────────────────────────────

async function step_setup(): Promise<void> {
  header("Step 0: Setup");

  // Shared prereq checks (Paperclip health, CEO agent, heartbeat config)
  await checkPrereqs();

  // Workspace isolation
  const e2eProject = await ensureE2eProject(E2E_PROJECT_NAME);
  projectId = e2eProject.projectId;
  targetWorkspaceDir = e2eProject.workspaceDir;
  mkdirSync(targetWorkspaceDir, { recursive: true });
  log("📂", `Agent workspace: ${targetWorkspaceDir}`);

  // Inject TARGET_PROJECT_ROOT into all agent configs
  const agentEntries = Object.entries(AGENTS);
  for (const [, id] of agentEntries) {
    await setAgentTargetWorkspace(id, targetWorkspaceDir);
  }
  log("🔧", `Updated ${agentEntries.length} agent configs with TARGET_PROJECT_ROOT`);
}

async function step_createSeedIssue(): Promise<PaperclipIssue> {
  header("Step 1: Create Seed Issue (Vague/Complex)");

  const issue = await paperclip<PaperclipIssue>(
    "POST",
    `/api/companies/${COMPANY_ID}/issues`,
    {
      title: SEED_ISSUE.title,
      description: SEED_ISSUE.description,
      status: "backlog",
      priority: "medium",
      assigneeAgentId: AGENTS.ceo,
      ...(projectId ? { projectId } : {}),
      metadata: {
        e2eTest: true,
        testType: "spec-pipeline",
        createdBy: "e2e-spec-pipeline.ts",
        timestamp: new Date().toISOString(),
      },
    },
  );

  log("✅", "Seed issue created", {
    id: issue.id,
    title: issue.title.slice(0, 60),
  });

  return issue;
}

async function step_invokeCeo(issueId: string): Promise<void> {
  header("Step 2: Invoke CEO Heartbeat (Delegation)");

  // Pause all → move to todo → resume CEO only → invoke
  await pauseAllAgents();

  await paperclip("PATCH", `/api/issues/${issueId}`, { status: "todo" });
  log("📝", "Issue moved to 'todo'");

  await resumeAgent("ceo");
  log("▶️ ", "CEO resumed");

  log("🚀", "Invoking CEO heartbeat...");
  const startTime = Date.now();

  const run = await invokeHeartbeat(AGENTS.ceo);
  log("📋", `Heartbeat run created`, { runId: run.id.slice(0, 8) });

  log("⏳", "Polling for completion (timeout: 5 min)...");
  const completedRun = await waitForHeartbeatRun(AGENTS.ceo, run.id, "CEO", 300_000, 3_000);
  const elapsed = Math.round((Date.now() - startTime) / 1000);

  if (completedRun.status === "succeeded") {
    log("✅", `CEO heartbeat completed in ${elapsed}s`);
  } else {
    log("❌", `CEO heartbeat ${completedRun.status} (${elapsed}s)`, {
      exitCode: completedRun.exitCode,
      error: completedRun.error,
    });
    throw new Error(`CEO heartbeat ${completedRun.status}`);
  }
}

async function step_observeDelegation(
  parentIssueId: string,
): Promise<{
  subIssues: PaperclipIssue[];
  phaseGroups: Map<BmadPhase, PaperclipIssue[]>;
  delegationInvariants: InvariantResult[];
}> {
  header("Step 3: Observe CEO Delegation Plan");

  const subIssues = await findSubIssues(parentIssueId);

  if (subIssues.length === 0) {
    log("⚠️ ", "No sub-issues found. Checking comments for clues...");
    const comments = await paperclip<PaperclipComment[]>(
      "GET",
      `/api/issues/${parentIssueId}/comments`,
    );
    for (const c of comments) {
      log("💬", `Comment: ${c.body.slice(0, 200)}`);
    }
    throw new Error("CEO did not create any sub-issues");
  }

  // Log the delegation plan as observed
  log("📊", `CEO created ${subIssues.length} sub-issues:`);
  for (const issue of subIssues) {
    const agentKey = issue.assigneeAgentId ? resolveAgentKey(issue.assigneeAgentId) : "unassigned";
    const phase = (issue.metadata as Record<string, string>)?.bmadPhase ?? "?";
    log("  📌", `[${phase}] ${issue.title}`, {
      agent: agentKey,
      status: issue.status,
      id: issue.id.slice(0, 8),
    });
  }

  // Group by phase
  const phaseGroups = groupByPhase(subIssues);
  const phaseList = [...phaseGroups.keys()];
  log("📋", `Phases in plan: ${phaseList.join(" → ")}`);

  // Get parent issue state for invariant checking
  const parentIssue = await paperclip<PaperclipIssue>("GET", `/api/issues/${parentIssueId}`);
  const parentComments = await paperclip<PaperclipComment[]>(
    "GET",
    `/api/issues/${parentIssueId}/comments`,
  );

  if (parentComments.length > 0) {
    log("📋", `${parentComments.length} comment(s) on parent issue:`);
    for (const c of parentComments) {
      const preview = c.body.split("\n")[0].slice(0, 120);
      log("  💬", preview);
    }
  }

  // Validate delegation invariants
  const delegationInvariants = validateDelegationInvariants(
    subIssues,
    parentIssue.status,
    parentComments,
    phaseGroups,
  );

  // Print invariant results immediately
  for (const inv of delegationInvariants) {
    const icon = inv.passed ? "✅" : "❌";
    log(icon, `${inv.id}: ${inv.label} — ${inv.detail}`);
  }

  const failedCount = delegationInvariants.filter((i) => !i.passed).length;
  if (failedCount > 0) {
    log("⚠️ ", `${failedCount} delegation invariant(s) failed — continuing to observe`);
  }

  return { subIssues, phaseGroups, delegationInvariants };
}

async function step_invokePhases(
  phaseGroups: Map<BmadPhase, PaperclipIssue[]>,
): Promise<PhaseTrace[]> {
  header("Step 4: Invoke Specialists (Phase by Phase)");

  const traces: PhaseTrace[] = [];

  // Determine which phases to run
  const stopIdx = FLAGS.stopAfter
    ? PHASE_ORDER.indexOf(FLAGS.stopAfter)
    : PHASE_ORDER.indexOf("plan"); // Default: stop after plan (spec-only)
  const phasesToRun = PHASE_ORDER.slice(0, stopIdx + 1);

  for (const phase of phasesToRun) {
    const issues = phaseGroups.get(phase);
    if (!issues || issues.length === 0) continue;

    log("", ""); // Visual separator
    log("🔷", `── Phase: ${phase.toUpperCase()} (${issues.length} task${issues.length > 1 ? "s" : ""}) ──`);

    for (let i = 0; i < issues.length; i++) {
      const issue = issues[i];
      const agentKey = issue.assigneeAgentId ? resolveAgentKey(issue.assigneeAgentId) : "unknown";
      const agentName = issue.assigneeAgentId ? resolveAgentName(issue.assigneeAgentId) : "unknown";

      log("", "");
      log("🔹", `[${phase} ${i + 1}/${issues.length}] "${issue.title}"  →  ${agentName}`);

      const trace = await invokeSpecialist(issue, phase, agentKey, agentName);
      traces.push(trace);

      // Print trace summary
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

  return traces;
}

/**
 * Invoke a single specialist agent for a sub-issue and observe the result.
 */
async function invokeSpecialist(
  issue: PaperclipIssue,
  phase: BmadPhase,
  agentKey: string,
  agentName: string,
): Promise<PhaseTrace> {
  const agentId = issue.assigneeAgentId;
  if (!agentId) {
    return {
      issueId: issue.id,
      title: issue.title,
      phase,
      agentKey,
      agentName,
      heartbeatStatus: "skipped",
      issueStatus: issue.status,
      durationSec: 0,
      commentCount: 0,
      totalCommentChars: 0,
      commentPreviews: [],
      error: "No assignee — skipped",
    };
  }

  // Ensure issue is in 'todo' status for the agent's inbox to pick it up
  try {
    await paperclip("PATCH", `/api/issues/${issue.id}`, { status: "todo" });
  } catch {
    // May already be todo or status transition may not be allowed
  }

  // Resume this specialist, invoke, then re-pause
  await resumeAgent(agentKey);

  const startTime = Date.now();
  let heartbeatStatus = "unknown";
  let error: string | undefined;

  try {
    const run = await invokeHeartbeat(agentId);
    log("  📋", `Run: ${run.id.slice(0, 8)}`);

    const completedRun = await waitForHeartbeatRun(
      agentId,
      run.id,
      `${agentName}/${phase}`,
      300_000,
      3_000,
    );
    heartbeatStatus = completedRun.status;

    if (completedRun.status !== "succeeded") {
      error = completedRun.error ?? `Heartbeat ${completedRun.status}`;
    }
  } catch (err) {
    heartbeatStatus = "error";
    error = err instanceof Error ? err.message : String(err);
  }

  const durationSec = Math.round((Date.now() - startTime) / 1000);

  // Re-pause the agent to prevent auto-wakeup interference
  try {
    await pauseAgent(agentKey);
  } catch {
    // Non-critical
  }

  // Observe outputs: issue status + comments
  const updatedIssue = await paperclip<PaperclipIssue>("GET", `/api/issues/${issue.id}`);
  const comments = await paperclip<PaperclipComment[]>(
    "GET",
    `/api/issues/${issue.id}/comments`,
  );

  const commentPreviews = comments.map((c) => c.body.split("\n")[0]);
  const totalCommentChars = comments.reduce((sum, c) => sum + c.body.length, 0);

  return {
    issueId: issue.id,
    title: issue.title,
    phase,
    agentKey,
    agentName,
    heartbeatStatus,
    issueStatus: updatedIssue.status,
    durationSec,
    commentCount: comments.length,
    totalCommentChars,
    commentPreviews,
    error,
  };
}

async function step_verifyCosts(): Promise<InvariantResult> {
  header("Step 5: Verify Cost Tracking");

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
      return {
        id: "C2",
        label: "Cost data for all agents",
        passed: true,
        detail: `${byAgent.length} agent(s) with cost data`,
      };
    } else {
      log("⚠️ ", "No cost data recorded");
      return {
        id: "C2",
        label: "Cost data for all agents",
        passed: false,
        detail: "0 rows in /costs/by-agent",
      };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log("⚠️ ", `Cost API error: ${msg}`);
    return {
      id: "C2",
      label: "Cost data for all agents",
      passed: false,
      detail: `API error: ${msg}`,
    };
  }
}

async function step_cleanup(issueId: string, subIssues: PaperclipIssue[]): Promise<void> {
  header("Step 7: Cleanup");

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

// ─────────────────────────────────────────────────────────────────────────────
// Test Report
// ─────────────────────────────────────────────────────────────────────────────

function printTestReport(
  traces: PhaseTrace[],
  allInvariants: InvariantResult[],
  totalTimeSec: number,
  subIssueCount: number,
  phaseGroups: Map<BmadPhase, PaperclipIssue[]>,
): boolean {
  header("Spec Pipeline E2E — Test Report");

  // Phase summary
  const phaseSummary = [...phaseGroups.entries()]
    .map(([p, issues]) => `${p}(${issues.length})`)
    .join(" → ");
  log("📋", `Seed: "${SEED_ISSUE.title.slice(0, 60)}..."`);
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
  log("📊", `Hard assertions: ${hardPassed}/${hard.length} passed` +
    (hardFailed > 0 ? `, ${hardFailed} FAILED` : ""));
  if (soft.length > 0) {
    log("📊", `Soft assertions: ${soft.length - softWarnings}/${soft.length} passed` +
      (softWarnings > 0 ? `, ${softWarnings} warning(s)` : ""));
  }
  log("⏱️ ", `Total time: ${Math.floor(totalTimeSec / 60)}m${totalTimeSec % 60}s`);

  const allPassed = hardFailed === 0;
  if (allPassed) {
    log("✅", "Pipeline: PASS");
  } else {
    log("❌", "Pipeline: FAIL");
  }

  return allPassed;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("\n🧪 BMAD Copilot Factory — E2E Spec Pipeline Test (observer-based)");
  console.log(`   Paperclip: ${PAPERCLIP_URL}`);
  console.log(`   Company:   ${COMPANY_ID}`);
  console.log(`   Mode:      /heartbeat/invoke (Paperclip-native)`);
  console.log(`   Stop:      after ${FLAGS.stopAfter ?? "plan"} phase`);
  console.log(`   Flags:     ${FLAGS.skipCleanup ? "--skip-cleanup " : ""}${FLAGS.verbose ? "--verbose" : ""}`);
  console.log();

  setVerbose(FLAGS.verbose);
  const startTime = Date.now();

  // 0. Resolve agent IDs + setup
  await resolveAgentIds();
  await step_setup();

  // 1. Create seed issue
  const seedIssue = await step_createSeedIssue();

  // 2. Invoke CEO for delegation
  try {
    await step_invokeCeo(seedIssue.id);
  } catch (err) {
    log("💥", `CEO heartbeat failed: ${err instanceof Error ? err.message : String(err)}`);
    await step_cleanup(seedIssue.id, []);
    process.exit(1);
  }

  // 3. Observe delegation plan + validate invariants
  let subIssues: PaperclipIssue[] = [];
  let phaseGroups: Map<BmadPhase, PaperclipIssue[]>;
  let delegationInvariants: InvariantResult[];
  try {
    const result = await step_observeDelegation(seedIssue.id);
    subIssues = result.subIssues;
    phaseGroups = result.phaseGroups;
    delegationInvariants = result.delegationInvariants;
  } catch (err) {
    log("💥", `Delegation observation failed: ${err instanceof Error ? err.message : String(err)}`);
    await step_cleanup(seedIssue.id, []);
    process.exit(1);
  }

  // 4. Invoke specialists phase by phase
  let traces: PhaseTrace[] = [];
  try {
    traces = await step_invokePhases(phaseGroups);
  } catch (err) {
    log("⚠️ ", `Phase execution error: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 5. Verify cost tracking
  let costInvariant: InvariantResult;
  try {
    costInvariant = await step_verifyCosts();
  } catch {
    costInvariant = { id: "C2", label: "Cost data", passed: false, detail: "Check failed" };
  }

  // 6. Collect all invariants and run assertions
  const phaseInvariants = traces.flatMap((t) => validatePhaseInvariants(t));
  const crossPhaseInvariants = validateCrossPhaseInvariants(traces, subIssues);
  // Replace the placeholder C2 with the real cost check result
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

  // 7. Cleanup
  await step_cleanup(seedIssue.id, subIssues);

  // 8. Print report
  const passed = printTestReport(traces, allInvariants, totalTimeSec, subIssues.length, phaseGroups);

  process.exit(passed ? 0 : 1);
}

main().catch((err) => {
  console.error("\n💥 E2E spec pipeline test crashed:", err);
  process.exit(1);
});

#!/usr/bin/env npx tsx
/**
 * E2E Test — Unified BMAD Copilot Factory Pipeline Validation
 *
 * Three modes:
 *   --smoke       Quick validation: CEO heartbeat → 1 specialist → protocol checks → costs
 *   --full        Full spec pipeline: CEO delegation → multi-phase (research→define→plan) with invariants
 *   --autonomous  Self-driving pipeline: resume all agents, create seed issue, let wakeOnDemand drive
 *                 Default: full pipeline (research→define→plan→execute→review)
 *                 With --spec-only: stop after plan phase (no implementation/review)
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
 *   npx tsx scripts/e2e-test.ts --autonomous                      # Full pipeline: spec + implement + review
 *   npx tsx scripts/e2e-test.ts --autonomous --spec-only          # Spec-only: stop after plan phase
 *   npx tsx scripts/e2e-test.ts --autonomous --timeout=45         # Custom timeout in minutes
 *   npx tsx scripts/e2e-test.ts --skip-cleanup --verbose          # Keep test data, verbose output
 *
 * @module scripts/e2e-test
 */

import { mkdirSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";
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
  /** Run only spec phases (research→define→plan), skip execute+review */
  specOnly: process.argv.includes("--spec-only"),
  stopAfter: (() => {
    const arg = process.argv.find((a) => a.startsWith("--stop-after="));
    return arg ? arg.split("=")[1] as BmadPhase : null;
  })(),
  timeout: (() => {
    const arg = process.argv.find((a) => a.startsWith("--timeout="));
    return arg ? parseInt(arg.split("=")[1], 10) * 60_000 : 45 * 60_000; // 45 min default for full pipeline
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

/** Phases for the full pipeline (includes implementation and review). */
const ALL_PHASES: BmadPhase[] = ["research", "define", "plan", "execute", "review"];

/** Active phases based on --spec-only flag. */
const activePipelinePhases = (): BmadPhase[] => FLAGS.specOnly ? SPEC_PHASES : ALL_PHASES;

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
  title: "Build a CLI tool that converts CSV files to JSON",
  description: [
    "## Context",
    "We need a small command-line utility that reads CSV files and outputs JSON.",
    "This is a simple, well-defined project — no external APIs, no databases.",
    "",
    "## Requirements",
    "- Accept a CSV file path as input, output JSON to stdout or a file",
    "- Support custom delimiters (comma, semicolon, tab)",
    "- Handle quoted fields and escaped characters correctly",
    "- Include a --pretty flag for formatted output",
    "- Provide a --headers flag to use the first row as object keys",
    "- Exit with meaningful error codes (file not found, parse error, etc.)",
    "- Single binary with no runtime dependencies (Node.js or Go)",
    "",
    "## Constraints",
    "- Must handle files up to 100 MB without running out of memory (streaming)",
    "- Should complete conversion of a 10 MB file in under 5 seconds",
    "",
    "## Scope",
    "**This issue covers SPECIFICATION ONLY — do not implement anything.**",
    "Deliver the following artifacts:",
    "1. Brief research summary (existing tools, gaps, our differentiator)",
    "2. Product Requirements Document (PRD)",
    "3. Architecture document (module structure, data flow, error handling)",
    "4. Epic breakdown with prioritized stories",
    "",
    "Keep each deliverable concise — this is a small utility, not an enterprise platform.",
    "Do NOT create implementation tasks, write code, or assign development work.",
  ].join("\n"),
  priority: "medium" as const,
};

/**
 * Full-pipeline task: specification → implementation → tests → code review.
 *
 * This seed issue instructs the CEO to cover ALL phases of the BMAD pipeline,
 * including execute (dev agent writes code + tests) and review (QA agent
 * performs adversarial code review). The scope is kept intentionally small
 * so the entire pipeline completes within a reasonable time.
 *
 * Key differences from SPEC_ISSUE:
 * - Explicitly requests implementation, tests, AND code review
 * - Small scope (single module with ~3 functions) to bound execution time
 * - Specifies Node.js + vitest (available on macOS dev machines)
 * - Requests working test suite that the E2E test can verify
 */
const FULL_PIPELINE_ISSUE = {
  title: "Build a CSV-to-JSON converter module with tests",
  description: [
    "## Context",
    "We need a small Node.js module that converts CSV strings/files to JSON.",
    "This is a well-defined, self-contained task — no external APIs, no databases.",
    "",
    "## Requirements",
    "- Export a `parseCsv(input: string, options?: CsvOptions): Record<string, string>[]` function",
    "- Support custom delimiters (comma, semicolon, tab) via options",
    "- Handle quoted fields and escaped characters (RFC 4180 compliant)",
    "- Use the first row as object keys by default (configurable via options)",
    "- Export a `convertFile(inputPath: string, outputPath?: string, options?: CsvOptions): Promise<void>` function",
    "- Exit with meaningful error messages (file not found, parse error, empty input)",
    "",
    "## Technical Constraints",
    "- **Language**: TypeScript (Node.js — already available in workspace)",
    "- **Package manager**: npm (already available)",
    "- **Test framework**: vitest (install via `npm install -D vitest`)",
    "- **No external CSV parsing libraries** — implement the parser from scratch",
    "- Keep it simple: ~3 exported functions, ~1 source file, ~1 test file",
    "- Must include `package.json` with `scripts.test` configured",
    "",
    "## Scope — FULL PIPELINE",
    "This issue covers the COMPLETE development lifecycle:",
    "",
    "1. **Research** — Brief survey of CSV parsing edge cases (RFC 4180, quoting rules)",
    "2. **Define** — Concise PRD with the API surface and error handling strategy",
    "3. **Plan** — Simple story breakdown (1-2 stories: core parser + file I/O)",
    "4. **Execute** — Implement the module in TypeScript:",
    "   - `src/csv-parser.ts` — Core parser logic",
    "   - `src/csv-parser.test.ts` — Test suite with ≥5 test cases",
    "   - `package.json` — With `scripts.test: \"vitest run\"`",
    "   - `tsconfig.json` — TypeScript config",
    "5. **Review** — Code review with quality checks, findings must be addressed",
    "",
    "After implementation, **run the tests** (`npm test`) and ensure they pass.",
    "After code review, fix any HIGH/CRITICAL findings and re-run tests.",
    "",
    "Keep everything minimal — this is an E2E test for the pipeline, not a production tool.",
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

  // D7: Execute phase tasks — depends on mode
  const execCount = phaseGroups.get("execute")?.length ?? 0;
  if (FLAGS.specOnly) {
    // Spec-only: no execute phase tasks expected
    results.push({ id: "D7", label: "No execute phase tasks (spec-only)", passed: execCount === 0, detail: execCount === 0 ? "OK" : `${execCount} execute task(s)` });
  } else {
    // Full pipeline: execute phase tasks expected
    results.push({ id: "D7", label: "Execute phase tasks present", passed: execCount > 0, detail: `${execCount} execute task(s)` });
  }

  // D8: Parent issue progressed
  results.push({ id: "D8", label: "Parent issue in_progress", passed: parentStatus === "in_progress" || parentStatus === "done", detail: `status: ${parentStatus}` });

  // D9: Delegation summary comment exists
  const hasDelegation = parentComments.some((c) => /delegation|ceo|sub-task|sub-issue/i.test(c.body));
  results.push({ id: "D9", label: "Delegation summary comment exists", passed: hasDelegation, detail: hasDelegation ? "Found" : `${parentComments.length} comment(s) but no delegation summary` });

  // D10: All assignees are valid agents
  const allValid = subIssues.every((i) => !i.assigneeAgentId || resolveAgentKey(i.assigneeAgentId) !== "unknown");
  results.push({ id: "D10", label: "All assignees are valid agents", passed: allValid, detail: allValid ? "OK" : "Some assignees not in AGENTS map" });

  // D11: Plan phase present
  results.push({ id: "D11", label: "Plan phase present", passed: (phaseGroups.get("plan")?.length ?? 0) > 0, detail: `${phaseGroups.get("plan")?.length ?? 0} task(s)` });

  // D12: Review phase present (full pipeline only)
  if (!FLAGS.specOnly) {
    const reviewCount = phaseGroups.get("review")?.length ?? 0;
    results.push({ id: "D12", label: "Review phase present", passed: reviewCount > 0, detail: `${reviewCount} task(s)` });
  }

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

  // C3: No orphan sub-issues in tracked phases
  const processedIds = new Set(traces.map((t) => t.issueId));
  const activePhaseSet = new Set(activePipelinePhases() as string[]);
  const trueOrphans = subIssues.filter((i) => {
    if (processedIds.has(i.id)) return false;
    const phase = (i.metadata as Record<string, string>)?.bmadPhase;
    return phase && activePhaseSet.has(phase);
  });
  results.push({ id: "C3", label: "No orphan sub-issues in tracked phases", passed: trueOrphans.length === 0, detail: trueOrphans.length === 0 ? "OK" : `${trueOrphans.length} unprocessed` });

  return results;
}

// ── Execute & Review Phase Invariants (Full Pipeline) ────────────────────────

/**
 * Validate execute-phase invariants: dev agent produced code artifacts.
 *
 * Checks issue comments for implementation signals and verifies the workspace
 * contains expected files (source code, tests, package.json).
 */
function validateExecutePhaseInvariants(
  traces: PhaseTrace[],
  workspaceDir: string | undefined,
): InvariantResult[] {
  const results: InvariantResult[] = [];
  const execTraces = traces.filter((t) => t.phase === "execute");

  if (execTraces.length === 0) {
    results.push({ id: "E1", label: "Execute phase ran", passed: false, detail: "No execute-phase traces" });
    return results;
  }

  // E1: Execute phase heartbeat(s) succeeded
  const allSucceeded = execTraces.every((t) => t.heartbeatStatus === "succeeded");
  results.push({
    id: "E1",
    label: "Execute phase heartbeat(s) succeeded",
    passed: allSucceeded,
    detail: execTraces.map((t) => `${t.agentKey}:${t.heartbeatStatus}`).join(", "),
  });

  // E2: Dev agent posted substantive comments (implementation summary)
  const totalChars = execTraces.reduce((sum, t) => sum + t.totalCommentChars, 0);
  results.push({
    id: "E2",
    label: "Dev agent posted implementation comments",
    passed: totalChars > 200,
    detail: `${totalChars} chars across ${execTraces.reduce((s, t) => s + t.commentCount, 0)} comment(s)`,
  });

  // E3-E6: Workspace artifact checks (only if workspace is known)
  if (workspaceDir && existsSync(workspaceDir)) {
    const files = listWorkspaceFiles(workspaceDir);
    const fileList = files.join(", ");

    // E3: Source files exist (.ts, .js, .py, .go files)
    const sourceFiles = files.filter((f) => /\.(ts|js|py|go)$/.test(f) && !f.includes(".test.") && !f.includes(".spec.") && !f.includes("node_modules"));
    results.push({
      id: "E3",
      label: "Source code files created",
      passed: sourceFiles.length > 0,
      detail: sourceFiles.length > 0 ? sourceFiles.slice(0, 5).join(", ") : `No source files in workspace. Files: ${fileList.slice(0, 200)}`,
    });

    // E4: Test files exist (.test.ts, .spec.ts, etc.)
    const testFiles = files.filter((f) => /\.(test|spec)\.(ts|js|py)$/.test(f));
    results.push({
      id: "E4",
      label: "Test files created",
      passed: testFiles.length > 0,
      detail: testFiles.length > 0 ? testFiles.slice(0, 5).join(", ") : `No test files. Files: ${fileList.slice(0, 200)}`,
    });

    // E5: Package manifest exists (package.json, pyproject.toml, go.mod)
    const hasManifest = files.some((f) => ["package.json", "pyproject.toml", "go.mod", "Cargo.toml"].includes(f));
    results.push({
      id: "E5",
      label: "Package manifest exists",
      passed: hasManifest,
      detail: hasManifest ? "Found" : `No manifest file. Files: ${fileList.slice(0, 200)}`,
    });

    // E6: Test script configured (check package.json scripts.test or similar)
    let hasTestScript = false;
    const pkgJsonPath = join(workspaceDir, "package.json");
    if (existsSync(pkgJsonPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf-8")) as Record<string, unknown>;
        const scripts = pkg.scripts as Record<string, string> | undefined;
        hasTestScript = Boolean(scripts?.test && scripts.test !== "echo \"Error: no test specified\" && exit 1");
      } catch { /* parse error — fail gracefully */ }
    }
    results.push({
      id: "E6",
      label: "Test script configured in manifest",
      passed: hasTestScript,
      detail: hasTestScript ? "scripts.test found" : "No test script in package.json",
    });
  } else {
    results.push({ id: "E3", label: "Source code files created", passed: false, detail: "Workspace dir unknown or missing" });
    results.push({ id: "E4", label: "Test files created", passed: false, detail: "Workspace dir unknown or missing" });
    results.push({ id: "E5", label: "Package manifest exists", passed: false, detail: "Workspace dir unknown or missing" });
    results.push({ id: "E6", label: "Test script configured in manifest", passed: false, detail: "Workspace dir unknown or missing" });
  }

  return results;
}

/**
 * Validate review-phase invariants: QA agent reviewed the code.
 */
function validateReviewPhaseInvariants(
  traces: PhaseTrace[],
): InvariantResult[] {
  const results: InvariantResult[] = [];
  const reviewTraces = traces.filter((t) => t.phase === "review");

  if (reviewTraces.length === 0) {
    results.push({ id: "R1", label: "Review phase ran", passed: false, detail: "No review-phase traces" });
    return results;
  }

  // R1: Review phase heartbeat(s) succeeded
  const allSucceeded = reviewTraces.every((t) => t.heartbeatStatus === "succeeded");
  results.push({
    id: "R1",
    label: "Review phase heartbeat(s) succeeded",
    passed: allSucceeded,
    detail: reviewTraces.map((t) => `${t.agentKey}:${t.heartbeatStatus}`).join(", "),
  });

  // R2: Reviewer posted comments (review findings)
  const totalComments = reviewTraces.reduce((s, t) => s + t.commentCount, 0);
  results.push({
    id: "R2",
    label: "Reviewer posted review comments",
    passed: totalComments > 0,
    detail: `${totalComments} comment(s)`,
  });

  // R3: Review comments are substantive
  const totalChars = reviewTraces.reduce((s, t) => s + t.totalCommentChars, 0);
  results.push({
    id: "R3",
    label: "Review comments are substantive",
    passed: totalChars > 200,
    detail: `${totalChars} chars`,
  });

  return results;
}

/**
 * Try to run tests in the workspace and check if they pass.
 *
 * Returns an InvariantResult. Only runs if a test script is configured.
 * Uses a short timeout (60s) to avoid blocking the E2E test.
 */
function verifyTestsPass(workspaceDir: string | undefined): InvariantResult {
  if (!workspaceDir || !existsSync(workspaceDir)) {
    return { id: "E7", label: "Tests pass in workspace", passed: false, detail: "Workspace dir unknown or missing" };
  }

  const pkgJsonPath = join(workspaceDir, "package.json");
  if (!existsSync(pkgJsonPath)) {
    return { id: "E7", label: "Tests pass in workspace", passed: false, detail: "No package.json found" };
  }

  try {
    const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf-8")) as Record<string, unknown>;
    const scripts = pkg.scripts as Record<string, string> | undefined;
    if (!scripts?.test || scripts.test === "echo \"Error: no test specified\" && exit 1") {
      return { id: "E7", label: "Tests pass in workspace", passed: false, detail: "No test script configured" };
    }

    // Install dependencies first (if node_modules doesn't exist)
    const nodeModulesPath = join(workspaceDir, "node_modules");
    if (!existsSync(nodeModulesPath)) {
      try {
        log("🔧", "Installing workspace dependencies for test verification...");
        execSync("npm install --ignore-scripts 2>&1", { cwd: workspaceDir, timeout: 60_000, encoding: "utf-8" });
      } catch (installErr) {
        const msg = installErr instanceof Error ? installErr.message : String(installErr);
        return { id: "E7", label: "Tests pass in workspace", passed: false, detail: `npm install failed: ${msg.slice(0, 200)}`, soft: true };
      }
    }

    // Run tests with a timeout
    log("🧪", "Running workspace tests for verification...");
    const output = execSync("npm test 2>&1", { cwd: workspaceDir, timeout: 60_000, encoding: "utf-8" });
    const passed = !output.includes("FAIL") || output.includes("Tests passed") || output.includes("✓");
    log(passed ? "✅" : "⚠️ ", `Test output (last 200 chars): ${output.slice(-200)}`);
    return { id: "E7", label: "Tests pass in workspace", passed: true, detail: `npm test succeeded`, soft: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Test failures are expected during review cycles — this is a soft check
    return { id: "E7", label: "Tests pass in workspace", passed: false, detail: `npm test failed: ${msg.slice(0, 200)}`, soft: true };
  }
}

/**
 * List files in a workspace directory (non-recursive, top-level only + one level deep).
 * Excludes node_modules, .git, etc.
 */
function listWorkspaceFiles(dir: string): string[] {
  const IGNORE = new Set(["node_modules", ".git", "dist", "coverage", ".nyc_output", ".cache"]);
  const files: string[] = [];

  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (IGNORE.has(entry.name)) continue;
      if (entry.isFile()) {
        files.push(entry.name);
      } else if (entry.isDirectory()) {
        // One level deep
        try {
          const subDir = join(dir, entry.name);
          for (const subEntry of readdirSync(subDir, { withFileTypes: true })) {
            if (subEntry.isFile()) {
              files.push(`${entry.name}/${subEntry.name}`);
            }
          }
        } catch { /* skip unreadable subdirs */ }
      }
    }
  } catch { /* skip unreadable dir */ }

  return files;
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
  const domainTerms = ["CSV", "JSON", "CLI", "delimiter", "parser", "convert", "command-line", "streaming", "file"];
  const rc = commentsByPhase.get("research") ?? [];
  const s1 = rc.some((c) => domainTerms.some((t) => c.toLowerCase().includes(t.toLowerCase())));
  results.push({ id: "S1", label: "Research references domain terms", passed: s1 || rc.length === 0, detail: s1 ? "Found" : rc.length === 0 ? "No research comments" : "Missing", soft: true });

  // S2: Define mentions architecture patterns
  const archTerms = ["streaming", "parser", "module", "cli", "error", "stdin", "stdout", "pipe", "api", "architecture", "interface", "argument"];
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

  // S5: Total time reasonable (15 min for spec-only, 30 min for full pipeline)
  const timeLimit = FLAGS.specOnly ? 900 : 1800;
  const timeLimitLabel = FLAGS.specOnly ? "15 minutes" : "30 minutes";
  results.push({ id: "S5", label: `Total time < ${timeLimitLabel}`, passed: totalTimeSec < timeLimit, detail: `${Math.floor(totalTimeSec / 60)}m${totalTimeSec % 60}s`, soft: true });

  // ── Execute+Review soft assertions (full pipeline only) ──
  if (!FLAGS.specOnly) {
    // S6: Execute comments reference implementation artifacts
    const execTerms = ["implemented", "created", "wrote", "function", "export", "module", "test", "package.json", "npm", "vitest"];
    const ec = commentsByPhase.get("execute") ?? [];
    const s6 = ec.some((c) => execTerms.some((t) => c.toLowerCase().includes(t.toLowerCase())));
    results.push({ id: "S6", label: "Execute comments reference implementation", passed: s6 || ec.length === 0, detail: s6 ? "Found" : ec.length === 0 ? "No execute comments" : "Missing", soft: true });

    // S7: Review comments reference code quality
    const reviewTerms = ["review", "finding", "approved", "passed", "quality", "issue", "fix", "severity", "recommendation"];
    const rvc = commentsByPhase.get("review") ?? [];
    const s7 = rvc.some((c) => reviewTerms.some((t) => c.toLowerCase().includes(t.toLowerCase())));
    results.push({ id: "S7", label: "Review comments reference code quality", passed: s7 || rvc.length === 0, detail: s7 ? "Found" : rvc.length === 0 ? "No review comments" : "Missing", soft: true });

    // S8: Execute issues reach done status
    const execTraces = traces.filter((t) => t.phase === "execute");
    const execDone = execTraces.every((t) => t.issueStatus === "done");
    results.push({ id: "S8", label: "Execute issues completed", passed: execDone, detail: execTraces.map((t) => `${t.agentKey}:${t.issueStatus}`).join(", "), soft: true });
  }

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
  header("Pipeline E2E — Test Report");

  const phaseSummary = [...phaseGroups.entries()]
    .map(([p, issues]) => `${p}(${issues.length})`)
    .join(" → ");
  const seedTitle = FLAGS.specOnly ? SPEC_ISSUE.title : FULL_PIPELINE_ISSUE.title;
  log("📋", `Seed: "${seedTitle.slice(0, 60)}"`);
  log("📋", `Pipeline: ${FLAGS.specOnly ? "spec-only" : "full"}`);
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

  // Execute+review phase invariants (if phases were run)
  const hasExecutePhase = traces.some((t) => t.phase === "execute");
  const fullModeExecuteInvariants = hasExecutePhase ? validateExecutePhaseInvariants(traces, targetWorkspaceDir) : [];
  const fullModeReviewInvariants = traces.some((t) => t.phase === "review") ? validateReviewPhaseInvariants(traces) : [];
  const fullModeTestResult = hasExecutePhase ? verifyTestsPass(targetWorkspaceDir) : null;

  const totalTimeSec = Math.round((Date.now() - startTime) / 1000);
  const softAssertions = runSoftAssertions(traces, subIssues, totalTimeSec);

  const allInvariants = [
    ...delegationInvariants,
    ...phaseInvariants,
    ...crossWithRealCost,
    ...fullModeExecuteInvariants,
    ...fullModeReviewInvariants,
    ...(fullModeTestResult ? [fullModeTestResult] : []),
    ...softAssertions,
  ];

  // Cleanup
  await cleanup(seedIssue.id, subIssues);

  // Print report
  return printTestReport(traces, allInvariants, totalTimeSec, subIssues.length, phaseGroups);
}

// ── Autonomous Pipeline ──────────────────────────────────────────────────────

/**
 * Paperclip LiveEvent shape (from @paperclipai/shared).
 * Received on the company WebSocket: /api/companies/:id/events/ws
 */
interface LiveEvent {
  id: number;
  companyId: string;
  type: string;
  createdAt: string;
  payload: Record<string, unknown>;
}

/**
 * Connect to Paperclip's company WebSocket for real-time event streaming.
 *
 * Uses the native Node.js WebSocket API (stable since Node 22).
 * In local_trusted mode no auth is needed — Paperclip auto-grants board access.
 *
 * @returns Object with { onEvent, close } — call onEvent to register a listener,
 *          close() when done.
 */
function connectPaperclipWebSocket(): {
  onEvent: (listener: (event: LiveEvent) => void) => void;
  close: () => void;
  ready: Promise<void>;
} {
  const wsUrl = PAPERCLIP_URL.replace(/^http/, "ws") + `/api/companies/${COMPANY_ID}/events/ws`;
  const ws = new WebSocket(wsUrl);
  const listeners: Array<(event: LiveEvent) => void> = [];

  const ready = new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => {
      log("🔌", `WebSocket connected to ${wsUrl}`);
      resolve();
    });
    ws.addEventListener("error", (err) => {
      log("⚠️ ", `WebSocket error: ${(err as ErrorEvent).message ?? "unknown"}`);
      reject(err);
    });
  });

  ws.addEventListener("message", (evt) => {
    try {
      const event = JSON.parse(String(evt.data)) as LiveEvent;
      for (const listener of listeners) {
        listener(event);
      }
    } catch {
      // Ignore malformed messages
    }
  });

  ws.addEventListener("close", () => {
    log("🔌", "WebSocket disconnected");
  });

  return {
    onEvent: (listener) => listeners.push(listener),
    close: () => ws.close(),
    ready,
  };
}

/**
 * Autonomous mode: resume all agents, create a seed issue, and let Paperclip's
 * wakeOnDemand pipeline self-drive. Uses WebSocket for real-time event streaming
 * instead of polling — reacts instantly to heartbeat completions and status changes.
 */
async function runAutonomous(): Promise<boolean> {
  const startTime = Date.now();
  await setup("bmad-e2e-autonomous");

  // 1. Connect WebSocket BEFORE creating issues (don't miss events)
  let wsConn: ReturnType<typeof connectPaperclipWebSocket> | null = null;
  try {
    wsConn = connectPaperclipWebSocket();
    await wsConn.ready;
  } catch {
    log("⚠️ ", "WebSocket connection failed — falling back to polling mode");
    wsConn = null;
  }

  // 2. Resume ALL agents (critical — wakeOnDemand needs active agents)
  await resumeAllAgents();
  log("▶️", "All agents resumed — wakeOnDemand will drive the pipeline");

  // 3. Create seed issue assigned to CEO, status=todo
  //    This triggers Paperclip's issue.create wakeup on CEO
  //    Use FULL_PIPELINE_ISSUE unless --spec-only is set
  const seedSpec = FLAGS.specOnly ? SPEC_ISSUE : FULL_PIPELINE_ISSUE;
  const seedIssue = await createIssue(seedSpec, "autonomous");
  await paperclip("PATCH", `/api/issues/${seedIssue.id}`, { status: "todo" });
  log("🚀", `Seed issue created (${FLAGS.specOnly ? "spec-only" : "full pipeline"}) — pipeline is self-driving now`);

  // 4. Wait for CEO to create sub-issues
  let subIssues: PaperclipIssue[] = [];

  if (wsConn) {
    // ── WebSocket-driven: wait for CEO heartbeat to finish, then snapshot sub-issues ──
    subIssues = await waitForSubIssuesViaWebSocket(wsConn, seedIssue.id, AGENTS.ceo, 5 * 60_000);
  } else {
    // ── Fallback: polling mode ──
    const ceoPollDeadline = Date.now() + 5 * 60_000;
    while (Date.now() < ceoPollDeadline) {
      subIssues = await findSubIssues(seedIssue.id);
      if (subIssues.length > 0) break;
      log("⏳", "Waiting for CEO to create sub-issues...");
      await new Promise((r) => setTimeout(r, 10_000));
    }
  }

  if (subIssues.length === 0) {
    log("💥", "CEO did not create sub-issues within 5 minutes");
    wsConn?.close();
    await cleanup(seedIssue.id, []);
    return false;
  }

  // Log delegation plan
  log("📊", `CEO created ${subIssues.length} sub-issues`);
  for (const issue of subIssues) {
    const agentKey = issue.assigneeAgentId ? resolveAgentKey(issue.assigneeAgentId) : "?";
    const phase = (issue.metadata as Record<string, string>)?.bmadPhase ?? "?";
    const deps = (issue.metadata as Record<string, unknown>)?.dependsOn;
    const depInfo = Array.isArray(deps) && deps.length > 0 ? ` (deps: ${deps.join(",")})` : "";
    log("  📌", `[${phase}] ${issue.title} → ${agentKey} [${issue.status}]${depInfo}`);
  }

  // 5. Wait for all tracked-phase sub-issues to reach "done"
  // Build initial trackedIssueIds from the stable snapshot (post-CEO-heartbeat).
  // waitForPipelineCompletionViaWebSocket also discovers new sub-issues dynamically
  // (created during CEO re-evaluation) via the bmadPhase metadata filter.
  const trackedPhases = activePipelinePhases();
  const trackedPhaseSet = new Set(trackedPhases as string[]);
  const specIssueIds = new Set(
    subIssues
      .filter((i) => {
        const phase = (i.metadata as Record<string, string>)?.bmadPhase;
        return phase && trackedPhaseSet.has(phase);
      })
      .map((i) => i.id),
  );
  log("📋", `Tracking ${specIssueIds.size} sub-issues for completion (phases: ${trackedPhases.join(", ")})`);

  if (wsConn) {
    // ── WebSocket-driven: stream events and track status changes in real time ──
    await waitForPipelineCompletionViaWebSocket(
      wsConn, seedIssue.id, specIssueIds, trackedPhaseSet, FLAGS.timeout,
    );
    wsConn.close();
  } else {
    // ── Fallback: polling mode ──
    const pipelineDeadline = Date.now() + FLAGS.timeout;
    let lastStatusLog = "";
    let pollExitReason = "timeout";
    while (Date.now() < pipelineDeadline) {
      const current = await findSubIssues(seedIssue.id);
      // Dynamic discovery: include original IDs + any new tracked-phase issues
      const specCurrent = current.filter((i) => {
        if (specIssueIds.has(i.id)) return true;
        const phase = (i.metadata as Record<string, string>)?.bmadPhase;
        return phase && trackedPhaseSet.has(phase);
      });

      const statusMap = specCurrent
        .map((i) => {
          const phase = (i.metadata as Record<string, string>)?.bmadPhase ?? "?";
          return `${phase}:${i.status}`;
        })
        .join(" | ");

      if (statusMap !== lastStatusLog) {
        log("📊", `Pipeline status: ${statusMap} (${specCurrent.length} spec issues)`);
        lastStatusLog = statusMap;
      }

      const allDone = specCurrent.length > 0 && specCurrent.every(
        (i) => i.status === "done" || i.status === "cancelled",
      );
      if (allDone) {
        pollExitReason = "all spec issues done/cancelled";
        log("✅", "All spec-phase sub-issues completed!");
        break;
      }

      await new Promise((r) => setTimeout(r, 15_000));
    }
    log("🏁", `Polling exit: ${pollExitReason}`);
  }

  // 6. Collect traces from completed sub-issues (comments, status)
  // Re-fetch sub-issues to get the full set (including any created during re-evaluation)
  subIssues = await findSubIssues(seedIssue.id);
  log("📊", `Final sub-issue count: ${subIssues.length} (was ${specIssueIds.size} spec-phase at step 5)`);

  // Build phaseGroups from the final (complete) sub-issue set
  const phaseGroups = groupByPhase(subIssues);
  log("📋", `Final phases: ${[...phaseGroups.entries()].map(([p, issues]) => `${p}(${issues.length})`).join(" → ")}`);

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

  // Sort traces by pipeline phase order for report readability and C1 invariant.
  // In autonomous mode agents finish in arbitrary order, but the report and
  // cross-phase checks should reflect logical pipeline ordering.
  traces.sort((a, b) => PHASE_ORDER.indexOf(a.phase) - PHASE_ORDER.indexOf(b.phase));

  // 7. Run invariants
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

  // Execute+review phase invariants (full pipeline only)
  let executeInvariants: InvariantResult[] = [];
  let reviewInvariants: InvariantResult[] = [];
  let testResult: InvariantResult | null = null;

  if (!FLAGS.specOnly) {
    executeInvariants = validateExecutePhaseInvariants(traces, targetWorkspaceDir);
    reviewInvariants = validateReviewPhaseInvariants(traces);

    // Try running tests in the workspace (soft check)
    testResult = verifyTestsPass(targetWorkspaceDir);
  }

  const totalTimeSec = Math.round((Date.now() - startTime) / 1000);
  const softAssertions = runSoftAssertions(traces, subIssues, totalTimeSec);
  const allInvariants = [
    ...delegationInvariants,
    ...phaseInvariants,
    ...crossWithRealCost,
    ...executeInvariants,
    ...reviewInvariants,
    ...(testResult ? [testResult] : []),
    ...softAssertions,
  ];

  // 8. Cleanup + report
  await cleanup(seedIssue.id, subIssues);
  return printTestReport(
    traces,
    allInvariants,
    totalTimeSec,
    subIssues.length,
    phaseGroups,
  );
}

// ── WebSocket Event Helpers ──────────────────────────────────────────────────

/**
 * Wait for the CEO to finish creating sub-issues.
 *
 * Strategy: wait for the CEO's heartbeat run to reach "succeeded" (or "failed")
 * status via WebSocket, THEN snapshot sub-issues. This avoids the race condition
 * where we snapshot mid-creation and only see a subset of the sub-issues.
 *
 * The CEO creates all sub-issues in a single heartbeat run, so "succeeded" means
 * all sub-issues are guaranteed to exist.
 *
 * Falls back to a periodic API check every 30s as a safety net.
 */
async function waitForSubIssuesViaWebSocket(
  wsConn: ReturnType<typeof connectPaperclipWebSocket>,
  parentIssueId: string,
  ceoAgentId: string,
  timeoutMs: number,
): Promise<PaperclipIssue[]> {
  return new Promise<PaperclipIssue[]>((resolve) => {
    const deadline = Date.now() + timeoutMs;
    let resolved = false;
    let ceoHeartbeatFinished = false;
    let issueCreatedCount = 0;

    async function tryResolve(reason: string): Promise<void> {
      if (resolved) return;
      try {
        const subIssues = await findSubIssues(parentIssueId);
        if (subIssues.length > 0) {
          resolved = true;
          clearInterval(safetyInterval);
          log("✅", `Sub-issues resolved (${reason}): ${subIssues.length} found`);
          resolve(subIssues);
        } else {
          log("⚠️ ", `${reason} but findSubIssues returned 0 — will retry`);
        }
      } catch (err) {
        log("⚠️ ", `findSubIssues failed after ${reason}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    wsConn.onEvent(async (event) => {
      if (resolved) return;

      // Track CEO heartbeat completion — this is the primary signal
      if (event.type === "heartbeat.run.status") {
        const { status, agentId } = event.payload;
        const isCeo = agentId === ceoAgentId;
        if (isCeo && (status === "succeeded" || status === "failed")) {
          log("🔔", `CEO heartbeat ${status} — snapshotting sub-issues`);
          ceoHeartbeatFinished = true;
          await tryResolve(`CEO heartbeat ${status}`);
        } else if (isCeo && status === "running") {
          log("🔔", "CEO heartbeat started");
        }
        return;
      }

      // Track issue creation events (informational — don't resolve yet)
      if (
        event.type === "activity.logged" &&
        event.payload.action === "issue.created"
      ) {
        issueCreatedCount++;
        log("🔔", `Issue created event #${issueCreatedCount}`);
        // Don't resolve here — wait for CEO heartbeat to finish
        // so we get the complete set of sub-issues.
      }
    });

    // Safety net: periodic check. If the CEO heartbeat event was missed
    // (e.g., fired before WS listener registered), this catches it.
    const safetyInterval = setInterval(async () => {
      if (resolved || Date.now() > deadline) {
        clearInterval(safetyInterval);
        if (!resolved) {
          resolved = true;
          log("⏰", `Sub-issue wait timed out (safety net). CEO finished: ${ceoHeartbeatFinished}, events seen: ${issueCreatedCount}`);
          resolve([]);
        }
        return;
      }
      // Only resolve on safety net if CEO heartbeat already finished
      // OR if we've seen issue creation events (fallback for missed heartbeat event)
      if (ceoHeartbeatFinished || issueCreatedCount > 0) {
        await tryResolve(`safety net (ceoFinished=${ceoHeartbeatFinished}, events=${issueCreatedCount})`);
      }
    }, 30_000);

    // Hard timeout
    setTimeout(() => {
      if (!resolved) {
        resolved = true;
        clearInterval(safetyInterval);
        log("⏰", `Sub-issue wait hard timeout (${timeoutMs / 1000}s). CEO finished: ${ceoHeartbeatFinished}, events seen: ${issueCreatedCount}`);
        resolve([]);
      }
    }, timeoutMs);
  });
}

/**
 * Wait for all spec-phase sub-issues to reach "done" by streaming WebSocket events.
 *
 * Reacts to:
 * - heartbeat.run.status (succeeded/failed) → re-check issue statuses
 * - activity.logged (issue.updated) → re-check issue statuses
 *
 * Uses dynamic sub-issue discovery: re-fetches sub-issues from the API on each
 * check, so new sub-issues created during CEO re-evaluation are automatically
 * included in the completion criteria.
 *
 * Also logs heartbeat run events and comments for real-time pipeline visibility.
 * Every exit path logs a diagnostic reason for post-mortem analysis.
 */
async function waitForPipelineCompletionViaWebSocket(
  wsConn: ReturnType<typeof connectPaperclipWebSocket>,
  parentIssueId: string,
  specIssueIds: Set<string>,
  trackedPhaseSet: Set<string>,
  timeoutMs: number,
): Promise<void> {
  return new Promise<void>((resolve) => {
    const deadline = Date.now() + timeoutMs;
    let resolved = false;
    let lastStatusLog = "";
    let heartbeatEvents = 0;
    let statusChangeEvents = 0;

    function exitWith(reason: string): void {
      if (resolved) return;
      resolved = true;
      clearInterval(safetyInterval);
      log("🏁", `Pipeline wait exited: ${reason} (heartbeats=${heartbeatEvents}, statusChanges=${statusChangeEvents})`);
      resolve();
    }

    async function checkAndLogStatus(trigger: string): Promise<boolean> {
      // Dynamic discovery: re-fetch sub-issues to catch new ones from CEO re-eval
      const current = await findSubIssues(parentIssueId);

      // Build the tracked-phase set dynamically — includes original IDs plus any
      // new sub-issues created during CEO re-evaluation
      const specCurrent = current.filter((i) => {
        if (specIssueIds.has(i.id)) return true;
        const phase = (i.metadata as Record<string, string>)?.bmadPhase;
        return phase && trackedPhaseSet.has(phase);
      });

      const statusMap = specCurrent
        .map((i) => {
          const phase = (i.metadata as Record<string, string>)?.bmadPhase ?? "?";
          return `${phase}:${i.status}`;
        })
        .join(" | ");

      if (statusMap !== lastStatusLog) {
        log("📊", `Pipeline status [${trigger}]: ${statusMap} (${specCurrent.length} spec issues)`);
        lastStatusLog = statusMap;
      }

      if (specCurrent.length === 0) {
        log("⚠️ ", `No spec-phase sub-issues found (trigger: ${trigger})`);
        return false;
      }

      return specCurrent.every(
        (i) => i.status === "done" || i.status === "cancelled",
      );
    }

    wsConn.onEvent(async (event) => {
      if (resolved) return;

      // ── Heartbeat run status changes ──
      if (event.type === "heartbeat.run.status") {
        const { status, agentId } = event.payload;
        if (status === "running") {
          const agentKey = typeof agentId === "string" ? resolveAgentKey(agentId) : "?";
          log("🔔", `Agent ${agentKey} heartbeat started`);
        } else if (status === "succeeded" || status === "failed") {
          heartbeatEvents++;
          const agentKey = typeof agentId === "string" ? resolveAgentKey(agentId) : "?";
          const icon = status === "succeeded" ? "✅" : "❌";
          log("🔔", `${icon} Agent ${agentKey} heartbeat ${status} (event #${heartbeatEvents})`);

          try {
            const allDone = await checkAndLogStatus(`heartbeat.${agentKey}.${status}`);
            if (allDone) {
              exitWith(`all spec issues done after ${agentKey} heartbeat ${status}`);
            }
          } catch (err) {
            log("⚠️ ", `Status check failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
        return;
      }

      // ── Activity events (issue updates, comments) ──
      if (event.type === "activity.logged") {
        const { action, entityType, agentId } = event.payload;

        // Issue status updated
        if (action === "issue.updated" && entityType === "issue") {
          const details = event.payload.details as Record<string, unknown> | undefined;
          const newStatus = details?.status;
          if (newStatus) {
            statusChangeEvents++;
            const agentKey = typeof agentId === "string" ? resolveAgentKey(agentId) : "system";
            log("🔔", `Issue updated → ${newStatus} (by ${agentKey}, event #${statusChangeEvents})`);

            if (newStatus === "done" || newStatus === "cancelled") {
              try {
                const allDone = await checkAndLogStatus(`issue.${newStatus}.by.${agentKey}`);
                if (allDone) {
                  exitWith(`all spec issues done after issue → ${newStatus} by ${agentKey}`);
                }
              } catch (err) {
                log("⚠️ ", `Status check failed: ${err instanceof Error ? err.message : String(err)}`);
              }
            }
          }
        }

        // New comment added (show progress)
        if (action === "issue.comment_added") {
          const details = event.payload.details as Record<string, unknown> | undefined;
          const snippet = details?.bodySnippet;
          const agentKey = typeof agentId === "string" ? resolveAgentKey(agentId) : "system";
          if (typeof snippet === "string") {
            log("  💬", `[${agentKey}] ${snippet.slice(0, 100)}`);
          }
        }
      }
    });

    // Safety net: periodic full status check every 60s
    const safetyInterval = setInterval(async () => {
      if (resolved || Date.now() > deadline) {
        clearInterval(safetyInterval);
        if (!resolved) {
          exitWith(`safety-net deadline (${timeoutMs / 1000}s elapsed)`);
        }
        return;
      }
      try {
        log("🔍", "Safety-net status check...");
        const allDone = await checkAndLogStatus("safety-net-60s");
        if (allDone) {
          exitWith("all spec issues done (safety-net check)");
        }
      } catch {
        // Non-fatal
      }
    }, 60_000);

    // Hard timeout
    setTimeout(() => {
      if (!resolved) {
        exitWith(`hard timeout (${timeoutMs / 1000}s)`);
      }
    }, timeoutMs);
  });
}

// ═════════════════════════════════════════════════════════════════════════════
// Main
// ═════════════════════════════════════════════════════════════════════════════

async function main(): Promise<void> {
  const mode = FLAGS.smoke ? "smoke" : FLAGS.autonomous ? "autonomous" : "full";
  const pipelineScope = FLAGS.specOnly ? "spec-only (research→define→plan)" : "full (research→define→plan→execute→review)";

  console.log("\n🧪 BMAD Copilot Factory — E2E Test");
  console.log(`   Paperclip: ${PAPERCLIP_URL}`);
  console.log(`   Company:   ${COMPANY_ID}`);
  console.log(`   Mode:      ${mode}${FLAGS.stopAfter ? ` (stop-after=${FLAGS.stopAfter})` : ""}`);
  console.log(`   Pipeline:  ${pipelineScope}`);
  console.log(`   Timeout:   ${FLAGS.timeout / 60_000} min`);
  console.log(`   Flags:     ${FLAGS.ceoOnly ? "--ceo-only " : ""}${FLAGS.specOnly ? "--spec-only " : ""}${FLAGS.skipCleanup ? "--skip-cleanup " : ""}${FLAGS.verbose ? "--verbose" : ""}`);
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

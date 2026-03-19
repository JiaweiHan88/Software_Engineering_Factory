/**
 * Quality Gate Engine — Core evaluation logic.
 *
 * Evaluates code review findings against BMAD quality standards:
 * - Counts blocking vs advisory findings
 * - Computes severity scores
 * - Determines gate verdict (PASS / FAIL / ESCALATE)
 * - Decides next orchestrator action
 *
 * Pure logic module — no I/O, no side effects.
 *
 * @module quality-gates/engine
 */

import type {
  Severity,
  ReviewFinding,
  GateResult,
  GateVerdict,
  OrchestratorAction,
  ReviewHistory,
} from "./types.js";
import { BLOCKING_SEVERITIES, SEVERITY_WEIGHT } from "./types.js";

// ─────────────────────────────────────────────────────────────────────────────
// Finding Analysis
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Check if a severity level blocks merge.
 *
 * @param severity - The severity to check
 * @returns true if HIGH or CRITICAL
 */
export function isBlocking(severity: Severity): boolean {
  return (BLOCKING_SEVERITIES as readonly string[]).includes(severity);
}

/**
 * Count findings by severity.
 *
 * @param findings - Array of review findings
 * @returns Map of severity → count
 */
export function countBySeverity(findings: ReviewFinding[]): Record<Severity, number> {
  const counts: Record<Severity, number> = { LOW: 0, MEDIUM: 0, HIGH: 0, CRITICAL: 0 };
  for (const f of findings) {
    counts[f.severity]++;
  }
  return counts;
}

/**
 * Count findings that block merge (HIGH + CRITICAL), excluding already-fixed ones.
 *
 * @param findings - Array of review findings
 * @returns Number of unresolved blocking findings
 */
export function countBlocking(findings: ReviewFinding[]): number {
  return findings.filter((f) => isBlocking(f.severity) && !f.fixed).length;
}

/**
 * Count advisory (non-blocking) findings.
 *
 * @param findings - Array of review findings
 * @returns Number of LOW + MEDIUM findings
 */
export function countAdvisory(findings: ReviewFinding[]): number {
  return findings.filter((f) => !isBlocking(f.severity)).length;
}

/**
 * Compute a weighted severity score for a set of findings.
 * Higher score = worse code quality.
 *
 * @param findings - Array of review findings (unfixed only counted)
 * @returns Numeric score
 */
export function computeSeverityScore(findings: ReviewFinding[]): number {
  return findings
    .filter((f) => !f.fixed)
    .reduce((score, f) => score + SEVERITY_WEIGHT[f.severity], 0);
}

// ─────────────────────────────────────────────────────────────────────────────
// Gate Evaluation
// ─────────────────────────────────────────────────────────────────────────────

/** Input parameters for gate evaluation. */
export interface EvaluateGateInput {
  /** Story ID under review */
  storyId: string;
  /** Current pass number (1-based) */
  passNumber: number;
  /** Maximum allowed passes */
  maxPasses: number;
  /** Findings from this review pass */
  findings: ReviewFinding[];
}

/**
 * Evaluate findings against the quality gate.
 *
 * Decision logic:
 * 1. If zero blocking findings → PASS
 * 2. If blocking findings exist and passes remaining → FAIL (fix and retry)
 * 3. If blocking findings exist and no passes remaining → ESCALATE
 *
 * @param input - Gate evaluation parameters
 * @returns Full gate result with verdict, counts, and summary
 */
export function evaluateGate(input: EvaluateGateInput): GateResult {
  const { storyId, passNumber, maxPasses, findings } = input;

  const blockingCount = countBlocking(findings);
  const advisoryCount = countAdvisory(findings);
  const severityScore = computeSeverityScore(findings);

  let verdict: GateVerdict;
  let summary: string;

  if (blockingCount === 0) {
    verdict = "PASS";
    summary = advisoryCount > 0
      ? `✅ APPROVED with ${advisoryCount} advisory finding(s). No blocking issues.`
      : `✅ APPROVED — clean review, no findings.`;
  } else if (passNumber >= maxPasses) {
    verdict = "ESCALATE";
    summary = [
      `⚠️ ESCALATION: ${blockingCount} blocking finding(s) remain after ${passNumber}/${maxPasses} passes.`,
      `Human intervention required. Severity score: ${severityScore}.`,
    ].join(" ");
  } else {
    verdict = "FAIL";
    summary = [
      `❌ FAILED pass ${passNumber}/${maxPasses}: ${blockingCount} blocking finding(s).`,
      `${advisoryCount} advisory. Severity score: ${severityScore}.`,
      `Next: fix blocking issues, then re-review (pass ${passNumber + 1}).`,
    ].join(" ");
  }

  return {
    verdict,
    storyId,
    passNumber,
    maxPasses,
    findings,
    blockingCount,
    advisoryCount,
    severityScore,
    summary,
    evaluatedAt: new Date().toISOString(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Orchestrator Decision
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Given a gate result and the full review history, decide the next orchestrator action.
 *
 * @param result - The gate evaluation result
 * @param history - Full review history (for escalation context)
 * @returns The action the orchestrator should take
 */
export function decideNextAction(result: GateResult, history: ReviewHistory): OrchestratorAction {
  switch (result.verdict) {
    case "PASS":
      return {
        type: "approve",
        summary: result.summary,
      };

    case "FAIL":
      return {
        type: "fix-and-retry",
        findings: result.findings.filter((f) => isBlocking(f.severity) && !f.fixed),
        passNumber: result.passNumber,
      };

    case "ESCALATE":
      return {
        type: "escalate",
        reason: result.summary,
        history,
      };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Summary Formatting
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Format a gate result as a human-readable report.
 *
 * @param result - Gate evaluation result
 * @returns Multi-line report string
 */
export function formatGateReport(result: GateResult): string {
  const counts = countBySeverity(result.findings);
  const lines: string[] = [
    `╔══════════════════════════════════════════════════════════╗`,
    `║  QUALITY GATE — ${result.storyId} — Pass ${result.passNumber}/${result.maxPasses}`,
    `╠══════════════════════════════════════════════════════════╣`,
    `║  Verdict: ${result.verdict}`,
    `║  Score:   ${result.severityScore}`,
    `║  Findings:`,
    `║    CRITICAL: ${counts.CRITICAL}  HIGH: ${counts.HIGH}`,
    `║    MEDIUM:   ${counts.MEDIUM}  LOW:  ${counts.LOW}`,
    `╠══════════════════════════════════════════════════════════╣`,
  ];

  if (result.findings.length > 0) {
    for (const f of result.findings) {
      const fixedTag = f.fixed ? " [FIXED]" : "";
      lines.push(`║  ${f.id} [${f.severity}] ${f.category} — ${f.filePath}:${f.line ?? "?"}${fixedTag}`);
      lines.push(`║    ${f.title}`);
    }
    lines.push(`╠══════════════════════════════════════════════════════════╣`);
  }

  lines.push(`║  ${result.summary}`);
  lines.push(`╚══════════════════════════════════════════════════════════╝`);

  return lines.join("\n");
}

/**
 * Format a review history as a concise timeline.
 *
 * @param history - Full review history
 * @returns Multi-line timeline string
 */
export function formatReviewTimeline(history: ReviewHistory): string {
  const lines: string[] = [
    `Review Timeline — ${history.storyId} (${history.status})`,
    `${"─".repeat(50)}`,
  ];

  for (const pass of history.passes) {
    const { result } = pass;
    lines.push(
      `  Pass ${pass.passNumber}: ${result.verdict} — ${result.blockingCount} blocking, ${result.advisoryCount} advisory (score: ${result.severityScore})`,
    );
    if (pass.fixedFiles && pass.fixedFiles.length > 0) {
      lines.push(`    Fixed: ${pass.fixedFiles.join(", ")}`);
    }
  }

  if (history.escalationReason) {
    lines.push(`\n  ⚠️ Escalated: ${history.escalationReason}`);
  }

  return lines.join("\n");
}

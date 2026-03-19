/**
 * Quality Gates — Type Definitions
 *
 * Types for the BMAD adversarial review system:
 * - Severity levels (LOW → CRITICAL)
 * - Review findings with structured metadata
 * - Gate verdicts (PASS / FAIL / ESCALATE)
 * - Review pass tracking
 *
 * @module quality-gates/types
 */

// ─────────────────────────────────────────────────────────────────────────────
// Severity Levels
// ─────────────────────────────────────────────────────────────────────────────

/** Severity rating for a code review finding. */
export type Severity = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

/** Severities that block merge. */
export const BLOCKING_SEVERITIES: readonly Severity[] = ["HIGH", "CRITICAL"] as const;

/** All severity levels, ordered by increasing severity. */
export const SEVERITY_ORDER: readonly Severity[] = ["LOW", "MEDIUM", "HIGH", "CRITICAL"] as const;

/**
 * Numeric weight for each severity level (for scoring).
 */
export const SEVERITY_WEIGHT: Record<Severity, number> = {
  LOW: 1,
  MEDIUM: 3,
  HIGH: 7,
  CRITICAL: 15,
};

// ─────────────────────────────────────────────────────────────────────────────
// Review Findings
// ─────────────────────────────────────────────────────────────────────────────

/** Category of a code review finding. */
export type FindingCategory =
  | "correctness"
  | "security"
  | "performance"
  | "error-handling"
  | "type-safety"
  | "maintainability"
  | "testing"
  | "documentation"
  | "style";

/**
 * A single code review finding.
 */
export interface ReviewFinding {
  /** Unique finding ID within this review (e.g., "F-001") */
  id: string;
  /** Severity rating */
  severity: Severity;
  /** Finding category */
  category: FindingCategory;
  /** File where the issue was found */
  filePath: string;
  /** Line number (approximate, 1-based) */
  line?: number;
  /** Short description of the issue */
  title: string;
  /** Detailed explanation of the problem and impact */
  description: string;
  /** Suggested fix (code or prose) */
  suggestedFix?: string;
  /** Whether this finding was fixed in-place by the reviewer */
  fixed?: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Gate Verdicts
// ─────────────────────────────────────────────────────────────────────────────

/** The outcome of a quality gate evaluation. */
export type GateVerdict = "PASS" | "FAIL" | "ESCALATE";

/**
 * Full result from a quality gate evaluation.
 */
export interface GateResult {
  /** The verdict: PASS, FAIL, or ESCALATE */
  verdict: GateVerdict;
  /** Story ID under review */
  storyId: string;
  /** Which review pass this was (1-based) */
  passNumber: number;
  /** Maximum allowed passes before escalation */
  maxPasses: number;
  /** All findings from this review pass */
  findings: ReviewFinding[];
  /** Count of blocking findings (HIGH + CRITICAL) */
  blockingCount: number;
  /** Count of non-blocking findings (LOW + MEDIUM) */
  advisoryCount: number;
  /** Total severity score (weighted sum) */
  severityScore: number;
  /** Human-readable summary */
  summary: string;
  /** Timestamp of evaluation */
  evaluatedAt: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Review Pass Tracking
// ─────────────────────────────────────────────────────────────────────────────

/**
 * History of a single review pass.
 */
export interface ReviewPassRecord {
  /** Pass number (1-based) */
  passNumber: number;
  /** Gate result for this pass */
  result: GateResult;
  /** Agent that performed the review */
  reviewerAgent: string;
  /** Agent that performed fixes (if any) */
  fixerAgent?: string;
  /** Files that were modified to fix findings */
  fixedFiles?: string[];
  /** Timestamp when this pass started */
  startedAt: string;
  /** Timestamp when this pass completed */
  completedAt: string;
}

/**
 * Full review history for a story, persisted across passes.
 */
export interface ReviewHistory {
  /** Story ID */
  storyId: string;
  /** All review passes */
  passes: ReviewPassRecord[];
  /** Current status of the review lifecycle */
  status: "in-review" | "approved" | "escalated";
  /** Final verdict (set when status is approved or escalated) */
  finalVerdict?: GateVerdict;
  /** Escalation reason (if escalated) */
  escalationReason?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Orchestrator Actions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What the review orchestrator should do next after a gate evaluation.
 */
export type OrchestratorAction =
  | { type: "approve"; summary: string }
  | { type: "fix-and-retry"; findings: ReviewFinding[]; passNumber: number }
  | { type: "escalate"; reason: string; history: ReviewHistory };

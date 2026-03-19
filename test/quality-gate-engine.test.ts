/**
 * Quality Gate Engine — Unit Tests
 *
 * Tests the pure logic in the quality gate engine:
 * - Severity classification
 * - Finding counting (blocking vs advisory)
 * - Severity score computation
 * - Gate evaluation (PASS / FAIL / ESCALATE)
 * - Next action decisions
 * - Report formatting
 */

import { describe, it, expect } from "vitest";
import {
  isBlocking,
  countBySeverity,
  countBlocking,
  countAdvisory,
  computeSeverityScore,
  evaluateGate,
  decideNextAction,
  formatGateReport,
} from "../src/quality-gates/engine.js";
import type { ReviewFinding, ReviewHistory } from "../src/quality-gates/types.js";

// ─────────────────────────────────────────────────────────────────────────────
// Test Fixtures
// ─────────────────────────────────────────────────────────────────────────────

function makeFinding(overrides: Partial<ReviewFinding> = {}): ReviewFinding {
  return {
    id: "F-001",
    severity: "LOW",
    category: "style",
    filePath: "src/index.ts",
    line: 10,
    title: "Minor style issue",
    description: "A minor style issue was found.",
    ...overrides,
  };
}

function makeFindings(): ReviewFinding[] {
  return [
    makeFinding({ id: "F-001", severity: "LOW", category: "style" }),
    makeFinding({ id: "F-002", severity: "MEDIUM", category: "maintainability" }),
    makeFinding({ id: "F-003", severity: "HIGH", category: "correctness", title: "Null pointer risk" }),
    makeFinding({ id: "F-004", severity: "CRITICAL", category: "security", title: "SQL injection" }),
    makeFinding({ id: "F-005", severity: "LOW", category: "documentation" }),
  ];
}

function makeEmptyHistory(storyId = "STORY-001"): ReviewHistory {
  return {
    storyId,
    passes: [],
    status: "in-review",
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// isBlocking
// ─────────────────────────────────────────────────────────────────────────────

describe("isBlocking", () => {
  it("should return true for HIGH severity", () => {
    expect(isBlocking("HIGH")).toBe(true);
  });

  it("should return true for CRITICAL severity", () => {
    expect(isBlocking("CRITICAL")).toBe(true);
  });

  it("should return false for MEDIUM severity", () => {
    expect(isBlocking("MEDIUM")).toBe(false);
  });

  it("should return false for LOW severity", () => {
    expect(isBlocking("LOW")).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// countBySeverity
// ─────────────────────────────────────────────────────────────────────────────

describe("countBySeverity", () => {
  it("should count findings by severity level", () => {
    const findings = makeFindings();
    const counts = countBySeverity(findings);

    expect(counts.LOW).toBe(2);
    expect(counts.MEDIUM).toBe(1);
    expect(counts.HIGH).toBe(1);
    expect(counts.CRITICAL).toBe(1);
  });

  it("should return zero counts for empty findings", () => {
    const counts = countBySeverity([]);

    expect(counts.LOW).toBe(0);
    expect(counts.MEDIUM).toBe(0);
    expect(counts.HIGH).toBe(0);
    expect(counts.CRITICAL).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// countBlocking / countAdvisory
// ─────────────────────────────────────────────────────────────────────────────

describe("countBlocking", () => {
  it("should count only HIGH and CRITICAL findings", () => {
    expect(countBlocking(makeFindings())).toBe(2);
  });

  it("should exclude fixed findings", () => {
    const findings = [
      makeFinding({ severity: "HIGH", fixed: true }),
      makeFinding({ id: "F-002", severity: "CRITICAL", fixed: false }),
    ];
    expect(countBlocking(findings)).toBe(1);
  });

  it("should return 0 for no blocking findings", () => {
    const findings = [
      makeFinding({ severity: "LOW" }),
      makeFinding({ id: "F-002", severity: "MEDIUM" }),
    ];
    expect(countBlocking(findings)).toBe(0);
  });
});

describe("countAdvisory", () => {
  it("should count LOW and MEDIUM findings", () => {
    expect(countAdvisory(makeFindings())).toBe(3);
  });

  it("should return 0 for no advisory findings", () => {
    const findings = [
      makeFinding({ severity: "HIGH" }),
      makeFinding({ id: "F-002", severity: "CRITICAL" }),
    ];
    expect(countAdvisory(findings)).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// computeSeverityScore
// ─────────────────────────────────────────────────────────────────────────────

describe("computeSeverityScore", () => {
  it("should compute weighted severity score", () => {
    const findings = makeFindings();
    // 2×LOW(1) + 1×MEDIUM(3) + 1×HIGH(7) + 1×CRITICAL(15) = 27
    expect(computeSeverityScore(findings)).toBe(27);
  });

  it("should exclude fixed findings from score", () => {
    const findings = [
      makeFinding({ severity: "CRITICAL", fixed: true }),
      makeFinding({ id: "F-002", severity: "LOW", fixed: false }),
    ];
    // Only the LOW(1) counts
    expect(computeSeverityScore(findings)).toBe(1);
  });

  it("should return 0 for empty findings", () => {
    expect(computeSeverityScore([])).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// evaluateGate
// ─────────────────────────────────────────────────────────────────────────────

describe("evaluateGate", () => {
  it("should PASS when no blocking findings", () => {
    const result = evaluateGate({
      storyId: "STORY-001",
      passNumber: 1,
      maxPasses: 3,
      findings: [
        makeFinding({ severity: "LOW" }),
        makeFinding({ id: "F-002", severity: "MEDIUM" }),
      ],
    });

    expect(result.verdict).toBe("PASS");
    expect(result.blockingCount).toBe(0);
    expect(result.advisoryCount).toBe(2);
    expect(result.summary).toContain("APPROVED");
  });

  it("should PASS with clean review (no findings)", () => {
    const result = evaluateGate({
      storyId: "STORY-001",
      passNumber: 1,
      maxPasses: 3,
      findings: [],
    });

    expect(result.verdict).toBe("PASS");
    expect(result.blockingCount).toBe(0);
    expect(result.advisoryCount).toBe(0);
    expect(result.summary).toContain("clean review");
  });

  it("should FAIL when blocking findings exist and passes remain", () => {
    const result = evaluateGate({
      storyId: "STORY-001",
      passNumber: 1,
      maxPasses: 3,
      findings: [makeFinding({ severity: "HIGH" })],
    });

    expect(result.verdict).toBe("FAIL");
    expect(result.blockingCount).toBe(1);
    expect(result.summary).toContain("FAILED");
    expect(result.summary).toContain("pass 1/3");
  });

  it("should ESCALATE when blocking findings exist and no passes remain", () => {
    const result = evaluateGate({
      storyId: "STORY-001",
      passNumber: 3,
      maxPasses: 3,
      findings: [makeFinding({ severity: "CRITICAL" })],
    });

    expect(result.verdict).toBe("ESCALATE");
    expect(result.summary).toContain("ESCALATION");
    expect(result.summary).toContain("Human intervention");
  });

  it("should include correct metadata in result", () => {
    const findings = makeFindings();
    const result = evaluateGate({
      storyId: "STORY-042",
      passNumber: 2,
      maxPasses: 3,
      findings,
    });

    expect(result.storyId).toBe("STORY-042");
    expect(result.passNumber).toBe(2);
    expect(result.maxPasses).toBe(3);
    expect(result.findings).toEqual(findings);
    expect(result.evaluatedAt).toBeTruthy();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// decideNextAction
// ─────────────────────────────────────────────────────────────────────────────

describe("decideNextAction", () => {
  it("should return approve action on PASS verdict", () => {
    const result = evaluateGate({
      storyId: "STORY-001",
      passNumber: 1,
      maxPasses: 3,
      findings: [],
    });

    const action = decideNextAction(result, makeEmptyHistory());
    expect(action.type).toBe("approve");
  });

  it("should return fix-and-retry on FAIL verdict with only blocking findings", () => {
    const highFinding = makeFinding({ severity: "HIGH" });
    const lowFinding = makeFinding({ id: "F-002", severity: "LOW" });

    const result = evaluateGate({
      storyId: "STORY-001",
      passNumber: 1,
      maxPasses: 3,
      findings: [highFinding, lowFinding],
    });

    const action = decideNextAction(result, makeEmptyHistory());
    expect(action.type).toBe("fix-and-retry");
    if (action.type === "fix-and-retry") {
      // Only the blocking finding should be in the fix list
      expect(action.findings).toHaveLength(1);
      expect(action.findings[0].severity).toBe("HIGH");
    }
  });

  it("should return escalate on ESCALATE verdict", () => {
    const result = evaluateGate({
      storyId: "STORY-001",
      passNumber: 3,
      maxPasses: 3,
      findings: [makeFinding({ severity: "CRITICAL" })],
    });

    const history = makeEmptyHistory();
    const action = decideNextAction(result, history);
    expect(action.type).toBe("escalate");
    if (action.type === "escalate") {
      expect(action.history).toBe(history);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// formatGateReport
// ─────────────────────────────────────────────────────────────────────────────

describe("formatGateReport", () => {
  it("should produce a formatted report string", () => {
    const result = evaluateGate({
      storyId: "STORY-001",
      passNumber: 1,
      maxPasses: 3,
      findings: makeFindings(),
    });

    const report = formatGateReport(result);
    expect(report).toContain("QUALITY GATE");
    expect(report).toContain("STORY-001");
    expect(report).toContain("Pass 1/3");
    expect(report).toContain("CRITICAL: 1");
    expect(report).toContain("HIGH: 1");
  });

  it("should handle empty findings", () => {
    const result = evaluateGate({
      storyId: "STORY-001",
      passNumber: 1,
      maxPasses: 3,
      findings: [],
    });

    const report = formatGateReport(result);
    expect(report).toContain("PASS");
  });
});

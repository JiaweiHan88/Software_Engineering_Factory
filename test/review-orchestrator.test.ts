/**
 * Review Orchestrator — Unit Tests
 *
 * Tests the finding parser (structured + heuristic formats)
 * and review history persistence logic.
 */

import { describe, it, expect, vi } from "vitest";

// Mock the Copilot SDK to avoid import resolution errors
vi.mock("@github/copilot-sdk", () => ({
  CopilotClient: vi.fn(),
  approveAll: vi.fn(),
  defineTool: vi.fn((_name: string, _opts: unknown) => ({ name: _name })),
}));

import { parseFindings } from "../src/quality-gates/review-orchestrator.js";

// ─────────────────────────────────────────────────────────────────────────────
// parseFindings — Structured Format
// ─────────────────────────────────────────────────────────────────────────────

describe("parseFindings — structured format", () => {
  it("should parse a single structured finding", () => {
    const response = `Some intro text

[FINDING:F-001:HIGH:security:src/auth.ts:42]
SQL injection risk
User input is concatenated directly into a SQL query string.
[/FINDING]

Some conclusion text`;

    const findings = parseFindings(response);
    expect(findings).toHaveLength(1);
    expect(findings[0].id).toBe("F-001");
    expect(findings[0].severity).toBe("HIGH");
    expect(findings[0].category).toBe("security");
    expect(findings[0].filePath).toBe("src/auth.ts");
    expect(findings[0].line).toBe(42);
    expect(findings[0].title).toBe("SQL injection risk");
    expect(findings[0].description).toContain("concatenated directly");
  });

  it("should parse multiple structured findings", () => {
    const response = `
[FINDING:F-001:CRITICAL:security:src/auth.ts:10]
No input sanitization
XSS vulnerability in user display.
[/FINDING]

[FINDING:F-002:LOW:style:src/utils.ts:55]
Unused import
The 'path' module is imported but never used.
[/FINDING]

[FINDING:F-003:MEDIUM:maintainability:src/config.ts]
Magic number
Hardcoded timeout value should be a named constant.
[/FINDING]`;

    const findings = parseFindings(response);
    expect(findings).toHaveLength(3);
    expect(findings[0].severity).toBe("CRITICAL");
    expect(findings[1].severity).toBe("LOW");
    expect(findings[2].severity).toBe("MEDIUM");
    expect(findings[2].line).toBeUndefined(); // no line number
  });

  it("should handle findings with no line number", () => {
    const response = `
[FINDING:F-001:HIGH:correctness:src/index.ts]
Missing error handling
Async function has no try/catch.
[/FINDING]`;

    const findings = parseFindings(response);
    expect(findings).toHaveLength(1);
    expect(findings[0].line).toBeUndefined();
    expect(findings[0].filePath).toBe("src/index.ts");
  });

  it("should return empty array for no findings", () => {
    const response = "The code looks great! No issues found.";
    const findings = parseFindings(response);
    expect(findings).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// parseFindings — Heuristic Format
// ─────────────────────────────────────────────────────────────────────────────

describe("parseFindings — heuristic format", () => {
  it("should parse heuristic severity patterns with file paths", () => {
    const response = `Review of story STORY-001:

HIGH: src/auth.ts:42 - SQL injection vulnerability in login handler
MEDIUM: src/utils.ts - Missing null check on return value
LOW: src/config.ts:10 - Consider using const instead of let`;

    const findings = parseFindings(response);
    expect(findings).toHaveLength(3);
    expect(findings[0].severity).toBe("HIGH");
    expect(findings[0].filePath).toBe("src/auth.ts");
    expect(findings[0].line).toBe(42);
    expect(findings[1].severity).toBe("MEDIUM");
    expect(findings[2].severity).toBe("LOW");
  });

  it("should parse CRITICAL findings from heuristic format", () => {
    const response = `CRITICAL: src/secrets.ts:5 - API key hardcoded in source code`;

    const findings = parseFindings(response);
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe("CRITICAL");
    expect(findings[0].filePath).toBe("src/secrets.ts");
    expect(findings[0].line).toBe(5);
  });

  it("should handle heuristic findings without file path", () => {
    const response = `HIGH: Missing error boundary in the application
LOW: Consider adding more documentation`;

    const findings = parseFindings(response);
    expect(findings).toHaveLength(2);
    expect(findings[0].filePath).toBe("unknown");
    expect(findings[0].line).toBeUndefined();
  });

  it("should auto-generate sequential IDs for heuristic findings", () => {
    const response = `LOW: src/a.ts - issue one
LOW: src/b.ts - issue two
LOW: src/c.ts - issue three`;

    const findings = parseFindings(response);
    expect(findings).toHaveLength(3);
    expect(findings[0].id).toBe("F-001");
    expect(findings[1].id).toBe("F-002");
    expect(findings[2].id).toBe("F-003");
  });

  it("should prefer structured format when present", () => {
    const response = `
[FINDING:F-001:HIGH:security:src/auth.ts:42]
SQL injection risk
User input concatenated into query.
[/FINDING]

Also noted: LOW: src/style.ts - formatting issue`;

    const findings = parseFindings(response);
    // Should only return the structured finding (structured takes priority)
    expect(findings).toHaveLength(1);
    expect(findings[0].id).toBe("F-001");
  });
});

/**
 * Git Integration — Unit Tests
 *
 * Tests git operations by mocking child_process.execFile:
 * - createStoryBranch: creates new branch or checks out existing
 * - commitChanges: stages, checks for changes, commits
 * - pushBranch: pushes with --set-upstream
 * - createPR: uses gh CLI, handles existing PRs
 * - getCurrentBranch / hasUncommittedChanges
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Must use vi.hoisted so the mock fn is available when vi.mock is hoisted
const mockExecFile = vi.hoisted(() => vi.fn());

// Mock child_process.execFile
vi.mock("node:child_process", () => ({
  execFile: mockExecFile,
}));

// Mock util.promisify to return our mock directly
vi.mock("node:util", () => ({
  promisify: () => mockExecFile,
}));

vi.mock("../../src/observability/logger.js", () => ({
  Logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
}));

import {
  createStoryBranch,
  commitChanges,
  pushBranch,
  createPR,
  getCurrentBranch,
  hasUncommittedChanges,
} from "../../src/adapter/git-integration.js";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Simulate a successful command */
function mockSuccess(stdout = "", stderr = "") {
  return { stdout, stderr };
}

/** Simulate a failed command */
function mockFailure(message: string, code = 1) {
  const err = new Error(message) as Error & { stdout: string; stderr: string; code: number };
  err.stdout = "";
  err.stderr = message;
  err.code = code;
  return err;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("git-integration", () => {
  beforeEach(() => {
    mockExecFile.mockReset();
  });

  // ─── createStoryBranch ──────────────────────────────────────────────

  describe("createStoryBranch", () => {
    it("creates a new branch when it doesn't exist", async () => {
      // rev-parse fails (branch doesn't exist) → checkout -b succeeds
      mockExecFile
        .mockRejectedValueOnce(mockFailure("not found"))
        .mockResolvedValueOnce(mockSuccess());

      const branch = await createStoryBranch("STORY-001");

      expect(branch).toBe("story/STORY-001");
      expect(mockExecFile).toHaveBeenCalledTimes(2);
      // Second call should be checkout -b
      expect(mockExecFile.mock.calls[1][0]).toBe("git");
      expect(mockExecFile.mock.calls[1][1]).toContain("-b");
    });

    it("checks out existing branch", async () => {
      // rev-parse succeeds (branch exists) → checkout succeeds
      mockExecFile
        .mockResolvedValueOnce(mockSuccess("abc123"))
        .mockResolvedValueOnce(mockSuccess());

      const branch = await createStoryBranch("STORY-001");

      expect(branch).toBe("story/STORY-001");
      // Second call should be plain checkout (no -b)
      expect(mockExecFile.mock.calls[1][1]).not.toContain("-b");
      expect(mockExecFile.mock.calls[1][1]).toContain("story/STORY-001");
    });

    it("throws when branch creation fails", async () => {
      mockExecFile
        .mockRejectedValueOnce(mockFailure("not found"))
        .mockRejectedValueOnce(mockFailure("fatal: git error"));

      await expect(createStoryBranch("STORY-001")).rejects.toThrow("Failed to create branch");
    });

    it("uses custom cwd when provided", async () => {
      mockExecFile
        .mockRejectedValueOnce(mockFailure("not found"))
        .mockResolvedValueOnce(mockSuccess());

      await createStoryBranch("S-001", { cwd: "/my/project" });

      expect(mockExecFile.mock.calls[0][2]).toEqual(
        expect.objectContaining({ cwd: "/my/project" }),
      );
    });
  });

  // ─── commitChanges ─────────────────────────────────────────────────

  describe("commitChanges", () => {
    it("stages and commits changes", async () => {
      // git add -A succeeds → git diff --cached --quiet fails (has changes) → git commit succeeds
      mockExecFile
        .mockResolvedValueOnce(mockSuccess()) // git add -A
        .mockRejectedValueOnce(mockFailure("")) // git diff --cached --quiet (exit 1 = has changes)
        .mockResolvedValueOnce(mockSuccess("1 file changed")); // git commit

      const result = await commitChanges("STORY-001", "Implement login");

      expect(result.success).toBe(true);
      // Verify commit message format
      const commitCall = mockExecFile.mock.calls[2];
      expect(commitCall[1]).toContain("-m");
      expect(commitCall[1]).toContain("feat(STORY-001): Implement login");
    });

    it("returns success with 'Nothing to commit' when no changes", async () => {
      // git add succeeds → git diff --cached --quiet succeeds (exit 0 = no changes)
      mockExecFile
        .mockResolvedValueOnce(mockSuccess()) // git add
        .mockResolvedValueOnce(mockSuccess()); // git diff --cached --quiet (no changes)

      const result = await commitChanges("STORY-001", "Nothing happened");

      expect(result.success).toBe(true);
      expect(result.stdout).toContain("Nothing to commit");
      // Should NOT attempt commit
      expect(mockExecFile).toHaveBeenCalledTimes(2);
    });

    it("returns failure when git add fails", async () => {
      mockExecFile.mockRejectedValueOnce(mockFailure("git add failed"));

      const result = await commitChanges("S-001", "msg");

      expect(result.success).toBe(false);
    });
  });

  // ─── pushBranch ────────────────────────────────────────────────────

  describe("pushBranch", () => {
    it("pushes branch to origin", async () => {
      mockExecFile.mockResolvedValueOnce(mockSuccess("Everything up-to-date"));

      const result = await pushBranch("story/STORY-001");

      expect(result.success).toBe(true);
      const call = mockExecFile.mock.calls[0];
      expect(call[1]).toContain("push");
      expect(call[1]).toContain("--set-upstream");
      expect(call[1]).toContain("story/STORY-001");
    });

    it("returns failure on push error", async () => {
      mockExecFile.mockRejectedValueOnce(mockFailure("remote rejected"));

      const result = await pushBranch("story/S-001");

      expect(result.success).toBe(false);
      expect(result.error).toContain("remote rejected");
    });
  });

  // ─── createPR ──────────────────────────────────────────────────────

  describe("createPR", () => {
    it("creates PR via gh CLI", async () => {
      mockExecFile.mockResolvedValueOnce(mockSuccess("https://github.com/org/repo/pull/42"));

      const url = await createPR("STORY-001", "Login feature", "Description here");

      expect(url).toBe("https://github.com/org/repo/pull/42");
      const call = mockExecFile.mock.calls[0];
      expect(call[0]).toBe("gh");
      expect(call[1]).toContain("pr");
      expect(call[1]).toContain("create");
    });

    it("returns existing PR URL when PR already exists", async () => {
      // First call fails with "already exists"
      const err = mockFailure("already exists");
      mockExecFile
        .mockRejectedValueOnce(err)
        .mockResolvedValueOnce(mockSuccess("https://github.com/org/repo/pull/99"));

      const url = await createPR("S-001", "Title", "Body");

      expect(url).toBe("https://github.com/org/repo/pull/99");
    });

    it("throws on non-existing-PR errors", async () => {
      mockExecFile.mockRejectedValueOnce(mockFailure("authentication required"));

      await expect(createPR("S-001", "Title", "Body")).rejects.toThrow("Failed to create PR");
    });
  });

  // ─── getCurrentBranch ──────────────────────────────────────────────

  describe("getCurrentBranch", () => {
    it("returns current branch name", async () => {
      mockExecFile.mockResolvedValueOnce(mockSuccess("main"));

      const branch = await getCurrentBranch();
      expect(branch).toBe("main");
    });

    it("throws when not in a git repo", async () => {
      mockExecFile.mockRejectedValueOnce(mockFailure("not a git repository"));

      await expect(getCurrentBranch()).rejects.toThrow("Failed to get current branch");
    });
  });

  // ─── hasUncommittedChanges ─────────────────────────────────────────

  describe("hasUncommittedChanges", () => {
    it("returns true when there are changes", async () => {
      mockExecFile.mockResolvedValueOnce(mockSuccess(" M src/foo.ts\n?? src/bar.ts"));

      const result = await hasUncommittedChanges();
      expect(result).toBe(true);
    });

    it("returns false when working dir is clean", async () => {
      mockExecFile.mockResolvedValueOnce(mockSuccess(""));

      const result = await hasUncommittedChanges();
      expect(result).toBe(false);
    });
  });
});

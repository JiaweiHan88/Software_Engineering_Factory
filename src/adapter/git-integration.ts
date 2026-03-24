/**
 * Git Integration — Branch Management, Commits, and PR Creation.
 *
 * Creates feature branches per story, commits changes, opens PRs.
 * Uses shell git commands (no library dependency). Designed for use
 * within the BMAD heartbeat pipeline.
 *
 * @module adapter/git-integration
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Logger } from "../observability/logger.js";

const log = Logger.child("git-integration");

const execAsync = promisify(execFile);

/**
 * Options for shell command execution.
 */
interface ExecOptions {
  /** Working directory for the command */
  cwd?: string;
  /** Timeout in milliseconds (default: 30s) */
  timeout?: number;
}

/**
 * Result of a git operation.
 */
export interface GitResult {
  /** Whether the operation succeeded */
  success: boolean;
  /** Standard output from the command */
  stdout: string;
  /** Standard error from the command */
  stderr: string;
  /** Error message if the operation failed */
  error?: string;
}

/**
 * Run a git command safely, capturing stdout/stderr.
 *
 * @param args - Arguments to pass to `git`
 * @param options - Execution options (cwd, timeout)
 * @returns GitResult with output and success status
 */
async function gitExec(args: string[], options: ExecOptions = {}): Promise<GitResult> {
  const { cwd = process.cwd(), timeout = 30_000 } = options;
  try {
    const result = await execAsync("git", args, { cwd, timeout });
    return {
      success: true,
      stdout: result.stdout.trim(),
      stderr: result.stderr.trim(),
    };
  } catch (err: unknown) {
    const error = err as { stdout?: string; stderr?: string; message?: string };
    return {
      success: false,
      stdout: (error.stdout ?? "").trim(),
      stderr: (error.stderr ?? "").trim(),
      error: error.message ?? String(err),
    };
  }
}

/**
 * Create a feature branch for a story.
 *
 * Checks out from the current branch (typically `main`) and creates
 * `story/{storyId}`. If the branch already exists, switches to it.
 *
 * @param storyId - Story identifier (e.g., "STORY-001")
 * @param options - Execution options
 * @returns The branch name
 */
export async function createStoryBranch(
  storyId: string,
  options: ExecOptions = {},
): Promise<string> {
  const branchName = `story/${storyId}`;
  log.info("Creating story branch", { branchName, cwd: options.cwd });

  // Check if branch already exists locally
  const checkResult = await gitExec(
    ["rev-parse", "--verify", branchName],
    options,
  );

  if (checkResult.success) {
    // Branch exists — switch to it
    log.info("Branch already exists, checking out", { branchName });
    const checkoutResult = await gitExec(["checkout", branchName], options);
    if (!checkoutResult.success) {
      throw new Error(
        `Failed to checkout existing branch ${branchName}: ${checkoutResult.error}`,
      );
    }
    return branchName;
  }

  // Create and checkout new branch
  const createResult = await gitExec(
    ["checkout", "-b", branchName],
    options,
  );

  if (!createResult.success) {
    throw new Error(
      `Failed to create branch ${branchName}: ${createResult.error}`,
    );
  }

  log.info("Story branch created", { branchName });
  return branchName;
}

/**
 * Stage all changes and commit with a conventional commit message.
 *
 * Uses `feat({storyId}): {message}` format for conventional commits.
 * Skips if there are no changes to commit.
 *
 * @param storyId - Story identifier for the commit prefix
 * @param message - Commit message body
 * @param options - Execution options
 * @returns GitResult with commit details
 */
export async function commitChanges(
  storyId: string,
  message: string,
  options: ExecOptions = {},
): Promise<GitResult> {
  log.info("Committing changes", { storyId, message });

  // Stage all changes
  const addResult = await gitExec(["add", "-A"], options);
  if (!addResult.success) {
    log.warn("git add failed", { error: addResult.error });
    return addResult;
  }

  // Check if there are staged changes
  const statusResult = await gitExec(
    ["diff", "--cached", "--quiet"],
    options,
  );

  if (statusResult.success) {
    // Exit code 0 means no differences — nothing staged
    log.info("No changes to commit", { storyId });
    return {
      success: true,
      stdout: "Nothing to commit",
      stderr: "",
    };
  }

  // Commit with conventional commit format
  const commitMessage = `feat(${storyId}): ${message}`;
  const commitResult = await gitExec(
    ["commit", "-m", commitMessage],
    options,
  );

  if (!commitResult.success) {
    log.warn("git commit failed", { error: commitResult.error });
    return commitResult;
  }

  log.info("Changes committed", { storyId, commitMessage });
  return commitResult;
}

/**
 * Push the current branch to origin.
 *
 * @param branchName - Branch name to push
 * @param options - Execution options
 * @returns GitResult with push details
 */
export async function pushBranch(
  branchName: string,
  options: ExecOptions = {},
): Promise<GitResult> {
  log.info("Pushing branch", { branchName });

  const result = await gitExec(
    ["push", "--set-upstream", "origin", branchName],
    options,
  );

  if (!result.success) {
    log.warn("git push failed", { branchName, error: result.error });
  } else {
    log.info("Branch pushed", { branchName });
  }

  return result;
}

/**
 * Create a pull request using the GitHub CLI (`gh`).
 *
 * Requires `gh` CLI to be installed and authenticated.
 * Falls back to a descriptive error if `gh` is not available.
 *
 * @param storyId - Story identifier for the PR title prefix
 * @param title - PR title
 * @param description - PR body/description
 * @param options - Execution options
 * @returns PR URL on success
 */
export async function createPR(
  storyId: string,
  title: string,
  description: string,
  options: ExecOptions = {},
): Promise<string> {
  const { cwd = process.cwd(), timeout = 60_000 } = options;
  log.info("Creating PR", { storyId, title });

  const prTitle = `feat(${storyId}): ${title}`;
  // Sanitize description for shell safety
  const safeDescription = description.replace(/"/g, '\\"');

  try {
    const result = await execAsync(
      "gh",
      [
        "pr", "create",
        "--title", prTitle,
        "--body", safeDescription,
        "--base", "main",
      ],
      { cwd, timeout },
    );

    const prUrl = result.stdout.trim();
    log.info("PR created", { storyId, prUrl });
    return prUrl;
  } catch (err: unknown) {
    const error = err as { message?: string; stderr?: string };
    const errMsg = error.stderr ?? error.message ?? String(err);

    // Check if PR already exists
    if (errMsg.includes("already exists")) {
      log.info("PR already exists for this branch", { storyId });
      // Try to get existing PR URL
      try {
        const viewResult = await execAsync(
          "gh",
          ["pr", "view", "--json", "url", "-q", ".url"],
          { cwd, timeout },
        );
        return viewResult.stdout.trim();
      } catch {
        return `PR already exists for story ${storyId}`;
      }
    }

    throw new Error(`Failed to create PR: ${errMsg}`);
  }
}

/**
 * Get the current branch name.
 *
 * @param options - Execution options
 * @returns Current branch name
 */
export async function getCurrentBranch(
  options: ExecOptions = {},
): Promise<string> {
  const result = await gitExec(
    ["rev-parse", "--abbrev-ref", "HEAD"],
    options,
  );

  if (!result.success) {
    throw new Error(`Failed to get current branch: ${result.error}`);
  }

  return result.stdout;
}

/**
 * Check if the working directory has uncommitted changes.
 *
 * @param options - Execution options
 * @returns `true` if there are uncommitted changes
 */
export async function hasUncommittedChanges(
  options: ExecOptions = {},
): Promise<boolean> {
  const result = await gitExec(
    ["status", "--porcelain"],
    options,
  );

  return result.success && result.stdout.length > 0;
}

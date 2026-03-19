/**
 * BMAD Copilot Factory — Runtime Configuration
 *
 * Centralizes environment variable loading and default values.
 * Used by all tools, sandbox scripts, and the main entry point.
 *
 * @module config
 */

import { resolve } from "node:path";

/**
 * Resolved runtime configuration for the BMAD Copilot Factory.
 */
export interface BmadConfig {
  /** GHE hostname (e.g., "bmw.ghe.com") or undefined for github.com */
  gheHost: string | undefined;
  /** Default model for sessions */
  model: string;
  /** Working directory for BMAD output (stories, reviews, etc.) */
  outputDir: string;
  /** Path to sprint-status.yaml */
  sprintStatusPath: string;
  /** Max code review passes before escalation */
  reviewPassLimit: number;
  /** Copilot SDK log level */
  logLevel: "none" | "error" | "warning" | "info" | "debug" | "all";
  /** Project root directory */
  projectRoot: string;
}

/**
 * Load configuration from environment variables with sensible defaults.
 *
 * @param projectRoot - Override for project root (defaults to cwd)
 * @returns Resolved configuration object
 */
export function loadConfig(projectRoot?: string): BmadConfig {
  const root = projectRoot ?? process.cwd();

  return {
    gheHost: process.env.COPILOT_GHE_HOST || undefined,
    model: process.env.COPILOT_MODEL || "claude-sonnet-4.5",
    outputDir: resolve(root, process.env.BMAD_OUTPUT_DIR || "_bmad-output"),
    sprintStatusPath: resolve(
      root,
      process.env.BMAD_SPRINT_STATUS_PATH || "_bmad-output/sprint-status.yaml",
    ),
    reviewPassLimit: Number(process.env.REVIEW_PASS_LIMIT) || 3,
    logLevel: (process.env.COPILOT_LOG_LEVEL as BmadConfig["logLevel"]) || "warning",
    projectRoot: root,
  };
}

/**
 * Build the env override object for CopilotClient when using GHE.
 * Returns undefined if no GHE host is configured (uses github.com default).
 */
export function buildClientEnv(config: BmadConfig): Record<string, string | undefined> | undefined {
  if (!config.gheHost) return undefined;
  return { ...process.env, GH_HOST: config.gheHost };
}

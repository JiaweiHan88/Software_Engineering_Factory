/**
 * BMAD Copilot Factory — Runtime Configuration
 *
 * Centralizes environment variable loading and default values.
 * Used by all tools, sandbox scripts, and the main entry point.
 *
 * @module config
 */

import { resolve } from "node:path";
import type { LogLevel, LogFormat } from "../observability/logger.js";

// ─────────────────────────────────────────────────────────────────────────────
// Observability Configuration
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Observability settings (logging, tracing, metrics).
 */
export interface ObservabilityConfig {
  /** Structured log level */
  logLevel: LogLevel;
  /** Log output format */
  logFormat: LogFormat;
  /** Enable OpenTelemetry tracing and metrics */
  otelEnabled: boolean;
  /** OTLP endpoint for traces and metrics */
  otelEndpoint: string;
  /** Service name for OTel */
  otelServiceName: string;
  /** Stall detection check interval in milliseconds */
  stallCheckIntervalMs: number;
  /** Enable stall auto-escalation */
  stallAutoEscalate: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Paperclip Configuration
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Paperclip integration settings.
 */
export interface PaperclipConfig {
  /** Paperclip server URL (e.g., "http://localhost:3100") */
  url: string;
  /** API key for authenticated mode (undefined = local_trusted) */
  apiKey: string | undefined;
  /** Organization ID in Paperclip */
  orgId: string;
  /** Heartbeat polling interval in milliseconds */
  pollIntervalMs: number;
  /** Whether Paperclip integration is enabled */
  enabled: boolean;
  /** Request timeout for Paperclip API calls in milliseconds */
  timeoutMs: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Configuration
// ─────────────────────────────────────────────────────────────────────────────

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
  /** Paperclip integration settings */
  paperclip: PaperclipConfig;
  /** Observability settings */
  observability: ObservabilityConfig;
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
    model: process.env.COPILOT_MODEL || "claude-sonnet-4.6",
    outputDir: resolve(root, process.env.BMAD_OUTPUT_DIR || "_bmad-output"),
    sprintStatusPath: resolve(
      root,
      process.env.BMAD_SPRINT_STATUS_PATH || "_bmad-output/sprint-status.yaml",
    ),
    reviewPassLimit: Number(process.env.REVIEW_PASS_LIMIT) || 3,
    logLevel: (process.env.COPILOT_LOG_LEVEL as BmadConfig["logLevel"]) || "warning",
    projectRoot: root,
    paperclip: {
      url: process.env.PAPERCLIP_URL || "http://localhost:3100",
      apiKey: process.env.PAPERCLIP_API_KEY || undefined,
      orgId: process.env.PAPERCLIP_ORG_ID || "bmad-factory",
      pollIntervalMs: Number(process.env.PAPERCLIP_POLL_INTERVAL_MS) || 5_000,
      enabled: process.env.PAPERCLIP_ENABLED === "true",
      timeoutMs: Number(process.env.PAPERCLIP_TIMEOUT_MS) || 10_000,
    },
    observability: {
      logLevel: (process.env.LOG_LEVEL as LogLevel) || "info",
      logFormat: (process.env.LOG_FORMAT as LogFormat) || "human",
      otelEnabled: process.env.OTEL_ENABLED === "true",
      otelEndpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT || "http://localhost:4317",
      otelServiceName: process.env.OTEL_SERVICE_NAME || "bmad-copilot-factory",
      stallCheckIntervalMs: Number(process.env.STALL_CHECK_INTERVAL_MS) || 60_000,
      stallAutoEscalate: process.env.STALL_AUTO_ESCALATE === "true",
    },
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

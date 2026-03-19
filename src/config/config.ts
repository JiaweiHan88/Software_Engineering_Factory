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
 *
 * Aligned with real Paperclip API (paperclipai/paperclip).
 * - Auth via Bearer agent API key (company-scoped)
 * - Company-scoped data model (not "org")
 * - Push model: Paperclip invokes heartbeats on agents
 * - Inbox-polling bridge for dev convenience
 */
export interface PaperclipConfig {
  /** Paperclip server URL (e.g., "http://localhost:3100") */
  url: string;
  /** Agent API key for Bearer auth (undefined = local_trusted) */
  agentApiKey: string | undefined;
  /** Company ID in Paperclip (company-scoped data model) */
  companyId: string;
  /** Inbox check interval in ms (bridge/dev mode only — real Paperclip pushes heartbeats) */
  inboxCheckIntervalMs: number;
  /** Whether Paperclip integration is enabled */
  enabled: boolean;
  /** Request timeout for Paperclip API calls in milliseconds */
  timeoutMs: number;
  /** Integration mode: "webhook" (prod) or "inbox-polling" (dev) */
  mode: "webhook" | "inbox-polling";
  /** Webhook port for receiving Paperclip heartbeat callbacks (webhook mode) */
  webhookPort: number;
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
  /** Project root directory (factory repo — used for config, skills, sprint data) */
  projectRoot: string;
  /**
   * Target project root — the workspace that agents operate in.
   * Defaults to projectRoot if TARGET_PROJECT_ROOT is not set.
   * Set this to a separate clean workspace to prevent agents from
   * exploring the factory source files (50–100s savings per dispatch).
   */
  targetProjectRoot: string;
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
  const targetRoot = process.env.TARGET_PROJECT_ROOT
    ? resolve(root, process.env.TARGET_PROJECT_ROOT)
    : root;

  // When a target workspace is set, sprint data lives there, not in the factory
  const dataRoot = targetRoot;

  return {
    gheHost: process.env.COPILOT_GHE_HOST || undefined,
    model: process.env.COPILOT_MODEL || "claude-sonnet-4.6",
    outputDir: resolve(dataRoot, process.env.BMAD_OUTPUT_DIR || "_bmad-output"),
    sprintStatusPath: resolve(
      dataRoot,
      process.env.BMAD_SPRINT_STATUS_PATH || "_bmad-output/sprint-status.yaml",
    ),
    reviewPassLimit: Number(process.env.REVIEW_PASS_LIMIT) || 3,
    logLevel: (process.env.COPILOT_LOG_LEVEL as BmadConfig["logLevel"]) || "warning",
    projectRoot: root,
    targetProjectRoot: targetRoot,
    paperclip: {
      url: process.env.PAPERCLIP_URL || "http://localhost:3100",
      agentApiKey: process.env.PAPERCLIP_AGENT_API_KEY || undefined,
      companyId: process.env.PAPERCLIP_COMPANY_ID || "bmad-factory",
      inboxCheckIntervalMs: Number(process.env.PAPERCLIP_INBOX_CHECK_INTERVAL_MS) || 15_000,
      enabled: process.env.PAPERCLIP_ENABLED === "true",
      timeoutMs: Number(process.env.PAPERCLIP_TIMEOUT_MS) || 10_000,
      mode: (process.env.PAPERCLIP_MODE as "webhook" | "inbox-polling") || "inbox-polling",
      webhookPort: Number(process.env.PAPERCLIP_WEBHOOK_PORT) || 3200,
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

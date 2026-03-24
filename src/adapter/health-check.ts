/**
 * Health Check — System Readiness Probe
 *
 * Verifies that all required subsystems of the BMAD Copilot Factory are
 * operational. Designed for the `--health` CLI flag and for programmatic
 * readiness checks before starting a sprint cycle.
 *
 * Checks performed:
 * 1. **config**      — required fields are populated and paths are resolvable
 * 2. **agents**      — at least one BMAD agent is registered
 * 3. **tools**       — all expected BMAD tools are registered
 * 4. **sprint-file** — sprint-status.yaml exists and is readable (non-critical)
 *
 * Status semantics:
 * - `healthy`   — all checks passed
 * - `degraded`  — all critical checks passed; one or more non-critical failed
 * - `unhealthy` — at least one critical check failed
 *
 * @module adapter/health-check
 */

import { access } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import type { BmadConfig } from "../config/config.js";
import { allAgents } from "../agents/registry.js";
import { allTools } from "../tools/index.js";
import { PaperclipClient } from "./paperclip-client.js";

/** Overall system health status */
export type HealthStatus = "healthy" | "degraded" | "unhealthy";

/** Result of a single health check probe */
export interface HealthProbe {
  /** Short identifier for the probe */
  name: string;
  /** Whether this probe passed */
  ok: boolean;
  /** Human-readable detail (pass reason or failure reason) */
  message: string;
  /** If true, failure marks the whole system 'unhealthy' */
  critical: boolean;
}

/** Aggregated health check result */
export interface HealthCheckResult {
  /** Overall system status */
  status: HealthStatus;
  /** Individual probe results */
  probes: HealthProbe[];
  /** One-line human-readable summary */
  summary: string;
  /** ISO-8601 timestamp of when the check was run */
  timestamp: string;
}

/** Expected tool names that must be registered for the system to be healthy */
const REQUIRED_TOOL_NAMES = [
  "create_story",
  "dev_story",
  "code_review",
  "code_review_result",
  "issue_status",
] as const;

/**
 * Probe 1 — Validate required config fields are present.
 */
function checkConfig(config: BmadConfig): HealthProbe {
  const missing: string[] = [];

  if (!config.projectRoot) missing.push("projectRoot");
  if (!config.sprintStatusPath) missing.push("sprintStatusPath");
  if (!config.model) missing.push("model");
  if (!config.outputDir) missing.push("outputDir");
  if (config.reviewPassLimit <= 0) missing.push("reviewPassLimit (must be > 0)");

  return {
    name: "config",
    ok: missing.length === 0,
    message:
      missing.length === 0
        ? `Config valid — model=${config.model}, reviewPassLimit=${config.reviewPassLimit}`
        : `Missing or invalid fields: ${missing.join(", ")}`,
    critical: true,
  };
}

/**
 * Probe 2 — Verify at least one BMAD agent is registered.
 */
function checkAgents(): HealthProbe {
  const count = allAgents.length;
  return {
    name: "agents",
    ok: count > 0,
    message:
      count > 0
        ? `${count} agent(s) registered: ${allAgents.map((a) => a.name).join(", ")}`
        : "No agents registered in the registry",
    critical: true,
  };
}

/**
 * Probe 3 — Verify all expected BMAD tools are registered.
 */
function checkTools(): HealthProbe {
  const registeredNames = new Set(allTools.map((t) => t.name));
  const missing = REQUIRED_TOOL_NAMES.filter((name) => !registeredNames.has(name));

  return {
    name: "tools",
    ok: missing.length === 0,
    message:
      missing.length === 0
        ? `All ${REQUIRED_TOOL_NAMES.length} required tools registered`
        : `Missing tools: ${missing.join(", ")}`,
    critical: true,
  };
}

/**
 * Probe 4 — Check if sprint-status.yaml is readable.
 * Non-critical: the file may not exist on a fresh project.
 */
async function checkSprintFile(config: BmadConfig): Promise<HealthProbe> {
  try {
    await access(config.sprintStatusPath, fsConstants.R_OK);
    return {
      name: "sprint-file",
      ok: true,
      message: `sprint-status.yaml readable at ${config.sprintStatusPath}`,
      critical: false,
    };
  } catch {
    return {
      name: "sprint-file",
      ok: false,
      message: `sprint-status.yaml not found or unreadable at ${config.sprintStatusPath}`,
      critical: false,
    };
  }
}

/**
 * Probe 5 — Ping the Paperclip server.
 * Non-critical if Paperclip integration is disabled.
 * Critical if PAPERCLIP_ENABLED=true.
 */
async function checkPaperclip(config: BmadConfig): Promise<HealthProbe> {
  if (!config.paperclip.enabled) {
    return {
      name: "paperclip",
      ok: true,
      message: `Paperclip integration disabled (PAPERCLIP_ENABLED=false)`,
      critical: false,
    };
  }

  const client = new PaperclipClient({
    baseUrl: config.paperclip.url,
    agentApiKey: config.paperclip.agentApiKey,
    companyId: config.paperclip.companyId,
    timeoutMs: 5_000,
  });

  try {
    const reachable = await client.ping();
    return {
      name: "paperclip",
      ok: reachable,
      message: reachable
        ? `Paperclip reachable at ${config.paperclip.url}`
        : `Paperclip not reachable at ${config.paperclip.url}`,
      critical: true,
    };
  } catch {
    return {
      name: "paperclip",
      ok: false,
      message: `Paperclip connection failed: ${config.paperclip.url}`,
      critical: true,
    };
  }
}

/**
 * Run all health probes and return an aggregated result.
 *
 * @param config - Resolved BMAD configuration
 * @returns Aggregated health check result
 *
 * @example
 * ```ts
 * const result = await checkHealth(config);
 * if (result.status === "unhealthy") process.exit(1);
 * ```
 */
export async function checkHealth(config: BmadConfig): Promise<HealthCheckResult> {
  const probes: HealthProbe[] = [
    checkConfig(config),
    checkAgents(),
    checkTools(),
    await checkSprintFile(config),
    await checkPaperclip(config),
  ];

  const criticalFailed = probes.some((p) => p.critical && !p.ok);
  const nonCriticalFailed = probes.some((p) => !p.critical && !p.ok);

  let status: HealthStatus;
  if (criticalFailed) {
    status = "unhealthy";
  } else if (nonCriticalFailed) {
    status = "degraded";
  } else {
    status = "healthy";
  }

  const failCount = probes.filter((p) => !p.ok).length;
  const summary =
    status === "healthy"
      ? `All ${probes.length} probes passed`
      : `${failCount}/${probes.length} probe(s) failed — status: ${status}`;

  return {
    status,
    probes,
    summary,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Format a HealthCheckResult for console output.
 *
 * @param result - The health check result to format
 * @returns Multi-line string suitable for printing to stdout
 */
export function formatHealthResult(result: HealthCheckResult): string {
  const icon = result.status === "healthy" ? "✅" : result.status === "degraded" ? "⚠️ " : "❌";
  const lines: string[] = [
    `${icon} BMAD Copilot Factory — ${result.status.toUpperCase()}`,
    `   ${result.summary}`,
    `   Checked at: ${result.timestamp}`,
    "",
  ];

  for (const probe of result.probes) {
    const probeIcon = probe.ok ? "  ✓" : probe.critical ? "  ✗" : "  ⚠";
    lines.push(`${probeIcon} [${probe.name}] ${probe.message}`);
  }

  return lines.join("\n");
}

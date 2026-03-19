/**
 * Metrics Collector — OpenTelemetry metrics for BMAD Copilot Factory
 *
 * Tracks key operational metrics:
 * - Stories processed (counter, by status)
 * - Agent dispatch duration (histogram, by agent + phase)
 * - Review pass count (counter, by story)
 * - Quality gate verdicts (counter, by verdict)
 * - Active sessions (up/down gauge)
 * - Stall detections (counter)
 *
 * When OTEL_ENABLED=true, exports metrics via OTLP to Prometheus/Grafana.
 * When disabled, all metric operations are no-ops.
 *
 * @module observability/metrics
 */

import {
  metrics,
  type Counter,
  type Histogram,
  type UpDownCounter,
  type Meter,
} from "@opentelemetry/api";
import { MeterProvider, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { Resource } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions";

// ─────────────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────────────

/** Metrics configuration. */
export interface MetricsConfig {
  /** Whether metrics collection is enabled */
  enabled: boolean;
  /** OTLP endpoint for metric export */
  endpoint: string;
  /** Metric export interval in milliseconds */
  exportIntervalMs: number;
  /** Service name for metrics */
  serviceName: string;
}

/**
 * Load metrics configuration from environment variables.
 */
export function loadMetricsConfig(): MetricsConfig {
  return {
    enabled: process.env.OTEL_ENABLED === "true",
    endpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT || "http://localhost:4317",
    exportIntervalMs: Number(process.env.OTEL_METRICS_INTERVAL_MS) || 30_000,
    serviceName: process.env.OTEL_SERVICE_NAME || "bmad-copilot-factory",
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Provider Initialization
// ─────────────────────────────────────────────────────────────────────────────

let meterProvider: MeterProvider | null = null;

/**
 * Initialize the metrics provider.
 * Call once at application startup. Idempotent.
 */
export function initMetrics(config?: Partial<MetricsConfig>): void {
  if (meterProvider) return;

  const cfg = { ...loadMetricsConfig(), ...config };

  if (!cfg.enabled) return;

  const resource = new Resource({
    [ATTR_SERVICE_NAME]: cfg.serviceName,
    [ATTR_SERVICE_VERSION]: "0.1.0",
  });

  const exporter = new OTLPMetricExporter({ url: cfg.endpoint });
  const reader = new PeriodicExportingMetricReader({
    exporter,
    exportIntervalMillis: cfg.exportIntervalMs,
  });

  meterProvider = new MeterProvider({ resource, readers: [reader] });
  metrics.setGlobalMeterProvider(meterProvider);
}

/**
 * Gracefully shut down the metrics provider (flush pending metrics).
 */
export async function shutdownMetrics(): Promise<void> {
  if (meterProvider) {
    await meterProvider.shutdown();
    meterProvider = null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Meter Access
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Get a meter instance for a component.
 */
function getMeter(name: string): Meter {
  return metrics.getMeter(`bmad.${name}`, "0.1.0");
}

// ─────────────────────────────────────────────────────────────────────────────
// BMAD Metrics
// ─────────────────────────────────────────────────────────────────────────────

/** Lazy-initialized metric instruments. */
let _storiesProcessed: Counter | null = null;
let _storiesDone: Counter | null = null;
let _agentDispatchDuration: Histogram | null = null;
let _reviewPasses: Counter | null = null;
let _gateVerdicts: Counter | null = null;
let _activeSessions: UpDownCounter | null = null;
let _stallDetections: Counter | null = null;
let _sprintCycles: Counter | null = null;

function storiesProcessed(): Counter {
  if (!_storiesProcessed) {
    _storiesProcessed = getMeter("sprint").createCounter("bmad.stories.processed", {
      description: "Total stories processed by the factory",
      unit: "stories",
    });
  }
  return _storiesProcessed;
}

function storiesDone(): Counter {
  if (!_storiesDone) {
    _storiesDone = getMeter("sprint").createCounter("bmad.stories.done", {
      description: "Stories that reached done status",
      unit: "stories",
    });
  }
  return _storiesDone;
}

function agentDispatchDuration(): Histogram {
  if (!_agentDispatchDuration) {
    _agentDispatchDuration = getMeter("agent").createHistogram("bmad.agent.dispatch_duration", {
      description: "Duration of agent dispatch operations",
      unit: "ms",
    });
  }
  return _agentDispatchDuration;
}

function reviewPasses(): Counter {
  if (!_reviewPasses) {
    _reviewPasses = getMeter("quality-gate").createCounter("bmad.review.passes", {
      description: "Total review passes executed",
      unit: "passes",
    });
  }
  return _reviewPasses;
}

function gateVerdicts(): Counter {
  if (!_gateVerdicts) {
    _gateVerdicts = getMeter("quality-gate").createCounter("bmad.gate.verdicts", {
      description: "Quality gate verdicts by outcome",
      unit: "verdicts",
    });
  }
  return _gateVerdicts;
}

function activeSessions(): UpDownCounter {
  if (!_activeSessions) {
    _activeSessions = getMeter("session").createUpDownCounter("bmad.sessions.active", {
      description: "Currently active Copilot SDK sessions",
      unit: "sessions",
    });
  }
  return _activeSessions;
}

function stallDetections(): Counter {
  if (!_stallDetections) {
    _stallDetections = getMeter("stall").createCounter("bmad.stall.detections", {
      description: "Number of stalled stories detected",
      unit: "stalls",
    });
  }
  return _stallDetections;
}

function sprintCycles(): Counter {
  if (!_sprintCycles) {
    _sprintCycles = getMeter("sprint").createCounter("bmad.sprint.cycles", {
      description: "Total sprint cycles executed",
      unit: "cycles",
    });
  }
  return _sprintCycles;
}

// ─────────────────────────────────────────────────────────────────────────────
// Public Recording API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Record that a story was processed.
 */
export function recordStoryProcessed(storyId: string, phase: string): void {
  storiesProcessed().add(1, { "story.id": storyId, "story.phase": phase });
}

/**
 * Record that a story reached "done".
 */
export function recordStoryDone(storyId: string): void {
  storiesDone().add(1, { "story.id": storyId });
}

/**
 * Record the duration of an agent dispatch.
 */
export function recordDispatchDuration(
  agentName: string,
  phase: string,
  durationMs: number,
  success: boolean,
): void {
  agentDispatchDuration().record(durationMs, {
    "agent.name": agentName,
    "agent.phase": phase,
    "dispatch.success": String(success),
  });
}

/**
 * Record a review pass.
 */
export function recordReviewPass(storyId: string, passNumber: number): void {
  reviewPasses().add(1, { "story.id": storyId, "review.pass_number": passNumber });
}

/**
 * Record a quality gate verdict.
 */
export function recordGateVerdict(
  storyId: string,
  verdict: "PASS" | "FAIL" | "ESCALATE",
  score: number,
): void {
  gateVerdicts().add(1, {
    "story.id": storyId,
    "gate.verdict": verdict,
    "gate.score": score,
  });
}

/**
 * Record a session being opened.
 */
export function recordSessionOpen(agentName: string): void {
  activeSessions().add(1, { "agent.name": agentName });
}

/**
 * Record a session being closed.
 */
export function recordSessionClose(agentName: string): void {
  activeSessions().add(-1, { "agent.name": agentName });
}

/**
 * Record a stall detection.
 */
export function recordStallDetection(storyId: string, phase: string, stalledMinutes: number): void {
  stallDetections().add(1, {
    "story.id": storyId,
    "story.phase": phase,
    "stall.duration_minutes": stalledMinutes,
  });
}

/**
 * Record a sprint cycle execution.
 */
export function recordSprintCycle(sprintNumber: number, storiesProcessed: number): void {
  sprintCycles().add(1, {
    "sprint.number": sprintNumber,
    "sprint.stories_processed": storiesProcessed,
  });
}

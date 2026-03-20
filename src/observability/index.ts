/**
 * Observability Module — Barrel exports
 *
 * Production-grade observability stack for the BMAD Copilot Factory:
 * - Structured logging (JSON / human-readable)
 * - OpenTelemetry tracing (distributed spans)
 * - OpenTelemetry metrics (counters, histograms, gauges)
 * - Stall detection (stuck story alerting)
 *
 * @module observability
 */

// Logger
export { Logger, loadLoggerConfig } from "./logger.js";
export type { LogLevel, LogFormat, LogEntry, LoggerConfig } from "./logger.js";

// Tracing
export {
  initTracing,
  shutdownTracing,
  getTracer,
  withSpan,
  startChildSpan,
  traceSprintCycle,
  traceStoryProcessing,
  traceAgentDispatch,
  traceQualityGate,
  loadTracingConfig,
} from "./tracing.js";
export type { TracingConfig } from "./tracing.js";

// Metrics
export {
  initMetrics,
  shutdownMetrics,
  loadMetricsConfig,
  recordStoryProcessed,
  recordStoryDone,
  recordDispatchDuration,
  recordReviewPass,
  recordGateVerdict,
  recordSessionOpen,
  recordSessionClose,
  recordStallDetection,
  recordSprintCycle,
} from "./metrics.js";
export type { MetricsConfig } from "./metrics.js";

// Stall Detector
export {
  StallDetector,
  DEFAULT_STALL_THRESHOLDS,
} from "./stall-detector.js";
export type {
  StallablePhase,
  StallThresholds,
  StallEvent,
  StallEventHandler,
  StallDetectorConfig,
} from "./stall-detector.js";

// Cost Tracker
export { CostTracker } from "./cost-tracker.js";
export type { UsageRecord, UsageSummary } from "./cost-tracker.js";

/**
 * OpenTelemetry Tracing — Distributed tracing for BMAD Copilot Factory
 *
 * Instruments the autonomous factory with spans for:
 * - Sprint cycles (root span)
 * - Story processing (child span per story)
 * - Agent dispatches (child span per dispatch)
 * - Quality gate evaluations (child span per review pass)
 *
 * When OTEL_ENABLED=true, exports traces to an OTLP endpoint
 * (e.g., Jaeger, Grafana Tempo). When disabled, uses a NoOp tracer.
 *
 * Environment variables:
 * - OTEL_ENABLED — "true" to enable (default: "false")
 * - OTEL_SERVICE_NAME — service name (default: "bmad-copilot-factory")
 * - OTEL_EXPORTER_OTLP_ENDPOINT — OTLP gRPC endpoint (default: "http://localhost:4317")
 *
 * @module observability/tracing
 */

import {
  trace,
  context,
  SpanKind,
  SpanStatusCode,
  type Tracer,
  type Span,
  type Context,
} from "@opentelemetry/api";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { BatchSpanProcessor, ConsoleSpanExporter } from "@opentelemetry/sdk-trace-base";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { Resource } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions";

// ─────────────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────────────

/** Tracing configuration loaded from environment. */
export interface TracingConfig {
  /** Whether tracing is enabled */
  enabled: boolean;
  /** OTLP endpoint URL */
  endpoint: string;
  /** Service name for traces */
  serviceName: string;
  /** Also log spans to console (for debugging) */
  consoleExport: boolean;
}

/**
 * Load tracing configuration from environment variables.
 */
export function loadTracingConfig(): TracingConfig {
  return {
    enabled: process.env.OTEL_ENABLED === "true",
    endpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT || "http://localhost:4317",
    serviceName: process.env.OTEL_SERVICE_NAME || "bmad-copilot-factory",
    consoleExport: process.env.OTEL_CONSOLE_EXPORT === "true",
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Provider Initialization
// ─────────────────────────────────────────────────────────────────────────────

let provider: NodeTracerProvider | null = null;

/**
 * Initialize the OpenTelemetry tracing provider.
 * Call once at application startup. Safe to call multiple times (idempotent).
 *
 * @param config - Tracing configuration (defaults to env-based config)
 */
export function initTracing(config?: Partial<TracingConfig>): void {
  if (provider) return; // Already initialized

  const cfg = { ...loadTracingConfig(), ...config };

  if (!cfg.enabled) {
    // NoOp — tracing calls become no-ops via the default API tracer
    return;
  }

  const resource = new Resource({
    [ATTR_SERVICE_NAME]: cfg.serviceName,
    [ATTR_SERVICE_VERSION]: "0.1.0",
  });

  provider = new NodeTracerProvider({ resource });

  // OTLP exporter → Jaeger/Tempo/etc.
  // Append /v1/traces — the SDK does not auto-append when `url` is passed directly
  const tracesUrl = cfg.endpoint.replace(/\/+$/, "") + "/v1/traces";
  const otlpExporter = new OTLPTraceExporter({ url: tracesUrl });
  provider.addSpanProcessor(new BatchSpanProcessor(otlpExporter));

  // Optional console exporter for debugging
  if (cfg.consoleExport) {
    provider.addSpanProcessor(new BatchSpanProcessor(new ConsoleSpanExporter()));
  }

  provider.register();
}

/**
 * Gracefully shut down the tracing provider (flush pending spans).
 */
export async function shutdownTracing(): Promise<void> {
  if (provider) {
    await provider.shutdown();
    provider = null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Tracer Access
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Get a tracer instance for a component.
 *
 * @param name - Component name (e.g., "sprint-runner")
 * @returns OTel Tracer instance (NoOp if tracing is disabled)
 */
export function getTracer(name: string): Tracer {
  return trace.getTracer(`bmad.${name}`, "0.1.0");
}

// ─────────────────────────────────────────────────────────────────────────────
// Instrumentation Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Wrap an async function in an OTel span. Automatically handles
 * error recording and span status.
 *
 * @param tracer - Tracer instance
 * @param spanName - Name for the span
 * @param attributes - Span attributes
 * @param fn - Async function to instrument
 * @returns The function's return value
 */
export async function withSpan<T>(
  tracer: Tracer,
  spanName: string,
  attributes: Record<string, string | number | boolean>,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  return tracer.startActiveSpan(
    spanName,
    { kind: SpanKind.INTERNAL, attributes },
    async (span: Span) => {
      try {
        const result = await fn(span);
        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (err) {
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: err instanceof Error ? err.message : String(err),
        });
        span.recordException(err instanceof Error ? err : new Error(String(err)));
        throw err;
      } finally {
        span.end();
      }
    },
  );
}

/**
 * Create a child span from the current context.
 * Useful for manual span management when `withSpan` isn't flexible enough.
 *
 * @param tracer - Tracer instance
 * @param spanName - Name for the child span
 * @param attributes - Initial span attributes
 * @returns The span and its context
 */
export function startChildSpan(
  tracer: Tracer,
  spanName: string,
  attributes?: Record<string, string | number | boolean>,
): { span: Span; ctx: Context } {
  const ctx = context.active();
  const span = tracer.startSpan(spanName, { kind: SpanKind.INTERNAL, attributes }, ctx);
  const childCtx = trace.setSpan(ctx, span);
  return { span, ctx: childCtx };
}

// ─────────────────────────────────────────────────────────────────────────────
// BMAD-Specific Span Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create a span for a sprint cycle.
 */
export async function traceSprintCycle<T>(
  storyCount: number,
  sprintNumber: number,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  const tracer = getTracer("sprint-runner");
  return withSpan(
    tracer,
    "sprint.cycle",
    {
      "sprint.number": sprintNumber,
      "sprint.story_count": storyCount,
    },
    fn,
  );
}

/**
 * Create a span for processing a single story.
 */
export async function traceStoryProcessing<T>(
  storyId: string,
  phase: string,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  const tracer = getTracer("sprint-runner");
  return withSpan(
    tracer,
    "story.process",
    {
      "story.id": storyId,
      "story.phase": phase,
    },
    fn,
  );
}

/**
 * Create a span for an agent dispatch.
 */
export async function traceAgentDispatch<T>(
  agentName: string,
  phase: string,
  storyId: string,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  const tracer = getTracer("agent-dispatcher");
  return withSpan(
    tracer,
    "agent.dispatch",
    {
      "agent.name": agentName,
      "agent.phase": phase,
      "story.id": storyId,
    },
    fn,
  );
}

/**
 * Create a span for a quality gate evaluation.
 */
export async function traceQualityGate<T>(
  storyId: string,
  passNumber: number,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  const tracer = getTracer("quality-gate");
  return withSpan(
    tracer,
    "quality_gate.evaluate",
    {
      "story.id": storyId,
      "review.pass_number": passNumber,
    },
    fn,
  );
}

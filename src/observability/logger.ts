/**
 * Structured Logger — Production-grade logging for BMAD Copilot Factory
 *
 * Replaces console.log with structured JSON or human-readable log entries.
 * Each log entry includes:
 * - ISO-8601 timestamp
 * - Log level (debug, info, warn, error)
 * - Component name (e.g., "sprint-runner", "agent-dispatcher")
 * - Structured context fields
 *
 * Output modes:
 * - `json`  — one JSON object per line (for log aggregators, Grafana Loki)
 * - `human` — colored, human-readable (for local development)
 *
 * @module observability/logger
 */

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/** Supported log levels, ordered by severity. */
export type LogLevel = "debug" | "info" | "warn" | "error";

/** Output format for log entries. */
export type LogFormat = "json" | "human";

/** Numeric severity mapping for level comparison. */
const LEVEL_SEVERITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

/** ANSI color codes for human-readable output. */
const LEVEL_COLOR: Record<LogLevel, string> = {
  debug: "\x1b[90m",  // gray
  info: "\x1b[36m",   // cyan
  warn: "\x1b[33m",   // yellow
  error: "\x1b[31m",  // red
};

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";

/** Structured log entry. */
export interface LogEntry {
  /** ISO-8601 timestamp */
  timestamp: string;
  /** Log level */
  level: LogLevel;
  /** Component or module name */
  component: string;
  /** Human-readable message */
  message: string;
  /** Structured context fields */
  context?: Record<string, unknown>;
  /** Error details (if applicable) */
  error?: {
    message: string;
    stack?: string;
  };
}

/** Logger configuration. */
export interface LoggerConfig {
  /** Minimum log level to emit */
  level: LogLevel;
  /** Output format */
  format: LogFormat;
  /** Default context fields added to every entry */
  defaultContext?: Record<string, unknown>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Logger Class
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Structured logger with component context.
 *
 * Usage:
 * ```ts
 * const log = Logger.child("sprint-runner");
 * log.info("Sprint cycle started", { storyCount: 5 });
 * log.error("Dispatch failed", { storyId: "STORY-001" }, err);
 * ```
 */
export class Logger {
  private component: string;
  private config: LoggerConfig;
  private childContext: Record<string, unknown>;

  private constructor(
    component: string,
    config: LoggerConfig,
    childContext: Record<string, unknown> = {},
  ) {
    this.component = component;
    this.config = config;
    this.childContext = childContext;
  }

  // ── Static factory ──────────────────────────────────────────────────────

  /** Global logger configuration — set once at startup. */
  private static globalConfig: LoggerConfig = {
    level: "info",
    format: "human",
  };

  /**
   * Configure the global logger. Call once during startup.
   *
   * @param config - Logger configuration overrides
   */
  static configure(config: Partial<LoggerConfig>): void {
    Logger.globalConfig = { ...Logger.globalConfig, ...config };
  }

  /**
   * Create a child logger for a specific component.
   *
   * @param component - Component name (e.g., "sprint-runner", "quality-gate")
   * @param context - Additional context fields for all entries from this logger
   * @returns A new Logger instance
   */
  static child(component: string, context?: Record<string, unknown>): Logger {
    return new Logger(component, Logger.globalConfig, context);
  }

  // ── Log methods ─────────────────────────────────────────────────────────

  /** Log a debug-level message. */
  debug(message: string, context?: Record<string, unknown>): void {
    this.log("debug", message, context);
  }

  /** Log an info-level message. */
  info(message: string, context?: Record<string, unknown>): void {
    this.log("info", message, context);
  }

  /** Log a warning-level message. */
  warn(message: string, context?: Record<string, unknown>): void {
    this.log("warn", message, context);
  }

  /** Log an error-level message. */
  error(message: string, context?: Record<string, unknown>, err?: Error): void {
    this.log("error", message, context, err);
  }

  // ── Internal ────────────────────────────────────────────────────────────

  private log(
    level: LogLevel,
    message: string,
    context?: Record<string, unknown>,
    err?: Error,
  ): void {
    if (LEVEL_SEVERITY[level] < LEVEL_SEVERITY[this.config.level]) return;

    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      component: this.component,
      message,
      context: {
        ...this.config.defaultContext,
        ...this.childContext,
        ...context,
      },
    };

    if (err) {
      entry.error = {
        message: err.message,
        stack: err.stack,
      };
    }

    // Remove empty context
    if (entry.context && Object.keys(entry.context).length === 0) {
      delete entry.context;
    }

    this.emit(entry);
  }

  private emit(entry: LogEntry): void {
    const output =
      this.config.format === "json"
        ? this.formatJson(entry)
        : this.formatHuman(entry);

    if (entry.level === "error") {
      process.stderr.write(output + "\n");
    } else {
      process.stdout.write(output + "\n");
    }
  }

  private formatJson(entry: LogEntry): string {
    return JSON.stringify(entry);
  }

  private formatHuman(entry: LogEntry): string {
    const color = LEVEL_COLOR[entry.level];
    const time = entry.timestamp.slice(11, 23); // HH:MM:SS.mmm
    const lvl = entry.level.toUpperCase().padEnd(5);
    const comp = `${BOLD}[${entry.component}]${RESET}`;
    const ctx = entry.context
      ? ` ${LEVEL_COLOR.debug}${JSON.stringify(entry.context)}${RESET}`
      : "";
    const errLine = entry.error
      ? `\n  ${LEVEL_COLOR.error}↳ ${entry.error.message}${RESET}`
      : "";

    return `${LEVEL_COLOR.debug}${time}${RESET} ${color}${lvl}${RESET} ${comp} ${entry.message}${ctx}${errLine}`;
  }
}

/**
 * Load logger configuration from environment variables.
 *
 * Environment variables:
 * - `LOG_LEVEL` — "debug" | "info" | "warn" | "error" (default: "info")
 * - `LOG_FORMAT` — "json" | "human" (default: "human")
 */
export function loadLoggerConfig(): Partial<LoggerConfig> {
  return {
    level: (process.env.LOG_LEVEL as LogLevel) || "info",
    format: (process.env.LOG_FORMAT as LogFormat) || "human",
  };
}

/**
 * Stall Detector — Detects stuck stories and triggers escalation
 *
 * Monitors stories that have been in the same lifecycle phase for too long.
 * When a story exceeds the configured stall threshold, it emits a stall event
 * and can optionally auto-escalate (move to "review" with a human escalation flag).
 *
 * Detection strategy:
 * - Tracks when each story entered its current phase (via timestamps in memory)
 * - On each check cycle, compares elapsed time against thresholds
 * - Different phases have different thresholds (dev is longer than review)
 *
 * Integration points:
 * - Called by SprintRunner between story processing iterations
 * - Emits events consumed by the event logger
 * - Records metrics via the metrics collector
 *
 * Ported from Claw Loop stall detection (orchestrator.md reference).
 *
 * @module observability/stall-detector
 */

import { Logger } from "./logger.js";
import { recordStallDetection } from "./metrics.js";

const log = Logger.child("stall-detector");

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/** Lifecycle phases with stall thresholds. */
export type StallablePhase = "ready-for-dev" | "in-progress" | "review";

/** Per-phase stall thresholds in minutes. */
export interface StallThresholds {
  /** Max minutes a story can sit in ready-for-dev before stall alert */
  "ready-for-dev": number;
  /** Max minutes a story can be in-progress before stall alert */
  "in-progress": number;
  /** Max minutes a story can be in review before stall alert */
  review: number;
}

/** Default stall thresholds (minutes). */
export const DEFAULT_STALL_THRESHOLDS: StallThresholds = {
  "ready-for-dev": 30,
  "in-progress": 60,
  review: 30,
};

/** A detected stall event. */
export interface StallEvent {
  /** Story ID */
  storyId: string;
  /** Phase the story is stuck in */
  phase: StallablePhase;
  /** How long the story has been in this phase (minutes) */
  stalledMinutes: number;
  /** Configured threshold for this phase (minutes) */
  thresholdMinutes: number;
  /** ISO-8601 timestamp when stall was detected */
  detectedAt: string;
  /** Whether this is a repeat detection (story was already flagged) */
  repeat: boolean;
}

/** Callback for stall events. */
export type StallEventHandler = (event: StallEvent) => void;

/** Stall detector configuration. */
export interface StallDetectorConfig {
  /** Per-phase thresholds in minutes */
  thresholds: StallThresholds;
  /** Whether to auto-escalate stalled stories */
  autoEscalate: boolean;
  /** Check interval in milliseconds (for continuous mode) */
  checkIntervalMs: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tracked State
// ─────────────────────────────────────────────────────────────────────────────

/** Internal tracking record for a story's phase entry time. */
interface PhaseEntry {
  storyId: string;
  phase: StallablePhase;
  enteredAt: Date;
  alreadyFlagged: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// StallDetector
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Monitors stories for stalls (stuck in a phase too long).
 *
 * Usage:
 * ```ts
 * const detector = new StallDetector({ thresholds: DEFAULT_STALL_THRESHOLDS });
 *
 * // Register a story entering a phase
 * detector.trackPhaseEntry("STORY-001", "in-progress");
 *
 * // Periodically check for stalls
 * const stalls = detector.check();
 *
 * // When a story advances, clear its tracking
 * detector.clearStory("STORY-001");
 * ```
 */
export class StallDetector {
  private config: StallDetectorConfig;
  private tracked = new Map<string, PhaseEntry>();
  private onStall: StallEventHandler | null = null;
  private checkTimer: ReturnType<typeof setInterval> | null = null;

  constructor(config: Partial<StallDetectorConfig> = {}) {
    this.config = {
      thresholds: config.thresholds ?? DEFAULT_STALL_THRESHOLDS,
      autoEscalate: config.autoEscalate ?? false,
      checkIntervalMs: config.checkIntervalMs ?? 60_000, // 1 minute
    };
  }

  /**
   * Register a callback for stall events.
   */
  onStallDetected(handler: StallEventHandler): void {
    this.onStall = handler;
  }

  /**
   * Track a story entering a new phase.
   * If the story was already tracked, resets the entry time.
   *
   * @param storyId - Story identifier
   * @param phase - The phase the story just entered
   */
  trackPhaseEntry(storyId: string, phase: StallablePhase): void {
    this.tracked.set(storyId, {
      storyId,
      phase,
      enteredAt: new Date(),
      alreadyFlagged: false,
    });

    log.debug("Tracking phase entry", { storyId, phase });
  }

  /**
   * Stop tracking a story (it advanced or completed).
   */
  clearStory(storyId: string): void {
    this.tracked.delete(storyId);
    log.debug("Cleared tracking", { storyId });
  }

  /**
   * Check all tracked stories for stalls.
   *
   * @returns Array of stall events detected
   */
  check(): StallEvent[] {
    const now = new Date();
    const stalls: StallEvent[] = [];

    for (const [storyId, entry] of this.tracked) {
      const elapsedMs = now.getTime() - entry.enteredAt.getTime();
      const elapsedMinutes = elapsedMs / 60_000;
      const threshold = this.config.thresholds[entry.phase];

      if (elapsedMinutes >= threshold) {
        const event: StallEvent = {
          storyId,
          phase: entry.phase,
          stalledMinutes: Math.round(elapsedMinutes),
          thresholdMinutes: threshold,
          detectedAt: now.toISOString(),
          repeat: entry.alreadyFlagged,
        };

        stalls.push(event);

        if (!entry.alreadyFlagged) {
          log.warn("Stall detected", {
            storyId,
            phase: entry.phase,
            stalledMinutes: Math.round(elapsedMinutes),
            threshold,
          });
          entry.alreadyFlagged = true;
          recordStallDetection(storyId, entry.phase, Math.round(elapsedMinutes));
        }

        this.onStall?.(event);
      }
    }

    return stalls;
  }

  /**
   * Start continuous stall checking on an interval.
   */
  startContinuousCheck(): void {
    if (this.checkTimer) return;

    log.info("Starting continuous stall detection", {
      intervalMs: this.config.checkIntervalMs,
      thresholds: this.config.thresholds,
    });

    this.checkTimer = setInterval(() => {
      this.check();
    }, this.config.checkIntervalMs);

    // Don't block process exit
    if (this.checkTimer.unref) {
      this.checkTimer.unref();
    }
  }

  /**
   * Stop continuous stall checking.
   */
  stopContinuousCheck(): void {
    if (this.checkTimer) {
      clearInterval(this.checkTimer);
      this.checkTimer = null;
      log.info("Stopped continuous stall detection");
    }
  }

  /**
   * Get the current tracking state (for debugging / health checks).
   */
  getTrackedStories(): Array<{
    storyId: string;
    phase: StallablePhase;
    elapsedMinutes: number;
    flagged: boolean;
  }> {
    const now = new Date();
    return Array.from(this.tracked.values()).map((entry) => ({
      storyId: entry.storyId,
      phase: entry.phase,
      elapsedMinutes: Math.round((now.getTime() - entry.enteredAt.getTime()) / 60_000),
      flagged: entry.alreadyFlagged,
    }));
  }

  /**
   * Reset all tracking state.
   */
  reset(): void {
    this.tracked.clear();
    log.debug("Tracking state reset");
  }
}

/**
 * Stall Detector — Unit Tests
 *
 * Tests stall detection logic:
 * - Phase entry tracking
 * - Stall detection with thresholds
 * - Repeat detection flagging
 * - Continuous check lifecycle
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { StallDetector, DEFAULT_STALL_THRESHOLDS } from "../src/observability/stall-detector.js";

// Mock the metrics module to avoid OTel dependency
vi.mock("../src/observability/metrics.js", () => ({
  recordStallDetection: vi.fn(),
}));

describe("StallDetector", () => {
  let detector: StallDetector;

  beforeEach(() => {
    vi.useFakeTimers();
    detector = new StallDetector({
      thresholds: {
        "ready-for-dev": 5,  // 5 minutes for fast tests
        "in-progress": 10,
        review: 5,
      },
    });
  });

  afterEach(() => {
    detector.stopContinuousCheck();
    vi.useRealTimers();
  });

  describe("trackPhaseEntry", () => {
    it("should track a story entering a phase", () => {
      detector.trackPhaseEntry("STORY-001", "in-progress");
      const tracked = detector.getTrackedStories();

      expect(tracked).toHaveLength(1);
      expect(tracked[0].storyId).toBe("STORY-001");
      expect(tracked[0].phase).toBe("in-progress");
      expect(tracked[0].elapsedMinutes).toBe(0);
    });

    it("should reset tracking on re-entry", () => {
      detector.trackPhaseEntry("STORY-001", "in-progress");
      vi.advanceTimersByTime(3 * 60_000); // 3 minutes
      detector.trackPhaseEntry("STORY-001", "review");
      const tracked = detector.getTrackedStories();

      expect(tracked).toHaveLength(1);
      expect(tracked[0].phase).toBe("review");
      expect(tracked[0].elapsedMinutes).toBe(0);
    });
  });

  describe("clearStory", () => {
    it("should stop tracking a story", () => {
      detector.trackPhaseEntry("STORY-001", "in-progress");
      detector.clearStory("STORY-001");

      expect(detector.getTrackedStories()).toHaveLength(0);
    });

    it("should be safe to clear a non-tracked story", () => {
      expect(() => detector.clearStory("NONEXISTENT")).not.toThrow();
    });
  });

  describe("check", () => {
    it("should detect no stalls when within threshold", () => {
      detector.trackPhaseEntry("STORY-001", "in-progress");
      vi.advanceTimersByTime(5 * 60_000); // 5 min < 10 min threshold

      const stalls = detector.check();
      expect(stalls).toHaveLength(0);
    });

    it("should detect stall when threshold exceeded", () => {
      detector.trackPhaseEntry("STORY-001", "in-progress");
      vi.advanceTimersByTime(11 * 60_000); // 11 min > 10 min threshold

      const stalls = detector.check();
      expect(stalls).toHaveLength(1);
      expect(stalls[0].storyId).toBe("STORY-001");
      expect(stalls[0].phase).toBe("in-progress");
      expect(stalls[0].stalledMinutes).toBe(11);
      expect(stalls[0].thresholdMinutes).toBe(10);
      expect(stalls[0].repeat).toBe(false);
    });

    it("should mark subsequent detections as repeat", () => {
      detector.trackPhaseEntry("STORY-001", "in-progress");
      vi.advanceTimersByTime(11 * 60_000);

      detector.check(); // First detection
      const stalls = detector.check(); // Second detection

      expect(stalls).toHaveLength(1);
      expect(stalls[0].repeat).toBe(true);
    });

    it("should detect stalls for multiple stories", () => {
      detector.trackPhaseEntry("STORY-001", "ready-for-dev");
      detector.trackPhaseEntry("STORY-002", "review");
      vi.advanceTimersByTime(6 * 60_000); // 6 min > 5 min threshold for both

      const stalls = detector.check();
      expect(stalls).toHaveLength(2);
    });

    it("should use phase-specific thresholds", () => {
      detector.trackPhaseEntry("STORY-001", "ready-for-dev"); // threshold: 5 min
      detector.trackPhaseEntry("STORY-002", "in-progress");    // threshold: 10 min
      vi.advanceTimersByTime(7 * 60_000); // 7 min — only ready-for-dev stalls

      const stalls = detector.check();
      expect(stalls).toHaveLength(1);
      expect(stalls[0].storyId).toBe("STORY-001");
    });

    it("should call the stall event handler", () => {
      const handler = vi.fn();
      detector.onStallDetected(handler);

      detector.trackPhaseEntry("STORY-001", "review");
      vi.advanceTimersByTime(6 * 60_000);
      detector.check();

      expect(handler).toHaveBeenCalledOnce();
      expect(handler.mock.calls[0][0].storyId).toBe("STORY-001");
    });
  });

  describe("reset", () => {
    it("should clear all tracking state", () => {
      detector.trackPhaseEntry("STORY-001", "in-progress");
      detector.trackPhaseEntry("STORY-002", "review");
      detector.reset();

      expect(detector.getTrackedStories()).toHaveLength(0);
    });
  });

  describe("getTrackedStories", () => {
    it("should return current tracking info", () => {
      detector.trackPhaseEntry("STORY-001", "in-progress");
      vi.advanceTimersByTime(3 * 60_000);

      const stories = detector.getTrackedStories();
      expect(stories).toHaveLength(1);
      expect(stories[0].elapsedMinutes).toBe(3);
      expect(stories[0].flagged).toBe(false);
    });
  });
});

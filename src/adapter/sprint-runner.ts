/**
 * Sprint Runner — Autonomous Story Lifecycle Engine
 *
 * Iterates through stories in sprint-status.yaml and drives each one
 * through the BMAD lifecycle: create → dev → review → done.
 *
 * This is the "main loop" of the autonomous factory. It reads the sprint
 * status, finds stories that need work, dispatches them to the right agent,
 * and advances the lifecycle.
 *
 * Key behaviors:
 * - Processes stories in priority order (as listed in sprint-status.yaml)
 * - One story at a time (sequential, not parallel — for now)
 * - Respects review pass limit (max 3 by default) before escalation
 * - Emits events for observability
 *
 * @module adapter/sprint-runner
 */

import { readSprintStatus } from "../tools/sprint-status.js";
import type { SprintStatusData, SprintStory } from "../tools/sprint-status.js";
import type { BmadConfig } from "../config/config.js";
import type { AgentDispatcher, DispatchResult, WorkPhase } from "./agent-dispatcher.js";
import { ReviewOrchestrator } from "../quality-gates/review-orchestrator.js";
import type { ReviewOrchestratorEvent } from "../quality-gates/review-orchestrator.js";
import { Logger } from "../observability/logger.js";
import { traceSprintCycle, traceStoryProcessing } from "../observability/tracing.js";
import { recordStoryProcessed, recordStoryDone, recordSprintCycle } from "../observability/metrics.js";
import type { StallDetector, StallablePhase } from "../observability/stall-detector.js";

const log = Logger.child("sprint-runner");

/**
 * Sprint runner lifecycle events.
 */
export type SprintEvent =
  | { type: "sprint-start"; storyCount: number }
  | { type: "story-start"; storyId: string; phase: WorkPhase }
  | { type: "story-complete"; storyId: string; phase: WorkPhase; result: DispatchResult }
  | { type: "story-escalated"; storyId: string; reason: string }
  | { type: "story-failed"; storyId: string; error: string }
  | { type: "sprint-complete"; storiesProcessed: number; storiesDone: number }
  | { type: "sprint-idle"; message: string }
  | { type: "quality-gate"; storyId: string; event: ReviewOrchestratorEvent };

/**
 * Callback for sprint events.
 */
export type SprintEventHandler = (event: SprintEvent) => void;

/**
 * Options for running a sprint cycle.
 */
export interface SprintRunOptions {
  /** Process only this story (skip others) */
  storyFilter?: string;
  /** Run only one cycle (don't loop) */
  singlePass?: boolean;
  /** Streaming callback for agent output */
  onDelta?: (delta: string) => void;
  /** Event callback for lifecycle events */
  onEvent?: SprintEventHandler;
  /** Whether to actually dispatch (false = dry run) */
  live?: boolean;
}

/**
 * SprintRunner drives stories through the BMAD lifecycle autonomously.
 */
export class SprintRunner {
  private dispatcher: AgentDispatcher;
  private config: BmadConfig;
  private reviewOrchestrator: ReviewOrchestrator;
  private stallDetector: StallDetector | null;

  constructor(dispatcher: AgentDispatcher, config: BmadConfig, stallDetector?: StallDetector) {
    this.dispatcher = dispatcher;
    this.config = config;
    this.reviewOrchestrator = new ReviewOrchestrator(dispatcher, config);
    this.stallDetector = stallDetector ?? null;
  }

  /**
   * Run one sprint cycle — process all actionable stories.
   *
   * @returns Number of stories that reached 'done' in this cycle
   */
  async runCycle(opts: SprintRunOptions = {}): Promise<number> {
    const { storyFilter, onDelta, onEvent, live = true } = opts;

    // Read current sprint status
    let sprintData: SprintStatusData;
    try {
      sprintData = await readSprintStatus(this.config.sprintStatusPath);
    } catch {
      onEvent?.({ type: "sprint-idle", message: "No sprint-status.yaml found — nothing to do." });
      return 0;
    }

    const stories = sprintData.sprint.stories;
    const actionable = stories.filter((s) => {
      if (storyFilter && s.id !== storyFilter) return false;
      return s.status !== "done";
    });

    if (actionable.length === 0) {
      onEvent?.({ type: "sprint-idle", message: "All stories are done or blocked." });
      return 0;
    }

    onEvent?.({ type: "sprint-start", storyCount: actionable.length });
    log.info("Sprint cycle starting", {
      sprintNumber: sprintData.sprint.number,
      storyCount: actionable.length,
      stories: actionable.map((s) => s.id),
    });

    let doneCount = 0;

    const processCycle = async () => {
      for (const story of actionable) {
        try {
          const advanced = await traceStoryProcessing(
            story.id,
            this.nextPhase(story) ?? "unknown",
            async (span) => {
              const result = await this.advanceStory(story, { onDelta, onEvent, live });
              recordStoryProcessed(story.id, this.nextPhase(story) ?? "unknown");
              if (result) {
                recordStoryDone(story.id);
                span.setAttribute("story.done", true);
              }
              return result;
            },
          );
          if (advanced) doneCount++;
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : String(err);
          onEvent?.({ type: "story-failed", storyId: story.id, error: errorMsg });
          log.error("Story processing failed", { storyId: story.id }, err instanceof Error ? err : undefined);
        }
      }
    };

    // Wrap in sprint cycle trace if OTel is active
    await traceSprintCycle(
      actionable.length,
      sprintData.sprint.number,
      async () => { await processCycle(); },
    );

    recordSprintCycle(sprintData.sprint.number, actionable.length);

    onEvent?.({
      type: "sprint-complete",
      storiesProcessed: actionable.length,
      storiesDone: doneCount,
    });

    log.info("Sprint cycle complete", {
      storiesProcessed: actionable.length,
      storiesDone: doneCount,
    });

    return doneCount;
  }

  /**
   * Advance a single story through its next lifecycle phase.
   *
   * @returns true if the story reached 'done'
   */
  private async advanceStory(
    story: SprintStory,
    opts: Pick<SprintRunOptions, "onDelta" | "onEvent" | "live">,
  ): Promise<boolean> {
    const { onDelta, onEvent, live = true } = opts;

    // Determine the next phase based on current status
    const phase = this.nextPhase(story);
    if (!phase) {
      log.debug("No next phase for story", { storyId: story.id, status: story.status });
      return story.status === "done";
    }

    // Check review pass limit for code review phase
    if (phase === "code-review") {
      const passes = story.reviewPasses ?? 0;
      if (passes >= this.config.reviewPassLimit) {
        onEvent?.({
          type: "story-escalated",
          storyId: story.id,
          reason: `Exceeded ${this.config.reviewPassLimit} review passes — needs human review`,
        });
        return false;
      }
    }

    onEvent?.({ type: "story-start", storyId: story.id, phase });

    // Track phase entry for stall detection
    if (this.stallDetector && isStallablePhase(story.status)) {
      this.stallDetector.trackPhaseEntry(story.id, story.status as StallablePhase);
    }

    if (!live) {
      log.info("Dry run — skipping dispatch", { storyId: story.id, phase });
      onEvent?.({
        type: "story-complete",
        storyId: story.id,
        phase,
        result: { success: true, response: "[dry run]", agentName: "n/a", sessionId: "dry-run" },
      });
      return false;
    }

    // ── Quality Gate: use ReviewOrchestrator for code-review phase ──
    if (phase === "code-review") {
      const orchestrationResult = await this.reviewOrchestrator.run({
        storyId: story.id,
        storyTitle: story.title,
        onDelta,
        onEvent: (reviewEvent) => {
          onEvent?.({ type: "quality-gate", storyId: story.id, event: reviewEvent });
        },
      });

      const fakeResult: DispatchResult = {
        success: orchestrationResult.approved,
        response: orchestrationResult.summary,
        agentName: "bmad-qa",
        sessionId: `review-${story.id}`,
        error: orchestrationResult.escalated ? orchestrationResult.summary : undefined,
      };

      onEvent?.({ type: "story-complete", storyId: story.id, phase, result: fakeResult });

      if (orchestrationResult.escalated) {
        onEvent?.({
          type: "story-escalated",
          storyId: story.id,
          reason: orchestrationResult.summary,
        });
      }

      // Clear stall tracking when story passes review
      if (orchestrationResult.approved) {
        this.stallDetector?.clearStory(story.id);
      }

      return orchestrationResult.approved;
    }

    // ── Standard dispatch for non-review phases ──
    const result = await this.dispatcher.dispatch(
      {
        id: `${story.id}-${phase}`,
        phase,
        storyId: story.id,
        storyTitle: story.title,
      },
      onDelta,
    );

    onEvent?.({ type: "story-complete", storyId: story.id, phase, result });

    if (!result.success) {
      log.error("Dispatch failed for story", { storyId: story.id, phase, error: result.error });
      return false;
    }

    // Check if the story is now done (re-read status after agent made changes)
    const updated = await readSprintStatus(this.config.sprintStatusPath);
    const updatedStory = updated.sprint.stories.find((s) => s.id === story.id);
    const isDone = updatedStory?.status === "done";

    // Clear stall tracking when story completes
    if (isDone) {
      this.stallDetector?.clearStory(story.id);
    }

    return isDone;
  }

  /**
   * Determine the next lifecycle phase for a story based on its current status.
   */
  private nextPhase(story: SprintStory): WorkPhase | null {
    switch (story.status) {
      case "backlog":
        // Stories in backlog need to be moved to ready-for-dev first
        // This is typically a PM/PO action via sprint-planning
        return "sprint-planning";
      case "ready-for-dev":
        return "dev-story";
      case "in-progress":
        // If somehow stuck in-progress, try dev again
        return "dev-story";
      case "review":
        return "code-review";
      case "done":
        return null; // Nothing to do
      default:
        log.warn("Unknown story status", { storyId: story.id, status: story.status });
        return null;
    }
  }

  /**
   * Get a summary of the current sprint state.
   */
  async getSprintSummary(): Promise<string> {
    let sprintData: SprintStatusData;
    try {
      sprintData = await readSprintStatus(this.config.sprintStatusPath);
    } catch {
      return "No sprint-status.yaml found.";
    }

    const stories = sprintData.sprint.stories;
    const byStatus = new Map<string, number>();
    for (const s of stories) {
      byStatus.set(s.status, (byStatus.get(s.status) ?? 0) + 1);
    }

    const lines = [
      `Sprint #${sprintData.sprint.number}: ${sprintData.sprint.goal}`,
      `Stories: ${stories.length}`,
    ];
    for (const [status, count] of byStatus) {
      const icon = status === "done" ? "✅" : status === "review" ? "🔍" : status === "in-progress" ? "🔨" : "📋";
      lines.push(`  ${icon} ${status}: ${count}`);
    }

    return lines.join("\n");
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Phases that the stall detector can monitor. */
const STALLABLE_PHASES = new Set<string>(["ready-for-dev", "in-progress", "review"]);

/**
 * Type guard: is this story status a stallable phase?
 */
function isStallablePhase(status: string): status is StallablePhase {
  return STALLABLE_PHASES.has(status);
}

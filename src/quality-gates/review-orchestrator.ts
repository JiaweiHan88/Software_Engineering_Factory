/**
 * Review Orchestrator — Drives the adversarial review loop.
 *
 * Manages the full review lifecycle for a story:
 *   dev completes → code review → gate evaluation →
 *     PASS → done
 *     FAIL → fix in-place → re-review (up to maxPasses)
 *     ESCALATE → human intervention
 *
 * The orchestrator coordinates between agents (reviewer + fixer)
 * and the quality gate engine. It persists review history to disk
 * so passes survive process restarts.
 *
 * @module quality-gates/review-orchestrator
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import yaml from "js-yaml";

import type {
  ReviewFinding,
  ReviewHistory,
  ReviewPassRecord,
  GateResult,
} from "./types.js";
import { evaluateGate, decideNextAction, formatGateReport, formatReviewTimeline } from "./engine.js";
import type { BmadConfig } from "../config/config.js";
import type { AgentDispatcher, DispatchResult } from "../adapter/agent-dispatcher.js";
import { readSprintStatus, writeSprintStatus } from "../tools/sprint-status.js";
import { Logger } from "../observability/logger.js";
import { traceQualityGate } from "../observability/tracing.js";
import { recordReviewPass, recordGateVerdict } from "../observability/metrics.js";

const log = Logger.child("review-orchestrator");

// ─────────────────────────────────────────────────────────────────────────────
// Review History Persistence
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Get the file path for a story's review history.
 *
 * @param config - BMAD config
 * @param storyId - Story identifier
 * @returns Absolute path to the review history YAML file
 */
function reviewHistoryPath(config: BmadConfig, storyId: string): string {
  return resolve(config.outputDir, "review-history", `${storyId}.review.yaml`);
}

/**
 * Load review history from disk.
 * Returns a fresh history if the file doesn't exist.
 *
 * @param config - BMAD config
 * @param storyId - Story identifier
 * @returns Review history object
 */
export async function loadReviewHistory(
  config: BmadConfig,
  storyId: string,
): Promise<ReviewHistory> {
  const filePath = reviewHistoryPath(config, storyId);
  try {
    const content = await readFile(filePath, "utf-8");
    return yaml.load(content) as ReviewHistory;
  } catch {
    return {
      storyId,
      passes: [],
      status: "in-review",
    };
  }
}

/**
 * Save review history to disk.
 *
 * @param config - BMAD config
 * @param history - Review history to persist
 */
export async function saveReviewHistory(
  config: BmadConfig,
  history: ReviewHistory,
): Promise<void> {
  const filePath = reviewHistoryPath(config, history.storyId);
  await mkdir(dirname(filePath), { recursive: true });
  const content = yaml.dump(history, { lineWidth: 120, noRefs: true });
  await writeFile(filePath, content, "utf-8");
}

// ─────────────────────────────────────────────────────────────────────────────
// Review Orchestrator Events
// ─────────────────────────────────────────────────────────────────────────────

/** Events emitted during the review orchestration. */
export type ReviewOrchestratorEvent =
  | { type: "review-start"; storyId: string; passNumber: number }
  | { type: "review-dispatched"; storyId: string; passNumber: number; agentName: string }
  | { type: "gate-evaluated"; storyId: string; result: GateResult }
  | { type: "fix-start"; storyId: string; passNumber: number; findingCount: number }
  | { type: "fix-dispatched"; storyId: string; passNumber: number; agentName: string }
  | { type: "fix-complete"; storyId: string; passNumber: number }
  | { type: "review-approved"; storyId: string; totalPasses: number }
  | { type: "review-escalated"; storyId: string; reason: string; totalPasses: number }
  | { type: "review-error"; storyId: string; error: string };

/** Callback for review orchestrator events. */
export type ReviewOrchestratorEventHandler = (event: ReviewOrchestratorEvent) => void;

// ─────────────────────────────────────────────────────────────────────────────
// Finding Parser
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse structured findings from an agent's review response.
 *
 * The code reviewer agent is instructed to output findings in a structured format:
 * ```
 * [FINDING:F-001:HIGH:security:src/foo.ts:42]
 * Title of finding
 * Description of the problem.
 * [/FINDING]
 * ```
 *
 * Falls back to heuristic parsing if structured format isn't found.
 *
 * @param response - Raw agent response text
 * @returns Array of parsed findings
 */
export function parseFindings(response: string): ReviewFinding[] {
  const findings: ReviewFinding[] = [];

  // Try structured format first
  const structuredPattern =
    /\[FINDING:([^:]+):([^:]+):([^:]+):([^:]+)(?::(\d+))?\]\s*\n(.*?)\n(.*?)\[\/FINDING\]/gs;

  let match: RegExpExecArray | null;
  while ((match = structuredPattern.exec(response)) !== null) {
    findings.push({
      id: match[1].trim(),
      severity: match[2].trim().toUpperCase() as ReviewFinding["severity"],
      category: match[3].trim() as ReviewFinding["category"],
      filePath: match[4].trim(),
      line: match[5] ? parseInt(match[5], 10) : undefined,
      title: match[6].trim(),
      description: match[7].trim(),
    });
  }

  if (findings.length > 0) {
    return findings;
  }

  // Fallback: heuristic parsing for unstructured review output
  // Look for patterns like "HIGH: description" or "CRITICAL — file.ts: issue"
  const heuristicPattern =
    /\b(LOW|MEDIUM|HIGH|CRITICAL)\b[:\s—-]+(?:([^\n:]+\.(?:ts|js|tsx|jsx|json|yaml|yml|md))(?::(\d+))?[:\s—-]+)?(.+?)(?:\n|$)/gi;

  let findingIdx = 0;
  while ((match = heuristicPattern.exec(response)) !== null) {
    findingIdx++;
    findings.push({
      id: `F-${String(findingIdx).padStart(3, "0")}`,
      severity: match[1].toUpperCase() as ReviewFinding["severity"],
      category: "correctness", // default — can't infer category from heuristic
      filePath: match[2]?.trim() ?? "unknown",
      line: match[3] ? parseInt(match[3], 10) : undefined,
      title: match[4].trim(),
      description: match[4].trim(),
    });
  }

  return findings;
}

// ─────────────────────────────────────────────────────────────────────────────
// Review Orchestrator
// ─────────────────────────────────────────────────────────────────────────────

/** Options for running the review orchestrator. */
export interface ReviewOrchestrationOptions {
  /** Story ID to review */
  storyId: string;
  /** Story title for context */
  storyTitle?: string;
  /** Streaming callback for agent output */
  onDelta?: (delta: string) => void;
  /** Event callback for orchestrator lifecycle */
  onEvent?: ReviewOrchestratorEventHandler;
}

/** Result from the review orchestration. */
export interface ReviewOrchestrationResult {
  /** Whether the story was approved */
  approved: boolean;
  /** Whether it was escalated */
  escalated: boolean;
  /** Total review passes executed */
  totalPasses: number;
  /** Final gate result (last evaluation) */
  finalGateResult?: GateResult;
  /** Full review history */
  history: ReviewHistory;
  /** Human-readable summary */
  summary: string;
}

/**
 * ReviewOrchestrator drives the adversarial review loop.
 *
 * It runs review passes until the story is approved, escalated, or
 * the maximum number of passes is exhausted.
 */
export class ReviewOrchestrator {
  private dispatcher: AgentDispatcher;
  private config: BmadConfig;

  constructor(dispatcher: AgentDispatcher, config: BmadConfig) {
    this.dispatcher = dispatcher;
    this.config = config;
  }

  /**
   * Run the full review loop for a story.
   *
   * Lifecycle:
   *   1. Dispatch code-review to the reviewer agent
   *   2. Parse findings from the response
   *   3. Evaluate against quality gate
   *   4. If PASS → mark done, return
   *   5. If FAIL → dispatch fix to developer agent → goto 1
   *   6. If ESCALATE → mark escalated, return
   *
   * @param opts - Orchestration options
   * @returns Orchestration result with approval status and history
   */
  async run(opts: ReviewOrchestrationOptions): Promise<ReviewOrchestrationResult> {
    const { storyId, storyTitle, onDelta, onEvent } = opts;
    const maxPasses = this.config.reviewPassLimit;

    // Load existing history (supports resume after crash)
    const history = await loadReviewHistory(this.config, storyId);

    // If already terminal, return immediately
    if (history.status === "approved" || history.status === "escalated") {
      log.info("Story already terminal", { storyId, status: history.status });
      return {
        approved: history.status === "approved",
        escalated: history.status === "escalated",
        totalPasses: history.passes.length,
        finalGateResult: history.passes[history.passes.length - 1]?.result,
        history,
        summary: `Story ${storyId} already ${history.status}.`,
      };
    }

    let lastGateResult: GateResult | undefined;

    // Review loop — up to maxPasses
    for (let pass = history.passes.length + 1; pass <= maxPasses; pass++) {
      const startedAt = new Date().toISOString();

      // ── Step 1: Dispatch code review ──
      onEvent?.({ type: "review-start", storyId, passNumber: pass });
      log.info("Review pass starting", { storyId, pass, maxPasses });
      recordReviewPass(storyId, pass);

      const reviewResult = await traceQualityGate(storyId, pass, async (span) => {
        const result = await this.dispatchReview(storyId, storyTitle, pass, onDelta);
        span.setAttribute("review.success", result.success);
        span.setAttribute("review.agent", result.agentName);
        return result;
      });
      onEvent?.({
        type: "review-dispatched",
        storyId,
        passNumber: pass,
        agentName: reviewResult.agentName,
      });

      if (!reviewResult.success) {
        onEvent?.({ type: "review-error", storyId, error: reviewResult.error ?? "Review dispatch failed" });
        log.error("Review dispatch failed", { storyId, pass, error: reviewResult.error });
        // Record the failed pass and continue (or break)
        break;
      }

      // ── Step 2: Parse findings from response ──
      const findings = parseFindings(reviewResult.response);

      // ── Step 3: Evaluate gate ──
      const gateResult = evaluateGate({
        storyId,
        passNumber: pass,
        maxPasses,
        findings,
      });
      lastGateResult = gateResult;

      onEvent?.({ type: "gate-evaluated", storyId, result: gateResult });

      // Log the gate report
      log.info("Gate evaluated", {
        storyId,
        pass,
        verdict: gateResult.verdict,
        blocking: gateResult.blockingCount,
        advisory: gateResult.advisoryCount,
        score: gateResult.severityScore,
      });
      log.debug("Gate report detail", { report: formatGateReport(gateResult) });
      recordGateVerdict(storyId, gateResult.verdict, gateResult.severityScore);

      // ── Step 4: Decide next action ──
      const action = decideNextAction(gateResult, history);

      // Record this pass
      const passRecord: ReviewPassRecord = {
        passNumber: pass,
        result: gateResult,
        reviewerAgent: reviewResult.agentName,
        startedAt,
        completedAt: new Date().toISOString(),
      };

      if (action.type === "approve") {
        // ── PASS — story approved ──
        history.passes.push(passRecord);
        history.status = "approved";
        history.finalVerdict = "PASS";
        await saveReviewHistory(this.config, history);

        // Update sprint status → done
        await this.transitionStory(storyId, "done");

        onEvent?.({ type: "review-approved", storyId, totalPasses: pass });
        log.info("Story approved", { storyId, totalPasses: pass });

        return {
          approved: true,
          escalated: false,
          totalPasses: pass,
          finalGateResult: gateResult,
          history,
          summary: gateResult.summary,
        };
      }

      if (action.type === "fix-and-retry") {
        // ── FAIL — fix blocking findings and retry ──
        log.info("Fix-and-retry", { storyId, pass, findingCount: action.findings.length });
        onEvent?.({
          type: "fix-start",
          storyId,
          passNumber: pass,
          findingCount: action.findings.length,
        });

        const fixResult = await this.dispatchFix(storyId, storyTitle, action.findings, pass, onDelta);
        onEvent?.({
          type: "fix-dispatched",
          storyId,
          passNumber: pass,
          agentName: fixResult.agentName,
        });

        passRecord.fixerAgent = fixResult.agentName;
        // Mark fixed findings
        for (const f of action.findings) {
          f.fixed = true;
        }

        onEvent?.({ type: "fix-complete", storyId, passNumber: pass });
        history.passes.push(passRecord);
        await saveReviewHistory(this.config, history);

        // Continue to next pass
        continue;
      }

      if (action.type === "escalate") {
        // ── ESCALATE — exceeded max passes ──
        log.warn("Escalating story", { storyId, pass, reason: action.reason });
        history.passes.push(passRecord);
        history.status = "escalated";
        history.finalVerdict = "ESCALATE";
        history.escalationReason = action.reason;
        await saveReviewHistory(this.config, history);

        onEvent?.({ type: "review-escalated", storyId, reason: action.reason, totalPasses: pass });

        return {
          approved: false,
          escalated: true,
          totalPasses: pass,
          finalGateResult: gateResult,
          history,
          summary: action.reason,
        };
      }
    }

    // Fell through — max passes exhausted without resolution
    // This happens if the last pass was FAIL but we've used all passes
    if (lastGateResult && lastGateResult.verdict !== "PASS") {
      history.status = "escalated";
      history.finalVerdict = "ESCALATE";
      history.escalationReason = `Exceeded ${maxPasses} review passes without resolution.`;
      await saveReviewHistory(this.config, history);

      onEvent?.({
        type: "review-escalated",
        storyId,
        reason: history.escalationReason,
        totalPasses: history.passes.length,
      });
    }

    return {
      approved: false,
      escalated: history.status === "escalated",
      totalPasses: history.passes.length,
      finalGateResult: lastGateResult,
      history,
      summary: history.escalationReason ?? formatReviewTimeline(history),
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Private Dispatch Helpers
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Dispatch a code review to the reviewer agent.
   */
  private async dispatchReview(
    storyId: string,
    storyTitle: string | undefined,
    passNumber: number,
    onDelta?: (delta: string) => void,
  ): Promise<DispatchResult> {
    return this.dispatcher.dispatch(
      {
        id: `${storyId}-review-pass-${passNumber}`,
        phase: "code-review",
        storyId,
        storyTitle,
        extraContext: [
          `This is review pass ${passNumber}/${this.config.reviewPassLimit}.`,
          `Output findings in structured format:`,
          `[FINDING:F-001:SEVERITY:category:file/path.ts:lineNumber]`,
          `Title of finding`,
          `Description of the problem and impact.`,
          `[/FINDING]`,
          ``,
          `After listing all findings, call code_review_result with your verdict.`,
        ].join("\n"),
      },
      onDelta,
    );
  }

  /**
   * Dispatch a fix request to the developer agent.
   */
  private async dispatchFix(
    storyId: string,
    storyTitle: string | undefined,
    findings: ReviewFinding[],
    passNumber: number,
    onDelta?: (delta: string) => void,
  ): Promise<DispatchResult> {
    const findingsText = findings
      .map(
        (f) =>
          `• [${f.severity}] ${f.filePath}:${f.line ?? "?"} — ${f.title}\n  ${f.description}${f.suggestedFix ? `\n  Suggested fix: ${f.suggestedFix}` : ""}`,
      )
      .join("\n\n");

    return this.dispatcher.dispatch(
      {
        id: `${storyId}-fix-pass-${passNumber}`,
        phase: "dev-story",
        storyId,
        storyTitle,
        extraContext: [
          `⚠️ CODE REVIEW FIX REQUEST (pass ${passNumber}/${this.config.reviewPassLimit})`,
          ``,
          `The following blocking findings must be fixed:`,
          ``,
          findingsText,
          ``,
          `Fix ALL blocking findings. Do NOT use dev_story tool (already in-progress).`,
          `Read each file, apply the fix, then move on to the next finding.`,
          `After fixing all issues, use sprint_status to move the story back to 'review'.`,
        ].join("\n"),
      },
      onDelta,
    );
  }

  /**
   * Transition a story's status in sprint-status.yaml.
   */
  private async transitionStory(
    storyId: string,
    newStatus: "done" | "review" | "in-progress",
  ): Promise<void> {
    const sprintData = await readSprintStatus(this.config.sprintStatusPath);
    const story = sprintData.sprint.stories.find((s) => s.id === storyId);
    if (story) {
      story.status = newStatus;
      if (newStatus === "done") {
        story.assigned = undefined;
      }
      await writeSprintStatus(this.config.sprintStatusPath, sprintData);
    }
  }
}

/**
 * Quality Gates — Module Barrel Export
 *
 * Exports the quality gate engine, types, orchestrator, and tool
 * for the BMAD adversarial review system.
 *
 * @module quality-gates
 */

// Types
export type {
  Severity,
  FindingCategory,
  ReviewFinding,
  GateVerdict,
  GateResult,
  ReviewPassRecord,
  ReviewHistory,
  OrchestratorAction,
} from "./types.js";
export { BLOCKING_SEVERITIES, SEVERITY_ORDER, SEVERITY_WEIGHT } from "./types.js";

// Engine
export {
  isBlocking,
  countBySeverity,
  countBlocking,
  countAdvisory,
  computeSeverityScore,
  evaluateGate,
  decideNextAction,
  formatGateReport,
  formatReviewTimeline,
} from "./engine.js";
export type { EvaluateGateInput } from "./engine.js";

// Review Orchestrator
export {
  ReviewOrchestrator,
  loadReviewHistory,
  saveReviewHistory,
  parseFindings,
} from "./review-orchestrator.js";
export type {
  ReviewOrchestratorEvent,
  ReviewOrchestratorEventHandler,
  ReviewOrchestrationOptions,
  ReviewOrchestrationResult,
} from "./review-orchestrator.js";

// Copilot SDK Tool
export { qualityGateEvaluateTool } from "./tool.js";

/**
 * Adapter Layer — Paperclip ↔ Copilot SDK Bridge
 *
 * Exports the core orchestration modules:
 * - SessionManager — CopilotClient lifecycle + session management
 * - AgentDispatcher — Routes work to BMAD agents
 * - SprintRunner — Autonomous story lifecycle engine
 * - handleHeartbeat — Paperclip heartbeat handler (Phase 4)
 */

export { SessionManager } from "./session-manager.js";
export type { AgentSessionOptions } from "./session-manager.js";

export { AgentDispatcher } from "./agent-dispatcher.js";
export type { WorkItem, WorkPhase, DispatchResult } from "./agent-dispatcher.js";

export { SprintRunner } from "./sprint-runner.js";
export type { SprintEvent, SprintEventHandler, SprintRunOptions } from "./sprint-runner.js";

export { handleHeartbeat } from "./heartbeat-handler.js";
export type { HeartbeatContext, HeartbeatResult } from "./heartbeat-handler.js";

export { checkHealth, formatHealthResult } from "./health-check.js";
export type { HealthStatus, HealthProbe, HealthCheckResult } from "./health-check.js";

/**
 * Adapter Layer — Paperclip ↔ Copilot SDK Bridge
 *
 * Exports the core orchestration modules:
 * - SessionManager — CopilotClient lifecycle + session management
 * - AgentDispatcher — Routes work to BMAD agents
 * - SprintRunner — Autonomous story lifecycle engine (standalone mode)
 * - PaperclipClient — HTTP client for Paperclip API
 * - PaperclipReporter — Reports results back to Paperclip
 * - PaperclipLoop — Heartbeat-driven integration loop (Paperclip mode)
 * - handleHeartbeat — Paperclip heartbeat handler
 */

export { SessionManager } from "./session-manager.js";
export type { AgentSessionOptions } from "./session-manager.js";

export { AgentDispatcher } from "./agent-dispatcher.js";
export type { WorkItem, WorkPhase, DispatchResult } from "./agent-dispatcher.js";

export { SprintRunner } from "./sprint-runner.js";
export type { SprintEvent, SprintEventHandler, SprintRunOptions } from "./sprint-runner.js";

export { handleHeartbeat, handlePaperclipHeartbeat } from "./heartbeat-handler.js";
export type { HeartbeatContext, HeartbeatResult } from "./heartbeat-handler.js";

export { checkHealth, formatHealthResult } from "./health-check.js";
export type { HealthStatus, HealthProbe, HealthCheckResult } from "./health-check.js";

export { PaperclipClient, PaperclipApiError } from "./paperclip-client.js";
export type {
  PaperclipAgent,
  PaperclipTicket,
  PaperclipHeartbeat,
  HeartbeatPollResponse,
  PaperclipStatusReport,
  PaperclipOrg,
  PaperclipGoal,
  PaperclipClientOptions,
} from "./paperclip-client.js";

export { PaperclipReporter } from "./reporter.js";
export type { ReportLogEntry } from "./reporter.js";

export { PaperclipLoop } from "./paperclip-loop.js";
export type {
  PaperclipLoopEvent,
  PaperclipLoopEventHandler,
  PaperclipLoopOptions,
} from "./paperclip-loop.js";

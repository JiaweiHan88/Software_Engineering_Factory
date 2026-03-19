/**
 * BMAD Copilot Factory — Main Entry Point
 *
 * The autonomous software building factory orchestrator.
 * Bootstraps the SessionManager, AgentDispatcher, and SprintRunner,
 * then runs stories through the BMAD lifecycle.
 *
 * CLI modes:
 *   pnpm start                       — Run one sprint cycle (default)
 *   pnpm start -- --story STORY-001  — Process a single story
 *   pnpm start -- --dry-run          — Dry run (no SDK calls)
 *   pnpm start -- --status           — Print sprint status and exit
 *   pnpm start -- --dispatch <phase> <storyId> — Dispatch a single phase
 *   pnpm start -- --paperclip        — Run Paperclip integration loop
 *
 * @module index
 */

import { loadConfig } from "./config/config.js";
import { allAgents } from "./agents/registry.js";
import { SessionManager } from "./adapter/session-manager.js";
import { AgentDispatcher } from "./adapter/agent-dispatcher.js";
import { SprintRunner } from "./adapter/sprint-runner.js";
import { PaperclipLoop } from "./adapter/paperclip-loop.js";
import { checkHealth, formatHealthResult } from "./adapter/health-check.js";
import { Logger } from "./observability/logger.js";
import { initTracing, shutdownTracing } from "./observability/tracing.js";
import { initMetrics, shutdownMetrics } from "./observability/metrics.js";
import { StallDetector } from "./observability/stall-detector.js";
import type { SprintEvent } from "./adapter/sprint-runner.js";
import type { PaperclipLoopEvent } from "./adapter/paperclip-loop.js";
import type { ReviewOrchestratorEvent } from "./quality-gates/review-orchestrator.js";
import type { WorkPhase } from "./adapter/agent-dispatcher.js";

/**
 * Event handler that logs sprint lifecycle events to console.
 */
function logEvent(event: SprintEvent): void {
  switch (event.type) {
    case "sprint-start":
      console.log(`\n🏭 Sprint cycle starting — ${event.storyCount} stories to process`);
      break;
    case "story-start":
      console.log(`\n━━━ ${event.storyId} → ${event.phase} ━━━`);
      break;
    case "story-complete":
      console.log(`\n${event.result.success ? "✅" : "❌"} ${event.storyId} (${event.phase}) — ${event.result.agentName}`);
      break;
    case "story-escalated":
      console.log(`\n⚠️  ${event.storyId} ESCALATED: ${event.reason}`);
      break;
    case "story-failed":
      console.log(`\n❌ ${event.storyId} FAILED: ${event.error}`);
      break;
    case "sprint-complete":
      console.log(`\n🏁 Sprint cycle complete — ${event.storiesDone}/${event.storiesProcessed} stories done`);
      break;
    case "sprint-idle":
      console.log(`\n💤 ${event.message}`);
      break;
    case "quality-gate":
      logQualityGateEvent(event.storyId, event.event);
      break;
  }
}

/**
 * Event handler that logs quality gate review events to console.
 */
function logQualityGateEvent(storyId: string, event: ReviewOrchestratorEvent): void {
  switch (event.type) {
    case "review-start":
      console.log(`  🔍 ${storyId} — review pass ${event.passNumber} starting`);
      break;
    case "review-dispatched":
      console.log(`  📤 ${storyId} — review dispatched to ${event.agentName}`);
      break;
    case "gate-evaluated":
      console.log(`  🚦 ${storyId} — gate verdict: ${event.result.verdict} (blocking: ${event.result.blockingCount}, advisory: ${event.result.advisoryCount}, score: ${event.result.severityScore})`);
      break;
    case "fix-start":
      console.log(`  🔧 ${storyId} — fixing ${event.findingCount} blocking finding(s)`);
      break;
    case "fix-dispatched":
      console.log(`  📤 ${storyId} — fix dispatched to ${event.agentName}`);
      break;
    case "fix-complete":
      console.log(`  ✅ ${storyId} — fixes applied for pass ${event.passNumber}`);
      break;
    case "review-approved":
      console.log(`  🎉 ${storyId} — APPROVED after ${event.totalPasses} pass(es)`);
      break;
    case "review-escalated":
      console.log(`  ⚠️  ${storyId} — ESCALATED: ${event.reason}`);
      break;
    case "review-error":
      console.log(`  ❌ ${storyId} — review error: ${event.error}`);
      break;
  }
}

/**
 * Event handler that logs Paperclip loop events to console.
 */
function logPaperclipEvent(event: PaperclipLoopEvent): void {
  switch (event.type) {
    case "loop-start":
      console.log(`\n🔄 Paperclip loop started — ${event.agentCount} agents registered`);
      break;
    case "agents-registered":
      console.log(`📋 ${event.count} agents registered with Paperclip`);
      break;
    case "poll":
      if (event.heartbeatCount > 0) {
        console.log(`💓 Polled ${event.heartbeatCount} heartbeat(s)`);
      }
      break;
    case "heartbeat-processed":
      console.log(`✅ ${event.agentId}: ${event.result.status} — ${event.result.message}`);
      break;
    case "heartbeat-error":
      console.log(`❌ ${event.agentId}: ${event.error}`);
      break;
    case "poll-error":
      console.log(`⚠️  Poll error: ${event.error}`);
      break;
    case "loop-stop":
      console.log(`🛑 Loop stopped: ${event.reason}`);
      break;
  }
}

/**
 * Parse CLI arguments.
 */
function parseArgs(): {
  mode: "sprint" | "story" | "dispatch" | "status" | "dry-run" | "paperclip";
  storyId?: string;
  phase?: WorkPhase;
} {
  const args = process.argv.slice(2);

  if (args.includes("--status")) {
    return { mode: "status" };
  }

  if (args.includes("--paperclip")) {
    return { mode: "paperclip" };
  }

  if (args.includes("--dry-run")) {
    const storyIdx = args.indexOf("--story");
    return {
      mode: "dry-run",
      storyId: storyIdx >= 0 ? args[storyIdx + 1] : undefined,
    };
  }

  if (args.includes("--dispatch")) {
    const idx = args.indexOf("--dispatch");
    const phase = args[idx + 1] as WorkPhase;
    const storyId = args[idx + 2];
    if (!phase || !storyId) {
      console.error("Usage: --dispatch <phase> <storyId>");
      process.exit(1);
    }
    return { mode: "dispatch", phase, storyId };
  }

  if (args.includes("--story")) {
    const idx = args.indexOf("--story");
    return { mode: "story", storyId: args[idx + 1] };
  }

  return { mode: "sprint" };
}

async function main(): Promise<void> {
  const config = loadConfig();
  const cliArgs = parseArgs();

  // Initialize observability stack
  Logger.configure({
    level: config.observability.logLevel,
    format: config.observability.logFormat,
  });
  const log = Logger.child("main");

  if (config.observability.otelEnabled) {
    initTracing({
      enabled: true,
      endpoint: config.observability.otelEndpoint,
      serviceName: config.observability.otelServiceName,
    });
    initMetrics({
      enabled: true,
      endpoint: config.observability.otelEndpoint,
      serviceName: config.observability.otelServiceName,
    });
    log.info("OpenTelemetry initialized", {
      endpoint: config.observability.otelEndpoint,
      service: config.observability.otelServiceName,
    });
  }

  console.log("🏭 BMAD Copilot Factory\n");
  console.log(`📁 Project root: ${config.projectRoot}`);
  console.log(`📄 Sprint status: ${config.sprintStatusPath}`);
  console.log(`🤖 Model: ${config.model}`);
  console.log(`🔄 Review pass limit: ${config.reviewPassLimit}`);
  console.log(`� Paperclip: ${config.paperclip.enabled ? `enabled (${config.paperclip.url})` : "disabled"}`);
  console.log(`�📋 Agents: ${allAgents.length}`);
  for (const a of allAgents) {
    console.log(`   • ${a.displayName} (${a.name})`);
  }

  // Initialize the orchestration stack
  const sessionManager = new SessionManager(config);
  const dispatcher = new AgentDispatcher(sessionManager, config);
  const stallDetector = new StallDetector({
    checkIntervalMs: config.observability.stallCheckIntervalMs,
    autoEscalate: config.observability.stallAutoEscalate,
  });
  const runner = new SprintRunner(dispatcher, config, stallDetector);

  stallDetector.onStallDetected((event) => {
    log.warn("Stall detected", {
      storyId: event.storyId,
      phase: event.phase,
      stalledMinutes: event.stalledMinutes,
      threshold: event.thresholdMinutes,
      repeat: event.repeat,
    });
  });

  // Status mode — health check + sprint summary, then exit
  if (cliArgs.mode === "status") {
    const health = await checkHealth(config);
    console.log(`\n${formatHealthResult(health)}`);
    const summary = await runner.getSprintSummary();
    console.log(`\n${summary}`);
    return;
  }

  // Dry-run mode — no SDK calls
  if (cliArgs.mode === "dry-run") {
    console.log("\n🧪 DRY RUN MODE — no Copilot SDK calls\n");
    await runner.runCycle({
      storyFilter: cliArgs.storyId,
      singlePass: true,
      live: false,
      onEvent: logEvent,
    });
    return;
  }

  // Paperclip mode — run the heartbeat-driven integration loop
  if (cliArgs.mode === "paperclip") {
    if (!config.paperclip.enabled) {
      console.log("\n⚠️  Paperclip integration is disabled. Set PAPERCLIP_ENABLED=true to enable.");
      console.log("   Falling back to standalone sprint mode.\n");
    } else {
      console.log(`\n📡 Paperclip mode — connecting to ${config.paperclip.url}`);
      const loop = new PaperclipLoop(sessionManager, dispatcher, config);

      // Handle graceful shutdown
      const shutdown = async () => {
        console.log("\n🛑 Shutting down...");
        await loop.stop();
        process.exit(0);
      };
      process.on("SIGINT", () => void shutdown());
      process.on("SIGTERM", () => void shutdown());

      await loop.start({
        onEvent: logPaperclipEvent,
        onDelta: (delta) => process.stdout.write(delta),
      });
      return;
    }
  }

  // Live modes — start the SDK client
  try {
    console.log("\n🔌 Starting Copilot SDK...");
    await sessionManager.start();
    console.log("✅ SDK ready.\n");

    if (cliArgs.mode === "dispatch") {
      // Single dispatch mode
      console.log(`📡 Dispatching: ${cliArgs.phase} for ${cliArgs.storyId}`);
      const result = await dispatcher.dispatch(
        {
          id: `${cliArgs.storyId}-${cliArgs.phase}`,
          phase: cliArgs.phase!,
          storyId: cliArgs.storyId,
        },
        (delta) => process.stdout.write(delta),
      );
      console.log(`\n${result.success ? "✅" : "❌"} ${result.agentName}: ${result.response.slice(0, 200)}`);
    } else {
      // Sprint cycle mode (default)
      stallDetector.startContinuousCheck();
      const doneCount = await runner.runCycle({
        storyFilter: cliArgs.storyId,
        singlePass: true,
        live: true,
        onDelta: (delta) => process.stdout.write(delta),
        onEvent: logEvent,
      });

      console.log(`\n📊 Sprint cycle result: ${doneCount} stories completed.`);
    }
  } finally {
    stallDetector.stopContinuousCheck();
    await sessionManager.stop();
    await shutdownTracing();
    await shutdownMetrics();
    console.log("🧹 Shutdown complete.");
  }
}

main().catch((err) => {
  console.error("❌ Fatal error:", err);
  process.exit(1);
});

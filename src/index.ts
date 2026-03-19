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
 *
 * @module index
 */

import { loadConfig } from "./config/config.js";
import { allAgents } from "./agents/registry.js";
import { SessionManager } from "./adapter/session-manager.js";
import { AgentDispatcher } from "./adapter/agent-dispatcher.js";
import { SprintRunner } from "./adapter/sprint-runner.js";
import { checkHealth, formatHealthResult } from "./adapter/health-check.js";
import type { SprintEvent } from "./adapter/sprint-runner.js";
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
  }
}

/**
 * Parse CLI arguments.
 */
function parseArgs(): {
  mode: "sprint" | "story" | "dispatch" | "status" | "dry-run";
  storyId?: string;
  phase?: WorkPhase;
} {
  const args = process.argv.slice(2);

  if (args.includes("--status")) {
    return { mode: "status" };
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

  console.log("🏭 BMAD Copilot Factory\n");
  console.log(`📁 Project root: ${config.projectRoot}`);
  console.log(`📄 Sprint status: ${config.sprintStatusPath}`);
  console.log(`🤖 Model: ${config.model}`);
  console.log(`🔄 Review pass limit: ${config.reviewPassLimit}`);
  console.log(`📋 Agents: ${allAgents.length}`);
  for (const a of allAgents) {
    console.log(`   • ${a.displayName} (${a.name})`);
  }

  // Initialize the orchestration stack
  const sessionManager = new SessionManager(config);
  const dispatcher = new AgentDispatcher(sessionManager, config);
  const runner = new SprintRunner(dispatcher, config);

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
    await sessionManager.stop();
    console.log("🧹 Shutdown complete.");
  }
}

main().catch((err) => {
  console.error("❌ Fatal error:", err);
  process.exit(1);
});

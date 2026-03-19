/**
 * BMAD Copilot Factory — Main Entry Point
 *
 * This module bootstraps the adapter that bridges Paperclip heartbeats
 * to Copilot SDK sessions running BMAD agents.
 *
 * TODO (Phase 4): Wire up to Paperclip API and start heartbeat loop.
 */

import { allAgents } from "./agents/registry.js";

async function main() {
  console.log("🏭 BMAD Copilot Factory — Starting...\n");

  // Log registered agents
  console.log("📋 Registered BMAD Agents:");
  for (const agent of allAgents) {
    console.log(`   • ${agent.displayName} (${agent.name})`);
  }
  console.log();

  // TODO (Phase 1): Verify Copilot CLI connectivity
  // const client = new CopilotClient();
  // const session = await client.createSession({ model: "claude-sonnet-4.5" });
  // console.log("✅ Copilot CLI connected");

  // TODO (Phase 4): Connect to Paperclip API
  // const paperclip = new PaperclipClient({ url: "http://localhost:3100" });
  // console.log("✅ Paperclip connected");

  // TODO (Phase 4): Start heartbeat listener
  // paperclip.onHeartbeat(handleHeartbeat);

  console.log("⚠️  Phase 0 — Scaffolding complete. Waiting for GATE 0.");
  console.log("   See IMPLEMENTATION-PLAN.md for next steps.");
}

main().catch(console.error);

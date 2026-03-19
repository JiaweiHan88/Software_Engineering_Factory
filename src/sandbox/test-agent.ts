/**
 * Sandbox: Test BMAD Agent via Copilot SDK
 *
 * Verifies that a BMAD-personalized agent (Product Manager)
 * responds in-character through the Copilot SDK custom agents API.
 *
 * Run: pnpm sandbox:agent
 * Requires: Copilot CLI installed and authenticated (GATE 0)
 */

import { CopilotClient, approveAll } from "@github/copilot-sdk";
import { allAgents, getAgent } from "../agents/index.js";
import type { CustomAgentConfig } from "@github/copilot-sdk";

async function main() {
  console.log("🧪 BMAD Agent Persona Test\n");

  // Phase 0: Verify agent registry works (no SDK needed)
  console.log(`📋 Registered agents: ${allAgents.length}`);
  for (const agent of allAgents) {
    console.log(`   • ${agent.displayName} (${agent.name})`);
  }

  const pm = getAgent("bmad-pm");
  if (!pm) {
    console.error("❌ Product Manager agent not found in registry!");
    process.exit(1);
  }
  console.log(`\n✅ Product Manager agent loaded (prompt: ${pm.prompt.length} chars)`);

  // Phase 1: Test agent via Copilot SDK
  const gheHost = process.env.COPILOT_GHE_HOST;
  console.log(`\n🔌 Starting Copilot CLI via SDK...${gheHost ? ` (GH_HOST: ${gheHost})` : ""}`);
  const client = new CopilotClient({
    logLevel: "warning",
    ...(gheHost ? { env: { ...process.env, GH_HOST: gheHost } } : {}),
  });

  // Map all BMAD agents to CustomAgentConfig
  const customAgents: CustomAgentConfig[] = allAgents.map((a) => ({
    name: a.name,
    displayName: a.displayName,
    description: a.description,
    prompt: a.prompt,
  }));

  console.log(`📎 Registering ${customAgents.length} custom agents...`);

  const session = await client.createSession({
    onPermissionRequest: approveAll,
    customAgents,
    infiniteSessions: { enabled: false },
  });
  console.log(`📎 Session created: ${session.sessionId}`);

  // Stream output
  session.on("assistant.message_delta", (event) => {
    process.stdout.write(event.data.deltaContent);
  });

  // Test: Ask the PM agent to introduce itself
  console.log("\n📡 Sending test prompt to PM agent...\n---");
  const response = await session.sendAndWait(
    {
      prompt: `@${pm.name} Briefly introduce yourself and your role in 2-3 sentences. What methodology do you follow?`,
    },
    30_000,
  );

  const content = response?.data.content ?? "";
  console.log("\n---");

  const mentionsBMAD = content.toLowerCase().includes("bmad");
  console.log(mentionsBMAD
    ? "\n✅ Agent responded in BMAD character!"
    : "\n⚠️  Agent did not mention BMAD — persona prompt may need tuning");

  // Cleanup
  await session.disconnect();
  await client.stop();
  console.log("🧹 Cleanup complete.");
}

main().catch((err) => {
  console.error("❌ Error:", err);
  process.exit(1);
});

/**
 * Sandbox: Test BMAD Agent via Copilot SDK
 *
 * Verifies that a BMAD-personalized agent (Product Manager)
 * responds in-character through the Copilot SDK custom agents API.
 *
 * Run: npm run sandbox:agent
 * Requires: Copilot CLI installed and authenticated (GATE 0)
 */

import { allAgents, getAgent } from "../agents/index.js";

async function main() {
  console.log("🧪 BMAD Agent Persona Test\n");

  // Phase 0: Verify agent registry works (no SDK needed)
  console.log(`📋 Registered agents: ${allAgents.length}`);
  for (const agent of allAgents) {
    console.log(`   • ${agent.displayName} (${agent.name})`);
  }

  const pm = getAgent("product-manager");
  if (!pm) {
    console.error("❌ Product Manager agent not found in registry!");
    process.exit(1);
  }
  console.log(`\n✅ Product Manager agent loaded (prompt: ${pm.prompt.length} chars)`);

  // TODO (Phase 1): Uncomment when SDK is installed
  //
  // import { CopilotClient } from "@github/copilot-sdk";
  //
  // const client = new CopilotClient();
  // const session = await client.createSession({
  //   model: "claude-sonnet-4.5",
  //   customAgents: [
  //     {
  //       name: pm.name,
  //       description: pm.description,
  //       prompt: pm.prompt,
  //     },
  //   ],
  // });
  //
  // console.log("\n📡 Sending test prompt to PM agent...");
  // const response = await session.sendAndWait({
  //   prompt: "Briefly introduce yourself and your role. What methodology do you follow?",
  //   agent: pm.name,
  // });
  //
  // console.log(`\n📨 PM Response:\n${response?.data.content}`);
  //
  // const mentionsBMAD = response?.data.content?.toLowerCase().includes("bmad");
  // console.log(mentionsBMAD
  //   ? "\n✅ Agent responded in BMAD character!"
  //   : "\n⚠️  Agent did not mention BMAD — check prompt injection");
  //
  // await client.stop();

  console.log("\n⚠️  SDK not installed yet. Agent registry test passed.");
  console.log("   Complete GATE 0 to test full agent persona via SDK.");
}

main().catch(console.error);

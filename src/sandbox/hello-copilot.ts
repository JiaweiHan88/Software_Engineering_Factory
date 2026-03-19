/**
 * Sandbox: Hello Copilot SDK
 *
 * Minimal test to verify the Copilot SDK connects to the CLI
 * and can send/receive messages.
 *
 * Run: npm run sandbox:hello
 * Requires: Copilot CLI installed and authenticated (GATE 0)
 */

// import { CopilotClient } from "@github/copilot-sdk";

async function main() {
  console.log("🧪 Hello Copilot SDK — Connectivity Test\n");

  // TODO (Phase 1): Uncomment when SDK is installed
  //
  // const client = new CopilotClient();
  // const session = await client.createSession({ model: "claude-sonnet-4.5" });
  //
  // console.log("📡 Sending test message...");
  // const response = await session.sendAndWait({
  //   prompt: "Reply with exactly: BMAD COPILOT FACTORY ONLINE",
  // });
  //
  // console.log(`📨 Response: ${response?.data.content}`);
  //
  // const success = response?.data.content?.includes("BMAD COPILOT FACTORY ONLINE");
  // console.log(success ? "✅ SDK connection verified!" : "❌ Unexpected response");
  //
  // await client.stop();

  console.log("⚠️  SDK not installed yet. Complete GATE 0 first.");
  console.log("   See IMPLEMENTATION-PLAN.md for instructions.");
}

main().catch(console.error);

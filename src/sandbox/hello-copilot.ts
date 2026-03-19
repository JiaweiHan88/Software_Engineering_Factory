/**
 * Sandbox: Hello Copilot SDK
 *
 * Minimal test to verify the Copilot SDK connects to the CLI
 * and can send/receive messages.
 *
 * Run: pnpm sandbox:hello
 * Requires: Copilot CLI installed and authenticated (GATE 0)
 */

import { CopilotClient, approveAll } from "@github/copilot-sdk";

async function main() {
  console.log("🧪 Hello Copilot SDK — Connectivity Test\n");

  // Step 1: Create client (auto-starts bundled CLI via stdio)
  // Set GH_HOST for GHE instances; defaults to github.com if COPILOT_GHE_HOST is unset
  const gheHost = process.env.COPILOT_GHE_HOST;
  console.log(`🔌 Starting Copilot CLI via SDK...${gheHost ? ` (GH_HOST: ${gheHost})` : ""}`);
  const client = new CopilotClient({
    logLevel: "warning",
    ...(gheHost ? { env: { ...process.env, GH_HOST: gheHost } } : {}),
  });
  await client.start();
  console.log("✅ CLI started.");

  // Step 2: Ping the server to verify connectivity
  console.log("📡 Pinging server...");
  const ping = await client.ping("bmad-factory-hello");
  console.log(`✅ Ping OK — server responded at ${new Date(ping.timestamp).toISOString()}`);

  // Step 3: Check auth status
  const authStatus = await client.getAuthStatus();
  console.log(`🔑 Auth status: ${JSON.stringify(authStatus)}`);

  // Step 4: Get CLI status
  const status = await client.getStatus();
  console.log(`📋 CLI status: version=${status.version}, protocol=${status.protocolVersion}`);

  // Step 5: List available models
  const models = await client.listModels();
  console.log(`🤖 Available models (${models.length}):`);
  for (const m of models.slice(0, 5)) {
    console.log(`   • ${m.id} (${m.name})`);
  }
  if (models.length > 5) console.log(`   ... and ${models.length - 5} more`);

  // Step 6: Create a session and send a simple message
  console.log("\n💬 Creating session...");
  const session = await client.createSession({
    onPermissionRequest: approveAll,
    infiniteSessions: { enabled: false },
  });
  console.log(`📎 Session created: ${session.sessionId}`);

  // Subscribe to streaming deltas for live output
  session.on("assistant.message_delta", (event) => {
    process.stdout.write(event.data.deltaContent);
  });

  console.log("📡 Sending test message...");
  const response = await session.sendAndWait(
    { prompt: "Reply with exactly one line: BMAD COPILOT FACTORY ONLINE" },
    30_000,
  );

  const content = response?.data.content ?? "";
  console.log(`\n\n📨 Response: ${content}`);

  const success = content.includes("BMAD COPILOT FACTORY ONLINE");
  console.log(success ? "\n✅ SDK connection fully verified!" : "\n⚠️  Response received but didn't match exactly — SDK is working though!");

  // Cleanup
  await session.disconnect();
  await client.stop();
  console.log("🧹 Cleanup complete.");
}

main().catch((err) => {
  console.error("❌ Error:", err);
  process.exit(1);
});

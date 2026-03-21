#!/usr/bin/env tsx
/**
 * Test: Copilot SDK Streaming — Does token-by-token streaming work?
 *
 * This script creates a minimal Copilot session and subscribes to ALL relevant
 * event types to see what fires during a simple prompt:
 *
 *   - assistant.message_delta   (token chunks — the main one we care about)
 *   - assistant.streaming_delta (cumulative byte counter)
 *   - assistant.turn_start      (start of assistant's turn)
 *   - assistant.message         (final complete message)
 *   - assistant.reasoning       (reasoning content if any)
 *   - assistant.reasoning_delta (reasoning token chunks)
 *   - tool.execution_start      (tool call initiated)
 *   - tool.execution_complete   (tool call finished)
 *
 * Run:
 *   npx tsx scripts/test-streaming.ts
 *   npx tsx scripts/test-streaming.ts --agent  # test with a BMAD agent persona
 *
 * @module scripts/test-streaming
 */

import "dotenv/config";
import { CopilotClient, approveAll } from "@github/copilot-sdk";
import type { SessionConfig, SessionEvent } from "@github/copilot-sdk";

// ─────────────────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────────────────

const USE_AGENT = process.argv.includes("--agent");
const VERBOSE = process.argv.includes("--verbose");
const gheHost = process.env.COPILOT_GHE_HOST;

// A prompt that should produce a moderate-length response (easy to see streaming)
const TEST_PROMPT = USE_AGENT
  ? "@bmad-analyst Briefly analyze the feasibility of using WebSockets vs SSE for a real-time dashboard with 10,000 concurrent connections. Keep it under 200 words."
  : "Explain in exactly 5 bullet points why TypeScript is popular. Be concise.";

// ─────────────────────────────────────────────────────────────────────────────
// Event tracking
// ─────────────────────────────────────────────────────────────────────────────

interface EventRecord {
  type: string;
  time: number; // ms since start
  size?: number; // bytes/chars for deltas
  preview?: string; // first N chars of content
}

const events: EventRecord[] = [];
let startTime = 0;
let totalDeltaChars = 0;
let deltaCount = 0;
let firstDeltaTime = 0;
let lastDeltaTime = 0;

function elapsed(): number {
  return Date.now() - startTime;
}

function record(type: string, extra?: { size?: number; preview?: string }): void {
  events.push({ type, time: elapsed(), ...extra });
  if (VERBOSE) {
    const detail = extra?.preview ? ` "${extra.preview}"` : extra?.size ? ` (${extra.size}b)` : "";
    console.log(`  📌 [${elapsed()}ms] ${type}${detail}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("🧪 Copilot SDK Streaming Test\n");
  console.log(`   GHE host:  ${gheHost ?? "github.com (default)"}`);
  console.log(`   Agent:     ${USE_AGENT ? "bmad-analyst" : "none (bare session)"}`);
  console.log(`   Verbose:   ${VERBOSE}`);
  console.log(`   Prompt:    "${TEST_PROMPT.slice(0, 80)}…"\n`);

  // ── 1. Start client ──────────────────────────────────────────────────────
  console.log("🔌 Starting Copilot CLI…");
  const client = new CopilotClient({
    logLevel: "warning",
    ...(gheHost ? { env: { ...process.env, GH_HOST: gheHost } } : {}),
  });
  await client.start();
  const ping = await client.ping("streaming-test");
  console.log(`✅ CLI started (${new Date(ping.timestamp).toISOString()})\n`);

  // ── 2. Create session ────────────────────────────────────────────────────
  const sessionConfig: SessionConfig = {
    onPermissionRequest: approveAll,
    streaming: true,
    infiniteSessions: { enabled: false },
    ...(USE_AGENT
      ? {
          customAgents: [
            {
              name: "bmad-analyst",
              displayName: "Mary - Analyst",
              description: "Market research and technical feasibility analyst",
              prompt:
                "You are Mary, a senior analyst. You provide concise, data-driven analysis. Keep responses brief and structured.",
            },
          ],
        }
      : {}),
  };

  console.log("📎 Creating session…");
  const session = await client.createSession(sessionConfig);
  console.log(`✅ Session: ${session.sessionId}\n`);

  // ── 3. Subscribe to ALL event types ──────────────────────────────────────
  console.log("🎧 Subscribing to session events…\n");

  // Token-level streaming (the main one)
  session.on("assistant.message_delta", (event) => {
    const delta = event.data.deltaContent;
    deltaCount++;
    totalDeltaChars += delta.length;
    if (deltaCount === 1) firstDeltaTime = elapsed();
    lastDeltaTime = elapsed();

    record("assistant.message_delta", {
      size: delta.length,
      preview: delta.replace(/\n/g, "\\n").slice(0, 40),
    });

    // Print streaming output live
    process.stdout.write(delta);
  });

  // Byte-level progress
  session.on("assistant.streaming_delta", (event) => {
    record("assistant.streaming_delta", { size: event.data.totalResponseSizeBytes });
  });

  // Turn lifecycle
  session.on("assistant.turn_start", (event) => {
    record("assistant.turn_start", { preview: `turnId=${event.data.turnId.slice(0, 8)}` });
  });

  // Final message
  session.on("assistant.message", (event) => {
    record("assistant.message", {
      size: event.data.content.length,
      preview: event.data.content.slice(0, 50).replace(/\n/g, "\\n"),
    });
  });

  // Reasoning (if model supports it)
  session.on("assistant.reasoning", (event) => {
    record("assistant.reasoning", { preview: event.data.content.slice(0, 50) });
  });

  session.on("assistant.reasoning_delta", (event) => {
    record("assistant.reasoning_delta", { size: event.data.deltaContent.length });
  });

  // Tool calls (if any)
  session.on("tool.execution_start", (event) => {
    record("tool.execution_start", { preview: event.data.toolName });
  });

  session.on("tool.execution_complete", (event) => {
    record("tool.execution_complete", { preview: event.data.toolCallId.slice(0, 12) });
  });

  // Catch-all for anything we might miss
  const allEventTypes = new Set<string>();
  session.on((event: SessionEvent) => {
    allEventTypes.add(event.type);
  });

  // ── 4. Send prompt and measure ───────────────────────────────────────────
  console.log("📡 Sending prompt…\n");
  console.log("─".repeat(70));
  console.log("STREAMING OUTPUT:");
  console.log("─".repeat(70));

  startTime = Date.now();
  const response = await session.sendAndWait({ prompt: TEST_PROMPT }, 60_000);
  const totalTime = elapsed();

  console.log("\n" + "─".repeat(70));

  // ── 5. Print results ────────────────────────────────────────────────────
  const finalContent = response?.data.content ?? "";

  console.log("\n📊 STREAMING ANALYSIS\n");
  console.log(`   Total time:           ${totalTime}ms`);
  console.log(`   Time to first token:  ${firstDeltaTime > 0 ? `${firstDeltaTime}ms` : "N/A (no deltas received)"}`);
  console.log(`   Time to last token:   ${lastDeltaTime > 0 ? `${lastDeltaTime}ms` : "N/A"}`);
  console.log(`   Delta events:         ${deltaCount}`);
  console.log(`   Total delta chars:    ${totalDeltaChars}`);
  console.log(`   Final message chars:  ${finalContent.length}`);
  console.log(
    `   Avg chars/delta:      ${deltaCount > 0 ? (totalDeltaChars / deltaCount).toFixed(1) : "N/A"}`,
  );
  console.log(
    `   Streaming throughput: ${lastDeltaTime > firstDeltaTime ? ((totalDeltaChars / (lastDeltaTime - firstDeltaTime)) * 1000).toFixed(0) + " chars/sec" : "N/A"}`,
  );

  console.log(`\n   All event types seen: ${[...allEventTypes].sort().join(", ")}`);

  // ── 6. Event timeline ───────────────────────────────────────────────────
  if (VERBOSE && events.length > 0) {
    console.log("\n📋 EVENT TIMELINE (first 50):\n");
    for (const e of events.slice(0, 50)) {
      const detail = e.preview ? ` — ${e.preview}` : e.size ? ` — ${e.size}b` : "";
      console.log(`   [${String(e.time).padStart(6)}ms] ${e.type}${detail}`);
    }
    if (events.length > 50) {
      console.log(`   ... and ${events.length - 50} more events`);
    }
  }

  // ── 7. Verdict ──────────────────────────────────────────────────────────
  console.log("\n" + "═".repeat(70));
  if (deltaCount > 0) {
    console.log("✅ STREAMING WORKS — received " + deltaCount + " delta events with live token output");
    if (deltaCount === 1) {
      console.log("⚠️  Only 1 delta event — response may have been buffered (not truly streamed)");
    }
  } else {
    console.log("❌ NO STREAMING — zero assistant.message_delta events received");
    console.log("   The response was delivered as a single assistant.message (no token streaming)");
  }
  console.log("═".repeat(70));

  // ── 8. Cleanup ──────────────────────────────────────────────────────────
  await session.disconnect();
  await client.stop();
  console.log("\n🧹 Cleanup complete.");
}

main().catch((err) => {
  console.error("❌ Error:", err);
  process.exit(1);
});

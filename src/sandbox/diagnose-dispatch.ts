/**
 * Diagnostic: Test agent dispatch against a CLEAN target workspace.
 *
 * Points the Copilot CLI's workingDirectory at ../bmad-target-project
 * (a near-empty project) instead of the factory itself, so the agent
 * doesn't waste time exploring 30+ factory source files.
 *
 * Also overrides the sprint-status and story paths to the target workspace.
 *
 * Run: npx tsx src/sandbox/diagnose-dispatch.ts
 */

import { CopilotClient, approveAll } from "@github/copilot-sdk";
import type { CustomAgentConfig, SessionConfig } from "@github/copilot-sdk";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { allAgents } from "../agents/registry.js";
import { getAgent } from "../agents/registry.js";
import { issueStatusTool } from "../tools/index.js";

// ── KEY CHANGE: point at the clean target workspace ──────────────────────────
const FACTORY_ROOT = process.cwd(); // where this script lives (for skills)
const TARGET_ROOT = resolve(FACTORY_ROOT, "../bmad-target-project");
const STORY_ID = "ORCH-002";

async function main() {
  console.log("🔬 Dispatch Diagnostic — clean target workspace\n");
  console.log(`🏭 Factory root: ${FACTORY_ROOT}`);
  console.log(`🎯 Target workspace: ${TARGET_ROOT}`);

  if (!existsSync(TARGET_ROOT)) {
    console.error(`❌ Target workspace not found: ${TARGET_ROOT}`);
    process.exit(1);
  }

  // Override config env vars so dev_story/sprint_status tools read from the TARGET workspace
  process.env.BMAD_OUTPUT_DIR = resolve(TARGET_ROOT, "_bmad-output");
  process.env.BMAD_SPRINT_STATUS_PATH = resolve(TARGET_ROOT, "_bmad-output/sprint-status.yaml");

  const startTime = Date.now();

  // Step 1: Start client
  const gheHost = process.env.COPILOT_GHE_HOST;
  const client = new CopilotClient({
    logLevel: "info",
    ...(gheHost ? { env: { ...process.env, GH_HOST: gheHost } } : {}),
  });
  await client.start();
  console.log("✅ CLI started\n");

  // Step 2: Build session config — workingDirectory = TARGET workspace
  const agent = getAgent("bmad-dev")!;
  const customAgents: CustomAgentConfig[] = allAgents.map((a) => ({
    name: a.name,
    displayName: a.displayName,
    description: a.description,
    prompt: a.prompt,
  }));

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tools = [issueStatusTool] as any[];

  // Skills come from the factory, but working dir is the target
  const skillDirs = [
    resolve(FACTORY_ROOT, "src/skills"),
  ].filter((d) => existsSync(d));

  console.log(`📋 Agent: ${agent.displayName}`);
  console.log(`🔧 Tools: ${tools.length} (issue_status)`);
  console.log(`📚 Skill dirs: ${skillDirs.join(", ")}`);
  console.log(`📂 Working directory: ${TARGET_ROOT}`);
  console.log(`📎 Custom agents: ${customAgents.length}\n`);

  const sessionConfig: SessionConfig = {
    onPermissionRequest: approveAll,
    customAgents,
    tools,
    skillDirectories: skillDirs,
    infiniteSessions: { enabled: false },
    workingDirectory: TARGET_ROOT,  // ← AGENT OPERATES HERE
  };

  console.log("💬 Creating session...");
  const session = await client.createSession(sessionConfig);
  console.log(`📎 Session: ${session.sessionId}\n`);

  // Step 3: Set model
  await session.setModel("claude-sonnet-4.6");
  console.log("🤖 Model set: claude-sonnet-4.6\n");

  // Step 4: Subscribe to events — condensed logging
  let turnCount = 0;
  let toolCallCount = 0;
  session.on((event) => {
    const _ts = new Date().toISOString().slice(11, 23);
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    if (event.type === "assistant.message_delta") {
      process.stdout.write(event.data.deltaContent);
    } else if (event.type === "assistant.message") {
      console.log(`\n[${elapsed}s] 📨 assistant.message (${event.data.content.length} chars)`);
    } else if (event.type === "session.idle") {
      console.log(`[${elapsed}s] 💤 session.idle — DONE`);
    } else if (event.type === "assistant.turn_start") {
      turnCount++;
      console.log(`[${elapsed}s] 🔄 turn ${turnCount} start`);
    } else if (event.type === "assistant.turn_end") {
      console.log(`[${elapsed}s] 🔄 turn ${turnCount} end`);
    } else if (event.type.startsWith("tool.execution_start")) {
      toolCallCount++;
      const data = event.data as Record<string, unknown>;
      console.log(`[${elapsed}s] 🔧 tool #${toolCallCount}: ${data.toolName ?? "unknown"}`);
    } else if (event.type === "subagent.started") {
      const data = event.data as Record<string, unknown>;
      console.log(`[${elapsed}s] 🤖 SUB-AGENT: ${data.agentDisplayName}`);
    } else if (event.type === "session.error") {
      console.log(`[${elapsed}s] ❌ session.error: ${JSON.stringify(event.data)}`);
    } else if (event.type === "assistant.usage") {
      const data = event.data as Record<string, unknown>;
      console.log(`[${elapsed}s] � usage: model=${data.model} in=${data.inputTokens} out=${data.outputTokens} cost=${data.cost}`);
    }
    // Skip noisy events (pending_messages, permission, etc.)
  });

  // Step 5: Build prompt — paths point to TARGET workspace
  const storyPath = resolve(TARGET_ROOT, "_bmad-output/stories", `${STORY_ID}.md`);
  const prompt = [
    `@bmad-dev Use the dev_story tool to implement story ${STORY_ID}:`,
    `- story_id: "${STORY_ID}"`,
    `- story_file_path: "${storyPath}"`,
    ``,
    `Read the story file for acceptance criteria and implement accordingly.`,
    `When implementation is complete, use sprint_status to move the story to 'review'.`,
  ].join("\n");

  console.log("📡 Sending prompt (300s timeout)...\n");
  console.log(`--- PROMPT ---\n${prompt}\n--- END PROMPT ---\n`);

  try {
    const response = await session.sendAndWait({ prompt }, 300_000);
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`\n\n✅ COMPLETED in ${elapsed}s — response: ${response?.data.content.length ?? 0} chars`);
    console.log(`📊 Turns: ${turnCount}, Tool calls: ${toolCallCount}`);
  } catch (err) {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`\n\n❌ FAILED after ${elapsed}s: ${err instanceof Error ? err.message : String(err)}`);
    console.log(`📊 Turns: ${turnCount}, Tool calls: ${toolCallCount}`);
  }

  // Cleanup
  await session.disconnect();
  await client.stop();
  console.log("\n🧹 Done.");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});

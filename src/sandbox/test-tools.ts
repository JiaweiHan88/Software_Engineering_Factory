/**
 * Sandbox: Test BMAD Tools — End-to-End Lifecycle
 *
 * Runs the complete BMAD story lifecycle through real Copilot SDK sessions:
 *   1. PM agent creates a story via create_story tool
 *   2. Developer agent implements it via dev_story tool
 *   3. Code Reviewer approves it via code_review + code_review_result tools
 *
 * This validates that all tools work with the SDK's defineTool() system,
 * Zod schema validation, and sprint-status.yaml persistence.
 *
 * Run: pnpm sandbox:tools
 * Requires: GATE 0 complete + pnpm install
 */

import { CopilotClient, approveAll } from "@github/copilot-sdk";
import type { CustomAgentConfig } from "@github/copilot-sdk";
import { allAgents } from "../agents/index.js";
import { allTools } from "../tools/index.js";
import { readSprintStatus } from "../tools/sprint-status.js";
import { loadConfig, buildClientEnv } from "../config/index.js";

async function main() {
  const config = loadConfig();
  console.log("🧪 BMAD Tools — End-to-End Lifecycle Test\n");
  console.log(`📁 Output dir: ${config.outputDir}`);
  console.log(`📄 Sprint status: ${config.sprintStatusPath}`);
  console.log(`🔄 Review pass limit: ${config.reviewPassLimit}`);

  // --- Setup: Create SDK client with all agents and tools ---
  console.log("\n🔌 Starting Copilot CLI via SDK...");
  const client = new CopilotClient({
    logLevel: config.logLevel,
    env: buildClientEnv(config),
  });

  const customAgents: CustomAgentConfig[] = allAgents.map((a) => ({
    name: a.name,
    displayName: a.displayName,
    description: a.description,
    prompt: a.prompt,
  }));

  const session = await client.createSession({
    onPermissionRequest: approveAll,
    customAgents,
    tools: allTools,
    infiniteSessions: { enabled: false },
    workingDirectory: config.projectRoot,
  });

  console.log(`📎 Session: ${session.sessionId}`);
  console.log(`🤖 Agents: ${customAgents.length}`);
  console.log(`🔧 Tools: ${allTools.length}`);

  // Stream output
  session.on("assistant.message_delta", (event) => {
    process.stdout.write(event.data.deltaContent);
  });

  // --- Step 1: PM creates a story ---
  console.log("\n\n━━━ STEP 1: Create Story ━━━");
  console.log("Asking PM agent to create a story...\n");
  await session.sendAndWait(
    {
      prompt: [
        `@bmad-pm Use the create_story tool to create a new story with these parameters:`,
        `- epic_id: "epic-1"`,
        `- story_id: "STORY-001"`,
        `- story_title: "Implement heartbeat handler"`,
        `- story_description: "Create the Paperclip heartbeat adapter that bridges heartbeat JSON payloads to Copilot SDK sessions"`,
        `Only use the tool, don't write any code.`,
      ].join("\n"),
    },
    60_000,
  );

  // Verify sprint status
  let sprintData = await readSprintStatus(config.sprintStatusPath);
  const story = sprintData.sprint.stories.find((s) => s.id === "STORY-001");
  console.log(`\n\n📋 Sprint status after create: ${story ? `${story.id} = ${story.status}` : "NOT FOUND"}`);

  // --- Step 2: Developer implements the story ---
  console.log("\n━━━ STEP 2: Dev Story ━━━");
  console.log("Asking Developer agent to begin implementation...\n");
  await session.sendAndWait(
    {
      prompt: [
        `@bmad-developer Use the dev_story tool to begin implementing story STORY-001.`,
        `Parameters:`,
        `- story_id: "STORY-001"`,
        `- story_file_path: "${config.outputDir}/stories/STORY-001.md"`,
        `Only use the dev_story tool to read the story. Don't actually write code yet.`,
        `After reading, use the sprint_status tool to move the story to 'review'.`,
      ].join("\n"),
    },
    60_000,
  );

  sprintData = await readSprintStatus(config.sprintStatusPath);
  const afterDev = sprintData.sprint.stories.find((s) => s.id === "STORY-001");
  console.log(`\n\n📋 Sprint status after dev: ${afterDev ? `${afterDev.id} = ${afterDev.status}` : "NOT FOUND"}`);

  // --- Step 3: Code reviewer approves ---
  console.log("\n━━━ STEP 3: Code Review ━━━");
  console.log("Asking Code Reviewer agent to review...\n");
  await session.sendAndWait(
    {
      prompt: [
        `@bmad-code-reviewer Use the code_review tool to review story STORY-001.`,
        `Parameters:`,
        `- story_id: "STORY-001"`,
        `- story_file_path: "${config.outputDir}/stories/STORY-001.md"`,
        `- files_to_review: "src/adapter/heartbeat-handler.ts"`,
        `After reviewing, use code_review_result with approved=true and a brief summary.`,
      ].join("\n"),
    },
    60_000,
  );

  sprintData = await readSprintStatus(config.sprintStatusPath);
  const afterReview = sprintData.sprint.stories.find((s) => s.id === "STORY-001");
  console.log(`\n\n📋 Sprint status after review: ${afterReview ? `${afterReview.id} = ${afterReview.status}` : "NOT FOUND"}`);

  // --- Summary ---
  console.log("\n━━━ LIFECYCLE SUMMARY ━━━");
  const finalData = await readSprintStatus(config.sprintStatusPath);
  for (const s of finalData.sprint.stories) {
    const icon = s.status === "done" ? "✅" : s.status === "review" ? "🔍" : "⏳";
    console.log(`${icon} ${s.id}: ${s.title} → ${s.status} (passes: ${s.reviewPasses ?? 0})`);
  }

  const allDone = finalData.sprint.stories.every((s) => s.status === "done");
  console.log(allDone
    ? "\n🎉 Full lifecycle test PASSED — story went backlog → ready-for-dev → in-progress → review → done!"
    : "\n⚠️  Lifecycle test incomplete — check logs above for issues.");

  // Cleanup
  await session.disconnect();
  await client.stop();
  console.log("🧹 Cleanup complete.");
}

main().catch((err) => {
  console.error("❌ Error:", err);
  process.exit(1);
});

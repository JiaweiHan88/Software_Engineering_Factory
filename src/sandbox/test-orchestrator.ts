/**
 * Sandbox: Test Orchestrator — Full Stack Smoke Test
 *
 * Exercises the complete orchestration stack:
 *   SessionManager → AgentDispatcher → SprintRunner
 *
 * Creates a test sprint with 2 stories and runs them through the lifecycle.
 *
 * Run: pnpm sandbox:orchestrator
 * Requires: GATE 0 complete + pnpm install
 */

import { resolve } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import * as yaml from "js-yaml";
import { loadConfig } from "../config/config.js";
import { SessionManager } from "../adapter/session-manager.js";
import { AgentDispatcher } from "../adapter/agent-dispatcher.js";
import { SprintRunner } from "../adapter/sprint-runner.js";
import type { SprintEvent } from "../adapter/sprint-runner.js";
import type { SprintStatusData } from "../tools/sprint-status.js";
import { readSprintStatus } from "../tools/sprint-status.js";

/**
 * Colored event logger.
 */
function logEvent(event: SprintEvent): void {
  switch (event.type) {
    case "sprint-start":
      console.log(`\n🏭 Sprint cycle — ${event.storyCount} actionable stories`);
      break;
    case "story-start":
      console.log(`\n━━━ ${event.storyId} → ${event.phase} ━━━`);
      break;
    case "story-complete": {
      const icon = event.result.success ? "✅" : "❌";
      console.log(`\n${icon} ${event.storyId} (${event.phase}) via ${event.result.agentName}`);
      if (event.result.error) console.log(`   Error: ${event.result.error}`);
      break;
    }
    case "story-escalated":
      console.log(`\n⚠️  ESCALATED ${event.storyId}: ${event.reason}`);
      break;
    case "story-failed":
      console.log(`\n❌ FAILED ${event.storyId}: ${event.error}`);
      break;
    case "sprint-complete":
      console.log(`\n🏁 Cycle done — ${event.storiesDone}/${event.storiesProcessed} stories completed`);
      break;
    case "sprint-idle":
      console.log(`\n💤 ${event.message}`);
      break;
  }
}

async function main(): Promise<void> {
  const config = loadConfig();
  console.log("🧪 BMAD Orchestrator — Full Stack Smoke Test\n");
  console.log(`📁 Output: ${config.outputDir}`);
  console.log(`📄 Sprint: ${config.sprintStatusPath}`);

  // --- Step 0: Seed a test sprint ---
  console.log("\n📝 Seeding test sprint...");
  await mkdir(resolve(config.outputDir, "stories"), { recursive: true });

  const testSprint: SprintStatusData = {
    sprint: {
      number: 1,
      goal: "Orchestrator smoke test",
      stories: [
        {
          id: "ORCH-001",
          title: "Add health check endpoint",
          status: "ready-for-dev",
        },
        {
          id: "ORCH-002",
          title: "Implement session resume logic",
          status: "ready-for-dev",
        },
      ],
    },
  };

  // Write the story files (simulating PM already created them)
  for (const story of testSprint.sprint.stories) {
    const storyContent = [
      `# ${story.id}: ${story.title}`,
      "",
      "## Acceptance Criteria",
      "- [ ] The feature works as described",
      "- [ ] Unit tests are included",
      "- [ ] No lint errors",
      "",
      "## Tasks",
      `1. Implement ${story.title.toLowerCase()}`,
      "2. Write tests",
      "3. Update documentation",
    ].join("\n");

    await writeFile(
      resolve(config.outputDir, "stories", `${story.id}.md`),
      storyContent,
    );
  }

  await writeFile(config.sprintStatusPath, yaml.dump(testSprint));
  console.log(`✅ Seeded ${testSprint.sprint.stories.length} stories`);

  // --- Step 1: Dry run first ---
  console.log("\n\n═══ DRY RUN ═══");
  const sessionManager = new SessionManager(config);
  const dispatcher = new AgentDispatcher(sessionManager, config);
  const runner = new SprintRunner(dispatcher, config);

  await runner.runCycle({
    singlePass: true,
    live: false,
    onEvent: logEvent,
  });

  // --- Step 2: Live run with a single story ---
  console.log("\n\n═══ LIVE RUN (single story: ORCH-001) ═══");
  console.log("🔌 Starting Copilot SDK...");
  await sessionManager.start();

  try {
    // Process only ORCH-001 through one phase
    const result = await dispatcher.dispatch(
      {
        id: "ORCH-001-dev",
        phase: "dev-story",
        storyId: "ORCH-001",
        storyTitle: "Add health check endpoint",
      },
      (delta) => process.stdout.write(delta),
    );

    console.log(`\n\n📊 Dispatch result: ${result.success ? "SUCCESS" : "FAILED"}`);
    console.log(`   Agent: ${result.agentName}`);
    console.log(`   Response: ${result.response.slice(0, 300)}...`);

    // Check sprint status
    const finalStatus = await readSprintStatus(config.sprintStatusPath);
    console.log("\n📋 Sprint Status After Live Run:");
    for (const s of finalStatus.sprint.stories) {
      const icon = s.status === "done" ? "✅" : s.status === "review" ? "🔍" : s.status === "in-progress" ? "🔨" : "📋";
      console.log(`   ${icon} ${s.id}: ${s.title} → ${s.status}`);
    }
  } finally {
    await sessionManager.stop();
  }

  console.log("\n🎉 Orchestrator smoke test complete!");
}

main().catch((err) => {
  console.error("❌ Error:", err);
  process.exit(1);
});

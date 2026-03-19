/**
 * Sprint Runner — Integration Tests
 *
 * Tests the sprint runner lifecycle with a real sprint-status.yaml
 * but mocked agent dispatcher (no SDK calls).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { resolve } from "node:path";
import { mkdir, writeFile, rm } from "node:fs/promises";
import yaml from "js-yaml";

// Mock the Copilot SDK to avoid import resolution errors
vi.mock("@github/copilot-sdk", () => ({
  CopilotClient: vi.fn(),
  approveAll: vi.fn(),
  defineTool: vi.fn((_name: string, _opts: unknown) => ({ name: _name })),
}));

// Mock observability to avoid side effects in tests
vi.mock("../src/observability/tracing.js", () => ({
  traceSprintCycle: vi.fn(async (_count: number, _num: number, fn: () => Promise<void>) => fn()),
  traceStoryProcessing: vi.fn(async (_id: string, _phase: string, fn: (span: { setAttribute: () => void }) => Promise<boolean>) =>
    fn({ setAttribute: vi.fn() } as unknown as { setAttribute: () => void }),
  ),
}));

vi.mock("../src/observability/metrics.js", () => ({
  recordStoryProcessed: vi.fn(),
  recordStoryDone: vi.fn(),
  recordSprintCycle: vi.fn(),
  recordDispatchDuration: vi.fn(),
  recordSessionOpen: vi.fn(),
  recordSessionClose: vi.fn(),
}));

import { SprintRunner } from "../src/adapter/sprint-runner.js";
import type { SprintEvent } from "../src/adapter/sprint-runner.js";
import type { AgentDispatcher, DispatchResult, WorkItem } from "../src/adapter/agent-dispatcher.js";
import type { BmadConfig } from "../src/config/config.js";
import type { SprintStatusData } from "../src/tools/sprint-status.js";

// ─────────────────────────────────────────────────────────────────────────────
// Test Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const TEST_DIR = resolve(import.meta.dirname ?? ".", ".test-sprint-runner");
const SPRINT_STATUS_PATH = resolve(TEST_DIR, "sprint-status.yaml");

function makeConfig(overrides: Partial<BmadConfig> = {}): BmadConfig {
  return {
    gheHost: undefined,
    model: "test-model",
    outputDir: TEST_DIR,
    sprintStatusPath: SPRINT_STATUS_PATH,
    reviewPassLimit: 3,
    logLevel: "warning",
    projectRoot: TEST_DIR,
    paperclip: {
      url: "http://localhost:3100",
      apiKey: undefined,
      orgId: "test",
      pollIntervalMs: 5000,
      enabled: false,
      timeoutMs: 10000,
    },
    observability: {
      logLevel: "warn",
      logFormat: "json",
      otelEnabled: false,
      otelEndpoint: "http://localhost:4317",
      otelServiceName: "test",
      stallCheckIntervalMs: 60000,
      stallAutoEscalate: false,
    },
    ...overrides,
  };
}

function makeSprintData(stories: SprintStatusData["sprint"]["stories"]): SprintStatusData {
  return {
    sprint: {
      number: 1,
      goal: "Test sprint",
      stories,
    },
  };
}

function makeMockDispatcher(
  resultFn: (item: WorkItem) => DispatchResult = () => ({
    success: true,
    response: "Done",
    agentName: "test-agent",
    sessionId: "test-session",
  }),
): AgentDispatcher {
  return {
    dispatch: vi.fn(async (item: WorkItem) => resultFn(item)),
    dispatchDirect: vi.fn(),
  } as unknown as AgentDispatcher;
}

async function seedSprint(data: SprintStatusData): Promise<void> {
  await mkdir(TEST_DIR, { recursive: true });
  await writeFile(SPRINT_STATUS_PATH, yaml.dump(data));
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("SprintRunner", () => {
  beforeEach(async () => {
    await mkdir(TEST_DIR, { recursive: true });
  });

  afterEach(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  it("should report idle when no sprint-status.yaml exists", async () => {
    const config = makeConfig();
    const dispatcher = makeMockDispatcher();
    const runner = new SprintRunner(dispatcher, config);
    const events: SprintEvent[] = [];

    const doneCount = await runner.runCycle({
      onEvent: (e) => events.push(e),
    });

    expect(doneCount).toBe(0);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("sprint-idle");
  });

  it("should report idle when all stories are done", async () => {
    await seedSprint(makeSprintData([
      { id: "S-001", title: "Done story", status: "done" },
    ]));

    const config = makeConfig();
    const dispatcher = makeMockDispatcher();
    const runner = new SprintRunner(dispatcher, config);
    const events: SprintEvent[] = [];

    const doneCount = await runner.runCycle({
      onEvent: (e) => events.push(e),
    });

    expect(doneCount).toBe(0);
    expect(events.some((e) => e.type === "sprint-idle")).toBe(true);
  });

  it("should process actionable stories in dry-run mode", async () => {
    await seedSprint(makeSprintData([
      { id: "S-001", title: "First story", status: "ready-for-dev" },
      { id: "S-002", title: "Second story", status: "ready-for-dev" },
    ]));

    const config = makeConfig();
    const dispatcher = makeMockDispatcher();
    const runner = new SprintRunner(dispatcher, config);
    const events: SprintEvent[] = [];

    const doneCount = await runner.runCycle({
      live: false,
      onEvent: (e) => events.push(e),
    });

    expect(doneCount).toBe(0); // dry-run never marks done
    // Should have sprint-start, 2x (story-start + story-complete), sprint-complete
    expect(events.filter((e) => e.type === "sprint-start")).toHaveLength(1);
    expect(events.filter((e) => e.type === "story-start")).toHaveLength(2);
    expect(events.filter((e) => e.type === "story-complete")).toHaveLength(2);
    expect(events.filter((e) => e.type === "sprint-complete")).toHaveLength(1);
    // Dispatcher should NOT be called in dry-run
    expect(dispatcher.dispatch).not.toHaveBeenCalled();
  });

  it("should filter stories by storyFilter option", async () => {
    await seedSprint(makeSprintData([
      { id: "S-001", title: "First story", status: "ready-for-dev" },
      { id: "S-002", title: "Second story", status: "ready-for-dev" },
    ]));

    const config = makeConfig();
    const dispatcher = makeMockDispatcher();
    const runner = new SprintRunner(dispatcher, config);
    const events: SprintEvent[] = [];

    await runner.runCycle({
      live: false,
      storyFilter: "S-002",
      onEvent: (e) => events.push(e),
    });

    const storyStarts = events.filter((e) => e.type === "story-start");
    expect(storyStarts).toHaveLength(1);
    if (storyStarts[0].type === "story-start") {
      expect(storyStarts[0].storyId).toBe("S-002");
    }
  });

  it("should map story status to correct phase", async () => {
    await seedSprint(makeSprintData([
      { id: "S-001", title: "Ready story", status: "ready-for-dev" },
      { id: "S-002", title: "In-progress story", status: "in-progress" },
    ]));

    const config = makeConfig();
    const dispatcher = makeMockDispatcher();
    const runner = new SprintRunner(dispatcher, config);
    const events: SprintEvent[] = [];

    await runner.runCycle({
      live: false,
      onEvent: (e) => events.push(e),
    });

    const storyStarts = events.filter(
      (e): e is Extract<SprintEvent, { type: "story-start" }> => e.type === "story-start",
    );
    expect(storyStarts).toHaveLength(2);
    expect(storyStarts[0].phase).toBe("dev-story"); // ready-for-dev → dev-story
    expect(storyStarts[1].phase).toBe("dev-story"); // in-progress → dev-story
  });

  it("should emit story-failed on dispatch error", async () => {
    await seedSprint(makeSprintData([
      { id: "S-001", title: "Failing story", status: "ready-for-dev" },
    ]));

    const config = makeConfig();
    const dispatcher = makeMockDispatcher(() => {
      throw new Error("SDK connection lost");
    });
    const runner = new SprintRunner(dispatcher, config);
    const events: SprintEvent[] = [];

    const doneCount = await runner.runCycle({
      onEvent: (e) => events.push(e),
    });

    expect(doneCount).toBe(0);
    const failures = events.filter((e) => e.type === "story-failed");
    expect(failures).toHaveLength(1);
    if (failures[0].type === "story-failed") {
      expect(failures[0].error).toContain("SDK connection lost");
    }
  });

  it("should produce a sprint summary", async () => {
    await seedSprint(makeSprintData([
      { id: "S-001", title: "Done", status: "done" },
      { id: "S-002", title: "In progress", status: "in-progress" },
      { id: "S-003", title: "Ready", status: "ready-for-dev" },
    ]));

    const config = makeConfig();
    const dispatcher = makeMockDispatcher();
    const runner = new SprintRunner(dispatcher, config);

    const summary = await runner.getSprintSummary();
    expect(summary).toContain("Sprint #1");
    expect(summary).toContain("Test sprint");
    expect(summary).toContain("done");
    expect(summary).toContain("in-progress");
  });

  it("should return default sprint summary when file is missing", async () => {
    // readSprintStatus returns a default (doesn't throw), so summary shows the default sprint
    const missingPath = resolve(TEST_DIR, "nonexistent", "missing.yaml");
    const config = makeConfig({ sprintStatusPath: missingPath });
    const dispatcher = makeMockDispatcher();
    const runner = new SprintRunner(dispatcher, config);

    const summary = await runner.getSprintSummary();
    expect(summary).toContain("Sprint #1");
    expect(summary).toContain("Stories: 0");
  });
});

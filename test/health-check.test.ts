/**
 * Health Check — Unit Tests
 *
 * Tests all 5 probes (config, agents, tools, sprint-file, paperclip),
 * aggregation logic, and formatted output.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { resolve } from "node:path";
import { mkdir, writeFile, rm } from "node:fs/promises";

// Mock the Copilot SDK to avoid import resolution errors
vi.mock("@github/copilot-sdk", () => ({
  CopilotClient: vi.fn(),
  approveAll: vi.fn(),
  defineTool: vi.fn((_name: string, _opts: unknown) => ({ name: _name })),
}));

// Mock observability (imported transitively)
vi.mock("../src/observability/logger.js", () => ({
  Logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
}));

vi.mock("../src/observability/metrics.js", () => ({
  recordSessionOpen: vi.fn(),
  recordSessionClose: vi.fn(),
  recordDispatchDuration: vi.fn(),
}));

import { checkHealth, formatHealthResult } from "../src/adapter/health-check.js";
import type { HealthCheckResult } from "../src/adapter/health-check.js";
import type { BmadConfig } from "../src/config/config.js";

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const TEST_DIR = resolve(import.meta.dirname ?? ".", ".test-health-check");
const SPRINT_PATH = resolve(TEST_DIR, "sprint-status.yaml");

function makeConfig(overrides: Partial<BmadConfig> = {}): BmadConfig {
  return {
    gheHost: undefined,
    model: "test-model",
    outputDir: TEST_DIR,
    sprintStatusPath: SPRINT_PATH,
    reviewPassLimit: 3,
    logLevel: "warning",
    projectRoot: TEST_DIR,
    targetProjectRoot: TEST_DIR,
    paperclip: {
      url: "http://localhost:3100",
      agentApiKey: "",
      companyId: "test",
      inboxCheckIntervalMs: 15000,
      timeoutMs: 10000,
      enabled: false,
      mode: "inbox-polling" as const,
      webhookPort: 3200,
    },
    observability: {
      logLevel: "info",
      logFormat: "human",
      otelEnabled: false,
      otelEndpoint: "http://localhost:4317",
      otelServiceName: "test",
      stallCheckIntervalMs: 60000,
      stallAutoEscalate: false,
    },
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("Health Check", () => {
  beforeEach(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
    await mkdir(TEST_DIR, { recursive: true });
  });

  describe("checkHealth — aggregation", () => {
    it("returns healthy when all probes pass", async () => {
      // Create a sprint file so that probe passes
      await writeFile(SPRINT_PATH, "sprint:\n  number: 1\n");

      const config = makeConfig();
      const result = await checkHealth(config);

      expect(result.status).toBe("healthy");
      expect(result.summary).toContain("All");
      expect(result.summary).toContain("probes passed");
      expect(result.timestamp).toBeTruthy();
    });

    it("returns degraded when only non-critical probes fail", async () => {
      // No sprint file → sprint-file probe fails (non-critical)
      const config = makeConfig({ sprintStatusPath: "/nonexistent/path.yaml" });
      const result = await checkHealth(config);

      // sprint-file is non-critical, paperclip is disabled (non-critical pass)
      // config, agents, tools are critical — should pass
      expect(result.status).toBe("degraded");
      expect(result.summary).toContain("failed");
    });

    it("returns unhealthy when a critical probe fails", async () => {
      // Empty model = missing config field → critical failure
      const config = makeConfig({ model: "" });
      const result = await checkHealth(config);

      expect(result.status).toBe("unhealthy");
      const configProbe = result.probes.find((p) => p.name === "config");
      expect(configProbe?.ok).toBe(false);
      expect(configProbe?.critical).toBe(true);
    });

    it("includes timestamp in ISO format", async () => {
      const config = makeConfig();
      const result = await checkHealth(config);

      expect(result.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });
  });

  describe("config probe", () => {
    it("passes with all required fields", async () => {
      const config = makeConfig();
      const result = await checkHealth(config);
      const probe = result.probes.find((p) => p.name === "config");

      expect(probe?.ok).toBe(true);
      expect(probe?.message).toContain("Config valid");
      expect(probe?.message).toContain("test-model");
    });

    it("fails on missing projectRoot", async () => {
      const config = makeConfig({ projectRoot: "" });
      const result = await checkHealth(config);
      const probe = result.probes.find((p) => p.name === "config");

      expect(probe?.ok).toBe(false);
      expect(probe?.message).toContain("projectRoot");
    });

    it("fails on missing sprintStatusPath", async () => {
      const config = makeConfig({ sprintStatusPath: "" });
      const result = await checkHealth(config);
      const probe = result.probes.find((p) => p.name === "config");

      expect(probe?.ok).toBe(false);
      expect(probe?.message).toContain("sprintStatusPath");
    });

    it("fails on reviewPassLimit <= 0", async () => {
      const config = makeConfig({ reviewPassLimit: 0 });
      const result = await checkHealth(config);
      const probe = result.probes.find((p) => p.name === "config");

      expect(probe?.ok).toBe(false);
      expect(probe?.message).toContain("reviewPassLimit");
    });

    it("reports multiple missing fields", async () => {
      const config = makeConfig({ projectRoot: "", model: "", outputDir: "" });
      const result = await checkHealth(config);
      const probe = result.probes.find((p) => p.name === "config");

      expect(probe?.ok).toBe(false);
      expect(probe?.message).toContain("projectRoot");
      expect(probe?.message).toContain("model");
      expect(probe?.message).toContain("outputDir");
    });
  });

  describe("agents probe", () => {
    it("passes when agents are registered", async () => {
      const config = makeConfig();
      const result = await checkHealth(config);
      const probe = result.probes.find((p) => p.name === "agents");

      expect(probe?.ok).toBe(true);
      expect(probe?.critical).toBe(true);
      expect(probe?.message).toMatch(/\d+ agent\(s\) registered/);
    });
  });

  describe("tools probe", () => {
    it("passes when required tools are registered", async () => {
      const config = makeConfig();
      const result = await checkHealth(config);
      const probe = result.probes.find((p) => p.name === "tools");

      expect(probe?.ok).toBe(true);
      expect(probe?.critical).toBe(true);
      expect(probe?.message).toContain("required tools registered");
    });
  });

  describe("sprint-file probe", () => {
    it("passes when sprint file exists", async () => {
      await writeFile(SPRINT_PATH, "sprint:\n  number: 1\n");

      const config = makeConfig();
      const result = await checkHealth(config);
      const probe = result.probes.find((p) => p.name === "sprint-file");

      expect(probe?.ok).toBe(true);
      expect(probe?.critical).toBe(false);
      expect(probe?.message).toContain("readable");
    });

    it("fails when sprint file is missing", async () => {
      const config = makeConfig({ sprintStatusPath: "/nonexistent/sprint-status.yaml" });
      const result = await checkHealth(config);
      const probe = result.probes.find((p) => p.name === "sprint-file");

      expect(probe?.ok).toBe(false);
      expect(probe?.critical).toBe(false);
      expect(probe?.message).toContain("not found");
    });
  });

  describe("paperclip probe", () => {
    it("passes (non-critical) when paperclip is disabled", async () => {
      const config = makeConfig();
      const result = await checkHealth(config);
      const probe = result.probes.find((p) => p.name === "paperclip");

      expect(probe?.ok).toBe(true);
      expect(probe?.critical).toBe(false);
      expect(probe?.message).toContain("disabled");
    });

    it("fails when paperclip is enabled but unreachable", async () => {
      const config = makeConfig({
        paperclip: {
          url: "http://localhost:19999",
          agentApiKey: "",
          companyId: "test",
          inboxCheckIntervalMs: 15000,
          timeoutMs: 1000,
          enabled: true,
          mode: "inbox-polling" as const,
          webhookPort: 3200,
        },
      });
      const result = await checkHealth(config);
      const probe = result.probes.find((p) => p.name === "paperclip");

      expect(probe?.ok).toBe(false);
      expect(probe?.critical).toBe(true);
    });
  });

  describe("formatHealthResult", () => {
    it("formats healthy result with checkmark icon", () => {
      const result: HealthCheckResult = {
        status: "healthy",
        probes: [
          { name: "config", ok: true, message: "Config valid", critical: true },
          { name: "agents", ok: true, message: "9 agents", critical: true },
        ],
        summary: "All 2 probes passed",
        timestamp: "2026-03-19T00:00:00.000Z",
      };

      const output = formatHealthResult(result);
      expect(output).toContain("✅");
      expect(output).toContain("HEALTHY");
      expect(output).toContain("All 2 probes passed");
      expect(output).toContain("✓");
    });

    it("formats unhealthy result with cross icon", () => {
      const result: HealthCheckResult = {
        status: "unhealthy",
        probes: [
          { name: "config", ok: false, message: "Missing model", critical: true },
        ],
        summary: "1/1 probe(s) failed — status: unhealthy",
        timestamp: "2026-03-19T00:00:00.000Z",
      };

      const output = formatHealthResult(result);
      expect(output).toContain("❌");
      expect(output).toContain("UNHEALTHY");
      expect(output).toContain("✗");
    });

    it("formats degraded result with warning icon", () => {
      const result: HealthCheckResult = {
        status: "degraded",
        probes: [
          { name: "config", ok: true, message: "Valid", critical: true },
          { name: "sprint-file", ok: false, message: "Not found", critical: false },
        ],
        summary: "1/2 probe(s) failed — status: degraded",
        timestamp: "2026-03-19T00:00:00.000Z",
      };

      const output = formatHealthResult(result);
      expect(output).toContain("⚠");
      expect(output).toContain("DEGRADED");
    });

    it("includes timestamp in output", () => {
      const result: HealthCheckResult = {
        status: "healthy",
        probes: [],
        summary: "OK",
        timestamp: "2026-03-19T12:34:56.789Z",
      };

      const output = formatHealthResult(result);
      expect(output).toContain("2026-03-19T12:34:56.789Z");
    });
  });
});

/**
 * Model Strategy — Unit Tests
 *
 * Tests the complexity classification and model selection pipeline:
 * - Phase-to-tier mapping
 * - Complexity signal upgrades
 * - BYOK provider selection
 * - Full resolve pipeline
 */

import { describe, it, expect } from "vitest";
import {
  classifyComplexity,
  selectModel,
  resolveModel,
  loadModelStrategyConfig,
} from "../src/config/model-strategy.js";
import type { ModelStrategyConfig, ComplexitySignals } from "../src/config/model-strategy.js";

// ─────────────────────────────────────────────────────────────────────────────
// Test Fixtures
// ─────────────────────────────────────────────────────────────────────────────

function makeConfig(overrides: Partial<ModelStrategyConfig> = {}): ModelStrategyConfig {
  return {
    defaultTier: "standard",
    preferByok: false,
    byokPreference: ["anthropic", "openai"],
    tiers: {
      fast: { copilot: "gpt-4o-mini", anthropic: "claude-haiku-3.5", openai: "gpt-4o-mini" },
      standard: { copilot: "claude-sonnet-4.5", anthropic: "claude-sonnet-4.5", openai: "gpt-4o" },
      powerful: { copilot: "claude-sonnet-4.5", anthropic: "claude-opus-4", openai: "o3" },
    },
    availableByok: new Set(),
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// classifyComplexity
// ─────────────────────────────────────────────────────────────────────────────

describe("classifyComplexity", () => {
  it("should map sprint-status to fast tier", () => {
    const { tier } = classifyComplexity("sprint-status");
    expect(tier).toBe("fast");
  });

  it("should map dev-story to standard tier", () => {
    const { tier } = classifyComplexity("dev-story");
    expect(tier).toBe("standard");
  });

  it("should map code-review to powerful tier", () => {
    const { tier } = classifyComplexity("code-review");
    expect(tier).toBe("powerful");
  });

  it("should respect explicit tier override", () => {
    const { tier, reason } = classifyComplexity("sprint-status", {
      explicitTier: "powerful",
    });
    expect(tier).toBe("powerful");
    expect(reason).toContain("Explicit tier override");
  });

  it("should upgrade to powerful for security-critical tasks", () => {
    const { tier } = classifyComplexity("dev-story", { securityCritical: true });
    expect(tier).toBe("powerful");
  });

  it("should upgrade to powerful for architectural changes", () => {
    const { tier } = classifyComplexity("dev-story", { architecturalChange: true });
    expect(tier).toBe("powerful");
  });

  it("should upgrade fast to standard for cross-module tasks", () => {
    const { tier } = classifyComplexity("sprint-status", { crossModule: true });
    expect(tier).toBe("standard");
  });

  it("should upgrade fast to standard for many files", () => {
    const { tier } = classifyComplexity("sprint-status", { fileCount: 10 });
    expect(tier).toBe("standard");
  });

  it("should upgrade standard to powerful for high LOC", () => {
    const { tier } = classifyComplexity("dev-story", { locEstimate: 800 });
    expect(tier).toBe("powerful");
  });

  it("should upgrade fast to standard for high LOC", () => {
    const { tier } = classifyComplexity("sprint-status", { locEstimate: 600 });
    expect(tier).toBe("standard");
  });

  it("should not downgrade from powerful", () => {
    const { tier } = classifyComplexity("code-review", { fileCount: 1, locEstimate: 10 });
    expect(tier).toBe("powerful");
  });

  it("should include reasoning in the response", () => {
    const { reason } = classifyComplexity("dev-story", { securityCritical: true });
    expect(reason).toContain("Security-critical");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// selectModel
// ─────────────────────────────────────────────────────────────────────────────

describe("selectModel", () => {
  it("should select Copilot model by default", () => {
    const config = makeConfig();
    const selection = selectModel("standard", config);

    expect(selection.model).toBe("claude-sonnet-4.5");
    expect(selection.provider).toBe("copilot");
    expect(selection.tier).toBe("standard");
  });

  it("should select BYOK Anthropic when preferred and available", () => {
    const config = makeConfig({
      preferByok: true,
      availableByok: new Set(["anthropic"]),
    });

    const selection = selectModel("powerful", config);
    expect(selection.model).toBe("claude-opus-4");
    expect(selection.provider).toBe("anthropic");
  });

  it("should select BYOK OpenAI when Anthropic unavailable", () => {
    const config = makeConfig({
      preferByok: true,
      availableByok: new Set(["openai"]),
    });

    const selection = selectModel("powerful", config);
    expect(selection.model).toBe("o3");
    expect(selection.provider).toBe("openai");
  });

  it("should fall back to Copilot when BYOK preferred but unavailable", () => {
    const config = makeConfig({
      preferByok: true,
      availableByok: new Set(),
    });

    const selection = selectModel("standard", config);
    expect(selection.model).toBe("claude-sonnet-4.5");
    expect(selection.provider).toBe("copilot");
  });

  it("should use Copilot even when BYOK available if not preferred", () => {
    const config = makeConfig({
      preferByok: false,
      availableByok: new Set(["anthropic", "openai"]),
    });

    const selection = selectModel("standard", config);
    expect(selection.provider).toBe("copilot");
  });

  it("should respect tier for fast model", () => {
    const config = makeConfig();
    const selection = selectModel("fast", config);
    expect(selection.model).toBe("gpt-4o-mini");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// resolveModel
// ─────────────────────────────────────────────────────────────────────────────

describe("resolveModel", () => {
  it("should combine classification and selection", () => {
    const config = makeConfig();
    const result = resolveModel("dev-story", {}, config);

    expect(result.tier).toBe("standard");
    expect(result.model).toBe("claude-sonnet-4.5");
    expect(result.provider).toBe("copilot");
    expect(result.complexityReason).toBeTruthy();
  });

  it("should route security-critical dev through powerful BYOK", () => {
    const config = makeConfig({
      preferByok: true,
      availableByok: new Set(["anthropic"]),
    });

    const result = resolveModel(
      "dev-story",
      { securityCritical: true },
      config,
    );

    expect(result.tier).toBe("powerful");
    expect(result.provider).toBe("anthropic");
    expect(result.model).toBe("claude-opus-4");
  });

  it("should route simple status check through fast Copilot", () => {
    const config = makeConfig();
    const result = resolveModel("sprint-status", {}, config);

    expect(result.tier).toBe("fast");
    expect(result.model).toBe("gpt-4o-mini");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// loadModelStrategyConfig
// ─────────────────────────────────────────────────────────────────────────────

describe("loadModelStrategyConfig", () => {
  it("should return a valid config with defaults", () => {
    const config = loadModelStrategyConfig();

    expect(config.defaultTier).toBe("standard");
    expect(config.preferByok).toBe(false);
    expect(config.tiers.fast.copilot).toBeTruthy();
    expect(config.tiers.standard.copilot).toBeTruthy();
    expect(config.tiers.powerful.copilot).toBeTruthy();
  });
});

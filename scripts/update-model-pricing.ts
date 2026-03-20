#!/usr/bin/env npx tsx
/**
 * Update Model Pricing — Fetch and apply current pricing to cost-tracker.ts
 *
 * Maintains a canonical pricing registry that can be:
 * 1. Displayed as a table (--show)
 * 2. Applied to src/observability/cost-tracker.ts (--apply)
 * 3. Exported as JSON (--json)
 *
 * Pricing data is hardcoded from official sources (fetched March 2026).
 * To refresh: update the PRICING_REGISTRY below from provider pricing pages,
 * then run: npx tsx scripts/update-model-pricing.ts --apply
 *
 * Sources:
 * - OpenAI:     https://platform.openai.com/docs/pricing
 * - Anthropic:  https://docs.anthropic.com/en/docs/about-claude/models
 * - Google:     https://ai.google.dev/gemini-api/docs/pricing
 *
 * Usage:
 *   npx tsx scripts/update-model-pricing.ts --show     # Print pricing table
 *   npx tsx scripts/update-model-pricing.ts --apply    # Update cost-tracker.ts
 *   npx tsx scripts/update-model-pricing.ts --json     # Export as JSON
 *
 * @module scripts/update-model-pricing
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

// ─────────────────────────────────────────────────────────────────────────────
// Pricing Registry (per 1M tokens, USD)
//
// Last updated: 2026-03-20
// ─────────────────────────────────────────────────────────────────────────────

interface ModelPricing {
  input: number;
  output: number;
  provider: "anthropic" | "openai" | "google" | "meta";
  /** "byok" = provider-native ID, "copilot" = Copilot SDK catalog ID */
  path: "byok" | "copilot";
  /** Date pricing was last verified (YYYY-MM-DD) */
  verified: string;
  /** Optional notes */
  notes?: string;
}

const PRICING_REGISTRY: Record<string, ModelPricing> = {
  // ═══════════════════════════════════════════════════════════════════════
  // Anthropic — Provider-native IDs (BYOK path via ANTHROPIC_API_KEY)
  // Source: https://docs.anthropic.com/en/docs/about-claude/models
  // ═══════════════════════════════════════════════════════════════════════

  "claude-opus-4-6":       { input: 5.00,  output: 25.00,  provider: "anthropic", path: "byok", verified: "2026-03-20" },
  "claude-sonnet-4-6":     { input: 3.00,  output: 15.00,  provider: "anthropic", path: "byok", verified: "2026-03-20" },
  "claude-haiku-4-5":      { input: 1.00,  output: 5.00,   provider: "anthropic", path: "byok", verified: "2026-03-20" },
  "claude-opus-4":         { input: 5.00,  output: 25.00,  provider: "anthropic", path: "byok", verified: "2026-03-20", notes: "Alias" },
  "claude-sonnet-4-5":     { input: 3.00,  output: 15.00,  provider: "anthropic", path: "byok", verified: "2026-03-20", notes: "Previous gen" },
  "claude-sonnet-4":       { input: 3.00,  output: 15.00,  provider: "anthropic", path: "byok", verified: "2026-03-20", notes: "Alias" },
  "claude-3-5-sonnet":     { input: 3.00,  output: 15.00,  provider: "anthropic", path: "byok", verified: "2026-03-20", notes: "Legacy" },
  "claude-3-opus":         { input: 15.00, output: 75.00,  provider: "anthropic", path: "byok", verified: "2026-03-20", notes: "Legacy" },
  "claude-3-haiku":        { input: 0.25,  output: 1.25,   provider: "anthropic", path: "byok", verified: "2026-03-20", notes: "Legacy" },

  // ═══════════════════════════════════════════════════════════════════════
  // Anthropic — Copilot SDK catalog IDs (dot notation, via gh auth)
  // These are the model IDs used in DEFAULT_TIER_MODELS in model-strategy.ts
  // ═══════════════════════════════════════════════════════════════════════

  "claude-opus-4.6":       { input: 5.00,  output: 25.00,  provider: "anthropic", path: "copilot", verified: "2026-03-20", notes: "Copilot catalog" },
  "claude-sonnet-4.6":     { input: 3.00,  output: 15.00,  provider: "anthropic", path: "copilot", verified: "2026-03-20", notes: "Copilot catalog" },
  "claude-haiku-4.5":      { input: 1.00,  output: 5.00,   provider: "anthropic", path: "copilot", verified: "2026-03-20", notes: "Copilot catalog" },
  "claude-haiku-3.5":      { input: 0.25,  output: 1.25,   provider: "anthropic", path: "copilot", verified: "2026-03-20", notes: "Copilot catalog, legacy" },

  // ═══════════════════════════════════════════════════════════════════════
  // OpenAI — GPT & O-series Models (both BYOK and Copilot use same IDs)
  // Source: https://platform.openai.com/docs/pricing (March 2026)
  // ═══════════════════════════════════════════════════════════════════════

  "gpt-5.4":               { input: 2.50,  output: 15.00,  provider: "openai", path: "byok", verified: "2026-03-20" },
  "gpt-5.4-mini":          { input: 0.75,  output: 4.50,   provider: "openai", path: "byok", verified: "2026-03-20" },
  "gpt-5.4-nano":          { input: 0.20,  output: 1.25,   provider: "openai", path: "byok", verified: "2026-03-20" },
  "gpt-5.4-pro":           { input: 30.00, output: 180.00, provider: "openai", path: "byok", verified: "2026-03-20" },
  "gpt-4o":                { input: 2.50,  output: 10.00,  provider: "openai", path: "byok", verified: "2026-03-20" },
  "gpt-4o-mini":           { input: 0.15,  output: 0.60,   provider: "openai", path: "byok", verified: "2026-03-20" },
  "gpt-4-turbo":           { input: 10.00, output: 30.00,  provider: "openai", path: "byok", verified: "2026-03-20", notes: "Legacy" },
  "o4-mini":               { input: 2.00,  output: 8.00,   provider: "openai", path: "byok", verified: "2026-03-20" },
  "o3":                    { input: 2.00,  output: 8.00,   provider: "openai", path: "byok", verified: "2026-03-20" },
  "o3-mini":               { input: 1.10,  output: 4.40,   provider: "openai", path: "byok", verified: "2026-03-20" },
  "o1":                    { input: 15.00, output: 60.00,  provider: "openai", path: "byok", verified: "2026-03-20" },
  "codex-mini-latest":     { input: 1.50,  output: 6.00,   provider: "openai", path: "byok", verified: "2026-03-20" },

  // ═══════════════════════════════════════════════════════════════════════
  // Google — Gemini Models
  // Source: https://ai.google.dev/gemini-api/docs/pricing (March 2026)
  // ═══════════════════════════════════════════════════════════════════════

  "gemini-3.1-pro":        { input: 2.00,  output: 12.00,  provider: "google", path: "byok", verified: "2026-03-20", notes: "≤200k context" },
  "gemini-3-flash":        { input: 0.50,  output: 3.00,   provider: "google", path: "byok", verified: "2026-03-20" },
  "gemini-3.1-flash-lite": { input: 0.25,  output: 1.50,   provider: "google", path: "byok", verified: "2026-03-20" },
  "gemini-2.5-pro":        { input: 1.25,  output: 10.00,  provider: "google", path: "byok", verified: "2026-03-20", notes: "≤200k context" },
  "gemini-2.5-flash":      { input: 0.30,  output: 2.50,   provider: "google", path: "byok", verified: "2026-03-20" },
  "gemini-2.5-flash-lite": { input: 0.10,  output: 0.40,   provider: "google", path: "byok", verified: "2026-03-20" },
  "gemini-2.0-flash":      { input: 0.10,  output: 0.40,   provider: "google", path: "byok", verified: "2026-03-20", notes: "Deprecated June 2026" },
};

// ─────────────────────────────────────────────────────────────────────────────
// Commands
// ─────────────────────────────────────────────────────────────────────────────

const COST_TRACKER_PATH = resolve(
  import.meta.dirname ?? process.cwd(),
  "../src/observability/cost-tracker.ts",
);

function showPricingTable(): void {
  console.log("\n📊 Model Pricing Registry (per 1M tokens, USD)\n");
  console.log(
    "  " +
    "Model".padEnd(28) +
    "Provider".padEnd(12) +
    "Path".padEnd(9) +
    "Input $".padStart(10) +
    "Output $".padStart(10) +
    "  Verified".padEnd(14) +
    "Notes",
  );
  console.log("  " + "─".repeat(105));

  let lastProvider = "";
  const sorted = Object.entries(PRICING_REGISTRY).sort(
    (a, b) => a[1].provider.localeCompare(b[1].provider)
      || a[1].path.localeCompare(b[1].path)
      || a[0].localeCompare(b[0]),
  );

  for (const [model, p] of sorted) {
    if (p.provider !== lastProvider) {
      if (lastProvider) console.log("");
      lastProvider = p.provider;
    }
    console.log(
      "  " +
      model.padEnd(28) +
      p.provider.padEnd(12) +
      p.path.padEnd(9) +
      `$${p.input.toFixed(2)}`.padStart(10) +
      `$${p.output.toFixed(2)}`.padStart(10) +
      `  ${p.verified}`.padEnd(14) +
      (p.notes ?? ""),
    );
  }
  console.log("");
}

function exportJson(): void {
  const slim: Record<string, { input: number; output: number }> = {};
  for (const [model, p] of Object.entries(PRICING_REGISTRY)) {
    slim[model] = { input: p.input, output: p.output };
  }
  console.log(JSON.stringify(slim, null, 2));
}

function applyToCostTracker(): void {
  console.log("\n🔧 Applying pricing to cost-tracker.ts...\n");

  const src = readFileSync(COST_TRACKER_PATH, "utf-8");

  // Build the replacement MODEL_PRICING block
  const lines: string[] = [];
  lines.push("const MODEL_PRICING: Record<string, { input: number; output: number }> = {");

  // Group by provider+path for clear sections
  const groupKey = (p: ModelPricing) => `${p.provider}:${p.path}`;
  const byGroup = new Map<string, [string, ModelPricing][]>();
  for (const [model, p] of Object.entries(PRICING_REGISTRY)) {
    const key = groupKey(p);
    const list = byGroup.get(key) ?? [];
    list.push([model, p]);
    byGroup.set(key, list);
  }

  const groupLabels: Record<string, string> = {
    "anthropic:byok":   "── Anthropic — Provider-native IDs (BYOK path) ──────────────────────",
    "anthropic:copilot": "── Anthropic — Copilot SDK catalog IDs (dot notation) ───────────────",
    "openai:byok":      "── OpenAI — GPT & O-series (March 2026) ─────────────────────────────",
    "google:byok":      "── Google — Gemini Models (March 2026) ───────────────────────────────",
  };

  for (const [group, models] of byGroup) {
    const label = groupLabels[group] ?? group;
    lines.push(`  // ${label}`);
    for (const [model, p] of models) {
      const padding = Math.max(1, 26 - model.length);
      const comment = p.notes ? ` // ${p.notes}` : "";
      lines.push(
        `  "${model}":${" ".repeat(padding)}{ input: ${p.input.toFixed(2)}, output: ${p.output.toFixed(2)} },${comment}`,
      );
    }
  }

  lines.push(`  // Default fallback (Sonnet-class pricing)`);
  lines.push(`  "default":${" ".repeat(20)}{ input: 3.00, output: 15.00 },`);
  lines.push("};");

  const newBlock = lines.join("\n");

  // Find and replace the existing MODEL_PRICING block
  const startMarker = "const MODEL_PRICING: Record<string, { input: number; output: number }> = {";
  const startIdx = src.indexOf(startMarker);
  if (startIdx === -1) {
    console.error("❌ Could not find MODEL_PRICING block in cost-tracker.ts");
    process.exit(1);
  }

  // Find the closing }; of the block
  let braceDepth = 0;
  let endIdx = startIdx;
  for (let i = startIdx; i < src.length; i++) {
    if (src[i] === "{") braceDepth++;
    if (src[i] === "}") {
      braceDepth--;
      if (braceDepth === 0) {
        // Include the semicolon after the closing brace
        endIdx = src[i + 1] === ";" ? i + 2 : i + 1;
        break;
      }
    }
  }

  const before = src.slice(0, startIdx);
  const after = src.slice(endIdx);
  const updated = before + newBlock + after;

  writeFileSync(COST_TRACKER_PATH, updated, "utf-8");

  const modelCount = Object.keys(PRICING_REGISTRY).length;
  console.log(`  ✅ Updated MODEL_PRICING with ${modelCount} models + default fallback`);
  console.log(`  📄 ${COST_TRACKER_PATH}\n`);
  console.log("  Models updated:");
  for (const [group, models] of byGroup) {
    console.log(`    ${group}: ${models.map(([m]: [string, ModelPricing]) => m).join(", ")}`);
  }
  console.log("");
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);

if (args.includes("--json")) {
  exportJson();
} else if (args.includes("--apply")) {
  applyToCostTracker();
} else if (args.includes("--show") || args.length === 0) {
  showPricingTable();
  if (args.length === 0) {
    console.log("  Usage:");
    console.log("    npx tsx scripts/update-model-pricing.ts --show     # Show this table");
    console.log("    npx tsx scripts/update-model-pricing.ts --apply    # Update cost-tracker.ts");
    console.log("    npx tsx scripts/update-model-pricing.ts --json     # Export as JSON\n");
  }
} else {
  console.error("Unknown flag. Use --show, --apply, or --json");
  process.exit(1);
}

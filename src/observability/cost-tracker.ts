/**
 * Cost Tracker — Token Usage Tracking for Paperclip Budget Integration
 *
 * Tracks estimated token usage per agent per heartbeat to support
 * Paperclip budget accounting. In the current Copilot SDK Technical Preview
 * (v0.1.32), the SDK does not expose per-request token counts, so this
 * module estimates usage based on prompt/response character lengths using
 * standard token-to-character ratios.
 *
 * When the Copilot SDK adds native token tracking, replace the estimation
 * logic with actual SDK usage data.
 *
 * Usage flow:
 *   1. heartbeat-entrypoint.ts creates a CostTracker at start
 *   2. After each sendAndWait(), call tracker.recordUsage()
 *   3. At heartbeat exit, call tracker.getSummary() to get totals
 *   4. Optionally report to Paperclip via issue comment or budget API
 *
 * @module observability/cost-tracker
 */

import { Logger } from "./logger.js";

const log = Logger.child("cost-tracker");

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A single usage record for one LLM interaction.
 */
export interface UsageRecord {
  /** BMAD agent name (e.g., "bmad-dev") */
  agentName: string;
  /** Model used (e.g., "claude-sonnet-4-5", "gpt-4o") */
  model: string;
  /** Estimated input tokens (prompt) */
  inputTokens: number;
  /** Estimated output tokens (response) */
  outputTokens: number;
  /** Estimated cost in USD (based on model pricing) */
  estimatedCostUsd: number;
  /** ISO timestamp */
  timestamp: string;
  /** Optional session ID for correlation */
  sessionId?: string;
  /** Optional work phase for categorization */
  phase?: string;
  /** Optional issue ID for per-ticket cost attribution */
  issueId?: string;
}

/**
 * Aggregated usage summary for a heartbeat run.
 */
export interface UsageSummary {
  /** Total estimated input tokens */
  totalInputTokens: number;
  /** Total estimated output tokens */
  totalOutputTokens: number;
  /** Total estimated cost in USD */
  totalCostUsd: number;
  /** Number of LLM interactions */
  interactionCount: number;
  /** Breakdown by agent */
  byAgent: Record<string, {
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
    interactions: number;
  }>;
  /** Breakdown by model */
  byModel: Record<string, {
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
    interactions: number;
  }>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Token Estimation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Approximate characters-per-token ratios.
 * Source: OpenAI tokenizer averages ~4 chars/token for English.
 * Claude averages ~3.5 chars/token. We use 4 as a safe estimate.
 */
const CHARS_PER_TOKEN = 4;

/**
 * Estimated pricing per 1M tokens (USD) by model family.
 * Last updated: March 2026 from official provider pricing pages.
 *
 * These are approximate — actual GitHub Copilot pricing is bundled into
 * the subscription. These values are used for budget estimation only.
 *
 * To refresh: npx tsx scripts/update-model-pricing.ts --apply
 */
const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  // ── Anthropic — Provider-native IDs (BYOK path) ──────────────────────
  "claude-opus-4-6":       { input: 5.00, output: 25.00 },
  "claude-sonnet-4-6":     { input: 3.00, output: 15.00 },
  "claude-haiku-4-5":      { input: 1.00, output: 5.00 },
  "claude-opus-4":         { input: 5.00, output: 25.00 },
  "claude-sonnet-4-5":     { input: 3.00, output: 15.00 },
  "claude-sonnet-4":       { input: 3.00, output: 15.00 },
  "claude-3-5-sonnet":     { input: 3.00, output: 15.00 }, // Legacy
  "claude-3-opus":         { input: 15.00, output: 75.00 }, // Legacy
  "claude-3-haiku":        { input: 0.25, output: 1.25 }, // Legacy
  // ── Anthropic — Copilot SDK catalog IDs (dot notation) ───────────────
  "claude-opus-4.6":       { input: 5.00, output: 25.00 },
  "claude-sonnet-4.6":     { input: 3.00, output: 15.00 },
  "claude-haiku-4.5":      { input: 1.00, output: 5.00 },
  "claude-haiku-3.5":      { input: 0.25, output: 1.25 },
  // ── OpenAI — GPT & O-series (March 2026) ─────────────────────────────
  "gpt-5.4":               { input: 2.50, output: 15.00 },
  "gpt-5.4-mini":          { input: 0.75, output: 4.50 },
  "gpt-5.4-nano":          { input: 0.20, output: 1.25 },
  "gpt-5.4-pro":           { input: 30.00, output: 180.00 },
  "gpt-4o":                { input: 2.50, output: 10.00 },
  "gpt-4o-mini":           { input: 0.15, output: 0.60 },
  "gpt-4-turbo":           { input: 10.00, output: 30.00 }, // Legacy
  "o4-mini":               { input: 2.00, output: 8.00 },
  "o3":                    { input: 2.00, output: 8.00 },
  "o3-mini":               { input: 1.10, output: 4.40 },
  "o1":                    { input: 15.00, output: 60.00 },
  "codex-mini-latest":     { input: 1.50, output: 6.00 },
  // ── Google — Gemini Models (March 2026) ───────────────────────────────
  "gemini-3.1-pro":        { input: 2.00, output: 12.00 },
  "gemini-3-flash":        { input: 0.50, output: 3.00 },
  "gemini-3.1-flash-lite": { input: 0.25, output: 1.50 },
  "gemini-2.5-pro":        { input: 1.25, output: 10.00 },
  "gemini-2.5-flash":      { input: 0.30, output: 2.50 },
  "gemini-2.5-flash-lite": { input: 0.10, output: 0.40 },
  "gemini-2.0-flash":      { input: 0.10, output: 0.40 }, // Deprecated June 2026
  // ── Default fallback (Sonnet-class pricing) ──────────────────────────
  "default":               { input: 3.00, output: 15.00 },
};

/**
 * Estimate token count from a string.
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Estimate cost for a given model and token counts.
 *
 * Lookup chain:
 * 1. Exact match on model ID
 * 2. Normalized match (dots ↔ dashes, e.g. "claude-sonnet-4.6" → "claude-sonnet-4-6")
 * 3. Prefix match (e.g. "claude-sonnet-4.6-20260301" → "claude-sonnet-4.6")
 * 4. Default fallback
 */
function estimateCost(model: string, inputTokens: number, outputTokens: number): number {
  type PricingEntry = { input: number; output: number };

  // 1. Exact match
  let pricing: PricingEntry | undefined = MODEL_PRICING[model];

  // 2. Normalized match (swap dots ↔ dashes in version segments)
  if (!pricing) {
    const normalized = model.replace(/(\d+)\.(\d+)/g, "$1-$2");
    pricing = MODEL_PRICING[normalized];
    if (!pricing) {
      const dotted = model.replace(/(\d+)-(\d+)/g, "$1.$2");
      pricing = MODEL_PRICING[dotted];
    }
  }

  // 3. Prefix match
  if (!pricing) {
    pricing = Object.entries(MODEL_PRICING).find(([key]) => model.startsWith(key))?.[1];
  }

  // 4. Default fallback
  const resolved: PricingEntry = pricing ?? MODEL_PRICING["default"];

  const inputCost = (inputTokens / 1_000_000) * resolved.input;
  const outputCost = (outputTokens / 1_000_000) * resolved.output;

  return Math.round((inputCost + outputCost) * 1_000_000) / 1_000_000; // 6 decimal places
}

/**
 * Infer the LLM provider from a model name.
 *
 * Used when constructing Paperclip cost events — the provider field is
 * required by the cost-events API.
 */
export function inferProvider(model: string): string {
  const m = model.toLowerCase();
  if (m.includes("claude") || m.includes("haiku") || m.includes("sonnet") || m.includes("opus")) return "anthropic";
  if (m.includes("gpt") || m.startsWith("o1") || m.startsWith("o3") || m.startsWith("o4")) return "openai";
  if (m.includes("gemini") || m.includes("gemma")) return "google";
  if (m.includes("copilot")) return "github";
  return "unknown";
}

// ─────────────────────────────────────────────────────────────────────────────
// Cost Tracker
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Tracks estimated token usage and costs across a heartbeat run.
 *
 * @example
 * ```ts
 * const tracker = new CostTracker();
 * tracker.recordUsage("bmad-dev", "claude-sonnet-4-5", prompt, response, { phase: "dev-story" });
 * const summary = tracker.getSummary();
 * console.log(`Total estimated cost: $${summary.totalCostUsd.toFixed(4)}`);
 * ```
 */
export class CostTracker {
  private records: UsageRecord[] = [];

  /**
   * Record a single LLM interaction.
   *
   * @param agentName - BMAD agent that made the call
   * @param model - Model name used
   * @param prompt - The input prompt text
   * @param response - The output response text
   * @param opts - Optional session/phase metadata
   */
  recordUsage(
    agentName: string,
    model: string,
    prompt: string,
    response: string,
    opts?: { sessionId?: string; phase?: string; issueId?: string },
  ): void {
    const inputTokens = estimateTokens(prompt);
    const outputTokens = estimateTokens(response);
    const estimatedCostUsd = estimateCost(model, inputTokens, outputTokens);

    const record: UsageRecord = {
      agentName,
      model,
      inputTokens,
      outputTokens,
      estimatedCostUsd,
      timestamp: new Date().toISOString(),
      sessionId: opts?.sessionId,
      phase: opts?.phase,
      issueId: opts?.issueId,
    };

    this.records.push(record);

    log.info("Token usage recorded", {
      agent: agentName,
      model,
      inputTokens,
      outputTokens,
      costUsd: estimatedCostUsd.toFixed(6),
    });
  }

  /**
   * Get aggregated usage summary.
   */
  getSummary(): UsageSummary {
    const summary: UsageSummary = {
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCostUsd: 0,
      interactionCount: this.records.length,
      byAgent: {},
      byModel: {},
    };

    for (const r of this.records) {
      summary.totalInputTokens += r.inputTokens;
      summary.totalOutputTokens += r.outputTokens;
      summary.totalCostUsd += r.estimatedCostUsd;

      // By agent
      if (!summary.byAgent[r.agentName]) {
        summary.byAgent[r.agentName] = { inputTokens: 0, outputTokens: 0, costUsd: 0, interactions: 0 };
      }
      summary.byAgent[r.agentName].inputTokens += r.inputTokens;
      summary.byAgent[r.agentName].outputTokens += r.outputTokens;
      summary.byAgent[r.agentName].costUsd += r.estimatedCostUsd;
      summary.byAgent[r.agentName].interactions++;

      // By model
      if (!summary.byModel[r.model]) {
        summary.byModel[r.model] = { inputTokens: 0, outputTokens: 0, costUsd: 0, interactions: 0 };
      }
      summary.byModel[r.model].inputTokens += r.inputTokens;
      summary.byModel[r.model].outputTokens += r.outputTokens;
      summary.byModel[r.model].costUsd += r.estimatedCostUsd;
      summary.byModel[r.model].interactions++;
    }

    // Round totals
    summary.totalCostUsd = Math.round(summary.totalCostUsd * 1_000_000) / 1_000_000;

    return summary;
  }

  /**
   * Format a usage summary as a Markdown string (for issue comments).
   */
  formatSummaryMarkdown(): string {
    const s = this.getSummary();

    if (s.interactionCount === 0) {
      return "📊 **Cost Tracker** — No LLM interactions recorded.";
    }

    const lines = [
      `📊 **Cost Tracker** — Heartbeat Usage Summary`,
      ``,
      `| Metric | Value |`,
      `|--------|-------|`,
      `| Interactions | ${s.interactionCount} |`,
      `| Input tokens (est.) | ${s.totalInputTokens.toLocaleString()} |`,
      `| Output tokens (est.) | ${s.totalOutputTokens.toLocaleString()} |`,
      `| Estimated cost | $${s.totalCostUsd.toFixed(4)} |`,
    ];

    if (Object.keys(s.byAgent).length > 1) {
      lines.push(``, `**By Agent:**`);
      for (const [name, data] of Object.entries(s.byAgent)) {
        lines.push(`- ${name}: ${data.interactions} calls, ~${(data.inputTokens + data.outputTokens).toLocaleString()} tokens, $${data.costUsd.toFixed(4)}`);
      }
    }

    return lines.join("\n");
  }

  /**
   * Get all individual records (for detailed logging or export).
   */
  getRecords(): readonly UsageRecord[] {
    return this.records;
  }

  /**
   * Reset the tracker (for a new heartbeat run).
   */
  reset(): void {
    this.records = [];
  }
}

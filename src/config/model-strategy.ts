/**
 * Model Strategy — Complexity-based model tier routing
 *
 * Maps task complexity to the optimal model tier, balancing cost vs capability.
 * Implements BMAD V6 model selection strategy with BYOK (Bring Your Own Key) support.
 *
 * Tier system:
 * - **fast**    — Simple tasks (formatting, status updates, simple queries)
 * - **standard** — Normal development tasks (code generation, reviews)
 * - **powerful** — Complex tasks (architecture decisions, multi-file refactors, security audit)
 *
 * Cost routing:
 * - When BYOK keys are available, expensive operations route through BYOK
 *   to preserve Copilot premium request quota for interactive work.
 * - When only Copilot quota is available, the model tier still applies
 *   but all requests go through Copilot.
 *
 * @module config/model-strategy
 */

import type { WorkPhase } from "../adapter/agent-dispatcher.js";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/** Model capability tiers. */
export type ModelTier = "fast" | "standard" | "powerful";

/** Available model providers. */
export type ModelProvider = "copilot" | "anthropic" | "openai";

/** A resolved model selection. */
export interface ModelSelection {
  /** The selected model identifier (e.g., "claude-sonnet-4.6", "gpt-4o-mini") */
  model: string;
  /** The provider to use */
  provider: ModelProvider;
  /** The tier this maps to */
  tier: ModelTier;
  /** Reason for the selection */
  reason: string;
}

/** Model configuration per tier. */
export interface TierModelConfig {
  /** Model ID for Copilot provider */
  copilot: string;
  /** Model ID for Anthropic BYOK (if available) */
  anthropic?: string;
  /** Model ID for OpenAI BYOK (if available) */
  openai?: string;
}

/** Full model strategy configuration. */
export interface ModelStrategyConfig {
  /** Default model tier when complexity can't be determined */
  defaultTier: ModelTier;
  /** Prefer BYOK over Copilot quota when keys are available */
  preferByok: boolean;
  /** BYOK provider preference order */
  byokPreference: ModelProvider[];
  /** Model mappings per tier */
  tiers: Record<ModelTier, TierModelConfig>;
  /** Available BYOK providers (determined by API key presence) */
  availableByok: Set<ModelProvider>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Default Configuration
// ─────────────────────────────────────────────────────────────────────────────

/** Default tier-to-model mapping. */
const DEFAULT_TIER_MODELS: Record<ModelTier, TierModelConfig> = {
  fast: {
    copilot: "gpt-4o-mini",
    anthropic: "claude-haiku-3.5",
    openai: "gpt-4o-mini",
  },
  standard: {
    copilot: "claude-sonnet-4.6",
    anthropic: "claude-sonnet-4.5",
    openai: "gpt-4o",
  },
  powerful: {
    copilot: "claude-opus-4.6",
    anthropic: "claude-opus-4",
    openai: "o3",
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Complexity Classification
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Phase-to-tier mapping. Determines baseline complexity from the work phase.
 */
const PHASE_TIER_MAP: Record<WorkPhase, ModelTier> = {
  // Core story lifecycle
  "sprint-status": "fast",
  "sprint-planning": "standard",
  "create-story": "standard",
  "dev-story": "standard",
  "code-review": "powerful",
  // Research phase
  "research": "standard",
  "domain-research": "standard",
  "market-research": "standard",
  "technical-research": "standard",
  // Define phase
  "create-prd": "standard",
  "create-architecture": "powerful",
  "create-ux-design": "standard",
  "create-product-brief": "standard",
  // Plan phase
  "create-epics": "standard",
  "check-implementation-readiness": "standard",
  // Execute phase (extensions)
  "e2e-tests": "standard",
  "documentation": "fast",
  "quick-dev": "standard",
  // Review phase (extensions)
  "editorial-review": "fast",
  // Generic delegated work
  "delegated-task": "standard",
};

/**
 * Complexity signals that can upgrade the tier.
 */
export interface ComplexitySignals {
  /** Number of files likely affected */
  fileCount?: number;
  /** Estimated lines of code to generate/review */
  locEstimate?: number;
  /** Whether the task involves architecture decisions */
  architecturalChange?: boolean;
  /** Whether security is a primary concern */
  securityCritical?: boolean;
  /** Whether the task requires cross-module understanding */
  crossModule?: boolean;
  /** Explicit tier override (from story metadata) */
  explicitTier?: ModelTier;
}

/**
 * Classify the complexity tier for a given work phase and signals.
 *
 * Rules:
 * 1. Explicit tier override always wins
 * 2. Security-critical or architectural changes → powerful
 * 3. Cross-module or high file count (>5) → at least standard
 * 4. High LOC estimate (>500) → upgrade one tier
 * 5. Base tier from phase mapping
 *
 * @param phase - The work phase
 * @param signals - Optional complexity signals
 * @returns The classified model tier
 */
export function classifyComplexity(
  phase: WorkPhase,
  signals: ComplexitySignals = {},
): { tier: ModelTier; reason: string } {
  // Rule 1: Explicit override
  if (signals.explicitTier) {
    return { tier: signals.explicitTier, reason: `Explicit tier override: ${signals.explicitTier}` };
  }

  let tier = PHASE_TIER_MAP[phase] ?? "standard";
  const reasons: string[] = [`Base tier from phase "${phase}": ${tier}`];

  // Rule 2: Security or architecture → powerful
  if (signals.securityCritical || signals.architecturalChange) {
    tier = "powerful";
    reasons.push(
      signals.securityCritical ? "Security-critical task" : "Architectural change",
    );
    return { tier, reason: reasons.join("; ") };
  }

  // Rule 3: Cross-module or many files → at least standard
  if (signals.crossModule || (signals.fileCount && signals.fileCount > 5)) {
    if (tier === "fast") {
      tier = "standard";
      reasons.push(`Upgraded from fast: ${signals.crossModule ? "cross-module" : `${signals.fileCount} files`}`);
    }
  }

  // Rule 4: High LOC → upgrade one tier
  if (signals.locEstimate && signals.locEstimate > 500) {
    if (tier === "fast") {
      tier = "standard";
      reasons.push(`Upgraded from fast: ${signals.locEstimate} LOC estimate`);
    } else if (tier === "standard") {
      tier = "powerful";
      reasons.push(`Upgraded from standard: ${signals.locEstimate} LOC estimate`);
    }
  }

  return { tier, reason: reasons.join("; ") };
}

// ─────────────────────────────────────────────────────────────────────────────
// Model Selection
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Select the best model for a given tier and configuration.
 *
 * @param tier - The model tier
 * @param config - Strategy configuration
 * @returns The model selection
 */
export function selectModel(
  tier: ModelTier,
  config: ModelStrategyConfig,
): ModelSelection {
  const tierConfig = config.tiers[tier];

  // If BYOK preferred and available, use BYOK
  if (config.preferByok) {
    for (const provider of config.byokPreference) {
      if (config.availableByok.has(provider) && tierConfig[provider]) {
        return {
          model: tierConfig[provider]!,
          provider,
          tier,
          reason: `BYOK ${provider} preferred for ${tier} tier`,
        };
      }
    }
  }

  // Fall back to Copilot
  return {
    model: tierConfig.copilot,
    provider: "copilot",
    tier,
    reason: `Copilot default for ${tier} tier`,
  };
}

/**
 * Full model selection pipeline: classify complexity → select model.
 *
 * @param phase - Work phase
 * @param signals - Complexity signals
 * @param config - Strategy configuration
 * @returns The model selection with reasoning
 */
export function resolveModel(
  phase: WorkPhase,
  signals: ComplexitySignals,
  config: ModelStrategyConfig,
): ModelSelection & { complexityReason: string } {
  const { tier, reason: complexityReason } = classifyComplexity(phase, signals);
  const selection = selectModel(tier, config);
  return { ...selection, complexityReason };
}

// ─────────────────────────────────────────────────────────────────────────────
// Configuration Loading
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Load model strategy configuration from environment variables.
 *
 * Environment variables:
 * - `MODEL_DEFAULT_TIER` — "fast" | "standard" | "powerful" (default: "standard")
 * - `MODEL_PREFER_BYOK` — "true" to prefer BYOK over Copilot (default: "false")
 * - `ANTHROPIC_API_KEY` — Anthropic API key (enables anthropic BYOK)
 * - `OPENAI_API_KEY` — OpenAI API key (enables openai BYOK)
 * - `MODEL_TIER_FAST` — Override fast tier Copilot model
 * - `MODEL_TIER_STANDARD` — Override standard tier Copilot model
 * - `MODEL_TIER_POWERFUL` — Override powerful tier Copilot model
 */
export function loadModelStrategyConfig(): ModelStrategyConfig {
  const availableByok = new Set<ModelProvider>();
  if (process.env.ANTHROPIC_API_KEY) availableByok.add("anthropic");
  if (process.env.OPENAI_API_KEY) availableByok.add("openai");

  const tiers = { ...DEFAULT_TIER_MODELS };

  // Allow per-tier Copilot model overrides
  if (process.env.MODEL_TIER_FAST) {
    tiers.fast = { ...tiers.fast, copilot: process.env.MODEL_TIER_FAST };
  }
  if (process.env.MODEL_TIER_STANDARD) {
    tiers.standard = { ...tiers.standard, copilot: process.env.MODEL_TIER_STANDARD };
  }
  if (process.env.MODEL_TIER_POWERFUL) {
    tiers.powerful = { ...tiers.powerful, copilot: process.env.MODEL_TIER_POWERFUL };
  }

  return {
    defaultTier: (process.env.MODEL_DEFAULT_TIER as ModelTier) || "standard",
    preferByok: process.env.MODEL_PREFER_BYOK === "true",
    byokPreference: ["anthropic", "openai"],
    tiers,
    availableByok,
  };
}

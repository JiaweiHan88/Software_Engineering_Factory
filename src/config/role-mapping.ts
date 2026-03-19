/**
 * Role Mapping — Paperclip Agent Role → BMAD Agent + Skills Configuration
 *
 * Maps Paperclip agent metadata (role, title, bmadRole) to the correct
 * BMAD agent persona and skill set for Copilot SDK session creation.
 *
 * Used by heartbeat-entrypoint.ts to determine which BMAD agent, skills,
 * and tools to load for each Paperclip agent heartbeat.
 *
 * @module config/role-mapping
 */

/**
 * Configuration for a single BMAD role within Paperclip.
 */
export interface RoleMappingEntry {
  /** BMAD agent name (from src/agents/registry.ts), or null for CEO */
  bmadAgentName: string | null;
  /** Display label for logs */
  displayName: string;
  /** Whether this role orchestrates (delegates) rather than does domain work */
  isOrchestrator: boolean;
  /** BMAD skill directories this role should have loaded */
  bmadSkills: string[];
  /** Additional Copilot SDK tool names available to this role */
  tools: string[];
}

/**
 * Master role mapping table.
 *
 * Lookup order in heartbeat-entrypoint.ts:
 * 1. agent.metadata.bmadRole (explicit)
 * 2. agent.title (if it matches a key here)
 * 3. agent.role (Paperclip role as fallback)
 */
export const ROLE_MAPPING: Record<string, RoleMappingEntry> = {
  // ─── CEO (Orchestrator) ──────────────────────────────────────────────
  ceo: {
    bmadAgentName: null, // CEO has no BMAD persona — it orchestrates
    displayName: "CEO",
    isOrchestrator: true,
    bmadSkills: [
      "bmad-help",
    ],
    tools: ["sprint_status"],
  },

  // ─── Product Manager ─────────────────────────────────────────────────
  "bmad-pm": {
    bmadAgentName: "bmad-pm",
    displayName: "Product Manager (John)",
    isOrchestrator: false,
    bmadSkills: [
      "bmad-brainstorming",
      "bmad-market-research",
      "bmad-create-product-brief",
      "bmad-create-prd",
      "bmad-edit-prd",
      "bmad-validate-prd",
      "bmad-create-epics-and-stories",
      "bmad-create-story",
      "bmad-check-implementation-readiness",
      "bmad-correct-course",
      "bmad-party-mode",
    ],
    tools: ["create_story", "sprint_status"],
  },

  // ─── Architect ────────────────────────────────────────────────────────
  "bmad-architect": {
    bmadAgentName: "bmad-architect",
    displayName: "Architect (Winston)",
    isOrchestrator: false,
    bmadSkills: [
      "bmad-create-architecture",
      "bmad-technical-research",
      "bmad-domain-research",
    ],
    tools: ["sprint_status"],
  },

  // ─── Developer ────────────────────────────────────────────────────────
  "bmad-dev": {
    bmadAgentName: "bmad-dev",
    displayName: "Developer (Amelia)",
    isOrchestrator: false,
    bmadSkills: [
      "bmad-dev-story",
      "bmad-quick-dev",
      "bmad-quick-spec",
    ],
    tools: ["dev_story", "sprint_status"],
  },

  // ─── QA Engineer ──────────────────────────────────────────────────────
  "bmad-qa": {
    bmadAgentName: "bmad-qa",
    displayName: "QA Engineer (Quinn)",
    isOrchestrator: false,
    bmadSkills: [
      "bmad-code-review",
      "bmad-review-adversarial-general",
      "bmad-review-edge-case-hunter",
      "bmad-qa-generate-e2e-tests",
      "bmad-testarch-atdd",
      "bmad-testarch-automate",
      "bmad-testarch-ci",
      "bmad-testarch-framework",
      "bmad-testarch-nfr",
      "bmad-testarch-test-design",
      "bmad-testarch-test-review",
      "bmad-testarch-trace",
    ],
    tools: ["code_review", "code_review_result", "quality_gate_evaluate", "sprint_status"],
  },

  // ─── Scrum Master ─────────────────────────────────────────────────────
  "bmad-sm": {
    bmadAgentName: "bmad-sm",
    displayName: "Scrum Master (Bob)",
    isOrchestrator: false,
    bmadSkills: [
      "bmad-sprint-planning",
      "bmad-sprint-status",
      "bmad-correct-course",
      "bmad-retrospective",
    ],
    tools: ["sprint_status", "create_story"],
  },

  // ─── Analyst ──────────────────────────────────────────────────────────
  "bmad-analyst": {
    bmadAgentName: "bmad-analyst",
    displayName: "Business Analyst (Mary)",
    isOrchestrator: false,
    bmadSkills: [
      "bmad-brainstorming",
      "bmad-market-research",
      "bmad-domain-research",
      "bmad-advanced-elicitation",
    ],
    tools: ["sprint_status"],
  },

  // ─── UX Designer ─────────────────────────────────────────────────────
  "bmad-ux-designer": {
    bmadAgentName: "bmad-ux-designer",
    displayName: "UX Designer (Sally)",
    isOrchestrator: false,
    bmadSkills: [
      "bmad-create-ux-design",
    ],
    tools: ["sprint_status"],
  },

  // ─── Tech Writer ──────────────────────────────────────────────────────
  "bmad-tech-writer": {
    bmadAgentName: "bmad-tech-writer",
    displayName: "Technical Writer (Paige)",
    isOrchestrator: false,
    bmadSkills: [
      "bmad-document-project",
      "bmad-generate-project-context",
      "bmad-index-docs",
      "bmad-shard-doc",
      "bmad-editorial-review-prose",
      "bmad-editorial-review-structure",
      "bmad-distillator",
    ],
    tools: ["sprint_status"],
  },

  // ─── Quick-Flow Solo Dev ──────────────────────────────────────────────
  "bmad-quick-flow-solo-dev": {
    bmadAgentName: "bmad-quick-flow-solo-dev",
    displayName: "Quick Flow Solo Dev (Barry)",
    isOrchestrator: false,
    bmadSkills: [
      "bmad-quick-flow-solo-dev",
      "bmad-dev-story",
      "bmad-quick-dev",
      "bmad-create-story",
      "bmad-code-review",
    ],
    tools: ["dev_story", "create_story", "code_review", "sprint_status"],
  },
};

/**
 * Paperclip skills that every agent gets (coordination layer).
 * These are loaded from the Paperclip repo's skills/ directory.
 */
export const PAPERCLIP_SKILLS = [
  "paperclip",
  "paperclip-create-agent",
  "para-memory-files",
];

/**
 * Resolve a Paperclip agent to its BMAD role mapping entry.
 *
 * Lookup order:
 * 1. agent.metadata.bmadRole (explicit annotation)
 * 2. agent.title (Paperclip title field, often set to bmad-* ID)
 * 3. agent.role (Paperclip role: ceo, engineer, etc.)
 * 4. Fallback: null (unknown role)
 *
 * @param agent - Paperclip agent record fields
 * @returns The role mapping entry, or null if no match
 */
export function resolveRoleMapping(agent: {
  role: string;
  title?: string | null;
  metadata?: Record<string, unknown> | null;
}): RoleMappingEntry | null {
  // 1. Explicit bmadRole in metadata
  const bmadRole = agent.metadata?.bmadRole as string | undefined;
  if (bmadRole && ROLE_MAPPING[bmadRole]) {
    return ROLE_MAPPING[bmadRole];
  }

  // 2. Title field (often set to "bmad-dev", "bmad-pm", etc.)
  if (agent.title && ROLE_MAPPING[agent.title]) {
    return ROLE_MAPPING[agent.title];
  }

  // 3. Paperclip role
  if (ROLE_MAPPING[agent.role]) {
    return ROLE_MAPPING[agent.role];
  }

  return null;
}

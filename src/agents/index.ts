/**
 * BMAD Agent Definitions — Copilot SDK Custom Agents
 *
 * Each BMAD role is defined as a Copilot SDK customAgent with a scoped prompt.
 * These are registered when creating a CopilotClient session.
 */

export { bmadProductManager } from "./product-manager.js";
export { bmadArchitect } from "./architect.js";
export { bmadDeveloper } from "./developer.js";
export { bmadCodeReviewer } from "./code-reviewer.js";
export { bmadProductOwner } from "./product-owner.js";

export type BmadAgentName =
  | "bmad-pm"
  | "bmad-architect"
  | "bmad-developer"
  | "bmad-code-reviewer"
  | "bmad-product-owner";

/**
 * Registry of all BMAD agents for use in session creation.
 */
export { allAgents, getAgent } from "./registry.js";

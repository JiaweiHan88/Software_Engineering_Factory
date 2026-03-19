import { bmadProductManager } from "./product-manager.js";
import { bmadArchitect } from "./architect.js";
import { bmadDeveloper } from "./developer.js";
import { bmadCodeReviewer } from "./code-reviewer.js";
import { bmadProductOwner } from "./product-owner.js";
import type { BmadAgent } from "./types.js";

/**
 * All BMAD agents, ready to pass to CopilotClient.createSession({ customAgents }).
 */
export const allAgents: BmadAgent[] = [
  bmadProductManager,
  bmadArchitect,
  bmadDeveloper,
  bmadCodeReviewer,
  bmadProductOwner,
];

/**
 * Lookup agent by name.
 */
export function getAgent(name: string): BmadAgent | undefined {
  return allAgents.find((a) => a.name === name);
}

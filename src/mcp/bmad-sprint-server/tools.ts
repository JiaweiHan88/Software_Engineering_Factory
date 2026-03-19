/**
 * BMAD Sprint MCP Server — Tool Handlers
 *
 * Implements the 5 MCP tools that expose BMAD sprint data:
 *   - get_sprint_status  — current sprint state from sprint-status.yaml
 *   - get_next_story     — next story in ready-for-dev state
 *   - update_story_status — move a story through the lifecycle
 *   - get_architecture_docs — project architecture context
 *   - get_story_details  — full story markdown with ACs and tasks
 *
 * These tools reuse the existing sprint-status utilities from src/tools/
 * and read BMAD artifacts from _bmad-output/.
 *
 * @module mcp/bmad-sprint-server/tools
 */

import { readFile, readdir } from "node:fs/promises";
import { resolve, extname } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  readSprintStatus,
  writeSprintStatus,
} from "../../tools/sprint-status.js";
import type { SprintStatusData, SprintStory } from "../../tools/sprint-status.js";
import { loadConfig } from "../../config/index.js";
import yaml from "js-yaml";

/** Valid story statuses in the BMAD lifecycle */
const STORY_STATUSES = [
  "backlog",
  "ready-for-dev",
  "in-progress",
  "review",
  "done",
] as const;

/**
 * Register all BMAD sprint tools on the given MCP server instance.
 *
 * @param server - The McpServer instance to register tools on
 */
export function registerSprintTools(server: McpServer): void {
  registerGetSprintStatus(server);
  registerGetNextStory(server);
  registerUpdateStoryStatus(server);
  registerGetArchitectureDocs(server);
  registerGetStoryDetails(server);
}

// ─────────────────────────────────────────────────────────────────────────────
// get_sprint_status
// ─────────────────────────────────────────────────────────────────────────────

/**
 * MCP tool: get_sprint_status
 *
 * Returns the full sprint status from sprint-status.yaml including
 * sprint number, goal, and all stories with their statuses.
 */
function registerGetSprintStatus(server: McpServer): void {
  server.tool(
    "get_sprint_status",
    "Read the current sprint status. Returns sprint number, goal, and all stories with their lifecycle status (backlog → ready-for-dev → in-progress → review → done).",
    {},
    async () => {
      try {
        const config = loadConfig();
        const data = await readSprintStatus(config.sprintStatusPath);

        // Build a summary with counts by status
        const counts = countByStatus(data);
        const summary = [
          `Sprint ${data.sprint.number}: ${data.sprint.goal}`,
          `Stories: ${data.sprint.stories.length} total`,
          ...Object.entries(counts).map(([status, count]) => `  ${status}: ${count}`),
        ].join("\n");

        return {
          content: [
            {
              type: "text" as const,
              text: `${summary}\n\n---\n\n${yaml.dump(data, { lineWidth: 120, noRefs: true })}`,
            },
          ],
        };
      } catch (error) {
        return errorResult(`Failed to read sprint status: ${String(error)}`);
      }
    },
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// get_next_story
// ─────────────────────────────────────────────────────────────────────────────

/**
 * MCP tool: get_next_story
 *
 * Finds the next story in "ready-for-dev" status. Returns its details
 * and the full story markdown if available.
 */
function registerGetNextStory(server: McpServer): void {
  server.tool(
    "get_next_story",
    "Get the next story ready for development. Returns the first story with status 'ready-for-dev' from the sprint, including its full markdown content if available.",
    {},
    async () => {
      try {
        const config = loadConfig();
        const data = await readSprintStatus(config.sprintStatusPath);
        const next = data.sprint.stories.find((s) => s.status === "ready-for-dev");

        if (!next) {
          return {
            content: [
              {
                type: "text" as const,
                text: "No stories in 'ready-for-dev' status. All stories are either in progress, in review, done, or still in backlog.",
              },
            ],
          };
        }

        // Try to read the full story markdown
        const storyContent = await readStoryFile(config.outputDir, next.id);

        const result = [
          `Next story ready for development:`,
          `  ID: ${next.id}`,
          `  Title: ${next.title}`,
          `  Status: ${next.status}`,
          next.assigned ? `  Assigned: ${next.assigned}` : `  Assigned: (unassigned)`,
        ].join("\n");

        if (storyContent) {
          return {
            content: [
              { type: "text" as const, text: result },
              { type: "text" as const, text: `\n---\n\n## Story Content\n\n${storyContent}` },
            ],
          };
        }

        return { content: [{ type: "text" as const, text: result }] };
      } catch (error) {
        return errorResult(`Failed to get next story: ${String(error)}`);
      }
    },
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// update_story_status
// ─────────────────────────────────────────────────────────────────────────────

/**
 * MCP tool: update_story_status
 *
 * Moves a story through the BMAD lifecycle. Validates transitions
 * and optionally increments the review pass counter.
 */
function registerUpdateStoryStatus(server: McpServer): void {
  server.tool(
    "update_story_status",
    "Update a story's lifecycle status. Valid statuses: backlog, ready-for-dev, in-progress, review, done. Optionally assign an agent and increment review pass count.",
    {
      story_id: z
        .string()
        .describe("The story identifier (e.g., 'STORY-001', 'ORCH-001')"),
      new_status: z
        .enum(STORY_STATUSES)
        .describe("The new lifecycle status for the story"),
      assigned: z
        .string()
        .optional()
        .describe("Agent to assign (e.g., 'bmad-developer', 'bmad-qa')"),
      increment_review_pass: z
        .boolean()
        .optional()
        .default(false)
        .describe("If true, increments the review pass counter"),
    },
    async (args) => {
      try {
        const config = loadConfig();
        const data = await readSprintStatus(config.sprintStatusPath);
        const story = data.sprint.stories.find((s) => s.id === args.story_id);

        if (!story) {
          return errorResult(
            `Story '${args.story_id}' not found in sprint ${data.sprint.number}. ` +
            `Available stories: ${data.sprint.stories.map((s) => s.id).join(", ") || "(none)"}`,
          );
        }

        // Validate lifecycle transition
        const validationError = validateTransition(story.status, args.new_status);
        if (validationError) {
          return errorResult(validationError);
        }

        const oldStatus = story.status;
        story.status = args.new_status;
        if (args.assigned) story.assigned = args.assigned;
        if (args.increment_review_pass) {
          story.reviewPasses = (story.reviewPasses ?? 0) + 1;
        }

        await writeSprintStatus(config.sprintStatusPath, data);

        return {
          content: [
            {
              type: "text" as const,
              text: [
                `Story ${args.story_id} updated:`,
                `  Status: ${oldStatus} → ${args.new_status}`,
                args.assigned ? `  Assigned: ${args.assigned}` : null,
                args.increment_review_pass
                  ? `  Review passes: ${story.reviewPasses}`
                  : null,
              ]
                .filter(Boolean)
                .join("\n"),
            },
          ],
        };
      } catch (error) {
        return errorResult(`Failed to update story status: ${String(error)}`);
      }
    },
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// get_architecture_docs
// ─────────────────────────────────────────────────────────────────────────────

/**
 * MCP tool: get_architecture_docs
 *
 * Returns the project architecture documentation from docs/architecture.md.
 * Optionally includes additional docs from the docs/ directory.
 */
function registerGetArchitectureDocs(server: McpServer): void {
  server.tool(
    "get_architecture_docs",
    "Get project architecture documentation. Returns docs/architecture.md content and optionally lists all available documentation files.",
    {
      include_file_list: z
        .boolean()
        .optional()
        .default(false)
        .describe("If true, also returns a list of all files in the docs/ directory"),
    },
    async (args) => {
      try {
        const config = loadConfig();
        const archPath = resolve(config.projectRoot, "docs", "architecture.md");

        let archContent: string;
        try {
          archContent = await readFile(archPath, "utf-8");
        } catch {
          return errorResult(
            "docs/architecture.md not found. The architecture documentation has not been created yet.",
          );
        }

        const contentBlocks: Array<{ type: "text"; text: string }> = [
          { type: "text" as const, text: archContent },
        ];

        if (args.include_file_list) {
          const docsDir = resolve(config.projectRoot, "docs");
          try {
            const files = await readdir(docsDir, { recursive: true });
            const docFiles = files
              .filter((f) => typeof f === "string" && (f.endsWith(".md") || f.endsWith(".txt")))
              .map((f) => `  - docs/${f}`);

            contentBlocks.push({
              type: "text" as const,
              text: `\n---\n\nAvailable documentation files:\n${docFiles.join("\n")}`,
            });
          } catch {
            contentBlocks.push({
              type: "text" as const,
              text: "\n---\n\n(Could not list docs/ directory)",
            });
          }
        }

        return { content: contentBlocks };
      } catch (error) {
        return errorResult(`Failed to read architecture docs: ${String(error)}`);
      }
    },
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// get_story_details
// ─────────────────────────────────────────────────────────────────────────────

/**
 * MCP tool: get_story_details
 *
 * Returns the full story markdown content along with its sprint status metadata.
 */
function registerGetStoryDetails(server: McpServer): void {
  server.tool(
    "get_story_details",
    "Get full details of a specific story by ID. Returns the story's markdown content (acceptance criteria, tasks, developer notes) and its sprint status metadata.",
    {
      story_id: z
        .string()
        .describe("The story identifier (e.g., 'STORY-001', 'ORCH-001')"),
    },
    async (args) => {
      try {
        const config = loadConfig();

        // Get sprint status metadata for this story
        const data = await readSprintStatus(config.sprintStatusPath);
        const story = data.sprint.stories.find((s) => s.id === args.story_id);

        const metadataBlock = story
          ? [
              `## Sprint Metadata`,
              `- **ID:** ${story.id}`,
              `- **Title:** ${story.title}`,
              `- **Status:** ${story.status}`,
              `- **Assigned:** ${story.assigned ?? "(unassigned)"}`,
              `- **Review Passes:** ${story.reviewPasses ?? 0}`,
            ].join("\n")
          : `Story '${args.story_id}' not found in sprint tracker.`;

        // Read the full story file
        const storyContent = await readStoryFile(config.outputDir, args.story_id);

        if (!storyContent && !story) {
          return errorResult(
            `Story '${args.story_id}' not found. No sprint entry and no story file exists. ` +
            `Available stories: ${data.sprint.stories.map((s) => s.id).join(", ") || "(none)"}`,
          );
        }

        const contentBlocks: Array<{ type: "text"; text: string }> = [
          { type: "text" as const, text: metadataBlock },
        ];

        if (storyContent) {
          contentBlocks.push({
            type: "text" as const,
            text: `\n---\n\n## Story Content\n\n${storyContent}`,
          });
        } else {
          contentBlocks.push({
            type: "text" as const,
            text: `\n---\n\n(Story file not found at _bmad-output/stories/${args.story_id}.md)`,
          });
        }

        return { content: contentBlocks };
      } catch (error) {
        return errorResult(`Failed to get story details: ${String(error)}`);
      }
    },
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Count stories grouped by status.
 */
function countByStatus(data: SprintStatusData): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const story of data.sprint.stories) {
    counts[story.status] = (counts[story.status] ?? 0) + 1;
  }
  return counts;
}

/**
 * Read a story markdown file from the output directory.
 * Returns null if the file doesn't exist.
 */
async function readStoryFile(outputDir: string, storyId: string): Promise<string | null> {
  const storyPath = resolve(outputDir, "stories", `${storyId}.md`);
  try {
    return await readFile(storyPath, "utf-8");
  } catch {
    return null;
  }
}

/**
 * Validate a story lifecycle transition.
 *
 * Valid forward transitions:
 *   backlog → ready-for-dev → in-progress → review → done
 *
 * Backward transitions allowed:
 *   review → in-progress (rework after failed code review)
 *   done → review (reopen for re-review)
 *
 * @returns Error message string if invalid, undefined if valid
 */
function validateTransition(
  currentStatus: string,
  newStatus: string,
): string | undefined {
  // Same status is always allowed (idempotent)
  if (currentStatus === newStatus) return undefined;

  const validTransitions: Record<string, string[]> = {
    backlog: ["ready-for-dev"],
    "ready-for-dev": ["in-progress", "backlog"],
    "in-progress": ["review", "ready-for-dev"],
    review: ["done", "in-progress"],
    done: ["review"],
  };

  const allowed = validTransitions[currentStatus];
  if (!allowed || !allowed.includes(newStatus)) {
    return (
      `Invalid status transition: '${currentStatus}' → '${newStatus}'. ` +
      `Allowed transitions from '${currentStatus}': ${allowed?.join(", ") ?? "(none)"}`
    );
  }

  return undefined;
}

/**
 * Build a standardized MCP error result.
 */
function errorResult(message: string) {
  return {
    content: [{ type: "text" as const, text: message }],
    isError: true,
  };
}

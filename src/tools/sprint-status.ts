/**
 * sprint-status tool — BMAD sprint status management.
 *
 * Reads and updates the sprint-status.yaml file which tracks all
 * stories across their lifecycle: backlog → ready-for-dev → in-progress → review → done.
 *
 * @module tools/sprint-status
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import yaml from "js-yaml";
import { defineTool } from "./types.js";
import { loadConfig } from "../config/index.js";

/** Valid story statuses in the BMAD lifecycle */
const STORY_STATUSES = ["backlog", "ready-for-dev", "in-progress", "review", "done"] as const;
type StoryStatus = (typeof STORY_STATUSES)[number];

/** Shape of a single story in sprint-status.yaml */
export interface SprintStory {
  id: string;
  title: string;
  status: StoryStatus;
  assigned?: string;
  reviewPasses?: number;
}

/** Shape of the sprint-status.yaml file */
export interface SprintStatusData {
  sprint: {
    number: number;
    goal: string;
    stories: SprintStory[];
  };
}

/**
 * Read sprint-status.yaml from disk.
 * Returns a default structure if the file doesn't exist.
 */
export async function readSprintStatus(filePath: string): Promise<SprintStatusData> {
  try {
    const content = await readFile(filePath, "utf-8");
    return yaml.load(content) as SprintStatusData;
  } catch {
    return {
      sprint: {
        number: 1,
        goal: "Initial sprint",
        stories: [],
      },
    };
  }
}

/**
 * Write sprint-status.yaml to disk.
 */
export async function writeSprintStatus(filePath: string, data: SprintStatusData): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const content = yaml.dump(data, { lineWidth: 120, noRefs: true });
  await writeFile(filePath, content, "utf-8");
}

/**
 * Copilot SDK tool: sprint_status
 *
 * Actions:
 * - `read` — returns full sprint status
 * - `update` — changes a story's status and optionally increments review passes
 * - `add` — adds a new story to the sprint
 */
export const sprintStatusTool = defineTool("sprint_status", {
  description:
    "Read or update the sprint status file (sprint-status.yaml). " +
    "Use action='read' to get all stories, 'update' to change a story's status, " +
    "'add' to insert a new story into the sprint.",
  parameters: z.object({
    action: z
      .enum(["read", "update", "add"])
      .describe("Action to perform on the sprint status file"),
    story_id: z
      .string()
      .optional()
      .describe("Story identifier (required for 'update' and 'add')"),
    story_title: z
      .string()
      .optional()
      .describe("Story title (required for 'add')"),
    new_status: z
      .enum(STORY_STATUSES)
      .optional()
      .describe("New status value (required for 'update')"),
    assigned: z
      .string()
      .optional()
      .describe("Agent assigned to the story (e.g., 'bmad-developer')"),
    increment_review_pass: z
      .boolean()
      .optional()
      .describe("If true, increments the review pass counter (for 'update')"),
  }),
  handler: async (args) => {
    const config = loadConfig();
    const filePath = config.sprintStatusPath;

    if (args.action === "read") {
      const data = await readSprintStatus(filePath);
      return {
        textResultForLlm: yaml.dump(data, { lineWidth: 120, noRefs: true }),
        resultType: "success" as const,
      };
    }

    if (args.action === "add") {
      if (!args.story_id || !args.story_title) {
        return {
          textResultForLlm: "Error: story_id and story_title are required for 'add' action.",
          resultType: "failure" as const,
        };
      }
      const data = await readSprintStatus(filePath);
      const existing = data.sprint.stories.find((s) => s.id === args.story_id);
      if (existing) {
        return {
          textResultForLlm: `Error: Story ${args.story_id} already exists with status '${existing.status}'.`,
          resultType: "failure" as const,
        };
      }
      data.sprint.stories.push({
        id: args.story_id,
        title: args.story_title,
        status: args.new_status ?? "backlog",
        assigned: args.assigned,
        reviewPasses: 0,
      });
      await writeSprintStatus(filePath, data);
      return {
        textResultForLlm: `Story ${args.story_id} added to sprint ${data.sprint.number} with status '${args.new_status ?? "backlog"}'.`,
        resultType: "success" as const,
      };
    }

    if (args.action === "update") {
      if (!args.story_id) {
        return {
          textResultForLlm: "Error: story_id is required for 'update' action.",
          resultType: "failure" as const,
        };
      }
      const data = await readSprintStatus(filePath);
      const story = data.sprint.stories.find((s) => s.id === args.story_id);
      if (!story) {
        return {
          textResultForLlm: `Error: Story ${args.story_id} not found in sprint.`,
          resultType: "failure" as const,
        };
      }
      if (args.new_status) story.status = args.new_status;
      if (args.assigned) story.assigned = args.assigned;
      if (args.increment_review_pass) story.reviewPasses = (story.reviewPasses ?? 0) + 1;
      await writeSprintStatus(filePath, data);
      return {
        textResultForLlm: `Story ${args.story_id} updated: status='${story.status}', assigned='${story.assigned ?? "unassigned"}', reviewPasses=${story.reviewPasses ?? 0}.`,
        resultType: "success" as const,
      };
    }

    return {
      textResultForLlm: `Unknown action: ${args.action}`,
      resultType: "failure" as const,
    };
  },
});


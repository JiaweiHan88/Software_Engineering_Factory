/**
 * sprint-status YAML helpers — BMAD sprint status file I/O.
 *
 * These helpers are retained for backward compatibility with quality-gates
 * (review-orchestrator.ts, tool.ts) which have not yet been migrated to
 * Paperclip issue state. The sprint_status Copilot SDK tool has been removed.
 *
 * @deprecated Migrate callers to Paperclip issue state (P1-1, P1-2).
 * @module tools/sprint-status
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import yaml from "js-yaml";

/** Valid story statuses in the BMAD lifecycle */
type StoryStatus = "backlog" | "ready-for-dev" | "in-progress" | "review" | "done";

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

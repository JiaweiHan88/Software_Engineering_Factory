/**
 * BMAD Agent Converter
 *
 * Reads the authentic BMAD V6 agent definitions from bmad_res/bmm/agents/
 * and the agent-manifest.csv, then generates updated src/agents/*.ts files
 * with the real BMAD persona prompts, activation steps, and skill references.
 *
 * Run: npx tsx scripts/convert-bmad-agents.ts
 */

import { readFile, writeFile, readdir } from "node:fs/promises";
import { resolve, basename, extname } from "node:path";

const PROJECT_ROOT = resolve(import.meta.dirname, "..");
const BMAD_AGENTS_DIR = resolve(PROJECT_ROOT, "bmad_res/bmm/agents");
const MANIFEST_PATH = resolve(PROJECT_ROOT, "bmad_res/_config/agent-manifest.csv");
const OUTPUT_DIR = resolve(PROJECT_ROOT, "src/agents");

/** Parsed agent from manifest CSV */
interface ManifestAgent {
  name: string;
  displayName: string;
  title: string;
  icon: string;
  capabilities: string;
  role: string;
  identity: string;
  communicationStyle: string;
  principles: string;
  module: string;
  path: string;
  canonicalId: string;
}

/** Parse a CSV line respecting quoted fields */
function parseCSVLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"' && !inQuotes) {
      inQuotes = true;
    } else if (ch === '"' && inQuotes) {
      if (line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = false;
      }
    } else if (ch === "," && !inQuotes) {
      fields.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  fields.push(current);
  return fields;
}

/** Parse agent-manifest.csv */
async function parseManifest(): Promise<ManifestAgent[]> {
  const raw = await readFile(MANIFEST_PATH, "utf-8");
  const lines = raw.trim().split("\n");
  const headers = parseCSVLine(lines[0]);
  return lines.slice(1).map((line) => {
    const fields = parseCSVLine(line);
    const obj: Record<string, string> = {};
    headers.forEach((h, i) => {
      obj[h] = (fields[i] ?? "").replace(/&apos;/g, "'").replace(/&amp;/g, "&");
    });
    return obj as unknown as ManifestAgent;
  });
}

/** Read the full agent .md file content */
async function readAgentMarkdown(agentPath: string): Promise<string> {
  const fullPath = resolve(PROJECT_ROOT, agentPath);
  return readFile(fullPath, "utf-8");
}

/** Extract menu items and their skill references from agent markdown */
function extractMenuItems(markdown: string): Array<{ cmd: string; label: string; skill?: string }> {
  const items: Array<{ cmd: string; label: string; skill?: string }> = [];
  const menuRegex = /<item\s+cmd="([^"]*)"(?:\s+exec="skill:([^"]*)")?(?:\s+[^>]*)?>([^<]*)<\/item>/g;
  let match;
  while ((match = menuRegex.exec(markdown)) !== null) {
    items.push({
      cmd: match[1],
      label: match[3].trim(),
      skill: match[2] || undefined,
    });
  }
  return items;
}

/** Extract activation steps from agent markdown */
function extractActivationSteps(markdown: string): string[] {
  const steps: string[] = [];
  const stepRegex = /<step\s+n="\d+">([\s\S]*?)<\/step>/g;
  let match;
  while ((match = stepRegex.exec(markdown)) !== null) {
    steps.push(match[1].trim());
  }
  return steps;
}

/** Map BMAD canonical IDs to our agent file names */
function getOutputFileName(canonicalId: string): string {
  const mapping: Record<string, string> = {
    "bmad-pm": "product-manager",
    "bmad-architect": "architect",
    "bmad-dev": "developer",
    "bmad-sm": "scrum-master",
    "bmad-qa": "qa-engineer",
    "bmad-analyst": "analyst",
    "bmad-ux-designer": "ux-designer",
    "bmad-tech-writer": "tech-writer",
    "bmad-quick-flow-solo-dev": "quick-flow-solo-dev",
  };
  return mapping[canonicalId] ?? canonicalId.replace("bmad-", "");
}

/** Map BMAD agent to our Copilot SDK customAgent name */
function getSdkAgentName(canonicalId: string): string {
  return canonicalId; // Already in "bmad-xxx" format
}

/** Generate the TypeScript agent file content */
function generateAgentFile(agent: ManifestAgent, markdown: string): string {
  const menuItems = extractMenuItems(markdown);
  const activationSteps = extractActivationSteps(markdown);
  const skills = menuItems.filter((m) => m.skill).map((m) => m.skill!);

  // Build the prompt — the full agent markdown is the prompt
  // We strip the YAML frontmatter but keep everything else
  const promptContent = markdown.replace(/^---[\s\S]*?---\n*/, "").trim();

  const varName = `bmad${agent.canonicalId
    .replace("bmad-", "")
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join("")}`;

  const escapedPrompt = promptContent.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$/g, "\\$");

  return `import type { BmadAgent } from "./types.js";

/**
 * ${agent.title} Agent — ${agent.icon}
 *
 * Name: ${agent.displayName} | Canonical ID: ${agent.canonicalId}
 * Role: ${agent.role}
 * Identity: ${agent.identity}
 * Communication: ${agent.communicationStyle}
 * Capabilities: ${agent.capabilities}
 *
 * Skills: ${skills.length > 0 ? skills.join(", ") : "none"}
 *
 * Source: bmad_res/bmm/agents/ (BMAD Method V6)
 * Auto-generated by scripts/convert-bmad-agents.ts — do not edit manually.
 */
export const ${varName}: BmadAgent = {
  name: "${getSdkAgentName(agent.canonicalId)}",
  displayName: "${agent.icon} ${agent.title} (${agent.displayName})",
  description: "${agent.role.replace(/"/g, '\\"')}",
  prompt: \`${escapedPrompt}\`,
};
`;
}

/** Generate the registry.ts file */
function generateRegistry(agents: ManifestAgent[]): string {
  const imports = agents.map((a) => {
    const fileName = getOutputFileName(a.canonicalId);
    const varName = `bmad${a.canonicalId
      .replace("bmad-", "")
      .split("-")
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join("")}`;
    return `import { ${varName} } from "./${fileName}.js";`;
  });

  const allAgentsArray = agents.map((a) => {
    return `bmad${a.canonicalId
      .replace("bmad-", "")
      .split("-")
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join("")}`;
  });

  return `import type { BmadAgent } from "./types.js";
${imports.join("\n")}

/**
 * All BMAD agents, ready to pass to CopilotClient.createSession({ customAgents }).
 *
 * Auto-generated by scripts/convert-bmad-agents.ts — do not edit manually.
 */
export const allAgents: BmadAgent[] = [
${allAgentsArray.map((v) => `  ${v},`).join("\n")}
];

/**
 * Lookup agent by name (canonical ID like "bmad-pm", "bmad-dev", etc.)
 */
export function getAgent(name: string): BmadAgent | undefined {
  return allAgents.find((a) => a.name === name);
}
`;
}

/** Generate the index.ts barrel export */
function generateIndex(agents: ManifestAgent[]): string {
  const exports = agents.map((a) => {
    const fileName = getOutputFileName(a.canonicalId);
    const varName = `bmad${a.canonicalId
      .replace("bmad-", "")
      .split("-")
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join("")}`;
    return `export { ${varName} } from "./${fileName}.js";`;
  });

  const nameType = agents.map((a) => `  | "${getSdkAgentName(a.canonicalId)}"`).join("\n");

  return `/**
 * BMAD Agent Definitions — Copilot SDK Custom Agents
 *
 * Each BMAD role is defined as a Copilot SDK customAgent with the authentic
 * BMAD V6 persona prompts, activation instructions, and skill references.
 *
 * Auto-generated by scripts/convert-bmad-agents.ts — do not edit manually.
 * Source: bmad_res/bmm/agents/ (BMAD Method V6)
 */

${exports.join("\n")}

export type BmadAgentName =
${nameType};

/**
 * Registry of all BMAD agents for use in session creation.
 */
export { allAgents, getAgent } from "./registry.js";
`;
}

// --- Main ---
async function main() {
  console.log("🔄 BMAD Agent Converter\n");

  // 1. Parse manifest
  const agents = await parseManifest();
  console.log(`📋 Found ${agents.length} agents in manifest:`);
  for (const a of agents) {
    console.log(`   ${a.icon} ${a.canonicalId} — ${a.title} (${a.displayName})`);
  }

  // 2. Read and convert each agent
  for (const agent of agents) {
    const markdown = await readAgentMarkdown(agent.path);
    const content = generateAgentFile(agent, markdown);
    const fileName = getOutputFileName(agent.canonicalId);
    const outPath = resolve(OUTPUT_DIR, `${fileName}.ts`);

    await writeFile(outPath, content, "utf-8");
    console.log(`   ✅ ${outPath}`);
  }

  // 3. Generate registry.ts
  const registryContent = generateRegistry(agents);
  await writeFile(resolve(OUTPUT_DIR, "registry.ts"), registryContent, "utf-8");
  console.log(`   ✅ ${resolve(OUTPUT_DIR, "registry.ts")}`);

  // 4. Generate index.ts
  const indexContent = generateIndex(agents);
  await writeFile(resolve(OUTPUT_DIR, "index.ts"), indexContent, "utf-8");
  console.log(`   ✅ ${resolve(OUTPUT_DIR, "index.ts")}`);

  console.log(`\n🎉 Converted ${agents.length} BMAD agents to Copilot SDK format.`);
  console.log(`   Run 'npx tsc --noEmit' to verify.`);
}

main().catch((err) => {
  console.error("❌ Error:", err);
  process.exit(1);
});

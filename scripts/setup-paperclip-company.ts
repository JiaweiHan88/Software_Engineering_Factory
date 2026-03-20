#!/usr/bin/env npx tsx
/**
 * Setup Paperclip Company — Automated Agent Provisioning
 *
 * Programmatically provisions a Paperclip company with all BMAD agents
 * using the process adapter pointed at `heartbeat-entrypoint.ts`.
 *
 * Creates:
 * 1. Company (if not already present, via Paperclip UI — cannot create via API)
 * 2. CEO agent (orchestrator — delegates, does not do domain work)
 * 3. 9 specialist agents (PM, Architect, Developer, QA, SM, Analyst, UX, Tech Writer, QuickFlow)
 * 4. Org chart: CEO → PM, Architect, Analyst, UX, Tech Writer
 *                PM → Developer, SM;  Architect → QA
 * 5. Process adapter config pointing at `npx tsx src/heartbeat-entrypoint.ts`
 *
 * Prerequisites:
 * - Paperclip running at localhost:3100 (or PAPERCLIP_URL)
 * - Company created via Paperclip UI (set PAPERCLIP_COMPANY_ID in .env)
 *
 * Usage:
 *   npx tsx scripts/setup-paperclip-company.ts
 *   npx tsx scripts/setup-paperclip-company.ts --dry-run
 *   npx tsx scripts/setup-paperclip-company.ts --reset   # Terminate existing + recreate
 *
 * @module scripts/setup-paperclip-company
 */

import "dotenv/config";
import { resolve } from "node:path";

// ─────────────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────────────

const PAPERCLIP_URL = process.env.PAPERCLIP_URL ?? "http://localhost:3100";
const COMPANY_ID = process.env.PAPERCLIP_COMPANY_ID;
const PROJECT_ROOT = resolve(import.meta.dirname ?? process.cwd(), "..");

const FLAGS = {
  dryRun: process.argv.includes("--dry-run"),
  reset: process.argv.includes("--reset"),
  verbose: process.argv.includes("--verbose"),
};

if (!COMPANY_ID) {
  console.error("❌ PAPERCLIP_COMPANY_ID is required. Create a company in the Paperclip UI first, then set it in .env");
  process.exit(1);
}

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface PaperclipAgent {
  id: string;
  name: string;
  title: string;
  role?: string;
  capabilities?: string;
  status: string;
  reportsTo?: string;
  adapterType?: string;
  adapterConfig?: Record<string, unknown>;
  runtimeConfig?: Record<string, unknown>;
  heartbeatEnabled: boolean;
  heartbeatCronSchedule?: string;
  monthlyBudget?: number;
  metadata?: Record<string, unknown>;
}

/**
 * Agent definition for provisioning.
 */
interface AgentDef {
  /** Unique name in Paperclip (also used as lookup key) */
  name: string;
  /** BMAD role title (matches role-mapping.ts keys) */
  title: string;
  /** Paperclip role category */
  role: string;
  /** Human-readable capabilities description */
  capabilities: string;
  /** Directory name under agents/ for 4-file config set */
  configDir: string;
  /** Agent this one reports to (by name) */
  reportsTo: string | null;
  /** Heartbeat interval in seconds */
  heartbeatIntervalSec: number;
  /** Monthly budget in cents */
  budgetMonthlyCents: number;
  /** BMAD skills this agent uses (for metadata) */
  bmadSkills: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Agent Definitions (Org Chart)
// ─────────────────────────────────────────────────────────────────────────────

/** Process adapter command shared by all agents. */
const PROCESS_COMMAND = "npx tsx src/heartbeat-entrypoint.ts";
const PROCESS_TIMEOUT_SEC = 600;

/**
 * Complete BMAD agent roster.
 * Order matters — agents are created top-down so `reportsTo` can resolve.
 */
const AGENT_DEFS: AgentDef[] = [
  // ── Tier 0: CEO ─────────────────────────────────────────────────────
  {
    name: "bmad-ceo",
    title: "ceo",
    role: "executive",
    capabilities: "Strategic orchestration, issue decomposition, phased delegation, progress monitoring, governance",
    configDir: "ceo",
    reportsTo: null,
    heartbeatIntervalSec: 120,
    budgetMonthlyCents: 50_000,
    bmadSkills: ["bmad-help"],
  },

  // ── Tier 1: Direct reports to CEO ────────────────────────────────────
  {
    name: "bmad-pm",
    title: "bmad-pm",
    role: "manager",
    capabilities: "PRD creation, user stories, market research, requirements, epics, brainstorming, product briefs",
    configDir: "pm",
    reportsTo: "bmad-ceo",
    heartbeatIntervalSec: 60,
    budgetMonthlyCents: 30_000,
    bmadSkills: [
      "bmad-brainstorming", "bmad-market-research", "bmad-create-product-brief",
      "bmad-create-prd", "bmad-edit-prd", "bmad-validate-prd",
      "bmad-create-epics-and-stories", "bmad-create-story",
      "bmad-check-implementation-readiness", "bmad-correct-course",
    ],
  },
  {
    name: "bmad-architect",
    title: "bmad-architect",
    role: "architect",
    capabilities: "Architecture design, technical research, domain research, system design, technology evaluation",
    configDir: "architect",
    reportsTo: "bmad-ceo",
    heartbeatIntervalSec: 60,
    budgetMonthlyCents: 30_000,
    bmadSkills: ["bmad-create-architecture", "bmad-technical-research", "bmad-domain-research"],
  },
  {
    name: "bmad-analyst",
    title: "bmad-analyst",
    role: "researcher",
    capabilities: "Market analysis, domain research, brainstorming, advanced elicitation, feasibility studies",
    configDir: "analyst",
    reportsTo: "bmad-ceo",
    heartbeatIntervalSec: 60,
    budgetMonthlyCents: 20_000,
    bmadSkills: ["bmad-brainstorming", "bmad-market-research", "bmad-domain-research", "bmad-advanced-elicitation"],
  },
  {
    name: "bmad-ux-designer",
    title: "bmad-ux-designer",
    role: "designer",
    capabilities: "UX patterns, interaction design, wireframes, design specs, accessibility",
    configDir: "ux-designer",
    reportsTo: "bmad-ceo",
    heartbeatIntervalSec: 60,
    budgetMonthlyCents: 15_000,
    bmadSkills: ["bmad-create-ux-design"],
  },
  {
    name: "bmad-tech-writer",
    title: "bmad-tech-writer",
    role: "engineer",
    capabilities: "Documentation, project context generation, editorial review, doc sharding, indexing",
    configDir: "tech-writer",
    reportsTo: "bmad-ceo",
    heartbeatIntervalSec: 60,
    budgetMonthlyCents: 15_000,
    bmadSkills: [
      "bmad-document-project", "bmad-generate-project-context",
      "bmad-editorial-review-prose", "bmad-editorial-review-structure",
      "bmad-index-docs", "bmad-shard-doc", "bmad-distillator",
    ],
  },

  // ── Tier 2: Reports to PM ────────────────────────────────────────────
  {
    name: "bmad-dev",
    title: "bmad-dev",
    role: "engineer",
    capabilities: "Story implementation, code writing, test creation, quick development, TypeScript specialist",
    configDir: "developer",
    reportsTo: "bmad-pm",
    heartbeatIntervalSec: 60,
    budgetMonthlyCents: 30_000,
    bmadSkills: ["bmad-dev-story", "bmad-quick-dev", "bmad-quick-spec"],
  },
  {
    name: "bmad-sm",
    title: "bmad-sm",
    role: "manager",
    capabilities: "Sprint planning, sprint status, course correction, retrospectives, impediment removal",
    configDir: "scrum-master",
    reportsTo: "bmad-pm",
    heartbeatIntervalSec: 90,
    budgetMonthlyCents: 15_000,
    bmadSkills: ["bmad-sprint-planning", "bmad-sprint-status", "bmad-correct-course", "bmad-retrospective"],
  },

  // ── Tier 2: Reports to Architect ─────────────────────────────────────
  {
    name: "bmad-qa",
    title: "bmad-qa",
    role: "engineer",
    capabilities: "Code review, adversarial review, edge-case hunting, E2E test generation, quality gates, test architecture",
    configDir: "qa",
    reportsTo: "bmad-architect",
    heartbeatIntervalSec: 60,
    budgetMonthlyCents: 25_000,
    bmadSkills: [
      "bmad-code-review", "bmad-review-adversarial-general", "bmad-review-edge-case-hunter",
      "bmad-qa-generate-e2e-tests", "bmad-testarch-atdd", "bmad-testarch-automate",
      "bmad-testarch-ci", "bmad-testarch-framework", "bmad-testarch-nfr",
      "bmad-testarch-test-design", "bmad-testarch-test-review", "bmad-testarch-trace",
    ],
  },

  // ── Standalone: Quick-Flow Solo Dev ──────────────────────────────────
  {
    name: "bmad-quick-flow",
    title: "bmad-quick-flow-solo-dev",
    role: "engineer",
    capabilities: "Full solo dev flow: spec, implement, review in one pass. For quick/small tasks",
    configDir: "quick-flow",
    reportsTo: "bmad-pm",
    heartbeatIntervalSec: 60,
    budgetMonthlyCents: 20_000,
    bmadSkills: ["bmad-quick-flow-solo-dev", "bmad-dev-story", "bmad-quick-dev", "bmad-create-story", "bmad-code-review"],
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const DIM = "\x1b[2m";
const NC = "\x1b[0m";

function log(icon: string, msg: string, details?: Record<string, unknown>): void {
  const detailStr = details && FLAGS.verbose ? ` ${DIM}${JSON.stringify(details)}${NC}` : "";
  console.log(`${icon}  ${msg}${detailStr}`);
}

function header(msg: string): void {
  console.log(`\n${CYAN}${"─".repeat(70)}${NC}`);
  console.log(`  ${msg}`);
  console.log(`${CYAN}${"─".repeat(70)}${NC}\n`);
}

/**
 * Make a request to the Paperclip API.
 */
async function paperclip<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const url = `${PAPERCLIP_URL}${path}`;
  const opts: RequestInit = {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  };

  if (FLAGS.dryRun && method !== "GET") {
    log(`${DIM}[dry-run]${NC}`, `${method} ${path}`, body as Record<string, unknown>);
    return {} as T;
  }

  const res = await fetch(url, opts);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Paperclip ${method} ${path} → ${res.status}: ${text}`);
  }

  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Setup Steps
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Step 1: Verify Paperclip is reachable and company exists.
 */
async function verifyPrerequisites(): Promise<void> {
  header("Step 1: Verify Prerequisites");

  // Check Paperclip health
  try {
    await paperclip<{ status: string }>("GET", "/api/health");
    log("✅", `Paperclip reachable at ${PAPERCLIP_URL}`);
  } catch {
    log(`${RED}❌${NC}`, `Paperclip not reachable at ${PAPERCLIP_URL}`);
    console.error("\n  Start Paperclip first: docker compose up -d (or pnpm dev in Paperclip repo)\n");
    process.exit(1);
  }

  // Verify company exists (cannot create via API — must use UI)
  try {
    const agents = await paperclip<PaperclipAgent[]>(
      "GET",
      `/api/companies/${COMPANY_ID}/agents`,
    );
    log("✅", `Company ${COMPANY_ID} exists (${agents.length} agents currently)`);
  } catch (err) {
    log(`${RED}❌${NC}`, `Company ${COMPANY_ID} not found`);
    console.error("\n  Create a company in the Paperclip UI first, then set PAPERCLIP_COMPANY_ID in .env\n");
    process.exit(1);
  }
}

/**
 * Step 2: Optionally terminate existing agents (--reset mode).
 */
async function resetExistingAgents(): Promise<void> {
  if (!FLAGS.reset) return;

  header("Step 2: Reset — Terminating Existing Agents");

  const existing = await paperclip<PaperclipAgent[]>(
    "GET",
    `/api/companies/${COMPANY_ID}/agents`,
  );

  if (existing.length === 0) {
    log("ℹ️ ", "No existing agents to terminate");
    return;
  }

  for (const agent of existing) {
    if (agent.status === "terminated") {
      log(`${DIM}⏭️${NC}`, `Already terminated: ${agent.name}`);
      continue;
    }
    try {
      await paperclip("POST", `/api/agents/${agent.id}/terminate`);
      log(`${YELLOW}🗑️${NC}`, `Terminated: ${agent.name} (${agent.id})`);
    } catch (err) {
      log(`${RED}⚠️${NC}`, `Failed to terminate ${agent.name}: ${err}`);
    }
  }

  log("✅", `Terminated ${existing.filter((a) => a.status !== "terminated").length} agents`);
}

/**
 * Step 3: Create all BMAD agents with process adapter config.
 *
 * Uses POST /api/companies/:companyId/agent-hires to create each agent.
 * Skips agents that already exist (matched by title).
 */
async function createAgents(): Promise<Map<string, string>> {
  header("Step 3: Create BMAD Agents");

  // Fetch existing agents to avoid duplicates
  const existing = await paperclip<PaperclipAgent[]>(
    "GET",
    `/api/companies/${COMPANY_ID}/agents`,
  );
  const existingByTitle = new Map<string, PaperclipAgent>();
  for (const agent of existing) {
    if (agent.title && agent.status !== "terminated") {
      existingByTitle.set(agent.title, agent);
    }
  }

  /** Map of agent name → Paperclip UUID (for org chart wiring) */
  const agentIds = new Map<string, string>();

  // Pre-populate from existing agents
  for (const agent of existing) {
    if (agent.status !== "terminated") {
      agentIds.set(agent.name, agent.id);
    }
  }

  for (const def of AGENT_DEFS) {
    // Check if already exists
    const existingAgent = existingByTitle.get(def.title);
    if (existingAgent) {
      agentIds.set(def.name, existingAgent.id);
      log(`${DIM}♻️${NC}`, `Already exists: ${def.name} → ${existingAgent.id}`);
      continue;
    }

    // Build process adapter config
    const adapterConfig: Record<string, unknown> = {
      command: PROCESS_COMMAND,
      cwd: PROJECT_ROOT,
      timeoutSec: PROCESS_TIMEOUT_SEC,
      env: {},
    };

    const runtimeConfig: Record<string, unknown> = {
      heartbeat: {
        enabled: true,
        intervalSec: def.heartbeatIntervalSec,
        wakeOnDemand: true,
      },
    };

    const metadata: Record<string, unknown> = {
      bmadRole: def.title,
      bmadSkills: def.bmadSkills,
      configDir: def.configDir,
    };

    try {
      const created = await paperclip<PaperclipAgent>(
        "POST",
        `/api/companies/${COMPANY_ID}/agent-hires`,
        {
          name: def.name,
          role: def.role,
          title: def.title,
          capabilities: def.capabilities,
          adapterType: "process",
          adapterConfig,
          runtimeConfig,
          budgetMonthlyCents: def.budgetMonthlyCents,
          metadata,
        },
      );

      agentIds.set(def.name, created.id);
      log(`${GREEN}✅${NC}`, `Created: ${def.name} → ${created.id}`);
    } catch (err) {
      log(`${RED}❌${NC}`, `Failed to create ${def.name}: ${err}`);
    }
  }

  return agentIds;
}

/**
 * Step 4: Wire the org chart (reportsTo relationships).
 *
 * Uses PATCH /api/agents/:id to set reportsTo for each agent.
 */
async function wireOrgChart(agentIds: Map<string, string>): Promise<void> {
  header("Step 4: Wire Org Chart");

  for (const def of AGENT_DEFS) {
    if (!def.reportsTo) continue;

    const agentId = agentIds.get(def.name);
    const managerId = agentIds.get(def.reportsTo);

    if (!agentId) {
      log(`${YELLOW}⚠️${NC}`, `Skip org link: ${def.name} not found`);
      continue;
    }
    if (!managerId) {
      log(`${YELLOW}⚠️${NC}`, `Skip org link: manager ${def.reportsTo} not found for ${def.name}`);
      continue;
    }

    try {
      await paperclip("PATCH", `/api/agents/${agentId}`, {
        reportsTo: managerId,
      });
      log("🔗", `${def.name} → reports to → ${def.reportsTo}`);
    } catch (err) {
      log(`${RED}⚠️${NC}`, `Failed to set reportsTo for ${def.name}: ${err}`);
    }
  }
}

/**
 * Step 5: Set instructionsFilePath for each agent.
 *
 * Points each agent's instructions to their AGENTS.md in the agents/ directory.
 */
async function setInstructionsPaths(agentIds: Map<string, string>): Promise<void> {
  header("Step 5: Set Instructions Paths");

  for (const def of AGENT_DEFS) {
    const agentId = agentIds.get(def.name);
    if (!agentId) continue;

    const instructionsPath = `agents/${def.configDir}/AGENTS.md`;

    try {
      await paperclip("PATCH", `/api/agents/${agentId}`, {
        adapterConfig: {
          command: PROCESS_COMMAND,
          cwd: PROJECT_ROOT,
          timeoutSec: PROCESS_TIMEOUT_SEC,
          instructionsFilePath: instructionsPath,
          env: {},
        },
      });
      log("📄", `${def.name} → ${instructionsPath}`);
    } catch (err) {
      log(`${YELLOW}⚠️${NC}`, `Failed to set instructions for ${def.name}: ${err}`);
    }
  }
}

/**
 * Step 6: Verify the setup by printing the org chart.
 */
async function verifySetup(agentIds: Map<string, string>): Promise<void> {
  header("Step 6: Verify Setup");

  const agents = await paperclip<PaperclipAgent[]>(
    "GET",
    `/api/companies/${COMPANY_ID}/agents`,
  );

  const active = agents.filter((a) => a.status !== "terminated");
  log("📊", `Total agents: ${active.length}`);

  // Print org chart
  console.log("");
  console.log(`  ${CYAN}Org Chart:${NC}`);

  // Build tree
  const byId = new Map<string, PaperclipAgent>();
  for (const a of active) byId.set(a.id, a);

  const roots = active.filter((a) => !a.reportsTo);
  const children = (parentId: string) => active.filter((a) => a.reportsTo === parentId);

  function printTree(agent: PaperclipAgent, indent: string, isLast: boolean): void {
    const connector = indent === "" ? "" : isLast ? "└── " : "├── ";
    const status = agent.status === "active" ? `${GREEN}●${NC}` : `${YELLOW}○${NC}`;
    console.log(`  ${indent}${connector}${status} ${agent.name} (${agent.title}) ${DIM}${agent.id.slice(0, 8)}…${NC}`);
    const kids = children(agent.id);
    kids.forEach((kid, i) => {
      const nextIndent = indent === "" ? "    " : indent + (isLast ? "    " : "│   ");
      printTree(kid, nextIndent, i === kids.length - 1);
    });
  }

  for (const root of roots) {
    printTree(root, "", true);
  }

  // Summary table
  console.log("");
  console.log(`  ${CYAN}Agent IDs (for .env / E2E scripts):${NC}`);
  console.log(`  ${"─".repeat(60)}`);
  for (const [name, id] of agentIds) {
    console.log(`  ${name.padEnd(25)} ${id}`);
  }
  console.log(`  ${"─".repeat(60)}`);

  // Emit .env snippet
  console.log("");
  console.log(`  ${CYAN}Add to .env:${NC}`);
  console.log(`  ${"─".repeat(60)}`);
  for (const [name, id] of agentIds) {
    const envKey = `PAPERCLIP_AGENT_${name.replace("bmad-", "").replace(/-/g, "_").toUpperCase()}_ID`;
    console.log(`  ${envKey}=${id}`);
  }
  console.log(`  ${"─".repeat(60)}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(`\n🏭 ${CYAN}BMAD Copilot Factory — Paperclip Company Setup${NC}\n`);
  console.log(`   Paperclip URL:  ${PAPERCLIP_URL}`);
  console.log(`   Company ID:     ${COMPANY_ID}`);
  console.log(`   Project Root:   ${PROJECT_ROOT}`);
  console.log(`   Dry Run:        ${FLAGS.dryRun}`);
  console.log(`   Reset:          ${FLAGS.reset}`);

  await verifyPrerequisites();
  await resetExistingAgents();
  const agentIds = await createAgents();
  await wireOrgChart(agentIds);
  await setInstructionsPaths(agentIds);
  await verifySetup(agentIds);

  console.log(`\n${GREEN}✅ Setup complete!${NC}\n`);

  if (FLAGS.dryRun) {
    console.log(`${YELLOW}⚠️  This was a dry run — no changes were made.${NC}\n`);
  }
}

main().catch((err) => {
  console.error(`\n${RED}💥 Setup failed:${NC}`, err);
  process.exit(1);
});

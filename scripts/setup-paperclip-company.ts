#!/usr/bin/env npx tsx
/**
 * Setup Paperclip Company — Automated Agent Provisioning
 *
 * Programmatically provisions a complete Paperclip company with:
 * 1. Company (created via API, ID written back to .env)
 * 2. Company goal ("Build high quality software autonomously")
 * 3. Project ("bmad-factory" with local workspace)
 * 4. CEO agent (orchestrator — delegates, does not do domain work)
 * 5. 9 specialist agents (PM, Architect, Developer, QA, SM, Analyst, UX, Tech Writer, QuickFlow)
 * 6. Org chart: CEO → PM, Architect, Analyst, UX, Tech Writer
 *                PM → Developer, SM;  Architect → QA
 * 7. Process adapter config pointing at `npx tsx src/heartbeat-entrypoint.ts`
 *
 * If PAPERCLIP_COMPANY_ID is set in .env AND the company exists, it is reused.
 * Otherwise a new company is created and .env is updated.
 *
 * Prerequisites:
 * - Paperclip running at localhost:3100 (or PAPERCLIP_URL)
 *
 * Usage:
 *   npx tsx scripts/setup-paperclip-company.ts
 *   npx tsx scripts/setup-paperclip-company.ts --dry-run
 *   npx tsx scripts/setup-paperclip-company.ts --reset   # Terminate existing + recreate
 *
 * @module scripts/setup-paperclip-company
 */

import "dotenv/config";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

// ─────────────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────────────

const PAPERCLIP_URL = process.env.PAPERCLIP_URL ?? "http://localhost:3100";
let COMPANY_ID = process.env.PAPERCLIP_COMPANY_ID;
const PROJECT_ROOT = resolve(import.meta.dirname ?? process.cwd(), "..");
const ENV_FILE = resolve(PROJECT_ROOT, ".env");

/** Company defaults — used when creating a new company. */
const COMPANY_NAME = "BMAD Copilot Factory";
const COMPANY_DESCRIPTION = "Autonomous software building system using BMAD method + Paperclip orchestration";
const COMPANY_BUDGET_CENTS = 500_000; // $5,000/month

/** Default project and goal. */
const PROJECT_NAME = "bmad-factory";
const PROJECT_DESCRIPTION = "Primary BMAD software factory workspace";
const GOAL_TITLE = "Build high quality software autonomously";
const GOAL_DESCRIPTION = "Deliver production-ready software through autonomous agent collaboration using the BMAD methodology";

const FLAGS = {
  dryRun: process.argv.includes("--dry-run"),
  reset: process.argv.includes("--reset"),
  verbose: process.argv.includes("--verbose"),
};

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

interface PaperclipCompany {
  id: string;
  name: string;
  description: string | null;
  status: string;
  issuePrefix: string;
  issueCounter: number;
  budgetMonthlyCents: number;
}

interface PaperclipProjectWorkspace {
  id: string;
  projectId: string;
  name: string;
  cwd: string | null;
  isPrimary: boolean;
}

interface PaperclipProject {
  id: string;
  name: string;
  description?: string;
  codebase?: {
    effectiveLocalFolder?: string;
    managedFolder?: string;
  };
  workspaces?: PaperclipProjectWorkspace[];
}

interface PaperclipGoal {
  id: string;
  title: string;
  description?: string;
}

/**
 * Agent definition for provisioning.
 */
interface AgentDef {
  /** Unique name in Paperclip (also used as lookup key) */
  name: string;
  /** Human-readable display title */
  title: string;
  /** Paperclip role category */
  role: string;
  /** Lucide icon name for the Paperclip UI */
  icon: string;
  /** Human-readable capabilities description */
  capabilities: string;
  /** Directory name under agents/ for 4-file config set */
  configDir: string;
  /** Agent this one reports to (by name) */
  reportsTo: string | null;
  /** Whether the periodic timer heartbeat is enabled */
  heartbeatEnabled: boolean;
  /** Heartbeat interval in seconds (0 = no timer) */
  heartbeatIntervalSec: number;
  /** Monthly budget in cents */
  budgetMonthlyCents: number;
  /** BMAD skills this agent uses (for metadata) */
  bmadSkills: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Agent Definitions (Org Chart)
// ─────────────────────────────────────────────────────────────────────────────

/** Process adapter command + args shared by all agents. */
const PROCESS_COMMAND = "npx";
const PROCESS_ARGS = ["tsx", "src/heartbeat-entrypoint.ts"];
const PROCESS_TIMEOUT_SEC = 900; // 15 min — outer kill fence for Paperclip process adapter

/**
 * OTel environment variables injected into every agent's process adapter env.
 * These are read by heartbeat-entrypoint.ts to init tracing + metrics.
 *
 * Set OTEL_ENABLED=true in .env (or shell) to activate. When false/unset,
 * the heartbeat entrypoint skips OTel initialization entirely (zero overhead).
 */
const OTEL_ENV: Record<string, string> = {
  ...(process.env.OTEL_ENABLED === "true"
    ? {
        OTEL_ENABLED: "true",
        OTEL_EXPORTER_OTLP_ENDPOINT:
          process.env.OTEL_EXPORTER_OTLP_ENDPOINT || "http://localhost:4318",
      }
    : {}),
};


/**
 * Proxy environment variables injected into every agent's process adapter env.
 * Required when running on corporate networks where outbound HTTPS to GitHub
 * (Copilot API) must go through a proxy.
 *
 * Set HTTPS_PROXY / HTTP_PROXY in .env or shell environment.
 * NO_PROXY defaults to localhost to avoid proxying local Paperclip calls.
 */
const PROXY_ENV: Record<string, string> = {
  ...(process.env.HTTPS_PROXY || process.env.https_proxy
    ? { HTTPS_PROXY: process.env.HTTPS_PROXY || process.env.https_proxy || "" }
    : {}),
  ...(process.env.HTTP_PROXY || process.env.http_proxy
    ? { HTTP_PROXY: process.env.HTTP_PROXY || process.env.http_proxy || "" }
    : {}),
  ...(process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy
    ? { NO_PROXY: process.env.NO_PROXY || process.env.no_proxy || "localhost,127.0.0.1" }
    : {}),
};

/**
 * Complete BMAD agent roster.
 * Order matters — agents are created top-down so `reportsTo` can resolve.
 */
const AGENT_DEFS: AgentDef[] = [
  // ── Tier 0: CEO ─────────────────────────────────────────────────────
  {
    name: "bmad-ceo",
    title: "CEO",
    role: "ceo",
    icon: "crown",
    capabilities: "Strategic orchestration, issue decomposition, phased delegation, progress monitoring, governance",
    configDir: "ceo",
    reportsTo: null,
    heartbeatEnabled: true,
    heartbeatIntervalSec: 300, // 5-min oversight sweep
    budgetMonthlyCents: 50_000,
    bmadSkills: ["bmad-help"],
  },

  // ── Tier 1: Direct reports to CEO ────────────────────────────────────
  {
    name: "bmad-pm",
    title: "John",
    role: "pm",
    icon: "clipboard",
    capabilities: "PRD creation, user stories, market research, requirements, epics, brainstorming, product briefs",
    configDir: "pm",
    reportsTo: "bmad-ceo",
    heartbeatEnabled: false,
    heartbeatIntervalSec: 0, // demand-only: wakes on assignment
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
    title: "Winston",
    role: "engineer",
    icon: "blocks",
    capabilities: "Architecture design, technical research, domain research, system design, technology evaluation",
    configDir: "architect",
    reportsTo: "bmad-ceo",
    heartbeatEnabled: false,
    heartbeatIntervalSec: 0, // demand-only: wakes on assignment
    budgetMonthlyCents: 30_000,
    bmadSkills: ["bmad-create-architecture", "bmad-technical-research", "bmad-domain-research"],
  },
  {
    name: "bmad-analyst",
    title: "Mary",
    role: "researcher",
    icon: "bar-chart-3",
    capabilities: "Market analysis, domain research, brainstorming, advanced elicitation, feasibility studies",
    configDir: "analyst",
    reportsTo: "bmad-ceo",
    heartbeatEnabled: false,
    heartbeatIntervalSec: 0, // demand-only: wakes on assignment
    budgetMonthlyCents: 20_000,
    bmadSkills: ["bmad-brainstorming", "bmad-market-research", "bmad-domain-research", "bmad-advanced-elicitation"],
  },
  {
    name: "bmad-ux-designer",
    title: "Sally",
    role: "designer",
    icon: "layout-template",
    capabilities: "UX patterns, interaction design, wireframes, design specs, accessibility",
    configDir: "ux-designer",
    reportsTo: "bmad-ceo",
    heartbeatEnabled: false,
    heartbeatIntervalSec: 0, // demand-only: wakes on assignment
    budgetMonthlyCents: 15_000,
    bmadSkills: ["bmad-create-ux-design"],
  },
  {
    name: "bmad-tech-writer",
    title: "Paige",
    role: "engineer",
    icon: "notebook-pen",
    capabilities: "Documentation, project context generation, editorial review, doc sharding, indexing",
    configDir: "tech-writer",
    reportsTo: "bmad-ceo",
    heartbeatEnabled: false,
    heartbeatIntervalSec: 0, // demand-only: wakes on assignment
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
    title: "Amelia",
    role: "engineer",
    icon: "code",
    capabilities: "Story implementation, code writing, test creation, quick development, TypeScript specialist",
    configDir: "developer",
    reportsTo: "bmad-pm",
    heartbeatEnabled: false,
    heartbeatIntervalSec: 0, // demand-only: wakes on assignment
    budgetMonthlyCents: 30_000,
    bmadSkills: ["bmad-dev-story", "bmad-quick-dev", "bmad-quick-spec"],
  },
  {
    name: "bmad-sm",
    title: "Bob",
    role: "pm",
    icon: "gantt-chart",
    capabilities: "Sprint planning, sprint status, course correction, retrospectives, impediment removal",
    configDir: "scrum-master",
    reportsTo: "bmad-pm",
    heartbeatEnabled: false,
    heartbeatIntervalSec: 0, // demand-only: wakes on assignment
    budgetMonthlyCents: 15_000,
    bmadSkills: ["bmad-sprint-planning", "bmad-sprint-status", "bmad-correct-course", "bmad-retrospective"],
  },

  // ── Tier 2: Reports to Architect ─────────────────────────────────────
  {
    name: "bmad-qa",
    title: "Quinn",
    role: "qa",
    icon: "test-tube",
    capabilities: "Code review, adversarial review, edge-case hunting, E2E test generation, quality gates, test architecture",
    configDir: "qa",
    reportsTo: "bmad-architect",
    heartbeatEnabled: false,
    heartbeatIntervalSec: 0, // demand-only: wakes on assignment
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
    title: "Barry",
    role: "engineer",
    icon: "fast-forward",
    capabilities: "Full solo dev flow: spec, implement, review in one pass. For quick/small tasks",
    configDir: "quick-flow",
    reportsTo: "bmad-pm",
    heartbeatEnabled: false,
    heartbeatIntervalSec: 0, // demand-only: wakes on assignment
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
// .env Management
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Update a key=value pair in the .env file.
 * If the key exists, its value is replaced. Otherwise, the key is appended.
 */
function updateEnvFile(key: string, value: string): void {
  if (FLAGS.dryRun) {
    log(`${DIM}[dry-run]${NC}`, `.env: ${key}=${value}`);
    return;
  }

  let content = "";
  if (existsSync(ENV_FILE)) {
    content = readFileSync(ENV_FILE, "utf-8");
  }

  const pattern = new RegExp(`^${key}=.*$`, "m");
  if (pattern.test(content)) {
    content = content.replace(pattern, `${key}=${value}`);
  } else {
    content = content.trimEnd() + `\n${key}=${value}\n`;
  }
  writeFileSync(ENV_FILE, content, "utf-8");
  log("📝", `.env updated: ${key}=${value}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Setup Steps
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Step 1: Verify Paperclip is reachable and ensure company exists.
 * Creates a new company if PAPERCLIP_COMPANY_ID is not set or company is gone.
 */
async function ensureCompany(): Promise<void> {
  header("Step 1: Ensure Company");

  // Check Paperclip health
  try {
    await paperclip<{ status: string }>("GET", "/api/health");
    log("✅", `Paperclip reachable at ${PAPERCLIP_URL}`);
  } catch {
    log(`${RED}❌${NC}`, `Paperclip not reachable at ${PAPERCLIP_URL}`);
    console.error("\n  Start Paperclip first: docker compose up -d (or pnpm dev in Paperclip repo)\n");
    process.exit(1);
  }

  // If we have a COMPANY_ID, check it still exists
  if (COMPANY_ID) {
    try {
      const agents = await paperclip<PaperclipAgent[]>(
        "GET",
        `/api/companies/${COMPANY_ID}/agents`,
      );
      log("✅", `Company ${COMPANY_ID} exists (${agents.length} agents currently)`);
      return;
    } catch {
      log(`${YELLOW}⚠️${NC}`, `Company ${COMPANY_ID} not found — will create a new one`);
    }
  }

  // Create a new company
  const company = await paperclip<PaperclipCompany>("POST", "/api/companies", {
    name: COMPANY_NAME,
    description: COMPANY_DESCRIPTION,
    budgetMonthlyCents: COMPANY_BUDGET_CENTS,
    requireBoardApprovalForNewAgents: false,
  });
  COMPANY_ID = company.id;
  log(`${GREEN}✅${NC}`, `Created company: ${company.name} → ${company.id}`);

  // Paperclip ignores requireBoardApprovalForNewAgents on create — PATCH it
  await paperclip("PATCH", `/api/companies/${company.id}`, {
    requireBoardApprovalForNewAgents: false,
  });
  log("📝", "Disabled board approval for new agent hires");

  // Persist to .env
  updateEnvFile("PAPERCLIP_COMPANY_ID", company.id);
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
 * Step 2b: Ensure a company goal exists.
 */
async function ensureGoal(): Promise<void> {
  header("Step 2b: Ensure Company Goal");

  const goals = await paperclip<PaperclipGoal[]>(
    "GET",
    `/api/companies/${COMPANY_ID}/goals`,
  );

  const existing = goals.find((g) => g.title === GOAL_TITLE);
  if (existing) {
    log("♻️ ", `Goal already exists: ${existing.title} (${existing.id})`);
    return;
  }

  const goal = await paperclip<PaperclipGoal>(
    "POST",
    `/api/companies/${COMPANY_ID}/goals`,
    { title: GOAL_TITLE, description: GOAL_DESCRIPTION },
  );
  log(`${GREEN}✅${NC}`, `Created goal: ${goal.title} → ${goal.id}`);
}

/**
 * Step 2c: Ensure a project exists with a workspace row pointing at the managed dir.
 *
 * The project_workspaces row is critical:
 * - The file browser plugin queries it to know which directory to browse
 * - The heartbeat service uses it to resolve the agent's working directory
 * Without it, agents work in a fallback dir and the file browser shows nothing.
 */
async function ensureProject(): Promise<void> {
  header("Step 2c: Ensure Project");

  const projects = await paperclip<PaperclipProject[]>(
    "GET",
    `/api/companies/${COMPANY_ID}/projects`,
  );

  let project = projects.find((p) => p.name === PROJECT_NAME);

  if (!project) {
    project = await paperclip<PaperclipProject>(
      "POST",
      `/api/companies/${COMPANY_ID}/projects`,
      {
        name: PROJECT_NAME,
        description: PROJECT_DESCRIPTION,
      },
    );
    log(`${GREEN}✅${NC}`, `Created project: ${project.name} → ${project.id}`);
  } else {
    log("♻️ ", `Project already exists: ${project.name} (${project.id})`);
  }

  // Ensure a project_workspace row exists so the file browser plugin
  // and heartbeat workspace resolution work correctly.
  const workspaceDir = project.codebase?.effectiveLocalFolder
    ?? project.codebase?.managedFolder;

  const existingWorkspaces = project.workspaces ?? [];
  if (existingWorkspaces.length === 0 && workspaceDir) {
    const workspace = await paperclip<PaperclipProjectWorkspace>(
      "POST",
      `/api/projects/${project.id}/workspaces`,
      {
        name: PROJECT_NAME,
        sourceType: "local_path",
        cwd: workspaceDir,
        isPrimary: true,
      },
    );
    log(`${GREEN}✅${NC}`, `Created project workspace: ${workspace.id} → ${workspaceDir}`);
  } else if (existingWorkspaces.length > 0) {
    const primary = existingWorkspaces.find((w) => w.isPrimary) ?? existingWorkspaces[0];
    log("♻️ ", `Project workspace exists: ${primary.id} → ${primary.cwd ?? workspaceDir ?? "(managed)"}`);
  } else {
    log("⚠️ ", "No workspace directory resolved — file browser may not work");
  }
}

/**
 * Step 3: Create all BMAD agents with process adapter config.
 *
 * Uses POST /api/companies/:companyId/agent-hires to create each agent.
 * Skips agents that already exist (matched by title).
 */
async function createAgents(): Promise<Map<string, string>> {
  header("Step 3: Create BMAD Agents");

  // Log injected env for transparency
  if (Object.keys(PROXY_ENV).length > 0) {
    log("🌐", `Proxy env: HTTPS_PROXY=${PROXY_ENV.HTTPS_PROXY ?? "—"}, NO_PROXY=${PROXY_ENV.NO_PROXY ?? "—"}`);
  }
  if (Object.keys(OTEL_ENV).length > 0) {
    log("��", `OTel env: OTEL_ENABLED=${OTEL_ENV.OTEL_ENABLED ?? "—"}`);
  }

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
    // Build the desired adapter config (same for create and update)
    const desiredAdapterConfig: Record<string, unknown> = {
      command: PROCESS_COMMAND,
      args: PROCESS_ARGS,
      cwd: PROJECT_ROOT,
      timeoutSec: PROCESS_TIMEOUT_SEC,
      env: {
        ...OTEL_ENV,
        ...PROXY_ENV,
      },
    };

    // Check if already exists
    const existingAgent = existingByTitle.get(def.title);
    if (existingAgent) {
      agentIds.set(def.name, existingAgent.id);

      // Always sync adapterConfig so env changes (proxy, OTel) propagate
      // to existing agents without requiring a --clean reset.
      try {
        await paperclip<PaperclipAgent>(
          "PATCH",
          `/api/agents/${existingAgent.id}`,
          { adapterConfig: desiredAdapterConfig },
        );
        log(`${DIM}♻️${NC}`, `Already exists: ${def.name} → ${existingAgent.id} (config synced)`);
      } catch (syncErr) {
        log(`${DIM}♻️${NC}`, `Already exists: ${def.name} → ${existingAgent.id} (config sync failed: ${syncErr})`);
      }
      continue;
    }

    const runtimeConfig: Record<string, unknown> = {
      heartbeat: {
        enabled: def.heartbeatEnabled,
        intervalSec: def.heartbeatIntervalSec,
        wakeOnDemand: true,
      },
    };

    const metadata: Record<string, unknown> = {
      bmadRole: def.name,
      bmadSkills: def.bmadSkills,
      configDir: def.configDir,
    };

    try {
      // agent-hires returns { agent, approval } wrapper — extract .agent
      const response = await paperclip<{ agent: PaperclipAgent; approval: unknown }>(
        "POST",
        `/api/companies/${COMPANY_ID}/agent-hires`,
        {
          name: def.name,
          role: def.role,
          title: def.title,
          icon: def.icon,
          capabilities: def.capabilities,
          adapterType: "process",
          adapterConfig: desiredAdapterConfig,
          runtimeConfig,
          budgetMonthlyCents: def.budgetMonthlyCents,
          metadata,
        },
      );

      const created = response.agent;
      agentIds.set(def.name, created.id);
      log(`${GREEN}✅${NC}`, `Created: ${def.name} → ${created.id}`);
    } catch (err) {
      log(`${RED}❌${NC}`, `Failed to create ${def.name}: ${err}`);
    }
  }

  return agentIds;
}

/**
 * Step 3b: Auto-approve any pending agent hire approvals.
 *
 * When requireBoardApprovalForNewAgents was true at hire time,
 * agents land in "pending_approval" status. This approves them all.
 */
async function autoApproveAgents(): Promise<void> {
  interface PaperclipApproval {
    id: string;
    type: string;
    status: string;
  }

  const approvals = await paperclip<PaperclipApproval[]>(
    "GET",
    `/api/companies/${COMPANY_ID}/approvals`,
  );

  const pending = approvals.filter(
    (a) => a.type === "hire_agent" && a.status === "pending",
  );

  if (pending.length === 0) {
    return;
  }

  header("Step 3b: Auto-Approve Agent Hires");

  for (const approval of pending) {
    try {
      await paperclip("POST", `/api/approvals/${approval.id}/approve`, {
        decisionNote: "Auto-approved by setup script",
      });
      log(`${GREEN}✅${NC}`, `Approved: ${approval.id}`);
    } catch (err) {
      log(`${RED}❌${NC}`, `Failed to approve ${approval.id}: ${err}`);
    }
  }

  log("✅", `Auto-approved ${pending.length} agent hire(s)`);
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
          args: PROCESS_ARGS,
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
// Step 5b: Seed generate-project-context issue
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create the initial generate-project-context issue assigned to the tech-writer.
 *
 * This seeds the first heartbeat so the tech-writer auto-generates
 * project-context.md on the first run. Idempotent — skipped if a
 * generate-project-context issue already exists.
 */
async function ensureProjectContextIssue(agentIds: Map<string, string>): Promise<void> {
  header("Step 5b: Seed generate-project-context Issue");

  if (FLAGS.dryRun) {
    log("🏃", "Dry run — skipping issue creation");
    return;
  }

  // Check if one already exists
  const existing = await paperclip<{ items?: unknown[]; data?: unknown[] }>(
    "GET",
    `/api/companies/${COMPANY_ID}/issues?status=todo&limit=50`,
  );
  const items = (existing.items ?? existing.data ?? existing) as Array<Record<string, unknown>>;
  const alreadyExists = Array.isArray(items) && items.some(
    (i) => (i.metadata as Record<string, unknown> | undefined)?.workPhase === "generate-project-context",
  );

  if (alreadyExists) {
    log("♻️ ", "generate-project-context issue already exists — skipping");
    return;
  }

  const techWriterId = agentIds.get("bmad-tech-writer");
  if (!techWriterId) {
    log(`${YELLOW}⚠️${NC}`, "Tech writer agent not found — skipping generate-project-context issue");
    return;
  }

  try {
    const issue = await paperclip<{ id: string; identifier?: string }>(
      "POST",
      `/api/companies/${COMPANY_ID}/issues`,
      {
        title: "Generate project context file",
        description:
          "Run the bmad-generate-project-context skill to produce project-context.md. " +
          "Use defaults from bmad_res/bmm/config.yaml. Analyze the codebase and save the output. " +
          "Mark this issue done when complete.",
        status: "todo",
        assigneeAgentId: techWriterId,
        metadata: {
          workPhase: "generate-project-context",
          bmadPhase: "define",
          delegatedBy: "setup-script",
        },
      },
    );
    log(`${GREEN}✅${NC}`, `Created generate-project-context issue: ${issue.identifier ?? issue.id}`);
  } catch (err) {
    log(`${YELLOW}⚠️${NC}`, `Failed to create generate-project-context issue (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(`\n🏭 ${CYAN}BMAD Copilot Factory — Paperclip Company Setup${NC}\n`);
  console.log(`   Paperclip URL:  ${PAPERCLIP_URL}`);
  console.log(`   Company ID:     ${COMPANY_ID ?? "(will create new)"}`);
  console.log(`   Project Root:   ${PROJECT_ROOT}`);
  console.log(`   Dry Run:        ${FLAGS.dryRun}`);
  console.log(`   Reset:          ${FLAGS.reset}`);

  // Step 1: Ensure company exists (create if needed)
  await ensureCompany();

  // Step 2: Optionally reset existing agents
  await resetExistingAgents();

  // Step 2b: Ensure goal
  await ensureGoal();

  // Step 2c: Ensure project
  await ensureProject();

  // Step 3: Create agents
  const agentIds = await createAgents();

  // Step 3b: Auto-approve any pending hires
  await autoApproveAgents();

  // Step 4: Wire org chart
  await wireOrgChart(agentIds);

  // Step 5: Set instructions paths
  await setInstructionsPaths(agentIds);

  // Step 5b: Create generate-project-context seed issue (if not already present)
  await ensureProjectContextIssue(agentIds);

  // Step 6: Verify
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

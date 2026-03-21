#!/usr/bin/env npx tsx
/**
 * Reset Paperclip Company — Nuclear Clean Slate
 *
 * Wipes ALL Paperclip data by truncating the `companies` table in Postgres
 * with CASCADE (which drops all FK-linked rows across 40+ tables), then
 * re-runs setup-paperclip-company.ts to provision a fresh company.
 *
 * Why DB-level truncate?
 * Paperclip's API-level DELETE for both issues and companies fails with
 * FK constraint errors (issue_comments, budget_policies, etc.) because
 * the delete handlers don't cascade. TRUNCATE ... CASCADE is the only
 * reliable way to clean slate.
 *
 * Flow:
 * 1. Verify Paperclip + Postgres container are reachable
 * 2. TRUNCATE companies CASCADE via docker exec psql
 * 3. Clear PAPERCLIP_COMPANY_ID from .env
 * 4. Run setup-paperclip-company.ts to recreate from scratch
 *
 * Prerequisites:
 * - Paperclip running at localhost:3100
 * - Postgres running in Docker container (bmad_copilot_rt-postgres-1)
 *
 * Usage:
 *   npx tsx scripts/reset-company.ts                # Full nuke + rebuild
 *   npx tsx scripts/reset-company.ts --dry-run      # Preview what would happen
 *   npx tsx scripts/reset-company.ts --nuke-only    # Truncate DB but don't recreate
 *   npx tsx scripts/reset-company.ts --verbose       # Show details
 *
 * @module scripts/reset-company
 */

import "dotenv/config";
import { execSync } from "node:child_process";
import { resolve } from "node:path";
import { readFileSync, writeFileSync, existsSync } from "node:fs";

// ─────────────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────────────

const PAPERCLIP_URL = process.env.PAPERCLIP_URL ?? "http://localhost:3100";
const PROJECT_ROOT = resolve(import.meta.dirname ?? process.cwd(), "..");
const ENV_FILE = resolve(PROJECT_ROOT, ".env");

/** Docker container name for Postgres. */
const PG_CONTAINER = process.env.PG_CONTAINER ?? "bmad_copilot_rt-postgres-1";
const PG_USER = process.env.POSTGRES_USER ?? "paperclip";
const PG_DB = process.env.POSTGRES_DB ?? "paperclip";

const FLAGS = {
  dryRun: process.argv.includes("--dry-run"),
  nukeOnly: process.argv.includes("--nuke-only"),
  verbose: process.argv.includes("--verbose"),
};

// ─────────────────────────────────────────────────────────────────────────────
// Styling
// ─────────────────────────────────────────────────────────────────────────────

const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const DIM = "\x1b[2m";
const NC = "\x1b[0m";

function log(icon: string, msg: string): void {
  console.log(`  ${icon}  ${msg}`);
}

function header(msg: string): void {
  console.log(`\n${CYAN}${"─".repeat(70)}${NC}`);
  console.log(`  ${msg}`);
  console.log(`${CYAN}${"─".repeat(70)}${NC}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Reset Steps
// ─────────────────────────────────────────────────────────────────────────────

/** Step 0: Verify Paperclip API and Postgres container are reachable. */
async function verifyPrereqs(): Promise<void> {
  header("Step 0: Verify Prerequisites");

  // Check Paperclip API
  try {
    const res = await fetch(`${PAPERCLIP_URL}/api/health`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    log("✅", `Paperclip reachable at ${PAPERCLIP_URL}`);
  } catch {
    log(`${RED}❌${NC}`, `Paperclip not reachable at ${PAPERCLIP_URL}`);
    process.exit(1);
  }

  // Check Postgres container
  try {
    execSync(`docker exec ${PG_CONTAINER} pg_isready -U ${PG_USER} -d ${PG_DB}`, {
      stdio: "pipe",
    });
    log("✅", `Postgres container reachable: ${PG_CONTAINER}`);
  } catch {
    log(`${RED}❌${NC}`, `Postgres container not found: ${PG_CONTAINER}`);
    console.error(`\n  Make sure Docker is running and the container name is correct.`);
    console.error(`  Override with PG_CONTAINER env var if needed.\n`);
    process.exit(1);
  }

  // Show current state
  try {
    const res = await fetch(`${PAPERCLIP_URL}/api/companies`);
    const companies = (await res.json()) as Array<{ name: string; id: string }>;
    if (companies.length > 0) {
      log("📋", `Current companies (${companies.length}):`);
      for (const c of companies) {
        log("  ", `${c.name} (${c.id})`);
      }
    } else {
      log("ℹ️ ", "No companies exist — DB is already clean");
    }
  } catch {
    // Non-fatal
  }
}

/** Step 1: Truncate the companies table with CASCADE. */
function truncateDatabase(): void {
  header("Step 1: Truncate Database");

  const sql = "TRUNCATE companies CASCADE;";
  const cmd = `docker exec ${PG_CONTAINER} psql -U ${PG_USER} -d ${PG_DB} -c "${sql}"`;

  if (FLAGS.dryRun) {
    log(`${DIM}[dry-run]${NC}`, cmd);
    return;
  }

  try {
    const output = execSync(cmd, { encoding: "utf-8", stdio: "pipe" });
    log("🗑️ ", "TRUNCATE companies CASCADE — complete");
    if (FLAGS.verbose && output.trim()) {
      // Show CASCADE notices
      for (const line of output.trim().split("\n")) {
        if (line.startsWith("NOTICE:")) {
          log(`${DIM}  ${NC}`, line.replace("NOTICE:  ", ""));
        }
      }
    }
  } catch (err) {
    log(`${RED}❌${NC}`, `DB truncate failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

/** Step 2: Clear PAPERCLIP_COMPANY_ID from .env. */
function clearCompanyIdFromEnv(): void {
  header("Step 2: Clear .env Company ID");

  if (FLAGS.dryRun) {
    log(`${DIM}[dry-run]${NC}`, "Would clear PAPERCLIP_COMPANY_ID from .env");
    return;
  }

  if (!existsSync(ENV_FILE)) {
    log("ℹ️ ", "No .env file found — nothing to clear");
    return;
  }

  let content = readFileSync(ENV_FILE, "utf-8");
  const pattern = /^PAPERCLIP_COMPANY_ID=.*$/m;
  if (pattern.test(content)) {
    content = content.replace(pattern, "PAPERCLIP_COMPANY_ID=");
    writeFileSync(ENV_FILE, content, "utf-8");
    log("📝", "Cleared PAPERCLIP_COMPANY_ID in .env");
  } else {
    log("ℹ️ ", "PAPERCLIP_COMPANY_ID not in .env");
  }
}

/** Step 3: Run setup-paperclip-company.ts to provision a fresh company. */
function runSetup(): void {
  header("Step 3: Recreate Company");

  if (FLAGS.nukeOnly) {
    log("⏭️ ", "Skipping setup (--nuke-only flag)");
    return;
  }

  if (FLAGS.dryRun) {
    log(`${DIM}[dry-run]${NC}`, "Would run: npx tsx scripts/setup-paperclip-company.ts");
    return;
  }

  log("🏗️ ", "Running setup-paperclip-company.ts...\n");

  try {
    const verboseFlag = FLAGS.verbose ? " --verbose" : "";
    execSync(
      `npx tsx scripts/setup-paperclip-company.ts${verboseFlag}`,
      {
        cwd: PROJECT_ROOT,
        stdio: "inherit",
        env: {
          ...process.env,
          // Clear so setup creates a new company
          PAPERCLIP_COMPANY_ID: "",
        },
      },
    );
  } catch (err) {
    log(
      `${RED}❌${NC}`,
      `Setup failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(`\n🧹 ${CYAN}BMAD Copilot Factory — Company Reset${NC}\n`);
  console.log(`   Paperclip:       ${PAPERCLIP_URL}`);
  console.log(`   Postgres:        ${PG_CONTAINER} (${PG_USER}@${PG_DB})`);
  console.log(`   Mode:            ${FLAGS.dryRun ? "DRY RUN (no changes)" : "LIVE — TRUNCATE CASCADE!"}`);
  console.log(`   After nuke:      ${FLAGS.nukeOnly ? "stop (no rebuild)" : "recreate via setup-paperclip-company.ts"}`);

  if (!FLAGS.dryRun) {
    console.log(`\n   ${YELLOW}⚠️  This will TRUNCATE all Paperclip data (companies, agents, issues, etc.)!${NC}`);
    console.log(`   ${YELLOW}   Press Ctrl+C within 3 seconds to abort...${NC}`);
    await new Promise((r) => setTimeout(r, 3000));
  }

  const startTime = Date.now();

  // Step 0: Verify
  await verifyPrereqs();

  // Step 1: Nuke
  truncateDatabase();

  // Step 2: Clear .env
  clearCompanyIdFromEnv();

  // Step 3: Rebuild
  runSetup();

  // Summary
  const elapsed = Math.round((Date.now() - startTime) / 1000);
  header("Reset Summary");
  log("📊", `Database:           truncated`);
  log("📊", `Rebuild:            ${FLAGS.nukeOnly ? "skipped" : "completed"}`);
  log("⏱️ ", `Elapsed:            ${elapsed}s`);

  if (FLAGS.dryRun) {
    console.log(`\n${YELLOW}⚠️  This was a dry run — no changes were made.${NC}\n`);
  } else {
    console.log(`\n${GREEN}✅ Reset complete — clean slate ready!${NC}\n`);
  }
}

main().catch((err) => {
  console.error(`\n${RED}💥 Reset failed:${NC}`, err);
  process.exit(1);
});

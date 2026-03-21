#!/usr/bin/env bash#!/usr/bin/env bash

# ─────────────────────────────────────────────────────────────────────────────# ─────────────────────────────────────────────────────────────────────────────

# reset-and-run-otel.sh — Start observability stack + re-provision agents with OTel# reset-and-run-otel.sh — Reset sprint state + workspace, then run with OTel

##

# With the Paperclip-native architecture, there is no long-running BMAD process.# Usage:

# Paperclip spawns heartbeat-entrypoint.ts per agent on demand. This script:#   ./scripts/reset-and-run-otel.sh              # reset + run ORCH-002

##   ./scripts/reset-and-run-otel.sh ORCH-001     # reset + run specific story

#   1. Starts the observability Docker stack (OTel Collector, Jaeger, Prometheus, Grafana)#   ./scripts/reset-and-run-otel.sh --reset-only # reset without running

#   2. Re-runs setup-paperclip-company.ts with OTEL_ENABLED=true so agent configs# ─────────────────────────────────────────────────────────────────────────────

#      get OTEL_* env vars injected into their process adapter configset -euo pipefail

#   3. Optionally invokes the CEO heartbeat to trigger a run with telemetry

#FACTORY_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# After this, every heartbeat Paperclip triggers will export traces + metrics.TARGET_PROJECT="$(cd "$FACTORY_ROOT/.." && pwd)/bmad-target-project"

#STORY_ID="${1:-ORCH-002}"

# Usage:RESET_ONLY=false

#   ./scripts/reset-and-run-otel.sh              # Start stack + re-provision agents

#   ./scripts/reset-and-run-otel.sh --invoke      # Also invoke CEO heartbeatif [[ "$STORY_ID" == "--reset-only" ]]; then

#   ./scripts/reset-and-run-otel.sh --stack-only   # Only start Docker stack  RESET_ONLY=true

#fi

# Dashboards:

#   http://localhost:3000   — Grafana (admin/bmad)echo "🔄 BMAD Copilot Factory — Reset & Run (OTel)"

#   http://localhost:16686  — Jaeger trace explorerecho "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

#   http://localhost:9090   — Prometheus metricsecho "📂 Factory root:    $FACTORY_ROOT"

# ─────────────────────────────────────────────────────────────────────────────echo "🎯 Target workspace: $TARGET_PROJECT"

set -euo pipefailecho ""



FACTORY_ROOT="$(cd "$(dirname "$0")/.." && pwd)"# ── Step 1: Kill any running factory process ───────────────────────────────

INVOKE_CEO=falseecho "🧹 Step 1: Killing any running factory processes..."

STACK_ONLY=falsepkill -9 -f "tsx src/index.ts" 2>/dev/null && echo "   Killed stale factory process" || echo "   No stale processes found"

sleep 1

for arg in "$@"; do

  case "$arg" in# ── Step 2: Reset factory sprint status ────────────────────────────────────

    --invoke)    INVOKE_CEO=true ;;echo "📋 Step 2: Resetting factory sprint status..."

    --stack-only) STACK_ONLY=true ;;cat > "$FACTORY_ROOT/_bmad-output/sprint-status.yaml" << 'EOF'

  esacsprint:

done  number: 1

  goal: Orchestrator smoke test

# ── Colors ───────────────────────────────────────────────────────────────────  stories:

CYAN='\033[0;36m'    - id: ORCH-001

GREEN='\033[0;32m'      title: Add health check endpoint

YELLOW='\033[1;33m'      status: ready-for-dev

NC='\033[0m'    - id: ORCH-002

      title: Implement session resume logic

echo -e "${CYAN}🔭 BMAD Copilot Factory — Observability Setup${NC}"      status: ready-for-dev

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"EOF

echo ""echo "   ✅ Factory sprint reset (both stories → ready-for-dev)"



# ── Step 1: Start observability Docker stack ─────────────────────────────# ── Step 3: Reset target workspace sprint status ───────────────────────────

echo "🐳 Step 1: Starting observability stack..."if [[ -d "$TARGET_PROJECT" ]]; then

cd "$FACTORY_ROOT"  echo "📋 Step 3: Resetting target workspace sprint status..."

docker compose -f docker-compose.observability.yml up -d  mkdir -p "$TARGET_PROJECT/_bmad-output/stories"



echo "   Waiting for services to become ready..."  cat > "$TARGET_PROJECT/_bmad-output/sprint-status.yaml" << 'EOF'

sleep 3sprint:

  number: 1

# Verify each service  goal: Build initial features

OTEL_OK=true  stories:

    - id: ORCH-002

if curl -sf http://localhost:4318/v1/traces -X POST -H "Content-Type: application/json" -d '{}' > /dev/null 2>&1; then      title: Implement session resume logic

  echo -e "   ${GREEN}✓${NC} OTel Collector (port 4318)"      status: ready-for-dev

elseEOF

  echo -e "   ${YELLOW}⚠${NC} OTel Collector not ready yet (port 4318)"  echo "   ✅ Target workspace sprint reset"

  OTEL_OK=false

fi  # ── Step 4: Clean agent-generated files from target workspace ────────────

  echo "🗑️  Step 4: Cleaning agent-generated files from target workspace..."

if curl -sf http://localhost:16686 > /dev/null 2>&1; then  rm -f "$TARGET_PROJECT/src/session-store.ts" && echo "   Removed src/session-store.ts" || true

  echo -e "   ${GREEN}✓${NC} Jaeger (port 16686)"  rm -rf "$TARGET_PROJECT/test/" && echo "   Removed test/" || true

else  rm -rf "$TARGET_PROJECT/.sessions/" && echo "   Removed .sessions/" || true

  echo -e "   ${YELLOW}⚠${NC} Jaeger not ready yet (port 16686)"

  OTEL_OK=false  # Reset src/index.ts to pristine state

fi  cat > "$TARGET_PROJECT/src/index.ts" << 'SCAFFOLD'

/**

if curl -sf http://localhost:9090/-/ready > /dev/null 2>&1; then * bmad-target-project — Entry point

  echo -e "   ${GREEN}✓${NC} Prometheus (port 9090)" * This is an empty project for BMAD agents to build into.

else */

  echo -e "   ${YELLOW}⚠${NC} Prometheus not ready yet (port 9090)"export function main(): void {

  OTEL_OK=false  console.log("Hello from bmad-target-project");

fi}



if curl -sf http://localhost:3000/api/health > /dev/null 2>&1; thenmain();

  echo -e "   ${GREEN}✓${NC} Grafana (port 3000)"SCAFFOLD

else  echo "   ✅ src/index.ts reset to pristine state"

  echo -e "   ${YELLOW}⚠${NC} Grafana not ready yet (port 3000)"else

  OTEL_OK=false  echo "⚠️  Step 3-4: Target workspace not found at $TARGET_PROJECT (skipping)"

fifi



if [[ "$OTEL_OK" == "false" ]]; then# ── Step 5: Verify observability stack ─────────────────────────────────────

  echo ""echo "🔍 Step 5: Checking observability stack..."

  echo -e "${YELLOW}⚠  Some services still starting — they should be ready in a few seconds.${NC}"OTEL_OK=true

fi

if ! curl -s http://localhost:4318/v1/traces -X POST -H "Content-Type: application/json" -d '{}' > /dev/null 2>&1; then

if [[ "$STACK_ONLY" == "true" ]]; then  echo "   ❌ OTel Collector not reachable on port 4318"

  echo ""  OTEL_OK=false

  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"else

  echo -e "${GREEN}✓${NC} Observability stack running (--stack-only mode)."  echo "   ✅ OTel Collector (port 4318)"

  echo ""fi

  echo "  To enable OTel in agent heartbeats, re-run setup with:"

  echo "    OTEL_ENABLED=true npx tsx scripts/setup-paperclip-company.ts"if ! curl -s http://localhost:16686 > /dev/null 2>&1; then

  exit 0  echo "   ❌ Jaeger not reachable on port 16686"

fi  OTEL_OK=false

else

# ── Step 2: Re-provision agents with OTel env vars ───────────────────────  echo "   ✅ Jaeger (port 16686)"

echo ""fi

echo "🔧 Step 2: Re-provisioning agents with OTEL_ENABLED=true..."

echo "   This updates adapterConfig.env on all agents so heartbeats export telemetry."if ! curl -s http://localhost:9090/-/ready > /dev/null 2>&1; then

echo ""  echo "   ❌ Prometheus not reachable on port 9090"

  OTEL_OK=false

cd "$FACTORY_ROOT"else

OTEL_ENABLED=true \  echo "   ✅ Prometheus (port 9090)"

OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 \fi

  npx tsx scripts/setup-paperclip-company.ts

if ! curl -s http://localhost:3000/api/health > /dev/null 2>&1; then

# ── Step 3: Optionally invoke CEO ─────────────────────────────────────────  echo "   ❌ Grafana not reachable on port 3000"

if [[ "$INVOKE_CEO" == "true" ]]; then  OTEL_OK=false

  echo ""else

  echo "🚀 Step 3: Invoking CEO heartbeat (with OTel telemetry)..."  echo "   ✅ Grafana (port 3000)"

fi

  # Source .env for PAPERCLIP_COMPANY_ID

  if [[ -f "$FACTORY_ROOT/.env" ]]; thenif [[ "$OTEL_OK" == "false" ]]; then

    # shellcheck disable=SC1091  echo ""

    source <(grep -E '^PAPERCLIP_COMPANY_ID=' "$FACTORY_ROOT/.env")  echo "⚠️  Some observability services are not running."

  fi  echo "   Start them with: pnpm observability:up"

  echo "   Then re-run this script."

  if [[ -z "${PAPERCLIP_COMPANY_ID:-}" ]]; then  exit 1

    echo -e "   ${YELLOW}⚠${NC} PAPERCLIP_COMPANY_ID not set — skipping invoke"fi

  else

    PAPERCLIP_URL="${PAPERCLIP_URL:-http://localhost:3100}"# ── Step 6: Summary ───────────────────────────────────────────────────────

echo ""

    # Find CEO agent IDecho "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

    CEO_ID=$(curl -sf "$PAPERCLIP_URL/api/companies/$PAPERCLIP_COMPANY_ID/agents" \echo "✅ Reset complete. Ready for a clean OTel run."

      | npx -y tsx -e "echo ""

        const data = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));

        const ceo = data.find((a: any) => a.name === 'bmad-ceo');if [[ "$RESET_ONLY" == "true" ]]; then

        if (ceo) process.stdout.write(ceo.id);  echo "🏁 Reset-only mode — not running factory."

        else { process.stderr.write('CEO not found'); process.exit(1); }  echo "   Run manually with: pnpm start:otel -- --story $STORY_ID"

      " 2>/dev/null) || true  exit 0

fi

    if [[ -n "$CEO_ID" ]]; then

      echo "   CEO agent: $CEO_ID"# ── Step 7: Run factory with OTel ─────────────────────────────────────────

      curl -sf -X POST "$PAPERCLIP_URL/api/agents/$CEO_ID/heartbeat/invoke" \echo "🚀 Step 6: Starting factory with OTel (story: $STORY_ID)..."

        -H "Content-Type: application/json" > /dev/null 2>&1 \echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

        && echo -e "   ${GREEN}✓${NC} CEO heartbeat invoked — check Jaeger for traces" \echo ""

        || echo -e "   ${YELLOW}⚠${NC} CEO invoke failed"

    elsecd "$FACTORY_ROOT"

      echo -e "   ${YELLOW}⚠${NC} Could not find CEO agent — skipping invoke"OTEL_ENABLED=true \

    fiOTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 \

  fiTARGET_PROJECT_ROOT=../bmad-target-project \

fiLOG_FORMAT=human \

LOG_LEVEL=debug \

# ── Summary ────────────────────────────────────────────────────────────────── exec pnpm start:otel-- --story "$STORY_ID"

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo -e "${GREEN}✓${NC} Observability setup complete!"
echo ""
echo "  Dashboards:"
echo "    Grafana:     http://localhost:3000  (admin/bmad)"
echo "    Jaeger:      http://localhost:16686"
echo "    Prometheus:  http://localhost:9090"
echo ""
echo "  Every heartbeat Paperclip triggers will now export traces + metrics."
echo "  To invoke a heartbeat manually:"
echo "    npx tsx scripts/e2e-smoke-invoke.ts"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

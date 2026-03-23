#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# start-paperclip.sh — One-command Paperclip startup for BMAD Copilot Factory
#
# Handles the complete lifecycle:
#   1. Ensure Docker Postgres is running
#   2. Optionally nuke all data (--clean)
#   3. Start Paperclip server natively (required for process adapter)
#   4. Ensure company + agents are provisioned (setup-paperclip-company.ts)
#   5. Optionally start observability stack (--observability)
#
# Usage:
#   ./scripts/start-paperclip.sh                    # Start Paperclip (foreground)
#   ./scripts/start-paperclip.sh --bg               # Start in background
#   ./scripts/start-paperclip.sh --clean             # Wipe DB, recreate company, start
#   ./scripts/start-paperclip.sh --observability     # Also start Grafana/Jaeger/Prometheus
#   ./scripts/start-paperclip.sh --clean --observability --bg  # Full reset + OTel + background
#
# Prerequisites:
#   - Docker running (for Postgres, and optionally observability stack)
#   - Paperclip repo built: cd ../paperclip && pnpm install && pnpm build
#   - Node.js with npx/tsx available in PATH
#
# Environment:
#   PAPERCLIP_REPO  — Path to Paperclip repo (default: ../paperclip)
#   PG_CONTAINER    — Postgres container name (default: bmad_copilot_rt-postgres-1)
# ──────────────────────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
PAPERCLIP_REPO="${PAPERCLIP_REPO:-$(dirname "$PROJECT_ROOT")/paperclip}"
PG_CONTAINER="${PG_CONTAINER:-bmad_copilot_rt-postgres-1}"
PG_USER="${POSTGRES_USER:-paperclip}"
PG_DB="${POSTGRES_DB:-paperclip}"

# ── Parse flags ──────────────────────────────────────────────────────────────
FLAG_CLEAN=false
FLAG_OBSERVABILITY=false
FLAG_BG=false

for arg in "$@"; do
  case "$arg" in
    --clean)          FLAG_CLEAN=true ;;
    --observability)  FLAG_OBSERVABILITY=true ;;
    --bg)             FLAG_BG=true ;;
  esac
done

# ── Colors ───────────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
DIM='\033[2m'
NC='\033[0m'

info()  { echo -e "  ${CYAN}ℹ${NC}  $*"; }
ok()    { echo -e "  ${GREEN}✓${NC}  $*"; }
warn()  { echo -e "  ${YELLOW}⚠${NC}  $*"; }
fail()  { echo -e "  ${RED}✗${NC}  $*" >&2; exit 1; }
header(){ echo -e "\n${CYAN}── $* ──${NC}"; }

echo -e "${CYAN}🏭 BMAD Copilot Factory — Start Paperclip${NC}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo -e "  Paperclip repo:   ${DIM}$PAPERCLIP_REPO${NC}"
echo -e "  Postgres:         ${DIM}$PG_CONTAINER${NC}"
echo -e "  Flags:            ${FLAG_CLEAN:+--clean }${FLAG_OBSERVABILITY:+--observability }${FLAG_BG:+--bg}"
echo ""

# ── Validate Paperclip build ─────────────────────────────────────────────────
if [ ! -f "$PAPERCLIP_REPO/server/dist/index.js" ]; then
  fail "Paperclip server not built. Run:\n    cd $PAPERCLIP_REPO && pnpm install && pnpm build"
fi

# ══════════════════════════════════════════════════════════════════════════════
# Step 1: Ensure Postgres
# ══════════════════════════════════════════════════════════════════════════════
header "Step 1: Ensure Postgres"

cd "$PROJECT_ROOT"
BETTER_AUTH_SECRET=dummy docker compose up -d postgres 2>/dev/null || true

for i in $(seq 1 15); do
  if docker exec "$PG_CONTAINER" pg_isready -U "$PG_USER" -d "$PG_DB" >/dev/null 2>&1; then
    ok "Postgres is ready"
    break
  fi
  if [ "$i" -eq 15 ]; then
    fail "Postgres not ready after 15 attempts"
  fi
  sleep 1
done

# ══════════════════════════════════════════════════════════════════════════════
# Step 2: Clean (optional)
# ══════════════════════════════════════════════════════════════════════════════
if [ "$FLAG_CLEAN" = true ]; then
  header "Step 2: Clean — TRUNCATE companies CASCADE"

  docker exec "$PG_CONTAINER" psql -U "$PG_USER" -d "$PG_DB" \
    -c "TRUNCATE companies CASCADE;" > /dev/null 2>&1
  ok "Database wiped (all companies, agents, issues, etc.)"

  # Clear company ID from .env so setup creates a new one
  if [ -f "$PROJECT_ROOT/.env" ]; then
    if grep -q '^PAPERCLIP_COMPANY_ID=' "$PROJECT_ROOT/.env"; then
      sed -i '' 's/^PAPERCLIP_COMPANY_ID=.*/PAPERCLIP_COMPANY_ID=/' "$PROJECT_ROOT/.env" 2>/dev/null || \
        sed -i 's/^PAPERCLIP_COMPANY_ID=.*/PAPERCLIP_COMPANY_ID=/' "$PROJECT_ROOT/.env"
      ok "Cleared PAPERCLIP_COMPANY_ID in .env"
    fi
  fi
else
  info "Step 2: Skip clean (use --clean to wipe DB)"
fi

# ══════════════════════════════════════════════════════════════════════════════
# Step 3: Observability stack (optional)
# ══════════════════════════════════════════════════════════════════════════════
if [ "$FLAG_OBSERVABILITY" = true ]; then
  header "Step 3: Start observability stack"

  cd "$PROJECT_ROOT"
  docker compose -f docker-compose.observability.yml up -d 2>/dev/null

  sleep 2
  curl -sf http://localhost:4318/v1/traces -X POST -H "Content-Type: application/json" -d '{}' > /dev/null 2>&1 \
    && ok "OTel Collector (port 4318)" || warn "OTel Collector not ready yet"
  curl -sf http://localhost:16686 > /dev/null 2>&1 \
    && ok "Jaeger (port 16686)" || warn "Jaeger not ready yet"
  curl -sf http://localhost:9090/-/ready > /dev/null 2>&1 \
    && ok "Prometheus (port 9090)" || warn "Prometheus not ready yet"
  curl -sf http://localhost:3000/api/health > /dev/null 2>&1 \
    && ok "Grafana (port 3000)" || warn "Grafana not ready yet"

  export OTEL_ENABLED=true
  export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
else
  info "Step 3: Skip observability (use --observability to start Grafana/Jaeger/Prometheus)"
fi

# ══════════════════════════════════════════════════════════════════════════════
# Step 4: Kill existing Paperclip on port 3100
# ══════════════════════════════════════════════════════════════════════════════
header "Step 4: Stop existing Paperclip"

# Stop Docker Paperclip if running
if docker ps -q -f name=bmad_copilot_rt-paperclip-1 2>/dev/null | grep -q .; then
  docker stop bmad_copilot_rt-paperclip-1 2>/dev/null || true
  ok "Stopped Docker Paperclip container"
fi

# Kill native Paperclip on port 3100
if lsof -i :3100 -P -n 2>/dev/null | grep -q LISTEN; then
  PIDS=$(lsof -ti :3100 -sTCP:LISTEN 2>/dev/null || true)
  if [ -n "$PIDS" ]; then
    echo "$PIDS" | xargs kill -TERM 2>/dev/null || true
    sleep 2
    # Force kill if still alive
    if lsof -i :3100 -P -n 2>/dev/null | grep -q LISTEN; then
      echo "$PIDS" | xargs kill -9 2>/dev/null || true
      sleep 1
    fi
    ok "Stopped existing Paperclip server"
  fi
else
  info "No existing Paperclip server on port 3100"
fi

# ══════════════════════════════════════════════════════════════════════════════
# Step 5: Start Paperclip server
# ══════════════════════════════════════════════════════════════════════════════
header "Step 5: Start Paperclip server"

export BETTER_AUTH_SECRET="${BETTER_AUTH_SECRET:-dev-secret-bmad}"
export DATABASE_URL="postgresql://paperclip:paperclip@localhost:5432/paperclip"
export PORT=3100
export SERVE_UI=true
export PAPERCLIP_DEPLOYMENT_MODE=local_trusted
export PAPERCLIP_HOME="${PAPERCLIP_HOME:-/tmp/paperclip-native}"
export PAPERCLIP_INSTANCE_ID=default
export AI_TOOLS_BRIDGE_URL="http://localhost:8000"

# Start AI tools bridge if available
if ! curl -s --max-time 1 http://localhost:8000/health >/dev/null 2>&1; then
  BRIDGE_DIR="$PAPERCLIP_REPO/ai_tools_bridge"
  if [ -f "$BRIDGE_DIR/.venv/bin/uvicorn" ]; then
    nohup "$BRIDGE_DIR/.venv/bin/uvicorn" src.main:app --host 0.0.0.0 --port 8000 \
      --app-dir "$BRIDGE_DIR" > /tmp/ai-tools-bridge.log 2>&1 &
    ok "AI tools bridge started (log: /tmp/ai-tools-bridge.log)"
  fi
fi

cd "$PAPERCLIP_REPO"
NODE_CMD="node --import ./server/node_modules/tsx/dist/loader.mjs server/dist/index.js"

if [ "$FLAG_BG" = true ]; then
  info "Starting Paperclip in background..."
  nohup $NODE_CMD > /tmp/paperclip-server.log 2>&1 &
  PID=$!
  sleep 3

  if ! kill -0 "$PID" 2>/dev/null; then
    fail "Paperclip failed to start. Check /tmp/paperclip-server.log"
  fi
  ok "Paperclip running (PID=$PID, log=/tmp/paperclip-server.log)"
else
  # For foreground mode, we need to start Paperclip in background temporarily
  # to run setup, then exec into it at the end
  info "Starting Paperclip temporarily for setup..."
  nohup $NODE_CMD > /tmp/paperclip-server.log 2>&1 &
  BG_PID=$!
  sleep 3

  if ! kill -0 "$BG_PID" 2>/dev/null; then
    fail "Paperclip failed to start. Check /tmp/paperclip-server.log"
  fi
  ok "Paperclip started (PID=$BG_PID)"
fi

# ══════════════════════════════════════════════════════════════════════════════
# Step 6: Ensure company + agents are provisioned
# ══════════════════════════════════════════════════════════════════════════════
header "Step 6: Ensure company + agents"

cd "$PROJECT_ROOT"

# Pass OTel env vars through so agent configs get OTEL_* in adapterConfig.env
SETUP_ENV=""
if [ "${OTEL_ENABLED:-}" = "true" ]; then
  SETUP_ENV="OTEL_ENABLED=true OTEL_EXPORTER_OTLP_ENDPOINT=${OTEL_EXPORTER_OTLP_ENDPOINT:-http://localhost:4318}"
fi

if [ -n "$SETUP_ENV" ]; then
  env $SETUP_ENV npx tsx scripts/setup-paperclip-company.ts
else
  npx tsx scripts/setup-paperclip-company.ts
fi

# ══════════════════════════════════════════════════════════════════════════════
# Summary
# ══════════════════════════════════════════════════════════════════════════════
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo -e "${GREEN}✓${NC} Paperclip is running!"
echo ""
echo "  🌐 UI:          http://localhost:3100"
echo "  📡 API:         http://localhost:3100/api/health"
if [ "$FLAG_OBSERVABILITY" = true ]; then
  echo "  📊 Grafana:     http://localhost:3000  (admin/bmad)"
  echo "  🔍 Jaeger:      http://localhost:16686"
  echo "  📈 Prometheus:  http://localhost:9090"
fi
echo ""
echo "  Heartbeats are managed by Paperclip automatically."
echo "  To invoke a heartbeat manually:"
echo "    npx tsx scripts/e2e-test.ts --smoke"
echo ""

if [ "$FLAG_BG" = true ]; then
  echo "  Paperclip log:  /tmp/paperclip-server.log"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
else
  echo "  Paperclip running in foreground (Ctrl+C to stop)."
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo ""

  # Kill the temporary background Paperclip and exec into foreground
  kill "$BG_PID" 2>/dev/null || true
  sleep 1

  cd "$PAPERCLIP_REPO"
  exec $NODE_CMD
fi

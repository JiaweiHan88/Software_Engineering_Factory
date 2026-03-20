#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# Start Paperclip Natively on Host (for process adapter compatibility)
#
# The process adapter needs to spawn commands directly on the host (npx, tsx,
# gh, Copilot CLI). Running Paperclip inside Docker won't work because the
# container can't reach host binaries. This script:
#
# 1. Ensures Docker Postgres is running (with port 5432 exposed)
# 2. Kills any existing Paperclip server on port 3100
# 3. Starts Paperclip server natively in local_trusted mode
# 4. Process adapter commands execute directly on the host
#
# Prerequisites:
#   - Docker running (for Postgres)
#   - Paperclip repo built: cd ../paperclip && pnpm install && pnpm build
#   - Node.js with npx/tsx available in PATH
#
# Usage:
#   ./scripts/start-paperclip-native.sh          # foreground
#   ./scripts/start-paperclip-native.sh --bg     # background (nohup)
# ──────────────────────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
PAPERCLIP_REPO="${PAPERCLIP_REPO:-$(dirname "$PROJECT_ROOT")/paperclip}"

# ── Validate prerequisites ────────────────────────────────────────────────
if [ ! -f "$PAPERCLIP_REPO/server/dist/index.js" ]; then
  echo "❌ Paperclip server not built. Run:"
  echo "   cd $PAPERCLIP_REPO && pnpm install && pnpm build"
  exit 1
fi

# ── Ensure Docker Postgres is running ─────────────────────────────────────
echo "🐘 Ensuring Postgres is running..."
cd "$PROJECT_ROOT"
BETTER_AUTH_SECRET=dummy docker compose up -d postgres 2>/dev/null || true

# Wait for Postgres to be healthy
for i in $(seq 1 15); do
  if docker exec bmad_copilot_rt-postgres-1 pg_isready -U paperclip -d paperclip >/dev/null 2>&1; then
    echo "   ✅ Postgres is ready"
    break
  fi
  if [ "$i" -eq 15 ]; then
    echo "   ❌ Postgres not ready after 15 attempts"
    exit 1
  fi
  sleep 1
done

# ── Stop Docker Paperclip server if running ───────────────────────────────
if docker ps -q -f name=bmad_copilot_rt-paperclip-1 | grep -q .; then
  echo "🛑 Stopping Docker Paperclip server..."
  docker stop bmad_copilot_rt-paperclip-1 2>/dev/null || true
fi

# ── Kill existing native Paperclip server on port 3100 ────────────────────
if lsof -i :3100 -P -n 2>/dev/null | grep -q LISTEN; then
  echo "🛑 Stopping existing Paperclip server on port 3100..."
  PIDS=$(lsof -ti :3100 -sTCP:LISTEN 2>/dev/null || true)
  if [ -n "$PIDS" ]; then
    echo "   Killing PID(s): $PIDS"
    echo "$PIDS" | xargs kill -TERM 2>/dev/null || true
    # Wait up to 5 seconds for graceful shutdown
    for i in $(seq 1 10); do
      if ! lsof -i :3100 -P -n 2>/dev/null | grep -q LISTEN; then
        echo "   ✅ Previous server stopped"
        break
      fi
      if [ "$i" -eq 10 ]; then
        echo "   ⚠️  Graceful shutdown timed out, force killing..."
        echo "$PIDS" | xargs kill -9 2>/dev/null || true
        sleep 1
      fi
      sleep 0.5
    done
  fi
fi

# ── Environment ───────────────────────────────────────────────────────────
export BETTER_AUTH_SECRET="${BETTER_AUTH_SECRET:-dev-secret-bmad}"
export DATABASE_URL="postgresql://paperclip:paperclip@localhost:5432/paperclip"
export PORT=3100
export SERVE_UI=true
export PAPERCLIP_DEPLOYMENT_MODE=local_trusted
export PAPERCLIP_HOME="${PAPERCLIP_HOME:-/tmp/paperclip-native}"
export PAPERCLIP_INSTANCE_ID=default

# ── Start server ──────────────────────────────────────────────────────────
cd "$PAPERCLIP_REPO"
NODE_CMD="node --import ./server/node_modules/tsx/dist/loader.mjs server/dist/index.js"

if [ "${1:-}" = "--bg" ]; then
  echo "🚀 Starting Paperclip server in background..."
  nohup $NODE_CMD > /tmp/paperclip-server.log 2>&1 &
  PID=$!
  sleep 3
  if kill -0 "$PID" 2>/dev/null; then
    echo "   ✅ Paperclip running (PID=$PID, log=/tmp/paperclip-server.log)"
    echo "   🌐 UI: http://localhost:3100"
    echo "   📡 API: http://localhost:3100/api/health"
  else
    echo "   ❌ Paperclip failed to start. Check /tmp/paperclip-server.log"
    exit 1
  fi
else
  echo "🚀 Starting Paperclip server (foreground)..."
  echo "   Mode: local_trusted (board access, no auth required)"
  echo "   DB:   postgresql://paperclip:***@localhost:5432/paperclip"
  echo "   UI:   http://localhost:3100"
  echo ""
  exec $NODE_CMD
fi

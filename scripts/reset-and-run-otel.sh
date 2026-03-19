#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# reset-and-run-otel.sh — Reset sprint state + workspace, then run with OTel
#
# Usage:
#   ./scripts/reset-and-run-otel.sh              # reset + run ORCH-002
#   ./scripts/reset-and-run-otel.sh ORCH-001     # reset + run specific story
#   ./scripts/reset-and-run-otel.sh --reset-only # reset without running
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

FACTORY_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TARGET_PROJECT="$(cd "$FACTORY_ROOT/.." && pwd)/bmad-target-project"
STORY_ID="${1:-ORCH-002}"
RESET_ONLY=false

if [[ "$STORY_ID" == "--reset-only" ]]; then
  RESET_ONLY=true
fi

echo "🔄 BMAD Copilot Factory — Reset & Run (OTel)"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "📂 Factory root:    $FACTORY_ROOT"
echo "🎯 Target workspace: $TARGET_PROJECT"
echo ""

# ── Step 1: Kill any running factory process ───────────────────────────────
echo "🧹 Step 1: Killing any running factory processes..."
pkill -9 -f "tsx src/index.ts" 2>/dev/null && echo "   Killed stale factory process" || echo "   No stale processes found"
sleep 1

# ── Step 2: Reset factory sprint status ────────────────────────────────────
echo "📋 Step 2: Resetting factory sprint status..."
cat > "$FACTORY_ROOT/_bmad-output/sprint-status.yaml" << 'EOF'
sprint:
  number: 1
  goal: Orchestrator smoke test
  stories:
    - id: ORCH-001
      title: Add health check endpoint
      status: ready-for-dev
    - id: ORCH-002
      title: Implement session resume logic
      status: ready-for-dev
EOF
echo "   ✅ Factory sprint reset (both stories → ready-for-dev)"

# ── Step 3: Reset target workspace sprint status ───────────────────────────
if [[ -d "$TARGET_PROJECT" ]]; then
  echo "📋 Step 3: Resetting target workspace sprint status..."
  mkdir -p "$TARGET_PROJECT/_bmad-output/stories"

  cat > "$TARGET_PROJECT/_bmad-output/sprint-status.yaml" << 'EOF'
sprint:
  number: 1
  goal: Build initial features
  stories:
    - id: ORCH-002
      title: Implement session resume logic
      status: ready-for-dev
EOF
  echo "   ✅ Target workspace sprint reset"

  # ── Step 4: Clean agent-generated files from target workspace ────────────
  echo "🗑️  Step 4: Cleaning agent-generated files from target workspace..."
  rm -f "$TARGET_PROJECT/src/session-store.ts" && echo "   Removed src/session-store.ts" || true
  rm -rf "$TARGET_PROJECT/test/" && echo "   Removed test/" || true
  rm -rf "$TARGET_PROJECT/.sessions/" && echo "   Removed .sessions/" || true

  # Reset src/index.ts to pristine state
  cat > "$TARGET_PROJECT/src/index.ts" << 'SCAFFOLD'
/**
 * bmad-target-project — Entry point
 * This is an empty project for BMAD agents to build into.
 */
export function main(): void {
  console.log("Hello from bmad-target-project");
}

main();
SCAFFOLD
  echo "   ✅ src/index.ts reset to pristine state"
else
  echo "⚠️  Step 3-4: Target workspace not found at $TARGET_PROJECT (skipping)"
fi

# ── Step 5: Verify observability stack ─────────────────────────────────────
echo "🔍 Step 5: Checking observability stack..."
OTEL_OK=true

if ! curl -s http://localhost:4318/v1/traces -X POST -H "Content-Type: application/json" -d '{}' > /dev/null 2>&1; then
  echo "   ❌ OTel Collector not reachable on port 4318"
  OTEL_OK=false
else
  echo "   ✅ OTel Collector (port 4318)"
fi

if ! curl -s http://localhost:16686 > /dev/null 2>&1; then
  echo "   ❌ Jaeger not reachable on port 16686"
  OTEL_OK=false
else
  echo "   ✅ Jaeger (port 16686)"
fi

if ! curl -s http://localhost:9090/-/ready > /dev/null 2>&1; then
  echo "   ❌ Prometheus not reachable on port 9090"
  OTEL_OK=false
else
  echo "   ✅ Prometheus (port 9090)"
fi

if ! curl -s http://localhost:3000/api/health > /dev/null 2>&1; then
  echo "   ❌ Grafana not reachable on port 3000"
  OTEL_OK=false
else
  echo "   ✅ Grafana (port 3000)"
fi

if [[ "$OTEL_OK" == "false" ]]; then
  echo ""
  echo "⚠️  Some observability services are not running."
  echo "   Start them with: pnpm observability:up"
  echo "   Then re-run this script."
  exit 1
fi

# ── Step 6: Summary ───────────────────────────────────────────────────────
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "✅ Reset complete. Ready for a clean OTel run."
echo ""

if [[ "$RESET_ONLY" == "true" ]]; then
  echo "🏁 Reset-only mode — not running factory."
  echo "   Run manually with: pnpm start:otel -- --story $STORY_ID"
  exit 0
fi

# ── Step 7: Run factory with OTel ─────────────────────────────────────────
echo "🚀 Step 6: Starting factory with OTel (story: $STORY_ID)..."
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

cd "$FACTORY_ROOT"
OTEL_ENABLED=true \
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 \
TARGET_PROJECT_ROOT=../bmad-target-project \
LOG_FORMAT=human \
LOG_LEVEL=debug \
exec pnpm start:otel -- --story "$STORY_ID"

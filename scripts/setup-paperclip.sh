#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# setup-paperclip.sh — Clone Paperclip and apply local patches
#
# Usage:
#   ./scripts/setup-paperclip.sh              # Clone + patch (default: ../paperclip)
#   ./scripts/setup-paperclip.sh /opt/paperclip  # Clone to custom path
#   PAPERCLIP_REF=v0.3.1 ./scripts/setup-paperclip.sh  # Pin to a specific tag
#
# This script:
#   1. Clones the Paperclip repo (if not already present)
#   2. Applies any patches from patches/ that haven't been applied yet
#   3. Verifies the patched build context is ready for docker compose
# ──────────────────────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PATCHES_DIR="$REPO_ROOT/patches"

# Default clone target: sibling directory
PAPERCLIP_DIR="${1:-$REPO_ROOT/../paperclip}"
PAPERCLIP_REPO="https://github.com/paperclipai/paperclip.git"
PAPERCLIP_REF="${PAPERCLIP_REF:-}"  # empty = default branch (master)

# ── Colors ───────────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

info()  { echo -e "${CYAN}ℹ${NC}  $*"; }
ok()    { echo -e "${GREEN}✓${NC}  $*"; }
warn()  { echo -e "${YELLOW}⚠${NC}  $*"; }
fail()  { echo -e "${RED}✗${NC}  $*" >&2; exit 1; }

# ── Step 1: Clone if needed ─────────────────────────────────────────────────
if [ -d "$PAPERCLIP_DIR/.git" ]; then
  ok "Paperclip repo already exists at $PAPERCLIP_DIR"
  cd "$PAPERCLIP_DIR"

  # Optionally update to latest
  CURRENT_SHA=$(git rev-parse HEAD)
  info "Current commit: $CURRENT_SHA"

  if [ -n "$PAPERCLIP_REF" ]; then
    info "Checking out requested ref: $PAPERCLIP_REF"
    git fetch origin --tags
    git checkout "$PAPERCLIP_REF"
  fi
else
  info "Cloning Paperclip from $PAPERCLIP_REPO → $PAPERCLIP_DIR"
  if [ -n "$PAPERCLIP_REF" ]; then
    git clone --branch "$PAPERCLIP_REF" "$PAPERCLIP_REPO" "$PAPERCLIP_DIR"
  else
    git clone "$PAPERCLIP_REPO" "$PAPERCLIP_DIR"
  fi
  ok "Cloned successfully"
  cd "$PAPERCLIP_DIR"
fi

# ── Step 2: Apply patches ───────────────────────────────────────────────────
if [ ! -d "$PATCHES_DIR" ]; then
  warn "No patches/ directory found — skipping patch step"
  exit 0
fi

PATCH_COUNT=0
APPLIED_COUNT=0
SKIPPED_COUNT=0

for patch_file in "$PATCHES_DIR"/*.patch; do
  [ -f "$patch_file" ] || continue
  PATCH_COUNT=$((PATCH_COUNT + 1))
  patch_name=$(basename "$patch_file")

  # Check if patch is already applied (reverse-apply test)
  if git apply --reverse --check "$patch_file" 2>/dev/null; then
    ok "Already applied: $patch_name"
    SKIPPED_COUNT=$((SKIPPED_COUNT + 1))
    continue
  fi

  # Check if patch can be applied cleanly
  if git apply --check "$patch_file" 2>/dev/null; then
    info "Applying: $patch_name"
    git apply "$patch_file"
    ok "Applied: $patch_name"
    APPLIED_COUNT=$((APPLIED_COUNT + 1))
  else
    # Try with 3-way merge for fuzzy matching
    warn "Clean apply failed for $patch_name, trying 3-way merge..."
    if git apply --3way "$patch_file" 2>/dev/null; then
      ok "Applied (3-way): $patch_name"
      APPLIED_COUNT=$((APPLIED_COUNT + 1))
    else
      fail "Cannot apply patch: $patch_name — manual resolution needed"
    fi
  fi
done

# ── Step 3: Summary ─────────────────────────────────────────────────────────
echo ""
echo "──────────────────────────────────────────"
ok "Paperclip setup complete"
info "  Location:  $PAPERCLIP_DIR"
info "  Commit:    $(git rev-parse --short HEAD)"
info "  Patches:   $PATCH_COUNT total, $APPLIED_COUNT applied, $SKIPPED_COUNT already present"
echo ""
info "Next steps:"
echo "  docker compose up -d          # Build & start Paperclip + PostgreSQL"
echo "  pnpm start:paperclip          # Run BMAD inbox-polling integration"
echo "──────────────────────────────────────────"

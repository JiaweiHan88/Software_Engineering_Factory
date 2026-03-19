# Paperclip Patches

Local patches applied to the upstream [Paperclip](https://github.com/paperclipai/paperclip)
repo to fix issues that haven't been merged yet.

## Current Patches

### `paperclip-dockerfile-plugin-packages.patch`

**Problem:** The upstream Dockerfile is missing `COPY` lines for the 6 `plugin-*` workspace
packages, causing `pnpm install --frozen-lockfile` to fail with unresolved workspace
dependencies. It also lacks the `plugin-sdk` build step that `@paperclipai/server` depends
on at compile time.

**Fix:** Adds 6 COPY lines for plugin packages in the deps stage + a
`pnpm --filter @paperclipai/plugin-sdk build` step before the server build.

**Upstream status:** Not yet submitted. This is a legitimate bug fix that could be PR'd to
`paperclipai/paperclip`.

## Usage

Patches are applied automatically by `scripts/setup-paperclip.sh`:

```bash
./scripts/setup-paperclip.sh          # Clones + patches ../paperclip
```

The script is idempotent — already-applied patches are detected and skipped.

## Adding a New Patch

1. Make your fix in the `../paperclip` repo and commit it
2. Export: `cd ../paperclip && git format-patch -1 HEAD --stdout > ../BMAD_Copilot_RT/patches/my-fix.patch`
3. Add a description to this README

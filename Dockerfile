# BMAD Copilot Factory — Dockerfile
# Builds the autonomous software building factory for Docker Compose deployment.
#
# Usage:
#   docker build -t bmad-factory .
#   docker run --env-file .env bmad-factory
#
# Note: Requires Copilot CLI to be available. In containerized mode,
# the SDK connects to the host's Copilot CLI via environment variables.

FROM node:22-alpine AS base
WORKDIR /app

# Install pnpm
RUN corepack enable && corepack prepare pnpm@latest --activate

# ── Dependencies ──────────────────────────────────────────────────────────────
FROM base AS deps
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod

# ── Build ─────────────────────────────────────────────────────────────────────
FROM base AS build
COPY package.json pnpm-lock.yaml tsconfig.json ./
RUN pnpm install --frozen-lockfile
COPY src/ src/
RUN pnpm run build

# ── Runtime ───────────────────────────────────────────────────────────────────
FROM base AS runtime

# Copy production dependencies
COPY --from=deps /app/node_modules ./node_modules

# Copy compiled output
COPY --from=build /app/dist ./dist

# Copy package.json for metadata
COPY package.json ./

# Copy templates and BMAD config
COPY templates/ templates/
COPY _bmad/ _bmad/

# Create output directory
RUN mkdir -p _bmad-output

# Default command: run Paperclip integration mode
ENV PAPERCLIP_ENABLED=true
CMD ["node", "dist/index.js", "--paperclip"]

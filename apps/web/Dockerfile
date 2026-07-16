# Web (Next.js 16) — multi-stage. Build stage installs the workspace and runs
# `next build` with the NEXT_PUBLIC_* values in scope so Next INLINES them into
# the client bundle (these are compile-time, NOT runtime). Runtime stage carries
# only Next's `standalone` output (a minimal `node server.js` + traced
# node_modules) plus the static assets — no pnpm, no node_modules install.
#
# Build context MUST be the repo root (pnpm workspace install needs libs/*):
#   docker build -f apps/web/Dockerfile \
#     --build-arg NEXT_PUBLIC_INDEXER_URL=... \
#     --build-arg NEXT_PUBLIC_SOLANA_RPC_URL=... \
#     --build-arg NEXT_PUBLIC_CLUSTER=devnet \
#     -t fpm-web .

# ---- build ----
FROM node:24-slim AS build
RUN corepack enable && corepack prepare pnpm@11.9.0 --activate
WORKDIR /repo

# NEXT_PUBLIC_* are inlined by Next at BUILD time (not read at runtime), so they
# must be ARGs in scope BEFORE `next build`. Passed via `docker build --build-arg`
# (CI) — never committed. Empty defaults keep a bare `docker build` from failing.
ARG NEXT_PUBLIC_INDEXER_URL=""
ARG NEXT_PUBLIC_SOLANA_RPC_URL=""
ARG NEXT_PUBLIC_CLUSTER=""
ENV NEXT_PUBLIC_INDEXER_URL=$NEXT_PUBLIC_INDEXER_URL \
    NEXT_PUBLIC_SOLANA_RPC_URL=$NEXT_PUBLIC_SOLANA_RPC_URL \
    NEXT_PUBLIC_CLUSTER=$NEXT_PUBLIC_CLUSTER \
    NEXT_TELEMETRY_DISABLED=1

# .dockerignore trims target/, node_modules, dist, .next, .git, secrets.
COPY . .
# Install the web slice (+ its workspace deps: @fpm/shared, @fpm/idl). Next's
# `transpilePackages` compiles those TS libs during `next build`, so no build
# step is needed for them here.
RUN pnpm install --frozen-lockfile --filter @fpm/web...
# Produce .next/standalone (nested under apps/web/ because outputFileTracingRoot
# is the repo root) + .next/static.
RUN pnpm --filter @fpm/web build

# ---- runtime ----
FROM node:24-slim AS runtime
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0
WORKDIR /app

# Copy the standalone bundle (minimal server + traced node_modules). In a pnpm
# monorepo traced from the repo root, this preserves the workspace layout, so the
# server entrypoint lands at /app/apps/web/server.js and hoisted deps under
# /app/node_modules + /app/apps/web/node_modules.
COPY --from=build --chown=node:node /repo/apps/web/.next/standalone ./
# server.js does NOT copy public/ or .next/static by itself — copy them into the
# nested package path so the standalone server serves them.
COPY --from=build --chown=node:node /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=build --chown=node:node /repo/apps/web/public ./apps/web/public

USER node
EXPOSE 3000
# Run the nested standalone entrypoint. PORT/HOSTNAME come from ENV above.
CMD ["node", "apps/web/server.js"]

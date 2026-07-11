# Indexer — multi-stage. Build stage installs the slice, compiles NestJS (swc),
# and extracts a self-contained prod-only deployment with `pnpm deploy`; runtime
# stage carries only that slice + openssl (for the Prisma engine).
#
# Build context MUST be the repo root:
#   docker build -f apps/indexer/Dockerfile -t fpm-indexer .

# ---- build ----
FROM node:24-slim AS build
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@11.9.0 --activate
WORKDIR /repo
# .dockerignore trims target/, node_modules, dist, .next, .git, secrets.
COPY . .
# Install the indexer slice (+ workspace deps). `postinstall` runs `prisma generate`.
RUN pnpm install --frozen-lockfile --filter @fpm/indexer...
# Compile NestJS → dist/main.js (swc emits decorator metadata).
RUN pnpm --filter @fpm/indexer build
# Inline the buildless @fpm/* TS libs into dist/bundle.cjs (Nest/Prisma stay
# external) so no TypeScript is resolved under node_modules at runtime.
RUN pnpm --filter @fpm/indexer bundle
# Extract a self-contained prod deployment (dev deps pruned; prisma CLI kept
# because it is now a prod dep — needed for `migrate deploy` at startup).
# `--legacy`: pnpm v10+ otherwise refuses to deploy a non-injected workspace.
RUN pnpm --filter @fpm/indexer deploy --legacy --prod /out
# `pnpm deploy` rebuilds /out/node_modules WITHOUT re-running postinstall, so
# regenerate the Prisma client into the deployed slice (schema + CLI are in /out).
RUN cd /out && node_modules/.bin/prisma generate

# ---- runtime ----
FROM node:24-slim AS runtime
ENV NODE_ENV=production
# Prisma's query engine needs openssl + CA certs.
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
# Non-root at runtime (the node image ships an unprivileged `node` user).
COPY --from=build --chown=node:node /out .
USER node
EXPOSE 3900
# Apply pending migrations against RDS, then serve the bundled entrypoint
# (no type-stripping needed — @fpm/* is inlined). DATABASE_URL from env
# (ECS task def → Secrets Manager); never baked in.
CMD ["sh", "-c", "node_modules/.bin/prisma migrate deploy && node dist/bundle.cjs"]

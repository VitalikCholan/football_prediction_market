# Keeper — multi-stage. Build stage bundles the keeper + its buildless workspace
# TS deps (@fpm/idl, @fpm/shared) into a single self-contained CJS file with
# esbuild. This sidesteps Node's "can't strip types under node_modules" limit
# (the buildless libs ship as .ts) and drops ALL runtime deps — the runtime
# image is just the base + one file.
#
# Build context MUST be the repo root:
#   docker build -f apps/keeper/Dockerfile -t fpm-keeper .

# ---- build ----
FROM node:24-slim AS build
RUN corepack enable && corepack prepare pnpm@11.9.0 --activate
WORKDIR /repo
# .dockerignore trims target/, node_modules, dist, .next, .git, apps/web, secrets.
COPY . .
RUN pnpm install --frozen-lockfile --filter @fpm/keeper...
# esbuild → CJS (native dynamic require; pino needs it) → dist/keeper.cjs.
RUN pnpm --filter @fpm/keeper bundle

# ---- runtime ----
FROM node:24-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
# Just the bundle — no node_modules, no pnpm, no source of other packages.
COPY --from=build --chown=node:node /repo/apps/keeper/dist/keeper.cjs .
USER node
# Secrets/config come from env (ECS task def → Secrets Manager): RPC_URLS,
# KEEPER_KEYPAIR, TXLINE_API_TOKEN, ENABLE_AUTO_SEED, … — never baked in.
CMD ["node", "keeper.cjs"]

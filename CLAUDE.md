# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

World Cup prediction-market AMM on Solana (TxLINE hackathon track, deadline 2026-07-19). Constant-product FPMM: users buy YES/NO positions in USDT (TxLINE devnet mint, classic SPL); a keeper resolves markets by CPI into the TxLINE oracle program (`validate_stat` → Merkle-proof-verified `bool`); winners redeem 1 token = 1 USDT.

**The `plans/` directory is the spec.** `PLAN.md` = master plan (§9 phases, §10 v0/v1/v2 scope); `plans/anchor-programs-plan.md` = full on-chain spec (accounts, instructions, math, security checklist, resolved decisions D-1…D-9); `plans/backend-plan.md`, `plans/frontend-plan.md`, `plans/monorepo-setup.md`. `apps/web/DESIGN_SPEC.md` = UI wireframe spec (design tokens, 7 screens). Implement to these; update them when decisions change.

## Commands

```bash
# On-chain (Anchor 1.0.x, Rust — run from repo root)
NO_DNA=1 anchor build          # builds program + emits target/idl/amm.json
cargo test --workspace         # all Rust tests: pure math/fee unit + LiteSVM integration
cargo test -p amm              # program unit tests only (math.rs / fee.rs)
cargo test -p tests <name>     # single LiteSVM test by name

# JS workspace (pnpm 11 + Turborepo)
pnpm install
pnpm codegen                   # regenerate libs/idl TS client from target/idl/amm.json (REQUIRED after anchor build)
pnpm -r typecheck              # all packages
pnpm --filter @fpm/web dev     # Next.js
pnpm --filter @fpm/indexer dev # NestJS (nest start --watch -b swc)
pnpm --filter @fpm/keeper dev  # plain TS (node --experimental-strip-types)
pnpm --filter @fpm/web build && pnpm --filter @fpm/web lint
pnpm --filter @fpm/indexer exec prisma migrate dev   # needs DATABASE_URL (Postgres)
```

After changing the program: `anchor build` → `pnpm codegen` → types ripple to all JS packages with no rebuild. CI (`.github/workflows/ci.yml`) fails if `libs/idl/src/generated` is stale vs the IDL.

Every program `.rs` file must pass the Solana MCP `program_autofixer` (framework=anchor) before it's considered done — loop until `require_another_tool_call_after_fixing` is false.

## Architecture

Three seams hold the monorepo together:

1. **Anchor is outside the JS workspace.** `programs/amm/` + `tests/` belong to the root Cargo workspace; `pnpm-workspace.yaml` deliberately excludes `programs/*`. The only Rust→JS bridge is `target/idl/amm.json` → Codama codegen → `libs/idl` (`@fpm/idl`, a generated `@solana/kit` client). Never hand-edit `libs/idl/src/generated`.
2. **Buildless internal packages.** `libs/shared` (`@fpm/shared`) points `main`/`exports` at TS source — no build step. It is the single source of truth for: PDA seeds/derivations (must match `programs/amm/src/constants.rs` byte-for-byte), zod DTOs (the API contract consumed by both the NestJS indexer via `nestjs-zod` and the web app), and TxLINE constants (program ids, mints, endpoints). Never hardcode a seed or DTO shape in an app.
3. **Per-app TS runners.** Keeper runs on Node native type-stripping (tsconfig `erasableSyntaxOnly` — no parameter properties, no decorators). Indexer needs decorator metadata, so it alone uses `nest start --watch -b swc` and the `nestjs.json` tsconfig. Web consumes workspace TS via `transpilePackages`. Don't apply one tsconfig repo-wide.

**On-chain design (see anchor plan for full detail):** virtual-reserve CPMM — reserves set odds only; solvency is a separate invariant (`vault_usdc >= max(yes_supply, no_supply)`) re-checked after every mutating instruction. Dynamic volatility fee (three-zone decay + quadratic, `fee.rs`) defends LPs against the 60s TxLINE feed delay. `math.rs`/`fee.rs` are pure (no Anchor types) for exhaustive unit testing. Anchor 1.0 conventions: Pubkey-first CPI (`CpiContext::new(program.key(), …)`), single `#[error_code]`, `address =` over `has_one`, `transfer_checked` only, all accounts `Box`ed in instruction structs (SBF stack limit). `Position` PDA holds v1-reserved leverage fields (zero in v0, `leverage = 1`).

**Off-chain flow:** keeper (apps/keeper) watches the TxLINE SSE score stream, detects match end (Game Phase ∈ {5,10,13}), fetches the Merkle proof from `/api/scores/stat-validation`, and sends `resolve` through a swappable `TxSender` (simulate-before-send, RPC failover). Indexer (apps/indexer, NestJS + Prisma/Postgres) subscribes to program events and serves `GET /markets`, `/markets/:id`, `/markets/:id/history` for the web app's charts. Web (apps/web) renders from demo fixtures by default; `NEXT_PUBLIC_USE_LIVE_DATA=true` switches to live indexer fetch, validated against the shared zod DTOs.

**Current state:** v0 Phase 1 (config/market-config/init-market/open-position/buy/sell) is implemented and tested. Phase 2 (activate/freeze/`resolve` TxLINE CPI/redeem/close) is specced but not implemented — buy/sell/claim tx builders in web and keeper are stubbed with `TODO(program IDL)`. The v1 leverage layer (per-epoch funded options vault) is design-locked in anchor plan §4.10/D-9, staged after v0.

TxLINE devnet IDL for `declare_program!(txline)` goes in `programs/amm/idls/txline.json` — see `programs/amm/idls/README.md` for how to obtain it (needed before implementing `resolve`).

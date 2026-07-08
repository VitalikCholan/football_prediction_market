# Implementation Plan — Football Prediction-Market AMM on Solana

**Track:** TxLINE (real-time World Cup data with on-chain cryptographic signatures) · Track 1 (DeFi / production-readiness)
**Deadline:** 2026-07-19
**Grounded in:** `solana-dev` skill (Anchor + security references) and the architecture fixed in the prior Claude conversation.

> **STATUS (2026-07-08): v0 SHIPPED.** Phases 0–5 are complete and proven end-to-end on devnet (program `H59qQz8DXzUWWc3L528iTCFL36ozwBhJc4tHzuwL2JuY`): all 11 instructions live (53 Rust tests + a Surfpool suite vs the forked txoracle), keeper wired to the real TxLINE API with a full-circle proof-valid `resolve` on devnet, indexer serving REST, web on live indexer data. **`CLAUDE.md` is the source of truth for current implementation state**; this file is the original vision plus the forward roadmap. Corrections since the first draft:
> - **Anchor 1.0.2** (anchor-lang 1.1.2), not 0.31.x — the §4.6 "decision needed" resolved to 1.0.
> - The escrow stable mint is the **TxLINE devnet USDT** (classic SPL, decision D-6); "USDC" throughout this doc means that pinned mint.
> - Keeper reliability shipped as a swappable **`TxSender`** (`KitTxSender`: simulate-before-send + RPC failover) — the concept the draft called "kitguard".
> - Wallet is **framework-kit** (`@solana/react-hooks`, Wallet-Standard), not the legacy wallet-adapter.
> - §9 milestones (0–5) are all done; §11 open items are all resolved (notes inline there).
> - §10 (v0/v1/v2 roadmap — leverage-as-option, pm-AMM, LeveragePool solvency) remains the live plan for v1/v2; on-chain detail in `plans/anchor-programs-plan.md` §4.10.

---

## 1. Product in one paragraph

A constant-product (CPMM/FPMM) prediction market for World Cup matches. Each match is a market with YES/NO outcomes priced by `x·y = k`. Fans deposit **USDC** to buy YES/NO positions (tracked as **PDAs**, not SPL mints). When a match ends, an off-chain **keeper** pulls TxLINE's signed result + **Validation Proof**, calls `resolve()` on the AMM program, which **CPIs into the TxLINE program** to trustlessly verify the outcome before unlocking escrow. Winners redeem each winning position for **$1 (1 USDC)**. The reliability of `resolve()` landing on-chain is delivered by **kitguard** (RPC failover / rebroadcast / dynamic fees) — this is the authentic production-readiness story for Track 1.

**Lifecycle:** market open → trading (`x·y=k`, price moves) → match end → keeper pulls proof → CPI `validate_stat` → resolve → payout.

---

## 2. Stack (locked)

| Layer | Choice | Notes |
|---|---|---|
| On-chain program | **Rust + Anchor 1.0.2** (anchor-lang 1.1.2) | IDL + TS client out of the box; Pubkey-first CPI |
| Contract tests | **LiteSVM** | in-process, no validator; Surfpool for integration vs devnet state |
| Keeper | **TS + @solana/kit + swappable `TxSender`** | resolve() reliability is the core value-add (simulate-before-send + RPC failover) |
| Indexer / API | **TS + NestJS + PostgreSQL** | price/volume history for charts; structured modules/DI for REST API |
| Frontend | **Next.js + Tailwind** (hand-rolled primitives) | polished demo fast; shadcn skipped per DESIGN_SPEC |
| Charts | **lightweight-charts** (TradingView) | odds/price history |
| Monorepo | **pnpm + Turborepo** | share IDL→TS types across packages |
| Wallet | **framework-kit** (`@solana/react-hooks`, Wallet-Standard) | embedded (Privy/Dynamic/LazorKit) noted in README as consumer-onboarding direction |

---

## 3. Monorepo layout

Adapted from the buildless full-stack-monorepo approach (DOU / Herman) — `apps/` + `libs/` + `packages/` boundaries you can read at a glance, **buildless internal packages** (no rebuild cycle), and Turborepo used only where it pays. Package manager stays **pnpm** (the win is the buildless pattern, not the PM).

```
football-pm-amm/
├─ programs/
│  └─ amm/                 # Anchor program (Rust) — outside the JS workspace
│     ├─ src/lib.rs
│     ├─ src/state.rs      # Market, Position, GlobalConfig
│     ├─ src/instructions/ # init_market, buy, sell, resolve, redeem, close_market
│     ├─ src/math.rs       # CPMM math (checked)
│     └─ src/error.rs
├─ tests/                  # LiteSVM unit tests + anchor/Surfpool integration
├─ apps/                   # runnable apps & long-running services
│  ├─ web/                 # Next.js + shadcn + lightweight-charts
│  ├─ indexer/             # NestJS + Postgres REST API
│  └─ keeper/              # TS @solana/kit + kitguard service
├─ libs/                   # shared runtime code (buildless — points at TS source)
│  ├─ shared/              # PDA derivations, constants, zod DTOs/schemas
│  └─ idl/                 # generated IDL + Codama/Kit client (BUILD-FED exception)
├─ packages/               # tooling & shared config (as workspace packages)
│  ├─ eslint-config/
│  ├─ prettier-config/
│  └─ tsconfig/
├─ Anchor.toml
├─ turbo.json
├─ CLAUDE.md               # run agents from root; per-app CLAUDE.md/AGENTS.md as needed
└─ pnpm-workspace.yaml
```

### 3.1 Buildless internal packages
`libs/shared` is consumed **directly as TS source** — no build step, no stale editor TS-server. The package points at source:

```jsonc
// libs/shared/package.json
{ "name": "@fpm/shared", "private": true, "type": "module",
  "main": "src/index.ts", "imports": { "#src/*.ts": "./src/*.ts" } }
```

tsconfig tuned to match (`verbatimModuleSyntax`, `erasableSyntaxOnly`, `allowImportingTsExtensions`, `module: NodeNext`, `noEmit`). Tradeoff: no TS path aliases (those need a build). Services run TS directly — `node src/index.ts` / `node --watch src/index.ts` (keeper, indexer dev).

### 3.2 The one build-fed exception — `libs/idl`
Anchor emits the IDL as a **build artifact**, so `libs/idl` can't be purely source-pointing. Flow:

```
anchor build  →  target/idl/amm.json  →  codama generate  →  libs/idl/src (Kit client)
```

`libs/idl` is regenerated on contract change (a `turbo` task with the IDL JSON as input); everything downstream (`shared`, `keeper`, `indexer`, `web`) imports it like any other workspace package.

### 3.3 API↔web type contract
NestJS gives no Hono-style `hc<App>()` inference, so the contract lives in **`libs/shared` as zod DTOs** — imported by NestJS (`nestjs-zod`) and the web app. Single source of truth, buildless. (Alt: NestJS Swagger → generated client; heavier, skip for hackathon.)

### 3.4 Turborepo — only where it pays
- **Affected CI:** `turbo run lint typecheck test --affected` (set `TURBO_SCM_BASE` in CI).
- **Lean Docker:** `turbo prune --scope=@fpm/indexer --docker` (and `@fpm/keeper`) so each image carries only its slice.
- Not used as a mandatory orchestration layer; not nx.

### 3.5 Conventions
Shared `eslint-config` / `prettier-config` / `tsconfig` as workspace packages · husky + lint-staged · conventional commits with scopes (`feat(amm):`, `fix(keeper):`) · single version across root + workspaces.

---

## 4. On-chain program design

### 4.1 Accounts (PDAs)

| Account | Seeds | Purpose |
|---|---|---|
| `GlobalConfig` | `[b"config"]` | admin authority, TxLINE program id, USDC mint |
| `MarketConfig` | `[b"mkt_config", config_id]` | **reusable** shared params for a whole tournament: fee params (base/max/control/reduction/filter/decay/`max_v_acc`), resolution rules, activation policy. One config → **104 markets**. |
| `Market` | `[b"market", match_id]` | references `MarketConfig`; reserves `yes_reserve`/`no_reserve` (k), state enum, outcome, escrow vault, totals; **dynamic-fee state** (`last_price_bps`, `last_ts`, `v_acc`); activation timestamps (`kickoff_ts`, `freeze_ts`) |
| `Position` | `[b"position", market.key(), owner.key()]` | per-user YES/NO balances (internal accounting — **no SPL mints**); **leverage fields reserved** (`collateral`, `leverage`, `notional`) — v0 sets `leverage = 1` |
| `EscrowVault` | `[b"vault", market.key()]` | token account (USDC) holding all liquidity for the market |

**Market state machine (with activation lifecycle, Meteora-inspired):**
`Uninitialized → Open (created, pre-kickoff) → Trading (activated at kickoff) → Locked/Frozen (final whistle, awaiting proof) → Resolved(outcome) → Closed`.
- `Market` references its `MarketConfig` via a stored `Pubkey`, validated with `has_one = config` (or an explicit `address` constraint — see §4.6 version note).
- Derive `Market` with `seeds = [b"market", match_id.as_ref()], bump`; read the shared config as `Account<'info, MarketConfig>` with its own `seeds` + `bump`.
- **Activation timing** (Meteora `activation_point`): market activates on kickoff, freezes on final whistle; the **keeper** triggers both via the TxLINE fixtures schedule.

### 4.2 Instructions

1. `initialize_config(txline_program, usdc_mint)` — admin only (GlobalConfig).
2. `create_market_config(config_id, fee_params, resolution_rules)` — admin creates a **reusable** `MarketConfig` once per tournament; 104 markets reference it.
3. `init_market(match_id, kickoff_ts, freeze_ts, seed_liquidity)` — creates `Market` + `EscrowVault` under a `MarketConfig`, seeds reserves so initial YES/NO ≈ 0.50/0.50.
4. `activate_market()` / `freeze_market()` — keeper flips `Open→Trading` at kickoff and `Trading→Locked` at final whistle (guard with `Clock`).
5. `buy(side, usdc_in, min_out)` — **update dynamic fee (§4.4)**, transfer USDC into vault, apply `x·y=k` on the fee-adjusted input, credit `Position`. Slippage guard via `min_out`.
6. `sell(side, tokens_in, min_usdc_out)` — inverse; update dynamic fee; debit `Position`, pay USDC from vault.
7. `resolve(proof, outcome)` — **CPI into TxLINE `validate_stat`** to verify the signed Merkle proof; on success set `outcome` and `Resolved`. **Unlock is by cryptographic proof, not operator's word.**
8. `redeem()` — winning `Position` holders withdraw `1 USDC × winning_tokens` from vault.
9. `close_market()` — after all redemptions / grace window; secure close (`close = destination`).

### 4.3 CPMM math (`math.rs`)

- Constant product `x·y = k`; price(YES) = `no_reserve / (yes_reserve + no_reserve)`.
- `amount_out = y - k/(x + amount_in_after_fee)`, where `amount_in_after_fee = amount_in · (1 − fee_bps/DENOM)` and `fee_bps` is the **dynamic** rate from §4.4.
- **All arithmetic checked** (`checked_add/sub/mul/div`); reject zero/overflow with custom errors. Use `u128` intermediates for the product to avoid overflow, downcast with checks.

### 4.4 Dynamic volatility fee (`fee.rs`) — *verified against Solana MCP*

Borrowed from Meteora DLMM/DAMM-v2 and cross-checked against **Raydium CLMM** (`pool_fee.rs`) and **Orca Whirlpools** adaptive-fee code via the Solana MCP. Purpose: protect LPs from the **~60s TxLINE oracle-delay adverse selection** (someone sees a goal on TV and buys at the stale price). A sharp price move spikes the fee; it decays back over time.

**Model:** keep a volatility accumulator `v_acc` that grows from the price move each trade and decays with elapsed time; `fee = base_fee + quadratic(v_acc)`, capped at `max_fee`.

**State on `Market` PDA:**
```
last_price_bps: u16,   // YES price at last trade, 0..10_000
last_ts:        i64,   // unix_timestamp of last trade (Clock.unix_timestamp — see note)
v_acc:          u64,   // volatility accumulator (scaled), 0..max_v_acc
```

**Params on `MarketConfig`** (names/roles confirmed against Raydium/Meteora):
```
base_fee_bps:    u16,  // e.g. 30  (0.30%)
max_fee_bps:     u16,  // e.g. 1000 (10% cap; Meteora MAX_FEE_BPS=9900)
vfc_num:         u32,  // dynamic_fee_control numerator (how fast volatility → fee)
filter_period:   u32,  // seconds: below this, don't decay (HFT burst window)
decay_period:    u32,  // seconds: above this, reset accumulator
reduction_bps:   u16,  // decay factor R, 5000 = ×0.5 (Meteora default 50%)
max_v_acc:       u64,  // cap on v_acc (bounds the fee)
```

**Verified fixed-point conventions (from Raydium CLMM `pool_fee.rs`):**
- `VOLATILITY_ACCUMULATOR_SCALE = 10_000` — scale the accumulator so repeated decay doesn't round to 0.
- `REDUCTION_FACTOR_DENOMINATOR = 10_000`; `DYNAMIC_FEE_CONTROL_DENOMINATOR = 100_000`.
- Quadratic term (Orca pattern): `fee_num = vfc_num · v_acc²`; `fee = base + ceil(fee_num / (CONTROL_DENOM · SCALE²))`, then `min(fee, max_fee)`. **Square in `u128`** (`v_acc²` overflows u64), downcast with checks. Ceiling division `(num + denom − 1)/denom`.

**Three-zone decay (time between trades):**
```
elapsed = now_ts - last_ts
if elapsed <  filter_period:  v_ref = v_acc            // burst continues — no decay
else if elapsed < decay_period: v_ref = v_acc · reduction_bps / 10_000   // decay
else:                          v_ref = 0               // stale — reset
// then add this trade's price move:
v_acc = min(v_ref + price_delta_bps · SCALE, max_v_acc)
```

> **MCP note — seconds, not slots.** Raydium/Meteora key `filter_period`/`decay_period` off **`Clock.unix_timestamp` (seconds)**, not slot counts — steadier than slot cadence. Use `Clock::get()?.unix_timestamp` for `last_ts`/`elapsed`. (If ever needed, `slots↔secs` via `DEFAULT_MS_PER_SLOT`, per Kamino `scope`.)

**Calibration is the whole game:** these params *are* the balance of the system (too low → snipers drain LPs; too high → no volume). Backtest on **TxLINE historical replay** matches before demo. Judge thesis: *"volatility-aware fee calibrated to the oracle-delay window, protecting liquidity from stale-price adverse selection during goals."*

### 4.5 Token program correctness (critical)

- **Escrow holds USDC = classic SPL Token.** Use `anchor_spl::token`/`token_interface` consistently.
- **TxL is Token-2022** — only relevant when touching TxLINE accounts (their mint/ATA on `TOKEN_2022_PROGRAM_ID`). Keep the two `token_program`s **separate** in account structs (`Interface<'info, TokenInterface>` where a path can be either). This separation is a known bug source.
- Use `transfer_checked` (never deprecated `transfer`) for any movement that might touch Token-2022.

### 4.6 Anchor version — *MCP-verified, decision needed*

The prior conversation locked **Anchor 0.31.x** (safe, well-documented — fine for the hackathon). But the Solana MCP flags that **Anchor 1.0.0 (April 2026)** is now current, with breaking changes that affect this design:
- `@coral-xyz/anchor` → **`@anchor-lang/core`** (TS client).
- **`CpiContext::new` takes a `Pubkey`, not an `AccountInfo`** — matters for the `resolve` CPI into TxLINE (drop the program account from the accounts struct). Applies to our token CPIs too.
- **Duplicate mutable accounts are now rejected** by the runtime (good — free defense-in-depth).
- **Space must include the 8-byte discriminator**; `AccountInfo` deprecated in `Accounts` structs; prefer explicit `address` checks over deprecated `has_one`.
- Toolchain: Rust 1.89+, Solana CLI 3.1.10+, Anchor 1.0.0, **Surfpool 1.1.2+**, LiteSVM as the default test template — aligns with our §7 testing tiers.

**Recommendation:** ~~stay on 0.31.x~~ — **RESOLVED: shipped on Anchor 1.0.2** (anchor-lang 1.1.2). All CPIs are Pubkey-first, space includes the 8-byte discriminator, `address =` used over `has_one`, `transfer_checked` only, accounts `Box`ed. The draft's "1.0 bump is mechanical" bet paid off.

---

## 5. Security checklist (escrow holds real funds)

Applied from the skill's security reference — the high-value items for this design:

- [ ] **PDA non-sharing:** `Position` seeds include both `market` and `owner` (no master-key PDA).
- [ ] **No `init_if_needed`** on `Market`/`Position` (reinitialization → outcome/balance overwrite).
- [ ] **Arbitrary-CPI guard:** validate TxLINE program id from `GlobalConfig` before the `resolve` CPI; validate SPL Token program id on every transfer.
- [ ] **Signer/owner checks:** `has_one = authority` on config-gated instructions; `Signer` on the trader/keeper.
- [ ] **Checked math everywhere** in `buy`/`sell`/`redeem`; re-validate reserves after CPIs.
- [ ] **Resolution can only happen once** — guard on `Market.state == Locked`; reject double-resolve.
- [ ] **Redeem accounting:** debit `Position` before/atomically with vault payout; prevent double-redeem (zero out winning balance).
- [ ] **Secure close** (`close = destination`) to avoid revival attacks; only after grace window.
- [ ] **Clock-based locking** uses the real `Clock` sysvar (`Clock::get()?`).
- [ ] **USDC mint pinned** in `GlobalConfig` — reject any other mint into the vault.
- [ ] **`Market` ↔ `MarketConfig` binding** validated (`has_one = config` / explicit `address`) — a market can't be pointed at a rogue config with a 0% fee.
- [ ] **Dynamic-fee math:** `v_acc` squared in `u128`; `v_acc` capped at `max_v_acc`; fee capped at `max_fee_bps`; ceiling division so fee never rounds to 0 under load; monotonic `last_ts` (reject `now < last_ts`).

---

## 6. Off-chain services

### 6.1 Keeper (`apps/keeper`) — the differentiator
- TS service: subscribe to TxLINE **SSE score stream**; detect match end.
- On match end: fetch TxLINE **Validation Proof**, build `resolve()` tx via `@solana/kit`, send through **kitguard** (RPC failover, rebroadcast, dynamic priority fees) so it reliably lands.
- Keep it light: `setInterval`/event loop for the hackathon; optional BullMQ/Redis retry queue if time allows.
- **Safety:** simulate before send; default devnet; never hold user keys (keeper has its own signer for resolve only).

### 6.2 Indexer / API (`apps/indexer`)
- **NestJS** + Postgres (TypeORM or Prisma). Subscribe to program logs / account changes; write price & volume time-series per market.
- Modules: `MarketsModule` (REST), `IndexerModule` (background subscriber/worker), `DbModule`.
- REST endpoints: `GET /markets`, `GET /markets/:id`, `GET /markets/:id/history` (feeds lightweight-charts).
- **API↔web contract:** NestJS doesn't provide Hono's `hc<App>()` end-to-end type inference. Two options: (a) define request/response **DTOs as zod schemas in `libs/shared`** and import them in both NestJS (via `nestjs-zod`) and web — single source of truth, buildless; or (b) enable NestJS **Swagger/OpenAPI** and generate a typed web client. Prefer (a) for the hackathon (less tooling).

### 6.3 Frontend (`apps/web`)
- Next.js + shadcn. Market list, market detail with **lightweight-charts** odds/price history, buy/sell panel with slippage, position view, redeem button.
- Wallet adapter connect; build/sign/send via Kit; show simulation result before signing.

---

## 7. Testing strategy

Three tiers (from the Surfpool discussion), each with a distinct job:

| Tier | Tool | Covers | Speed |
|---|---|---|---|
| Unit | **LiteSVM** | CPMM invariants (`k` preserved net of fee), **dynamic-fee math** (v_acc growth/decay/cap, quadratic, ceiling division), slippage rejection, buy→sell round-trip, double-resolve/double-redeem rejection, lifecycle guards | ms |
| Integration | **Surfpool (surfnet)** | **real CPI into forked TxLINE oracle**, USDC from faucet, Token-2022 forked automatically, **time-travel** for the freeze→resolution window, `surfnet_setAccount` for edge-case reserves/`v_acc` | fast (lazy fork) |
| Smoke | **Devnet** | final pre-demo check; keeper + kitguard against live RPC (true failover only tests here) | slow |

- **Fee calibration:** replay historical matches (TxLINE historical replay) through Surfpool time-travel to tune `base/max/vfc/reduction/filter/decay` before demo.
- Run with `NO_DNA=1 anchor build` / `NO_DNA=1 anchor test`.
- **Every program file** goes through the MCP `program_autofixer` before it's considered done (loop until no critical/high issues).

---

## 8. Deployment & demo

- Program → **devnet** (TxLINE free tier available there).
- Frontend → **Vercel**; keeper + indexer → **Railway** (long-running).
- **Demo via Historical Replay:** matches finish after the deadline, so record a full historical-match run: market open → trades (price shifts) → match end → proof → resolve → payout. Closes the "clearly showcases core functionality" criterion.

---

## 9. Milestones → July 19

| Phase | Days | Deliverable |
|---|---|---|
| 0. Scaffold | 1 | pnpm+Turbo monorepo (apps/libs/packages, buildless), Anchor init, CI with `NO_DNA=1 anchor build` |
| 1. Core program | 3–4 | `GlobalConfig`/`MarketConfig`/`init_market`/`buy`/`sell` + CPMM + **dynamic fee (§4.4)** + activation lifecycle + LiteSVM tests green (fee math via `program_autofixer`) |
| 2. Resolution | 2–3 | `freeze`/`resolve` w/ TxLINE CPI (mock in LiteSVM → real via Surfpool fork), `redeem` |
| 3. Keeper | 2 | TxLINE SSE → proof → `resolve` via kitguard; simulate-before-send |
| 4. Indexer | 1–2 | Postgres time-series + REST endpoints |
| 5. Frontend | 3 | market UI, charts, buy/sell/redeem, wallet connect |
| 6. Devnet deploy | 1 | program on devnet, web on Vercel, services on Railway |
| 7. Historical Replay + README | 1–2 | recorded demo, security notes, embedded-wallet roadmap |

---

## 10. Scope roadmap — v0 / v1 / v2 (leverage, Forecast-inspired)

Leverage is the strongest **novelty/commercial** story for judges, but it's a second protocol on top — so it's staged, not baked into the critical path.

**Three separate decisions, not one:** the **mark price** (what funding/PnL settle against), **spot liquidity** (which curve traders swap on), and the **leverage instrument** (how levered exposure is written). "Which AMM do we use for leverage?" is the wrong question — the leverage layer is not an AMM.

**The one reframe that decides everything:** Forecast-style "leverage without liquidation, pay-for-time" *is* a **binary option** — the trader pays the premium as **theta over time** instead of upfront; max loss = collateral (bounded downside), upside bounded to `[0,1]`. So a long position is a long call/put, and the **`LeveragePool` is the options writer / short gamma.** The entire protocol economics collapse to one question: **does the time-fee correctly price volatility?** Underprice it and the pool is a drainable options desk — *that* is the real risk, not smart-contract exploits.

| Ver | Scope | Ship rule |
|---|---|---|
| **v0** | Pure FPMM prediction market (CPMM + dynamic fee + escrow + proof-resolution + redeem). `Position.leverage = 1`. | **Must ship.** A broken leverage engine is worse than none — judges reward "simple but flawless." |
| **v1** | Light leverage **3–5×** (not 100×), financed by a **protocol-owned `LeveragePool`** (the options writer), priced with the **cheap theta approximation `fee_rate ∝ p(1−p)/(T−t)`** (pure mul/div, no erf), charged as **rolling per-epoch funding re-quoted at the current mark each epoch** — perps-style, not a lifetime premium fixed at open. Position "death" = `accrued_fees == collateral`, settled by permissionless crank or lazily on interaction. Demo: "open 3× YES → watch theta accrue → leveraged payout (or fee-death)." | Only if v0 is done + tested. |
| **v2** | Full Forecast-style up to 100×, exact theta `fee_rate ∝ φ(Φ⁻¹(p))/√(T−t)`, `p`-dependent leverage cap `∝ 1/φ(Φ⁻¹(p))`, and the swappable **`PricingCurve` trait** (FPMM → pm-AMM). | **README/roadmap only** (plus optional pm-AMM benchmark) — shows vision without spending days. |

**Why leverage on predictions is hard (Forecast's insight):** YES price jumps discontinuously (`60c → 0c`) at resolution, so classic price-liquidation can't close in time. Forecast's fix = **"time as liquidator"**: no liquidation, you pay **funding for the duration held** (≈ theta on options). Leverage needs a counterparty (the `LeveragePool` fronts the difference).

**The time-fee is theta, and theta is not flat.** Binary-option theta is **maximal near `p ≈ 0.5`, collapses near the edges, and explodes as `T → resolution`.** On-chain that's `fee_rate ∝ φ(Φ⁻¹(p)) / √(T−t)`; the hackathon-cheap approximation **`fee_rate ∝ p(1−p) / (T−t)`** captures the same shape with pure mul/div (no erf). This is the single knob the whole leverage protocol lives or dies on — same "does the fee price the risk?" thesis as §4.4, one layer up.

**And it must be charged per epoch, not over the position's whole life.** The Messari nuance: with instant-resolution jump risk and no liquidation, a fee priced over the entire remaining life at open exactly offsets the levered upside — the trader pre-pays the full option premium and leverage becomes pointless. The fix is **rolling per-epoch funding**: evaluate `p(1−p)/(T−t)` at the **current mark price** each epoch and accrue only for epochs actually held — price short-horizon jump risk, not the whole option. That is what makes "buy at 60¢, ride to 65¢, pay only for the time held" actually profitable. *(Epoch mechanics in `anchor-programs-plan.md` §4.10.)*

**No-liquidation is a *simplification*, not just a feature.** Because there is no price-based liquidation, there is **no incentive to manipulate a thin FPMM to trigger liquidation cascades** — so v1 needs **no TWAP oracle, no anti-cascade logic, and no liquidator bot.** The keeper stays as-is (Merkle resolution + optional price snapshots for fee accrual). The only "liquidation" is deterministic fee-death (`accrued_fees == collateral`).

**TxLINE StablePrice is the mark price — a structural advantage.** TxLINE streams StablePrice odds with on-chain-verifiable proofs: an authoritative, cryptographically provable mark — exactly the thing leverage-on-predictions projects struggle to source. Funding and PnL for leveraged positions **mark to it, not to our own thin FPMM spot** (marking to your own book invites nudge-the-pool manipulation; real perp venues mark to an external index, never their own book). v1: the keeper posts the mark; v2: proof-verified on-chain via the TxLINE `validate_odds` CPI, mirroring `resolve`. *(Roadmap note: with an authoritative mark, spot itself has an alternative — a vault quoting YES/NO at TxLINE ± spread, vault as counterparty, removing the AMM-vs-mark basis entirely. FPMM spot + TxLINE mark remains the July-19 build; the oracle-quoted vault goes in the README roadmap.)*

**De-risk now, build later:** the `Position` PDA already reserves `collateral`, `leverage`, `notional` (§4.1). v1 adds `entry_slot` + a per-epoch funding cursor so funding accrues **only on interaction** (open / add / close / crank; fields in `anchor-programs-plan.md` §4.10) — deterministic, no per-slot state churn. With v0 writing `leverage = 1`, v1 becomes an **extension, not a rewrite**. Risk to watch in v1: funding-rate (theta) correctness, **pool solvency** (bound total exposure with `max_open_interest` on `MarketConfig`), and a **cutoff** window before resolution (stop opening leveraged positions X minutes before the known end).

**LeveragePool solvency guards (from Delphi/Gensyn) — two controls, economic framing here, on-chain detail in `anchor-programs-plan.md` §4.10:**
- **Coverage ratio** = `LeveragePool balance / Σ(max_payout of open positions)`. When it drops below a threshold, **cap new positions** (refuse opens that would push it lower). The actuarially honest move for the README is to **publish the break-even formula** — "here is the coverage the pool needs to stay solvent" — rather than promising "no risk."
- **Lock / withdraw windows for LeveragePool LPs.** A `withdraw_request` with a delay to the **next settlement**, so an LP watching a match go against the pool can't flee before the known resolution and dump the shortfall on whoever's left. This matters **more** for sports than for Delphi precisely *because* resolution time is known in advance — the incentive to run is sharper.

**Adverse selection before resolution — the §4.4 story, one layer up.** An informed trader watching the TxLINE SSE stream with lower latency opens **100× in the last deterministic minutes**. Defenses stack: the `1/(T−t)` term already spikes the fee near `T`; **ban opening new positions N minutes before expected resolution** (the cutoff above); and **cap each new position against free pool liquidity.** Same oracle-delay adverse-selection thesis as the dynamic fee in §4.4 — the volatility fee protects the FPMM LPs, these guards protect the `LeveragePool`. The SSE stream is also a **risk valve**, not just a threat: live score events (goals, red cards) let the keeper **briefly pause new leverage opens or widen funding around jumps** — exactly when a naive short-gamma vault gets picked off. v2/pitch line: Messari's **jump-arbitrage auction** — auction off the post-jump arb and rebate proceeds to the `LeveragePool`, turning the jump leak into vault revenue.

**pm-AMM as a stretch differentiator (v2):** make the market curve a swappable **`PricingCurve` trait** in the Anchor program — **FPMM as the v0 impl**, static **pm-AMM** (Paradigm 2024) as a 2nd impl (erf via an Abramowitz–Stegun polynomial in Q64.64, ~"one evening + property tests"). Curve choice is an **isolated module**: the resolution/redemption layer (Merkle proof → 1:1 payout) is identical across curves, so swapping curves touches nothing downstream. *(Trait signature + fixed-point erf detail live in `anchor-programs-plan.md`.)*

**But be honest about *why* pm-AMM — and its football caveat.** pm-AMM's headline result is **uniform LVR** (loss-vs-rebalancing = LP loss after you delta-hedge; no invariant removes LVR, and "minimizing" it just means posting less liquidity — the real goal is *uniform* LVR, a constant fraction of pool value). CPMM is bad near the edges not because volatility is higher there but because **pool value dies faster than the LVR does**, so the loss-to-value ratio blows up. pm-AMM fixes the *shape*. **The catch:** that uniform-LVR optimality is **derived from Gaussian score dynamics** — in the paper it fits basketball, where the probability diffuses. **Football does not diffuse: it's a jump process** — probability sits ~flat for 85 minutes, then a goal is a ~30-point jump. So for a **World Cup** market pm-AMM's optimality **does not formally hold**, and nobody has publicly derived a uniform AMM for jump dynamics. Reframe the claim accordingly: pm-AMM is **not "theoretically optimal for us" but "a better-shaped prior for any bounded `[0,1]` asset — it concentrates liquidity near 0.5 and unloads the edges — with an explicit jump-dynamics caveat."** The honest, *stronger* README deliverable is therefore an **LVR simulation (FPMM vs static pm-AMM) on real TxLINE odds trajectories** — a Python evening, no on-chain code — that says *"we know our markets have jump dynamics; here's the measured reason we chose X."* Even this benchmark alone is a strong submission differentiator.

**Skip *dynamic* pm-AMM — technically *and* economically.** The `√(T−t)` liquidity decay is clock-dependent per-swap state = a bug surface (technical). Worse, it's **backwards for live sports**: dynamic pm-AMM deliberately surrenders ~half the LP capital by expiry and is **near-empty exactly at resolution** — but in live sports ~80% of volume is the final minutes, so it drains liquidity from the very flow the whole system was built to serve. Economically counterproductive here. pm-AMM math's lasting role in this design is the **derivation of the funding formula** — the `p(1−p)` shape and its time decay — not the pool.

**Actuarial honesty for the demo/README:** frame `LeveragePool` LPs as **option sellers** — steady fee income, rare large drawdowns — and show a **break-even fee-multiplier simulation on historical TxLINE odds.** That reads far stronger to judges than "100× with no risk." Be equally honest about *what* kills the vault: it is short gamma, and **jumps — not theta drift — dominate its losses**, so the theta multiplier must be sized off **realized TxLINE odds volatility** (that same simulation), not a hand-set constant.

**3-way markets are a real design question (football has draws).** A **binary** FPMM with complete sets gives coherent probabilities (`YES + NO = 1`) for free — mint/redeem enforces it. A **3-way win / draw / lose** football market does not: run three independent FPMM pools and their implied probabilities won't sum to 1, so an **LMSR / pm-AMM with joint multi-outcome normalization** genuinely beats independent pools here. This is a **scope consideration, not a v0 requirement** — v0 stays binary — but it's the honest reason multi-outcome coherence is where a shared-invariant curve earns its keep.

**Prior-art framing for the submission/README:** the general pattern is *any bounded-loss mechanism becomes a DeFi primitive via* **math loss bound → Vault underwrites → fee compensates → coverage ratio governs.** Cite **Delphi/Gensyn as prior art for the spot / market-maker layer** and **Forecast for the leverage layer** — positions this work as composing two known designs onto a known-jump-dynamics sports market, not claiming a novel invariant.

---

## 11. Open items to confirm with TxLINE docs (verify before coding `resolve`)

> **RESOLVED (v0 shipped).** All four confirmed live; `resolve` is implemented and proof-valid on devnet. (1) `validate_stat` interface verified via `declare_program!(txline)` — the Merkle-proof `bool` return is read through `get_return_data`; only account touched is the `daily_scores_merkle_roots` PDA (seeds `["daily_scores_roots", epoch_day u16 LE]`, `epoch_day = ts_ms / 86_400_000`). (2) It is a **CPI return**, not a sysvar/account read — so `resolve` has zero token exposure. (3) TxL is Token-2022, but our escrow is classic-SPL USDT, so no transfer-fee/hook exposure on the vault. (4) Devnet soccer feed works (full-circle on fixture 18179549). Items kept below for historical context.

1. Exact TxLINE program id + `validate_stat` instruction interface (accounts, proof format — Merkle path encoding).
2. Whether the signed result is a sysvar/account read or a CPI return — drives `resolve` account layout.
3. TxL Token-2022 extensions in play (transfer fee / hooks?) for any account we touch — affects §4.5.
4. Devnet availability of the specific World Cup match feed for the Historical Replay + fee calibration.

> **Solana MCP status:** `solana-mcp-server` is connected. Dynamic-fee conventions (§4.4) and the config/PDA + lifecycle patterns (§4.1) were **verified against it** (Raydium CLMM `pool_fee.rs`, Orca Whirlpools adaptive fee, Meteora DAMM-v2, Anchor PDA docs). The Anchor 1.0 breaking changes in §4.6 also came from the MCP. Before writing program Rust, run each file through the MCP **`program_autofixer`** and confirm the TxLINE CPI interface via **`Solana_Expert__Ask_For_Help`**.

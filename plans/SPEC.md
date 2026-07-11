# SPEC.md — Design decisions + forward (unbuilt) spec

**Purpose:** the durable "why it's built this way" record (resolved decisions) plus the concrete on-chain spec for what is **not yet coded** (v1 leverage §2, v2 pm-AMM curve §3, 3-way 1X2 LMSR market §3.1), and the technical-debt worth tracking. This consolidates the former `anchor-programs-plan.md` / `backend-plan.md` / `frontend-plan.md` / `monorepo-setup.md`.

- **Shipped state (source of truth): `CLAUDE.md`** at repo root — current program/keeper/indexer/web as-built, commands, architecture seams, live gotchas. Do not duplicate it here.
- **Master vision + roadmap: `PLAN.md`** — §9 phases, §10 v0/v1/v2 economics, §12 known bugs. Economic framing of leverage/pm-AMM lives there; SPEC.md holds the on-chain **mechanics** PLAN.md doesn't.
- SPEC.md is forward-looking + decisions only. As-built per-layer detail is intentionally dropped (it's in CLAUDE.md and the code).

---

## 1. Resolved decisions (the "why")

All shipped in v0 unless marked STAGED. One line each; deliberation dropped.

- **D-1 — keeper gate.** Explicit `keeper: Pubkey` on `GlobalConfig`; `activate_market`/`freeze_market`/`resolve` gated via `address = global.keeper` on a `keeper: Signer` (belt-and-suspenders with clock gates). Closes a griefing vector cheaply.
- **D-2 — virtual reserves.** `yes_reserve`/`no_reserve` set **odds only** via `x·y=k`; the vault holds all USDC. Hard solvency invariant re-checked after every buy/sell/redeem: **`vault_usdc >= max(yes_supply, no_supply)`** so every winning token redeems for exactly 1 USDC (`math::assert_solvent`).
- **D-3 — no `init_if_needed`.** Explicit `open_position` ix does the one-time `Position` PDA init; `buy`/`sell` take an already-created `mut` Position. The `init-if-needed` feature is not enabled (reinit→balance-overwrite hazard).
- **D-4 — `Outcome::Void` refunds pro-rata.** On Void, `redeem` refunds the trader's net USDC basis (`position.collateral` = Σ buy inputs − sell proceeds); win/lose distinction is void.
- **D-5 — Anchor 1.0.x stable (LOCKED).** Classic Borsh account model, **not** the v2/`anchor-next` alpha (unaudited, zero-copy — inappropriate for escrow holding real funds on a deadline). Toolchain: Rust 1.89+, Solana CLI 3.1.10+, Anchor CLI 1.0.x, Surfpool 1.1.2+. The 1.0 conventions (Pubkey-first CPI, single `#[error_code]`, `address =` over `has_one`, `UncheckedAccount` not `AccountInfo`, `8 + INIT_SPACE`, dup-mutable rejected by default) are baked into the shipped program — see CLAUDE.md.
- **D-6 — collateral = TxLINE devnet USDT.** Mint `ELWTKspHKCnCfCiCiqYw1EDH77k8VCP74dK9qytG2Ujh`, verified on-chain as **classic SPL Token** (owner Tokenkeg…), 6 decimals, `freezeAuthority=null`. Uses `anchor_spl::token_interface` + `transfer_checked`; no Token-2022 extension handling needed, but keep balance-delta accounting on deposits/payouts as cheap insurance. (Type-level Token-2022 compatibility is free via `InterfaceAccount`; actually accepting Token-2022 *collateral* would need the extension guards in §4 "deferred".)
- **D-7 — `fixture_id: i64`.** TxLINE fixture ids are `i64` (e.g. `17588316`). `Market.fixture_id: i64`, `MARKET_SEED = b"market" + fixture_id LE` — clean 1:1 to TxLINE.
- **D-8 — resolution predicate stored on-chain.** `MarketConfig` carries `resolution_threshold: i32`, `resolution_comparison: u8` (TxLINE `Comparison`), `stat_key_a: u32`, `stat_key_b: u32` (0 = unused), `stat_op: u8` (TxLINE `BinaryExpression`; 0 = none), carved from `_reserved`. `resolve` proves a **pre-committed** question the keeper can't alter; `outcome` is derived from what the proof proves, never a keeper arg.
- **D-9 — leverage-as-option + pm-AMM stretch (STAGED, direction LOCKED).** v1 = no-liquidation "pay-for-time" leverage modeled as a binary option; v2 = swappable `PricingCurve` trait with a static pm-AMM 2nd impl. Full on-chain mechanics in §2/§3; economics in `PLAN §10`.

**Resolved open questions (O-items), compressed:**

- **O-1/O-2 — TxLINE resolve model.** `validate_stat` is a **read-only CPI returning `bool`** (read via `Return<bool>::get()` / `get_return_data`), NOT `Ok/Err` and NOT a written result account. `resolve` CPIs it and unlocks only on `true`. Interface facts in §5.
- **O-3 — `resolve` has zero token exposure.** It touches only the read-only `daily_scores_merkle_roots` PDA — the collateral token-program choice is fully decoupled from verification.
- **O-4 — devnet feed.** Free/devnet tier = **Service Level 1 = 60s delayed** (SL12 realtime is mainnet-only). That 60s delay is exactly the adverse-selection window the dynamic volatility fee defends. Historical replay via `/api/scores/historical/{fixtureId}` (within 2wk 6h) feeds fee calibration.
- **O5/O6 — monorepo runtime split & Anchor version.** Anchor 1.0.x locked (Codama built-in codegen, TS base `@anchor-lang/core`). Keeper = native Node TS-strip (no decorators); indexer = `nest start --watch -b swc` (needs decorator metadata). This per-app-runner split is shipped and documented in CLAUDE.md.
- **kitguard** was never a real package — shipped as the swappable `TxSender` interface (`KitTxSender`: simulate-before-send + RPC failover + rebroadcast + dynamic priority fee).

---

## 2. v1 leverage — on-chain mechanics (UNBUILT)

**Not on the v0 path.** v0 ships pure FPMM with `Position.leverage = 1` and every leverage field zero. Reserved fields are pre-carved so v1 needs **no account migration**. Economic framing: `PLAN §10`; below is the concrete on-chain design.

**The reframe (options, not perps).** No-liquidation pay-for-time leverage **is a binary option**: the trader pays a continuous **time-fee = theta** (option decay) and can never be liquidated on price; **max loss = collateral**. The `LeveragePool` PDA is the protocol-owned **options writer**. This eliminates the entire perps liquidation stack (no liquidation ix, no TWAP oracle, no cascades).

### 2.1 Reserved fields (pre-carved, no migration)

- **`MarketConfig._reserved` [u8;64]** holds (30 bytes, 34 left): `max_open_interest: u64`, `time_fee_num: u32` (per-epoch theta slope), `funding_epoch_secs: u32`, `max_mark_age_secs: u32`, `leverage_cutoff_secs: i64`, `max_leverage: u16`. Plus `min_coverage_bps: u16` (or on `LeveragePool`).
- **`Position._reserved`** (16 bytes) holds `last_funding_epoch: u64` (index of last funding epoch settled; set to current epoch at open) and `funding_accrued: u64` (cumulative per-epoch funding; position expires when it reaches `collateral`). Reuses `collateral`/`leverage`/`notional` (already fields). v0 leaves all zero. *(These re-document the old `entry_slot`/`fee_rate_snapshot` reservation — same 16 bytes.)*
- **New `LeveragePool` PDA** (seeds `[b"lev_pool", market.key()]`) — new account, so its fields don't migrate existing accounts. Holds writer USDC + tracks `open_interest`, `total_max_payout`, `pending_withdraw`, `mark_price_bps`/`mark_ts`, risk-valve state.

### 2.2 Funding = per-epoch ROLLING (NOT snapshot-at-open)

**Critical correction (Messari/Forecast):** a fee priced over the position's *whole life* at open exactly offsets the levered upside when a market can jump straight to 0 → leverage confers no benefit. The fix, re-quoted each epoch like perps funding:

- Funding accrues in **epochs** of `funding_epoch_secs`; epoch index = `unix_timestamp / funding_epoch_secs` (the only clock read).
- **Each epoch's rate** = theta evaluated at that epoch's **mark price** (TxLINE StablePrice, §2.4) — NOT the open price.
- **Lazy accrual:** on any interaction, walk the epochs elapsed since `Position.last_funding_epoch`, sum each epoch's funding into `funding_accrued`, advance `last_funding_epoch`. (Exact per-epoch walk is O(epochs) but exact; a closed-form approximation is O(1) but inexact — pick one, keep the math a pure fn.)

**Per-epoch theta — pure `fee.rs` fn** `compute_epoch_funding_bps(...)` (no `Clock`/`AccountInfo`; checked, ceil-div so never rounds to 0 near resolution):
```
// FPMM-cheap form: fee_rate ∝ p(1−p)/(T−t); max near p≈0.5, spikes as t→T.
//   p_bps = the epoch's MARK price; t_remaining = T−t (secs/slots), guard != 0.
numer = (p_bps as u128) * ((BPS_DENOM - p_bps) as u128) * (time_fee_num as u128)
denom = (BPS_DENOM as u128) * (BPS_DENOM as u128) * (t_remaining as u128)
fee_rate_bps = ((numer + denom - 1) / denom) as u64   // ceil-div
```
"Correct" form (only if pm-AMM/erf lands, §3): `fee_rate ∝ φ(Φ⁻¹(p))/√(T−t)` — Gaussian theta; property-test the two against each other.

### 2.3 Solvency: coverage ratio (Delphi/Gensyn — primary guard)

Frame: bounded-loss vault (each position's `max_payout` is finite) → underwritten by the pool → compensated by theta → **governed by a coverage ratio**. On-chain = one PDA field + one guard, generalizing `max_open_interest`:

- Track **`total_max_payout: u64`** on `LeveragePool` — running Σ of `max_payout` of all open positions (bump on open, decrement on close/expire). Exact liability the pool must honor.
- `coverage = pool_balance / total_max_payout`; compute as the checked cross-multiply (no division, pool-favorable rounding). `min_coverage_bps` = configured threshold.
- **Guard in `open_leverage`:** reject if opening would drop coverage below threshold — `pool_balance * COVERAGE_DENOM >= min_coverage_bps * (total_max_payout + new_max_payout)`. `max_open_interest` bounds *notional* (sizing); coverage bounds *pool solvency vs worst-case payout* (stricter, primary). Both in the same guard block; keep `coverage_ok(...)` a pure checked fn.

### 2.4 Mark price = TxLINE StablePrice (never our own spot)

Funding/PnL/exposure mark to the **TxLINE StablePrice mark**, never our thin FPMM spot (spot is manipulable → nudge pool → distort funding). Keeper posts `mark_price_bps` + `mark_ts` on `LeveragePool` — **keeper-signed in v1** (keeper already gated, D-1), **proof-verified via CPI `validate_odds` in v2** (mirrors the §5 `validate_stat` resolve pattern). **Staleness guard:** `require!(now - mark_ts <= max_mark_age_secs)` — reject funding updates and new opens against a stale mark.

### 2.5 Expiry = deterministic (NO price-based liquidation)

Position dies the instant `funding_accrued == collateral` — a pure function of elapsed epochs + posted mark history, no price trigger.
- **Lazy settlement (preferred):** on interaction, sum elapsed-epoch funding; if `funding_accrued >= collateral`, settle expired (writer keeps collateral, trader keeps any in-the-money residual).
- **Permissionless crank:** optional `expire_position` ix anyone can call once `funding_accrued >= collateral` to reclaim rent / free open-interest.
- Replaces liquidation entirely — the whole point of the options reframe.

### 2.6 Adverse-selection guards (the 60s-delay attack window, O-4)

- **Fee spike near T** — `p(1−p)/(T−t)` already blows up as `t→T`, pricing out late openers.
- **Cutoff window** — reject new opens within `leverage_cutoff_secs` before expected resolution: `require!(now < resolution_estimate - leverage_cutoff_secs)`.
- **Size cap** — cap `new_notional` vs free (uncommitted) pool USDC and `max_open_interest`.
- **SSE risk valve (jump events)** — around goals/red-cards (keeper detects from the scores SSE) a naive short-gamma vault gets picked off. Keeper-gated `set_risk_valve(paused: bool, funding_multiplier_bps: u16, until_ts: i64)` field-set on `LeveragePool`: while active, reject new opens and/or widen funding by `funding_multiplier_bps`. Bound both knobs on-chain (`require!` multiplier ≤ hard cap, `until_ts - now` ≤ max duration) so the keeper can dampen, not rug. Size `time_fee_num` off **realized** TxLINE odds volatility (offline `fee.rs` sim), not a static constant.
- **Leverage cap as fn of p** — `max_leverage_for_p(p_bps, max_leverage)`: FPMM heuristic = full `max_leverage` in `p∈[0.2,0.8]`, linear taper → 1x toward edges. pm-AMM form `∝ 1/φ(Φ⁻¹(p))` once erf lands.

### 2.7 LP lock/withdraw windows (anti-runbank on a KNOWN resolution)

Writer capital is LP-funded; a sports resolution is a scheduled public event, so an LP could yank capital minutes before and dump the shortfall on remaining LPs. Defend with **two-step delayed withdrawal**:
- `request_withdraw` records the request; `withdraw` becomes claimable only after a delay — to the next settlement or gated by a lock window before `freeze_ts` (reuse `leverage_cutoff_secs` or a dedicated `lp_lock_secs`). `require!(now >= request.unlock_ts)` in `withdraw`; reject `request_withdraw` inside the lock window if policy is "no new requests near resolution."
- `LeveragePool.pending_withdraw: u64` (aggregate earmarked USDC, subtracted from *free* liquidity so it can't double-serve as coverage/OI headroom); per-LP `unlock_ts: i64` + amount on a `WithdrawRequest` PDA (`[b"lp_withdraw", lev_pool.key(), lp.key()]`). Free liquidity = `pool_balance - pending_withdraw`.

### 2.8 v1 instruction set (sketch)

`init_leverage_pool` (per market; funds writer, sets `min_coverage_bps`) · `open_leverage` (set `collateral`/`leverage`/`notional`, `last_funding_epoch`=current, `funding_accrued`=0; apply coverage + `max_open_interest` + mark-staleness + risk-valve + cutoff guards; bump `open_interest`/`total_max_payout`) · `close_leverage`/`expire_position` (settle elapsed funding lazily or via crank; decrement `total_max_payout`) · keeper pair `post_mark` / `set_risk_valve` · LP pair `request_withdraw` / `withdraw`. All reuse the shipped vault + Anchor-1.0 CPI conventions (Pubkey-first, PDA-signed `transfer_checked`, checked math).

### 2.9 v1 LiteSVM tests to add

(a) multi-epoch accrual with a **changing rate** (warp epochs, post different mark each, verify `funding_accrued` = Σ per-epoch rates); (b) `p(1−p)/(T−t)` peaks at p≈0.5, spikes as t→T; (b2) full-life vs epoch pricing economic sanity — epoch pricing leaves positive edge for a correct call, full-life doesn't (the Messari correction); (c) deterministic expiry at `funding_accrued==collateral` (lazy + crank); (d) OI cap + cutoff-window rejections; (d2) risk valve (opens rejected while active, funding ×multiplier, out-of-bounds knobs rejected); (d3) mark staleness rejection; (e) `max_leverage_for_p` taper; (f) coverage-ratio rejection + `total_max_payout` decrement on close/expire; (g) withdraw-window enforcement + `pending_withdraw` removes earmarked USDC from free liquidity.

---

## 3. v2 — pm-AMM curve (design-locked forward)

Isolate the pricing curve behind a small trait in `math.rs` so it swaps without touching handlers or resolution/redemption:
```rust
pub trait PricingCurve {
    fn compute_out(reserve_in: u64, reserve_out: u64, amount_in_net: u64) -> Result<u64, AmmError>;
    fn price_yes_bps(yes_reserve: u64, no_reserve: u64) -> Result<u16, AmmError>;
}
```
- **v0 impl = FPMM** (constant product) — shipped. `compute_out = y − k/(x + Δin_net)`.
- **v2 impl = static pm-AMM** (Paradigm 2024): invariant `price = Φ((y − x)/L)`, `L` constant (static variant). Same two reserves + a liquidity param `L`, no new account shape. Needs: **`erf` in fixed-point** via Abramowitz–Stegun in Q64.64 (`Φ(z)=½(1+erf(z/√2))`), pure + property-testable; a **Newton solve** to invert `Φ` per swap. **Oracle-free** — the score is *implied* by marginal price + time-to-maturity, not read from a feed; only `Φ` is needed on-chain (`Φ⁻¹` is NOT — Newton-solve the invariant). "One evening math module + property tests."
- **Skip dynamic pm-AMM** — two reasons: on-chain, its `L ∝ √(T−t)` per-swap clock state is a rounding/monotonicity hazard; economically it surrenders ~half LP capital by expiry and is near-empty exactly at resolution, but ~80% of live-sports volume is the final minutes → counterproductive.
- **Football caveat (verified):** pm-AMM's uniform-LVR optimality assumes **Gaussian** score dynamics (basketball fits). Football win-prob is a **jump process** (flat, then a discrete goal-jump), so pm-AMM here is "a better-shaped bounded-[0,1] prior with a jump caveat, NOT theoretically optimal." Frame as shape improvement, not optimality.
- **Delivery even without shipping on-chain:** a README LVR benchmark (FPMM vs static pm-AMM, replayed on real TxLINE odds, O-4) via the offline `fee.rs`/`math.rs` harness. The v1 Gaussian theta (`φ(Φ⁻¹(p))/√(T−t)`) reuses the same erf/Φ code — the two stretch tracks share one math module. pm-AMM's role in v1 is deriving the funding formula, NOT the pool curve (curve swap is strictly v2).
- **3-way (win/draw/lose)** — v0 (and v1 leverage) are **binary FPMM** on a home-win predicate; a proper football **1X2** market (Team1 / Draw / Team2) needs multi-outcome normalization so `P1+PX+P2=1`. Full LMSR spec in **§3.1** below. A jump-arbitrage auction around goals (Messari) is a v2/pitch item.

### 3.1 — 3-way (1X2) LMSR market (v1 — math + resolve protocol BUILT, wiring UNBUILT)

> **Status (2026-07-11):** phase A (`programs/amm/src/lmsr.rs`, pure fixed-point LMSR + 21 tests) and phase B (`instructions/resolve/predicate_1x2.rs` + `plans/resolve-1x2.md`, the 1-of-3 protocol + 8 tests) are **merged**. The EqualTo wall is dissolved (positive-proof protocol). Remaining: phase C — `Market`/`Position`/`Outcome` reshape, `buy`/`sell`/`resolve_1x2` instructions, codegen + full-stack.

**Why this exists.** The shipped market is **binary**: one predicate (`(P1_goals − P2_goals) > 0` = Team1 win, D-8), two tokens. `NO` = "Team1 does NOT win" = **{draw ∪ Team2 win}** — a single token covering two football results. So YES/NO cannot be relabeled to "Team1 / Team2" without lying on draws (~25% of matches): a draw settles `NO`, but a "Team2" label implies Team2 won. A truthful Team1 / Draw / Team2 market needs **three outcomes**, which a 2-reserve CPMM cannot express. This is a program-level feature, not a UI relabel.

**Model — 3 tokens, exactly one pays.** Outcomes `{Team1, Draw, Team2}` (+ `Void`); at resolution exactly one is true and its token redeems for 1 USDT, the others 0. Coherence is structural: a **complete set** `{1×P1, 1×PX, 1×P2}` always redeems for exactly 1 USDT (one guaranteed winner), which forces `price(P1)+price(PX)+price(P2)=1`. Binary FPMM gets this free (YES+NO=1 via `x·y=k`); N>2 needs a curve that preserves the sum.

**Curve = LMSR (primary).** Hanson's Logarithmic Market Scoring Rule — the natural multi-outcome maker:
```
cost:   C(q) = b · ln( Σ_i exp(q_i / b) )          // q_i = net tokens of outcome i minted; b = liquidity depth
price:  price_i = exp(q_i/b) / Σ_j exp(q_j/b)      // softmax → in (0,1), Σ price_i = 1 BY CONSTRUCTION
trade:  cost_to_buy(Δ on outcome i) = C(q + Δ·e_i) − C(q)
loss:   bounded = b · ln(3)                        // max subsidy the LP/vault can lose
```
Softmax normalization gives `Σ price = 1` for free — no separate invariant to enforce. On-chain cost = fixed-point `exp`/`ln` (Q64.64, pure + property-tested) — the one genuinely new math burden.

**As built (`lmsr.rs`, merged):** Q64.64 in u128; `exp(−x)` = ln2 range-reduction + sign-free paired Taylor series; `ln` = power-of-2 normalization + atanh series; 256-bit intermediates (limb split, nothing wraps silently); softmax max-subtraction (all exp args ≤ 0, ln arg ∈ [1,3]). Measured error ~1e-16 vs f64 reference. Supported ranges: `b ∈ [10³, 2^60]`, `q_i ≤ 2^60` (new appended `Lmsr*` error variants; existing codes unshifted). Rounding pool-favorable: buy = ceil (min 1 — never free), sell = floor, prices floor with `Σ prices_bps ∈ [9_997, 10_000]`. Structural guarantee: `cost(q) ≥ max(q)` holds EXACTLY in fixed point, so the `b·ln(3)` bounded loss survives truncation. Underflow semantics: an outcome ≳ 44.4·b below the max prices at 0 bps with zero marginal cost — `buy_cost`'s min-1 floor keeps buys non-free.

**pm-AMM (multi-dim) considered, not chosen.** The multi-outcome pm-AMM is the alternative, but its uniform-LVR optimality assumes **Gaussian** dynamics; football is a **jump process** (§3 caveat), so pm-AMM's advantage doesn't formally hold here while it costs more implementation. **LMSR is the pick for 3-way football**; pm-AMM stays the binary-curve v2 experiment (§3).

**Rejected surrogate — three independent binary markets.** Spinning up "Team1 win?", "Draw?", "Team2 win?" as three separate binary CPMMs reuses all shipped code and gives the 1X2 *look* cheaply, BUT (a) three independent pools' prices **don't sum to 1** (incoherent probabilities, cross-market arb — exactly what a shared-invariant curve fixes), and (b) the "Draw?" market's `resolve` hits the **EqualTo wall** below. It's a stopgap, not the real thing.

**On-chain rework (this is the "big" part):**

| Layer | Binary (shipped) | 1X2 LMSR |
|---|---|---|
| `state.rs` `Market` | `yes_reserve`, `no_reserve` | LMSR state: `q: [u64;3]` (u64 LOCKED — sells bounded by outstanding supply, q never negative) + `b: u64` |
| `state.rs` `Position` | `yes_tokens`, `no_tokens` | `tokens: [u64;3]` (Team1/Draw/Team2) |
| `Outcome` enum | `{Yes, No, Void}` | `{Team1, Draw, Team2, Void}` (2-bit) |
| `buy`/`sell` | `side: Side` | `outcome: u8 ∈ {0,1,2}`, price via LMSR cost delta |
| new math | `math.rs` CPMM | **new `lmsr.rs`** — pure `exp`/`ln`/cost/price, exhaustive tests |
| solvency (D-2 generalized) | `vault ≥ max(yes_supply, no_supply)` | `vault ≥ max(supply_Team1, supply_Draw, supply_Team2)` — re-checked after every mutate |
| complete set | implicit | optional `mint_set` (deposit 1 USDT → 1 of each) / `redeem_set` (burn 1 of each → 1 USDT) to pin the ≤$1 arb band |
| dynamic fee | `fee.rs` on YES price move | reuse; volatility measured on the traded outcome's price move |

**`resolve` — SOLVED (phase B, `plans/resolve-1x2.md`).** Protocol: **hint-and-prove-positively.** The keeper hints `outcome ∈ {Team1, Draw, Team2}`; the program derives that outcome's predicate on-chain from the stored D-8 config (comparator `GreaterThan`/`EqualTo`/`LessThan` per hint, on the same `stat_a − stat_b` Subtract, threshold pass-through) and makes exactly ONE `validate_stat` CPI which must return `true`; `market.outcome = hint` only after the proof verifies. **The EqualTo wall dissolves**: Draw is proven POSITIVELY via `EqualTo` (a first-class TxLINE comparator) — negation never runs, `PredicateNotNegatable` unreachable on this path. Soundness = integer trichotomy (exactly one of `{d>t, d==t, d<t}`), unit-proven exhaustively (`predicate_1x2.rs`, mutual exclusivity + exhaustiveness + truthfulness). Wrong hint → CPI `false` → `ProofRejected`, no state change (liveness only). D-8 fields suffice; `resolution_comparison` is IGNORED on this path (derived per-hint, never stored). One `MarketConfig` addition: **`market_kind: u8`** carved from `_reserved` (zero-default = Binary, no migration) gating binary `resolve` vs `resolve_1x2` apart; 1X2 configs require `stat_key_b != 0`, distinct keys, `stat_op = Subtract` (`validate_1x2_config`). Decisions on the doc's open questions: pin `stat_to_prove.period` on-chain (stale-batch replay guard, applies to binary too) — YES, in phase C; separate `resolve_1x2` instruction (keeps v0 binary IDL byte-stable) — YES; handicap 1X2 (`t ≠ 0`) — KEEP (free by construction; UI simply doesn't offer it for the WC demo).

**Full-stack ripple:** IDL change → `pnpm codegen` → `libs/idl` regen → keeper (resolve picks 1-of-3, hint), indexer (3 prices, 3-outcome events, DTOs), web (3-chip Team1/Draw/Team2 trade panel — all buyable; card shows 3 real on-chain prices, not the current cosmetic 0.42-split Draw). `libs/shared` DTOs gain a 3-price shape + 3-balance position. Seeder creates **one** 3-way market per fixture (not three binaries).

**Decision (LOCKED direction, UNBUILT):** true 1X2 = **single LMSR multi-outcome market**, chosen over (a) three independent binaries (incoherent prices + Draw-resolve wall) and (b) multi-outcome pm-AMM (Gaussian assumption fails on football jumps). Effort ≈ new `lmsr.rs` + `Market`/`Position`/`Outcome` reshape + `buy`/`sell`/`resolve` rework + codegen + full-stack adaptation. Not on the v0/demo path — demo uses **honest binary labels** ("{Team1} win" / "draw or {Team2}", PLAN §12 BUG-4).

**v1 LiteSVM tests to add:** (a) `Σ price_i == 1` invariant holds after arbitrary buy/sell sequences (within rounding); (b) LMSR cost monotone + bounded loss `≤ b·ln(3)`; (c) `exp`/`ln` fixed-point vs a reference (property test, error bound); (d) solvency `vault ≥ max(supply_i)` after every mutate; (e) `mint_set`/`redeem_set` round-trip = 1 USDT; (f) resolve to each of the three outcomes (positive-proof path) + Void refund; (g) the Draw-resolve path specifically (the EqualTo fix).

### 3.2 — Leverage over 3-way LMSR (composition, UNBUILT)

**The leverage layer (§2) composes ON TOP of the 3-way LMSR market cleanly — because it is orthogonal to the spot curve.** PLAN §10's frame: three *separate* decisions — **mark price**, **spot liquidity**, **leverage instrument**. Leverage marks to the **external TxLINE index, never the spot curve**, so swapping spot (binary FPMM → 3-way LMSR) leaves the leverage design essentially unchanged. Build order is free: LMSR-3-way then leverage, or binary+leverage (§2 as written) then generalize spot.

**What generalizes for free:**
- **Each outcome is itself a binary option.** From one outcome's view it's binary (`i` vs `not-i`, probability `p_i`); a leveraged long on outcome `i` = binary option, max loss = `collateral`, upside `[0,1]`. Same structure as §2.
- **Per-outcome theta:** `fee_rate ∝ p_i·(1−p_i)/(T−t)`, evaluated at that outcome's mark `p_i` (§2.2 unchanged, just indexed by outcome). The three `p_i(1−p_i)` are independent and their sum ≠ 1 — fine, theta is per-position/per-outcome.
- **Mark = TxLINE 1X2 odds per outcome** (home/draw/away) — more natural than the binary case; `validate_odds` CPI per outcome in v2 (§2.4).
- **Coverage (§2.3) generalizes and improves:** exactly one outcome wins, so realized payout is only the winning outcome's leveraged positions → guard `vault ≥ max_i(leveraged_payout_i)` (same shape as §3.1 LMSR spot solvency).
- **Deterministic expiry (§2.5), LP windows (§2.7) unchanged. Risk valve (§2.6) matters MORE** — a goal swings 1X2 hard (kills the draw especially), exactly when a leveraged pre-goal position is picked off.

**New work (honest cost):** `Position` carries a levered `outcome_idx ∈ {0,1,2}` + the §2 leverage fields; `resolve` pays leveraged positions on the winning outcome and expires the rest (composes with §3.1 resolve); `max_leverage_for_p(p_i)` per outcome (draw `p≈0.25` → mid-taper).

**Compute:** LMSR `exp`/`ln` (spot buy/sell ix) and the funding-epoch walk (open/close/crank leverage ix) live in **different instructions** — they never stack within one CU budget. Keep funding a **separate crank** (not bundled into a trade), per the Drift pattern below.

**Precedent (Solana MCP, 2026-07):** no public program combines LMSR/multi-outcome AMM with a leverage/options vault — this composition is novel (the thesis). The closest architecture precedent is **Drift Protocol** (perps): validates the pattern of **funding as a separate crank** (`update_funding_rate`), **oracle-marked positions** (`OracleSource`, not marked to own AMM), **fixed-point money math** (`PRICE_PRECISION`/`FUNDING_RATE_BUFFER`/`MARGIN_PRECISION`, no float), and a **multi-position account** (`MAX_PERP_POSITIONS`) — all directly applicable here.

**Decision (LOCKED direction, UNBUILT):** leverage-as-option is a **spot-curve-agnostic layer** marking to the TxLINE oracle; it drops onto binary FPMM (§2) or 3-way LMSR (§3.1) with only per-outcome indexing changes. Not on the v0 path.

---

## 4. Deferred / incomplete items (track these)

Known v0 bugs are in **PLAN.md §12** (BUG-1…BUG-5) — not duplicated here; fix before demo. Beyond those:

- **Indexer vs real devnet events** — Phase 4 was verified against the shipped program's live devnet history (see CLAUDE.md / former backend-plan §7 I1–I6, all done). Remaining: the optional websocket `logsSubscribe` fast-path (currently poll-only `tailOnce` every `INDEXER_POLL_MS`) is left unimplemented; the poll path is authoritative and idempotent.
- **Odds-movement chart overlay (deferred)** — a StablePrice odds curve overlaid on the market's hero price chart. Deferred because the devnet World Cup odds feed returns `[]` (club-league guest odds work; WC fixtures don't), so it would be dead code until mainnet WC or a club-league market. The `marketOdds` DTO field + market-vs-pool spread already exist but are inert on devnet WC.
- **Historical Replay demo affordance (frontend F11)** — `useDemoReplay` driving a scripted lifecycle (open→trades→lock→proof→resolve→payout) against a keeper-driven devnet replay dataset. Pending the stable replay dataset; needed for the recorded demo since real matches finish after the deadline.
- **Fee calibration harness** — offline replay via the pure `fee.rs` fns to hand-tune `create_market_config` defaults against the 60s-delay window (data via `/api/scores/historical/{fixtureId}`). Also the v1 theta/funding sizing input (realized TxLINE odds volatility).
- **Proof-VALID resolve not yet proven live** — Surfpool proved the full CPI/Merkle path against the real forked txoracle (discriminator, Borsh layout, PDA derivation all accepted; garbage proofs rejected with real `6004 InvalidMainTreeProof`), and a full devnet circle ran with the keeper (fixture 18179549, real Merkle proof). What remains untested in Surfpool specifically is a proof-VALID resolve there (needs real Merkle proofs from the keeper API) — covered on devnet, not in the integration suite.
- **Token-2022 collateral (not needed for D-6, but if ever accepted)** — vault must add: balance-delta accounting on every deposit/payout (TransferFee), extra-account resolution (TransferHook, `anchor_spl` does not auto-append), reject DefaultFrozen/CPIGuard mints at `init_market`, and `harvest_withheld_tokens_to_mint` before `close_account`. `resolve` stays token-free (O-3). Shipped USDT is classic SPL so none of this is active.
- **Deployment (keeper/indexer → Railway, web → Vercel)** — `turbo prune --docker` slices, secret env vars, Postgres reference-var, a paid RPC endpoint in `RPC_URLS` for the recorded demo (public devnet is flaky under load). Migrations run on indexer deploy.

---

## 5. TxLINE integration reference (facts not in CLAUDE.md)

CLAUDE.md already has the live gotchas (ms timestamps, PascalCase SSE + `Stats` map, match-end = `StatusId 100`/`game_finalised`, `seq` required, undici no auto-gunzip, the devnet base URL). The stable on-chain interface facts:

**`validate_stat` (read-only, returns `bool`):**
```
validate_stat(ts: i64, fixture_summary: ScoresBatchSummary, fixture_proof: Vec<ProofNode>,
              main_tree_proof: Vec<ProofNode>, predicate: TraderPredicate,
              stat_a: StatTerm, stat_b: Option<StatTerm>, op: Option<BinaryExpression>) -> bool
```
Account: `daily_scores_merkle_roots` (read-only PDA, seeds `["daily_scores_roots", epoch_day: u16 LE]`, owned by the TxLINE program). `epoch_day = ts_ms / 86_400_000` (TxLINE `ts` is MILLISECONDS — one root per 5-min batch slot; the seconds convention was a bug, fixed). Our `resolve` guards `txline_program` via `address = global.txline_program` (arbitrary-CPI guard) + re-derives/owns-checks the roots PDA, then CPIs and reads `Return<bool>::get()` **before any other CPI** (return data is cleared per CPI).

**Addresses / mints:**
| | Devnet | Mainnet |
|---|---|---|
| TxLINE program | `6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J` | `9ExbZjAapQww1vfcisDmrngPinHTEfpjYRWMunJgcKaA` |
| TxL token (Token-2022) | `4Zao8ocPhmMgq7PdsYWyxvqySMGx7xb9cMftPMkEokRG` | `Zhw9TVKp68a1QrftncMSd6ELXKDtpVMNuMGr1jNwdeL` |
| USDT (our collateral, classic SPL) | `ELWTKspHKCnCfCiCiqYw1EDH77k8VCP74dK9qytG2Ujh` | `Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB` |

**Types (mirror in `programs/amm/idls/txline.json`):** `ProofNode { hash: [u8;32], is_right_sibling: bool }` · `ScoreStat { key: u32, value: i32, period: i32 }` · `StatTerm { stat_to_prove: ScoreStat, event_stat_root: [u8;32], stat_proof: Vec<ProofNode> }` · `ScoresBatchSummary { fixture_id: i64, update_stats: ScoresUpdateStats, events_sub_tree_root: [u8;32] }` · `TraderPredicate { threshold: i32, comparison: GreaterThan|LessThan|EqualTo }` · `BinaryExpression { Add, Subtract }`.

**Stat-key encoding:** `key = period*1000 + base`. Base: 1=P1 goals, 2=P2 goals, 3–6=yellow/red cards, 7–8=corners. Period multipliers: H1 +1000, H2 +2000, ET1 +3000, ET2 +4000, Pens +5000. Example "home win": `stat_a`=key 1, `stat_b`=key 2, `op=Subtract`, predicate `threshold 0, GreaterThan`.

**TxLINE errors of note:** `6007 RootNotAvailable` (oracle hasn't posted this epoch-day root yet → keeper **retries**, not permanent) · `6021 PredicateFailed` · `6023 InvalidStatProof` · `6004 InvalidMainTreeProof` · `6062 ProofTooLarge`. Our `resolve` maps rejections to a clean `AmmError::ProofRejected`; the keeper refetches/retries.

**Keeper off-chain endpoints:** proof `GET /api/scores/stat-validation?fixtureId=&seq=&statKey=&statKey2=` (flat camelCase JSON, `seq` required); SSE `GET /api/scores/stream` (auth = guest JWT from `POST /auth/guest/start` + `X-Api-Token` from `/api/token/activate`); historical `GET /api/scores/historical/{fixtureId}` (SSE-framed, within 2wk 6h); snapshots `/api/scores/snapshot/{id}` (score) and `/api/odds/snapshot/{id}` (StablePrice odds); `/api/fixtures/snapshot` (team names + competition). Devnet feed = Service Level 1 (60s delay).

**PDA seeds (contract boundary, mirrored in `libs/shared`):** `CONFIG=b"config"` · `MKT_CONFIG=b"mkt_config"+config_id:u16 LE` · `MARKET=b"market"+fixture_id:i64 LE` · `POSITION=b"position"+market:Pubkey+owner:Pubkey` · `VAULT=b"vault"+market:Pubkey`. v1 adds `LEV_POOL=b"lev_pool"+market` and `LP_WITHDRAW=b"lp_withdraw"+lev_pool+lp`.

# leverage-v1.md — no-liquidation leverage layer over the LMSR 1X2 market

**Status: BUILT (2026-07-19).** On-chain (10 instructions, 115 workspace tests green,
autofixer clean), keeper MarkPoster (`ENABLE_MARK_POSTER`, odds→spot fallback), web
LeveragePanel (pool-gated). Implements SPEC §2/§3.2 (leverage-as-option, Drift-crank +
JLP-counterparty patterns). Deviations from SPEC noted inline with **[DEV]**.
Calibration note from tests: `time_fee_num` is a SMALL integer slope (≈1–50 sane,
50_000 = steep demo theta; 1e6 fee-kills in seconds). Not yet done: devnet demo
config/pool seeding with real theta calibration, LP web UI, v2 `validate_odds` marks.

## 0. Model (one paragraph)

A leveraged position is a **cash-settled binary option** on one outcome, written by a
protocol-owned **LeveragePool** (LP-funded vault = options writer). It never touches
`lmsr.rs` or the spot escrow. The trader deposits collateral `C`, picks `leverage L`
and `outcome i`; exposure is `units U` marked to the **posted TxLINE mark price**
(never our own LMSR spot). No price liquidation: the trader pays **funding = theta**
accrued via a **cumulative funding index** (Drift pattern); the position dies only
when accrued funding reaches `C` (deterministic fee-death) or settles at close /
resolution. Max trader loss = `C`. Pool solvency is governed by a **coverage ratio**.

## 1. Economics (LOCKED formulas — all checked math, u128 intermediates)

Prices in bps (`BPS_DENOM = 10_000`), money in USDT 6dp (u64).

```
N  (notional)        = C * L                          // L: u16, whole multiples
U  (units)           = floor(N * BPS / p_entry_bps)   // $1-payout-equivalent units
pnl(p)               = floor_signed(U * (p - p_entry_bps) / BPS)      // i128 → i64
F  (funding accrued) = floor(N * (idx_now - idx_snap) / INDEX_SCALE)  // u128
equity(p, F)         = clamp(C + pnl(p) - F, 0, ..)   // unified settle payout
max_gain             = floor(U * (BPS - p_entry_bps) / BPS)  // pool liability bound
```

**Unified settlement** (used by `close_leverage` AND `expire_position`):
`payout = max(0, C + pnl(p) - F)` where `p` =
- market `Trading`/`Locked`: current posted mark for the position's outcome
  (Locked allowed — trader may exit while awaiting proof, at last mark);
- market `Resolved`, `outcome == position.outcome_idx`: `p = BPS`;
- market `Resolved`, other real outcome: `p = 0`;
- market `Resolved(Void)`: `payout = max(0, C - F)` (mirror of D-4 basis refund).

Funding stays in the pool vault (writer revenue). Payout is transferred from the
**lev vault** (PDA-signed `transfer_checked`); `C` entered the lev vault at open.

**Funding index** (per outcome, `[u128; 3]`, scale `INDEX_SCALE = 1_000_000_000_000`):
updated ONLY inside `post_mark`. For the elapsed segment use the **previous** stored
mark (that was the price in force), then store the new mark:

```
t_rem      = max(freeze_ts - now, MIN_T_REMAINING_SECS)          // no div-by-0/blowup
elapsed    = now - last_funding_ts                                // secs, require >= 0
rate_num   = time_fee_num * p_prev * (BPS - p_prev)               // u128
idx_delta  = ceil(rate_num * INDEX_SCALE * elapsed / (BPS*BPS * t_rem))
if valve active: idx_delta = ceil(idx_delta * valve_multiplier_bps / BPS)
cum_funding_index[i] += idx_delta                                  // per outcome i
```
This IS the SPEC §2.2 "per-epoch rolling funding": the keeper posts every
`funding_epoch_secs`, each post closes one epoch priced at that epoch's mark.
**[DEV]** index accrues per elapsed-seconds segment instead of a discrete epoch walk
— O(1), exact per segment, no per-position epoch loop.

**Leverage cap taper** (`max_leverage_for_p`, pure fn):
```
edge = min(p_bps, BPS - p_bps)
if edge >= 2_000 -> max_leverage
else             -> max(1, 1 + (max_leverage - 1) * edge / 2_000)   // linear to 1x
```

**Coverage guard** (checked at `open_leverage` AND `request_withdraw`):
```
vault_balance * BPS >= min_coverage_bps * (total_max_payout + new_max_payout)
```
(at request_withdraw: `(vault_balance - withdraw_value) * BPS >= min_coverage_bps * total_max_payout`).

## 2. Accounts **[DEV: new PDAs, NOT Position._reserved carve — existing devnet
Position/Market accounts stay byte-identical; no seed bump needed]**

New seeds in `constants.rs` (+ mirror in `libs/shared/src/constants.ts`):
```
LEV_POOL_SEED     = b"lev_pool"   // [b"lev_pool", market]
LEV_VAULT_SEED    = b"lev_vault"  // [b"lev_vault", market]  (token account, authority = pool PDA)
LEV_POSITION_SEED = b"lev_pos"    // [b"lev_pos",  market, owner]
LEV_LP_SEED       = b"lev_lp"     // [b"lev_lp",   market, owner]
```
New numeric constants:
```
INDEX_SCALE: u128            = 1_000_000_000_000
MIN_T_REMAINING_SECS: i64    = 60
VALVE_MAX_MULTIPLIER_BPS: u16 = 50_000   // ×5 funding, hard cap
VALVE_MAX_DURATION_SECS: i64 = 600
LP_WITHDRAW_DELAY_SECS: i64  = 3_600
```

```rust
#[account] pub struct LeveragePool {
    pub market: Pubkey,
    pub vault: Pubkey,                    // lev vault token account
    pub total_shares: u64,                // LP share supply (internal, no SPL mint)
    pub pending_withdraw_shares: u64,
    pub open_interest: u64,               // Σ notional of open positions
    pub total_max_payout: u64,            // Σ max_gain of open positions
    pub mark_bps: [u16; 3],               // last posted marks [Team1, Draw, Team2]
    pub mark_ts: i64,                     // 0 until first post_mark
    pub last_funding_ts: i64,
    pub cum_funding_index: [u128; 3],
    pub valve_paused_until: i64,          // opens rejected while now < this
    pub valve_multiplier_bps: u16,        // BPS_DENOM = neutral; active while valve window
    pub valve_until_ts: i64,              // multiplier applies while now < this
    pub bump: u8,
    pub vault_bump: u8,
    pub _reserved: [u8; 32],
}
#[account] pub struct LevPosition {
    pub market: Pubkey,
    pub owner: Pubkey,
    pub outcome_idx: u8,                  // 0..3
    pub leverage: u16,
    pub collateral: u64,                  // C
    pub notional: u64,                    // N = C*L
    pub units: u64,                       // U
    pub entry_mark_bps: u16,
    pub funding_index_snap: u128,
    pub open_ts: i64,
    pub settled: bool,
    pub bump: u8,
    pub _reserved: [u8; 16],
}
#[account] pub struct LpAccount {
    pub market: Pubkey,
    pub owner: Pubkey,
    pub shares: u64,
    pub pending_shares: u64,              // earmarked by request_withdraw
    pub unlock_ts: i64,                   // claimable after this
    pub bump: u8,
    pub _reserved: [u8; 16],
}
```
All three `#[derive(InitSpace)]`, `8 + INIT_SPACE`, Boxed in instruction structs.

**MarketConfig `_reserved: [u8; 40]` carve → typed fields (28 bytes used, keep
`_reserved: [u8; 12]`)** — zero-default = leverage DISABLED for existing configs
(no migration; Borsh size unchanged):
```
pub max_open_interest: u64,    // 0 = leverage disabled
pub time_fee_num: u32,         // theta slope numerator
pub funding_epoch_secs: u32,   // keeper mark cadence (informational + min-post-interval)
pub max_mark_age_secs: u32,    // staleness guard
pub leverage_cutoff_secs: u32, // no opens within this window before freeze_ts
pub max_leverage: u16,         // 0 = disabled
pub min_coverage_bps: u16,     // e.g. 12_000 = 120%
```
`create_market_config` gains these as new args appended to `MarketConfigParams`
(IDL change; validate: if max_leverage > 0 then funding_epoch_secs > 0,
max_mark_age_secs > 0, min_coverage_bps >= BPS, time_fee_num > 0).

## 3. Pure math module — `programs/amm/src/funding.rs` (NO Anchor types)

Mirror `lmsr.rs` style: `pub enum FundingError { Overflow, Domain }`, exhaustive
`#[cfg(test)]` unit tests in-file. Functions (exact signatures):
```rust
pub fn units_for(collateral: u64, leverage: u16, entry_mark_bps: u16) -> Result<u64, FundingError>;
pub fn max_gain(units: u64, entry_mark_bps: u16) -> Result<u64, FundingError>;
pub fn pnl(units: u64, entry_mark_bps: u16, mark_bps: u16) -> Result<i64, FundingError>;
pub fn funding_accrued(notional: u64, idx_now: u128, idx_snap: u128) -> Result<u64, FundingError>;
pub fn idx_delta(time_fee_num: u32, p_prev_bps: u16, elapsed_secs: i64, t_remaining_secs: i64,
                 valve_multiplier_bps: u16) -> Result<u128, FundingError>; // formula §1, ceil-divs
pub fn settle_payout(collateral: u64, pnl: i64, funding: u64) -> u64;     // max(0, C+pnl-F), saturating
pub fn max_leverage_for_p(p_bps: u16, max_leverage: u16) -> u16;          // taper §1
pub fn coverage_ok(vault_balance: u64, min_coverage_bps: u16, total_max_payout: u64,
                   new_max_payout: u64) -> Result<bool, FundingError>;    // cross-multiply, no div
pub fn shares_for_deposit(amount: u64, total_shares: u64, vault_balance: u64) -> Result<u64, FundingError>;
pub fn value_for_shares(shares: u64, total_shares: u64, vault_balance: u64) -> Result<u64, FundingError>;
```
Required unit tests: theta peaks at p=5000 and → larger as t_remaining shrinks;
idx_delta ceil never 0 for nonzero inputs; epoch-vs-full-life economic sanity
(rolling accrual at rising mark < one-shot lifetime premium at entry for a winning
path); fee-death monotonicity; taper edges (p=0→1x, p=2000..8000→max, symmetry);
coverage cross-multiply overflow safety; share round-trip floor-favors-pool;
units/pnl/settle round-trips incl. p_entry extremes 1 and 9_999; pnl sign symmetry.

## 4. Instructions (9 new; `resolve` UNTOUCHED — leveraged positions settle lazily
against `market.state == Resolved` via close/expire)

| ix | signer/gate | effect |
|---|---|---|
| `init_leverage_pool` | `authority` (GlobalConfig) | create pool PDA + lev vault (mint = GlobalConfig.usdt_mint); market must exist; config.max_leverage > 0 |
| `deposit_lp(amount)` | anyone | transfer USDT → lev vault; shares = `shares_for_deposit` (first deposit: shares = amount); init-or-existing `LpAccount` via explicit `open_lp_account`? **NO — D-3 style: separate `open_lp_account` is overkill; use `init_if_needed`? FORBIDDEN. Lock: `deposit_lp` requires `LpAccount` created by this same ix with `init` if absent is impossible without init_if_needed → split: `open_lp_account` (init, zero) + `deposit_lp` (mut). Two ixs, mirrors `open_position`+`buy`.** |
| `request_withdraw(shares)` | LP owner | require shares ≤ free shares; coverage check post-withdraw (§1); `pending_shares += s`, `unlock_ts = now + LP_WITHDRAW_DELAY_SECS`, pool.pending_withdraw_shares += s |
| `withdraw_lp` | LP owner | require now ≥ unlock_ts ∧ pending_shares > 0; pay `value_for_shares(pending_shares)` from lev vault; burn shares; clear pending |
| `post_mark(marks: [u16;3])` | keeper (`address = global.keeper`) | require each mark in 1..BPS-1; accrue `idx_delta` per outcome with PREVIOUS marks over elapsed segment (skip accrual if mark_ts == 0 — first post initializes); store marks + mark_ts = last_funding_ts = now |
| `set_risk_valve(pause_secs, multiplier_bps, window_secs)` | keeper | require multiplier_bps ≤ VALVE_MAX_MULTIPLIER_BPS ∧ each window ≤ VALVE_MAX_DURATION_SECS; set valve fields (bounded — keeper can dampen, not rug) |
| `open_leverage(outcome, collateral, leverage)` | trader | guards in this order: leverage enabled (config), market Trading, now < freeze_ts − cutoff, mark posted ∧ fresh (now − mark_ts ≤ max_mark_age_secs), now ≥ valve_paused_until, leverage ≥ 2 ∧ ≤ `max_leverage_for_p(mark[outcome])`, collateral > 0, OI (`open_interest + N ≤ max_open_interest`), coverage (§1). Then: transfer C trader→lev vault; init LevPosition (one per market+owner; `init` fails if exists = one live levered position per user per market); snapshot index; bump OI + total_max_payout |
| `close_leverage` | position owner | require !settled; compute F (needs fresh mark unless Resolved: if market Trading/Locked require mark fresh); payout §1; transfer lev vault→owner; `settled = true`; decrement OI + total_max_payout; close account to owner (rent back) |
| `expire_position` | ANYONE (permissionless crank) | require !settled ∧ F ≥ C; same settle path (payout = max(0, pnl − (F − C) …) — just `settle_payout`); rent → position owner |

Common accounts: pool + lev vault (PDA-checked), market (`address`-bound via pool.market),
config chain (market.config), GlobalConfig for mint/keeper. All token flows
`transfer_checked` with lev-vault PDA signer seeds `[LEV_POOL_SEED, market, bump]`
(pool PDA is the vault authority). Box everything.

Events (append to state.rs): `LeveragePoolInitialized`, `LpDeposited`,
`LpWithdrawRequested`, `LpWithdrawn`, `MarkPosted { marks, idx: [u128;3] }`,
`RiskValveSet`, `LeverageOpened { outcome, collateral, leverage, units, entry_mark_bps }`,
`LeverageSettled { payout, funding_paid, reason: u8 }` (reason: 0=closed,1=expired,2=resolved,3=void).

Errors (append to `AmmError`, never reorder existing):
`LeverageDisabled, LeverageTooHigh, LeverageTooLow, MarkNotPosted, MarkStale,
MarkOutOfRange, RiskValvePaused, ValveOutOfBounds, LeverageCutoff,
OpenInterestExceeded, CoverageBreached, PositionSettled, PositionNotExpired,
WithdrawLocked, NothingPending, InsufficientShares, FundingMath`.
Map `FundingError → AmmError::FundingMath` (overflow) — same pattern as lmsr errors.

## 5. Out of scope for this build (defer)

v2 `validate_odds` proof-verified marks; per-outcome multiple positions per user;
LP share SPL mint; web UI (separate wave after on-chain lands); jump auction.

## 6. Devnet mark source (keeper, wave 6)

TxLINE devnet WC odds feed returns `[]` (SPEC §4) → keeper posts marks derived from
**on-chain LMSR spot prices** as documented fallback when the odds snapshot is empty,
real StablePrice odds when available. Keeper-gated + staleness-guarded either way.

## 7. Verification gates

- `cargo test -p amm` green (funding unit tests + existing 62+).
- `cargo test --workspace` green (LiteSVM suite incl. new leverage tests).
- Solana MCP `program_autofixer` (framework=anchor) clean on every touched `.rs`.
- `NO_DNA=1 anchor build` + `pnpm codegen` + `pnpm -r typecheck`.

LiteSVM tests to add (tests/ crate, wave D): open→post_mark→close profit path;
fee-death expire (crank); resolved-win pays `C+maxgain−F`, resolved-lose pays 0,
Void refunds `C−F`; guard rejections (stale mark, cutoff, valve, OI, coverage,
leverage>taper); LP deposit/withdraw round-trip with delay + coverage-blocked
request; funding monotone across multiple post_mark segments with changing marks;
one-position-per-user (second open fails); expire before F≥C fails; close twice fails.

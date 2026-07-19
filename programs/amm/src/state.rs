//! On-chain account layouts, enums, and events.
//!
//! Every account: `#[account] #[derive(InitSpace)]`; space = `8 + T::INIT_SPACE`.
//! Reserved padding on every account so v1 (leverage, pm-AMM) needs no migration.

use anchor_lang::prelude::*;

// ===========================================================================
// Enums
// ===========================================================================

/// Market lifecycle (plan §3).
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum MarketState {
    Uninitialized,
    Open,
    Trading,
    Locked,
    Resolved,
    Closed,
}

/// Resolved outcome of the 3-way (1X2) market. Exactly one of Team1/Draw/Team2
/// pays 1 USDT per token; `Void` refunds pro-rata net basis (D-4).
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum Outcome {
    Unset,
    Team1,
    Draw,
    Team2,
    Void,
}

// ===========================================================================
// GlobalConfig — seeds [b"config"]  (space 8 + 225 = 233)
// ===========================================================================

/// Singleton admin/config account.
#[account]
#[derive(InitSpace)]
pub struct GlobalConfig {
    /// Admin; gates config + market-config + market creation + close.
    pub authority: Pubkey,
    /// Keeper (D-1); gates activate/freeze/resolve.
    pub keeper: Pubkey,
    /// Trusted callee id for the `resolve` CPI (arbitrary-CPI guard).
    pub txline_program: Pubkey,
    /// Pinned collateral mint (TxLINE devnet USDT, D-6).
    pub usdt_mint: Pubkey,
    /// Pinned token program id for the collateral mint (classic SPL Token).
    pub token_program: Pubkey,
    /// Canonical bump.
    pub bump: u8,
    /// Future fields.
    pub _reserved: [u8; 64],
}
// INIT_SPACE = 32*5 + 1 + 64 = 225

// ===========================================================================
// MarketConfig — seeds [b"mkt_config", config_id LE]  (space 8 + 133 = 141)
// ===========================================================================

/// Reusable per-tournament fee + resolution params. One config → many markets.
#[account]
#[derive(InitSpace)]
pub struct MarketConfig {
    /// Echo of the seed for reads.
    pub config_id: u16,
    /// Must equal `GlobalConfig.authority`.
    pub authority: Pubkey,

    // ---- dynamic-fee params (plan §5.2) ----
    /// Base fee (bps), e.g. 30 = 0.30%.
    pub base_fee_bps: u16,
    /// Fee cap (bps), e.g. 1000 = 10%.
    pub max_fee_bps: u16,
    /// Volatility→fee slope numerator.
    pub vfc_num: u32,
    /// Seconds; below → no decay (burst window).
    pub filter_period: u32,
    /// Seconds; above → reset accumulator (stale).
    pub decay_period: u32,
    /// Decay factor R (bps; 5000 = ×0.5).
    pub reduction_bps: u16,
    /// Cap on the volatility accumulator.
    pub max_v_acc: u64,

    /// Grace (secs) before `close_market` is allowed after freeze.
    pub resolution_grace_secs: i64,

    // ---- resolution predicate (D-8; carved from former _reserved) ----
    /// TxLINE `TraderPredicate.threshold`.
    pub resolution_threshold: i32,
    /// TxLINE `Comparison` (0=GreaterThan,1=LessThan,2=EqualTo).
    pub resolution_comparison: u8,
    /// Primary stat key (0 = unset).
    pub stat_key_a: u32,
    /// Secondary stat key (0 = unused).
    pub stat_key_b: u32,
    /// TxLINE `BinaryExpression` combining a/b (0=none,1=Add,2=Subtract).
    pub stat_op: u8,

    /// Canonical bump.
    pub bump: u8,

    /// Expected `stat_to_prove.period` for `resolve` proofs (stale-batch
    /// replay guard, O-1x2-1). 100 = TxLINE full-time final stats.
    pub resolution_period: i32,

    // ---- v1 leverage params (leverage-v1.md §2; carved from former
    //      _reserved: [u8; 40] — zero-default = leverage DISABLED for existing
    //      configs, so no migration and Borsh size is unchanged) ----
    /// Cap on Σ notional of open leveraged positions. 0 = leverage disabled.
    pub max_open_interest: u64,
    /// Theta slope numerator in the funding-rate formula.
    pub time_fee_num: u32,
    /// Keeper mark cadence (secs) — informational + min-post-interval.
    pub funding_epoch_secs: u32,
    /// Max age (secs) of the posted mark before opens/closes reject as stale.
    pub max_mark_age_secs: u32,
    /// No leveraged opens within this window (secs) before `freeze_ts`.
    pub leverage_cutoff_secs: u32,
    /// Max leverage multiple (whole ×). 0 = leverage disabled.
    pub max_leverage: u16,
    /// Min pool coverage ratio (bps), e.g. 12_000 = 120%.
    pub min_coverage_bps: u16,

    /// Future.
    pub _reserved: [u8; 12],
}
// INIT_SPACE = 2 + 32 + 2 + 2 + 4 + 4 + 4 + 2 + 8 + 8   (= 68, params+grace)
//            + 4 + 1 + 4 + 4 + 1                        (= 14, predicate)
//            + 1 + 4                                    (=  5, bump+period)
//            + 8 + 4 + 4 + 4 + 4 + 2 + 2 + 12           (= 40, leverage+reserved)
//            = 133

// ===========================================================================
// Market — seeds [b"market_v2", fixture_id LE]  (space 8 + 270 = 278)
// ===========================================================================

/// One 3-way (Team1/Draw/Team2) LMSR market per match/fixture.
///
/// LMSR state: `q[i]` = net tokens minted of outcome i (seed offsets + user
/// supply), `b` = liquidity depth. Prices are the softmax of `q/b`
/// (`lmsr::prices_bps`), so `Σ price_i = 1` by construction.
///
/// Solvency (D-2 generalized): `vault ≥ max(supply[0], supply[1], supply[2])`
/// re-checked after every mutating instruction (`lmsr::assert_solvent_multi`).
#[account]
#[derive(InitSpace)]
pub struct Market {
    /// The `MarketConfig` this market binds to.
    pub config: Pubkey,
    /// TxLINE fixture id (D-7); echo of the seed.
    pub fixture_id: i64,

    // ---- LMSR curve state (odds only; vault holds all USDT) ----
    /// Net tokens minted per outcome [Team1, Draw, Team2] (includes the
    /// admin's seed offsets, which set the opening odds).
    pub q: [u64; 3],
    /// LMSR liquidity parameter (base units). Max LP subsidy = `b·ln 3`.
    pub b: u64,

    // ---- real solvency accounting ----
    /// Total USDT held for this market (mirrors vault balance).
    pub usdt_collateral: u64,
    /// Outstanding USER positions per outcome (excludes seed offsets) —
    /// redeem liability + solvency invariant input.
    pub supply: [u64; 3],

    // ---- lifecycle ----
    pub state: MarketState,
    pub outcome: Outcome,

    // ---- vault ----
    pub vault: Pubkey,
    pub vault_bump: u8,

    // ---- clock gates ----
    pub kickoff_ts: i64,
    pub freeze_ts: i64,

    // ---- pinned collateral mint (shortens buy/sell account lists) ----
    pub usdt_mint: Pubkey,

    // ---- dynamic-fee state (fee.rs reused; price = the TRADED outcome's) ----
    /// Price (bps) of the most recently traded outcome, post-trade.
    pub last_price_bps: u16,
    /// Timestamp of last trade.
    pub last_ts: i64,
    /// Volatility accumulator (scaled).
    pub v_acc: u64,

    /// Canonical bump.
    pub bump: u8,
    /// Future.
    pub _reserved: [u8; 64],
}
// INIT_SPACE = 32 + 8            (config, fixture_id)
//            + 24 + 8            (q, b)
//            + 8 + 24            (collateral, supply)
//            + 1 + 1             (state, outcome)
//            + 32 + 1            (vault, vault_bump)
//            + 8 + 8             (kickoff, freeze)
//            + 32                (usdt_mint)
//            + 2 + 8 + 8         (fee state)
//            + 1 + 64            (bump, reserved)
//            = 270

// ===========================================================================
// Position — seeds [b"position", market, owner]  (space 8 + 130 = 138)
// ===========================================================================

/// Per-user accounting. NO SPL mints — balances live here, indexed by outcome.
#[account]
#[derive(InitSpace)]
pub struct Position {
    /// Binds; part of seeds.
    pub market: Pubkey,
    /// Binds; part of seeds.
    pub owner: Pubkey,

    /// Token balances per outcome [Team1, Draw, Team2].
    pub tokens: [u64; 3],

    /// Net USDT basis deposited (buys − sell proceeds). Void refund (D-4).
    pub collateral: u64,

    /// Double-redeem guard.
    pub redeemed: bool,
    /// Canonical bump.
    pub bump: u8,
    /// Future (v1 leverage-over-LMSR, SPEC §3.2).
    pub _reserved: [u8; 32],
}
// INIT_SPACE = 32 + 32 + 24 + 8 + 1 + 1 + 32 = 130

// ===========================================================================
// Events (plan §9)
// ===========================================================================

#[event]
pub struct MarketCreated {
    pub fixture_id: i64,
    pub config: Pubkey,
    pub b: u64,
    pub q: [u64; 3],
    /// Opening softmax prices [Team1, Draw, Team2] in bps.
    pub prices_bps: [u16; 3],
}

#[event]
pub struct MarketActivated {
    pub fixture_id: i64,
    pub ts: i64,
}

#[event]
pub struct MarketFrozen {
    pub fixture_id: i64,
    pub ts: i64,
}

#[event]
pub struct MarketResolved {
    pub fixture_id: i64,
    pub outcome: Outcome,
}

#[event]
pub struct Redeemed {
    pub fixture_id: i64,
    pub owner: Pubkey,
    pub outcome: Outcome,
    pub payout: u64,
}

#[event]
pub struct MarketClosed {
    pub fixture_id: i64,
    /// Residual vault USDT swept to the admin.
    pub swept: u64,
}

#[event]
pub struct Trade {
    pub fixture_id: i64,
    pub owner: Pubkey,
    /// Traded outcome index: 0 = Team1, 1 = Draw, 2 = Team2.
    pub outcome: u8,
    /// true = buy, false = sell.
    pub is_buy: bool,
    pub usdt: u64,
    pub tokens: u64,
    /// Post-trade softmax price (bps) of the traded outcome.
    pub price_bps: u16,
    pub fee_bps: u16,
}

/// A complete set minted at par (SPEC §3.1 phase C-add): `amount` USDT in,
/// `amount` tokens of EVERY outcome out. Fee-free, price-neutral.
#[event]
pub struct SetMinted {
    pub fixture_id: i64,
    pub owner: Pubkey,
    /// Base-unit tokens of each outcome minted = USDT deposited.
    pub amount: u64,
}

/// A complete set burned back to par (SPEC §3.1 phase C-add): `amount` tokens
/// of EVERY outcome in, `amount` USDT out. Fee-free, price-neutral.
#[event]
pub struct SetRedeemed {
    pub fixture_id: i64,
    pub owner: Pubkey,
    /// Base-unit tokens of each outcome burned = USDT paid out.
    pub amount: u64,
}

// ===========================================================================
// LeveragePool — seeds [b"lev_pool", market]  (space 8 + 218 = 226)
// ===========================================================================

/// Protocol-owned options writer for the leverage layer (leverage-v1.md §0):
/// LP-funded vault that is the counterparty to every leveraged position.
/// Never touches the LMSR curve or the spot escrow. The pool PDA is the
/// authority of the lev vault (`[b"lev_vault", market]`).
#[account]
#[derive(InitSpace)]
pub struct LeveragePool {
    /// The `Market` this pool writes options on; part of seeds.
    pub market: Pubkey,
    /// Lev vault token account (`[b"lev_vault", market]`).
    pub vault: Pubkey,
    /// LP share supply (internal accounting, no SPL mint).
    pub total_shares: u64,
    /// Shares earmarked by `request_withdraw`, awaiting `withdraw_lp`.
    pub pending_withdraw_shares: u64,
    /// Σ notional of open positions (bounded by `max_open_interest`).
    pub open_interest: u64,
    /// Σ `max_gain` of open positions — pool liability bound (coverage input).
    pub total_max_payout: u64,
    /// Last posted TxLINE marks (bps) [Team1, Draw, Team2].
    pub mark_bps: [u16; 3],
    /// Timestamp of the last `post_mark`; 0 until first post.
    pub mark_ts: i64,
    /// Timestamp the funding index last accrued to.
    pub last_funding_ts: i64,
    /// Cumulative funding index per outcome (INDEX_SCALE fixed point).
    pub cum_funding_index: [u128; 3],
    /// Opens rejected while `now < valve_paused_until`.
    pub valve_paused_until: i64,
    /// Funding multiplier (bps); BPS_DENOM = neutral, active in valve window.
    pub valve_multiplier_bps: u16,
    /// Multiplier applies while `now < valve_until_ts`.
    pub valve_until_ts: i64,
    /// Canonical bump.
    pub bump: u8,
    /// Canonical bump of the lev vault token account.
    pub vault_bump: u8,
    /// Future.
    pub _reserved: [u8; 32],
}
// INIT_SPACE = 32 + 32                (market, vault)
//            + 8 + 8 + 8 + 8          (shares, pending, OI, max_payout)
//            + 6 + 8 + 8 + 48         (marks, mark_ts, funding_ts, cum index)
//            + 8 + 2 + 8              (valve)
//            + 1 + 1 + 32             (bumps, reserved)
//            = 218

// ===========================================================================
// LevPosition — seeds [b"lev_pos", market, owner]  (space 8 + 135 = 143)
// ===========================================================================

/// One live leveraged position per user per market (`init` fails if exists).
/// A cash-settled binary option on `outcome_idx`, written by the pool; marked
/// to the posted TxLINE mark, never our own LMSR spot. Max loss = collateral.
#[account]
#[derive(InitSpace)]
pub struct LevPosition {
    /// Binds; part of seeds.
    pub market: Pubkey,
    /// Binds; part of seeds.
    pub owner: Pubkey,
    /// Outcome index: 0 = Team1, 1 = Draw, 2 = Team2.
    pub outcome_idx: u8,
    /// Leverage multiple L (whole ×).
    pub leverage: u16,
    /// Collateral C deposited into the lev vault at open.
    pub collateral: u64,
    /// Notional N = C·L.
    pub notional: u64,
    /// $1-payout-equivalent units U = floor(N·BPS / p_entry).
    pub units: u64,
    /// Posted mark (bps) at open.
    pub entry_mark_bps: u16,
    /// `cum_funding_index[outcome_idx]` snapshot at open.
    pub funding_index_snap: u128,
    /// Open timestamp.
    pub open_ts: i64,
    /// Settle guard (close/expire flips it; account then closed).
    pub settled: bool,
    /// Canonical bump.
    pub bump: u8,
    /// Future.
    pub _reserved: [u8; 16],
}
// INIT_SPACE = 32 + 32               (market, owner)
//            + 1 + 2 + 8 + 8 + 8 + 2 (outcome, leverage, C, N, U, entry mark)
//            + 16 + 8 + 1            (index snap, open_ts, settled)
//            + 1 + 16                (bump, reserved)
//            = 135

// ===========================================================================
// LpAccount — seeds [b"lev_lp", market, owner]  (space 8 + 105 = 113)
// ===========================================================================

/// Per-LP share ledger in a `LeveragePool` (internal shares, no SPL mint).
/// Withdrawal is two-step: `request_withdraw` earmarks `pending_shares` and
/// starts the `LP_WITHDRAW_DELAY_SECS` clock; `withdraw_lp` pays after it.
#[account]
#[derive(InitSpace)]
pub struct LpAccount {
    /// Binds; part of seeds.
    pub market: Pubkey,
    /// Binds; part of seeds.
    pub owner: Pubkey,
    /// Free shares (excludes pending).
    pub shares: u64,
    /// Shares earmarked by `request_withdraw`.
    pub pending_shares: u64,
    /// Pending shares claimable after this timestamp.
    pub unlock_ts: i64,
    /// Canonical bump.
    pub bump: u8,
    /// Future.
    pub _reserved: [u8; 16],
}
// INIT_SPACE = 32 + 32 + 8 + 8 + 8 + 1 + 16 = 105

// ===========================================================================
// v1 leverage events (leverage-v1.md §4)
// ===========================================================================

#[event]
pub struct LeveragePoolInitialized {
    pub market: Pubkey,
    pub vault: Pubkey,
}

#[event]
pub struct LpDeposited {
    pub market: Pubkey,
    pub owner: Pubkey,
    /// USDT transferred into the lev vault.
    pub amount: u64,
    /// Shares minted for the deposit.
    pub shares: u64,
}

#[event]
pub struct LpWithdrawRequested {
    pub market: Pubkey,
    pub owner: Pubkey,
    /// Shares earmarked for withdrawal.
    pub shares: u64,
    /// Claimable after this timestamp.
    pub unlock_ts: i64,
}

#[event]
pub struct LpWithdrawn {
    pub market: Pubkey,
    pub owner: Pubkey,
    /// Shares burned.
    pub shares: u64,
    /// USDT paid out of the lev vault.
    pub value: u64,
}

#[event]
pub struct MarkPosted {
    pub market: Pubkey,
    /// Posted marks (bps) [Team1, Draw, Team2].
    pub marks: [u16; 3],
    /// Cumulative funding index per outcome after accrual.
    pub idx: [u128; 3],
}

#[event]
pub struct RiskValveSet {
    pub market: Pubkey,
    /// Opens rejected until this timestamp.
    pub paused_until: i64,
    /// Funding multiplier (bps) in force during the valve window.
    pub multiplier_bps: u16,
    /// Multiplier applies until this timestamp.
    pub until_ts: i64,
}

#[event]
pub struct LeverageOpened {
    pub market: Pubkey,
    pub owner: Pubkey,
    /// Outcome index: 0 = Team1, 1 = Draw, 2 = Team2.
    pub outcome: u8,
    pub collateral: u64,
    pub leverage: u16,
    pub units: u64,
    pub entry_mark_bps: u16,
}

#[event]
pub struct LeverageSettled {
    pub market: Pubkey,
    pub owner: Pubkey,
    /// USDT paid from the lev vault (max(0, C + pnl − F)).
    pub payout: u64,
    /// Funding retained by the pool (writer revenue).
    pub funding_paid: u64,
    /// 0 = closed, 1 = expired (fee-death), 2 = resolved, 3 = void.
    pub reason: u8,
}

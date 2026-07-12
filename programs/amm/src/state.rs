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

    /// Future (v1 leverage: max_open_interest, theta params, min_coverage_bps).
    pub _reserved: [u8; 40],
}
// INIT_SPACE = 2 + 32 + 2 + 2 + 4 + 4 + 4 + 2 + 8 + 8   (= 68, params+grace)
//            + 4 + 1 + 4 + 4 + 1                        (= 14, predicate)
//            + 1 + 4 + 40                               (= 45, bump+period+reserved)
//            = 133

// ===========================================================================
// Market — seeds [b"market", fixture_id LE]  (space 8 + 270 = 278)
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

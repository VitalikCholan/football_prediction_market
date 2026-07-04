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

/// Resolved outcome. `Void` triggers pro-rata stake refund (D-4).
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum Outcome {
    Unset,
    Yes,
    No,
    Void,
}

/// Trade side argument.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum Side {
    Yes,
    No,
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
    pub usdc_mint: Pubkey,
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
    /// Future (v1 leverage: max_open_interest, theta params, min_coverage_bps).
    pub _reserved: [u8; 44],
}
// INIT_SPACE = 2 + 32 + 2 + 2 + 4 + 4 + 4 + 2 + 8 + 8   (= 68, params+grace)
//            + 4 + 1 + 4 + 4 + 1                        (= 14, predicate)
//            + 1 + 44                                   (= 45, bump+reserved)
//            = 133

// ===========================================================================
// Market — seeds [b"market", fixture_id LE]  (space 8 + 246 = 254)
// ===========================================================================

/// One per match/fixture.
#[account]
#[derive(InitSpace)]
pub struct Market {
    /// The `MarketConfig` this market binds to.
    pub config: Pubkey,
    /// TxLINE fixture id (D-7); echo of the seed.
    pub fixture_id: i64,

    // ---- CPMM (virtual reserves — odds only, D-2) ----
    pub yes_reserve: u64,
    pub no_reserve: u64,

    // ---- real solvency accounting ----
    /// Total USDC held for this market (mirrors vault balance).
    pub usdc_collateral: u64,
    /// Outstanding YES positions (for redeem + solvency invariant).
    pub yes_supply: u64,
    /// Outstanding NO positions.
    pub no_supply: u64,

    // ---- lifecycle ----
    pub state: MarketState,
    pub outcome: Outcome,

    // ---- vault ----
    pub vault: Pubkey,
    pub vault_bump: u8,

    // ---- clock gates ----
    pub kickoff_ts: i64,
    pub freeze_ts: i64,

    // ---- pinned collateral mint (kept on Market to shorten buy/sell accts, §4.5) ----
    pub usdc_mint: Pubkey,

    // ---- dynamic-fee state ----
    /// YES price at last trade (bps 0..=10_000).
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
// INIT_SPACE = 32 + 8              (config, fixture_id)
//            + 8 + 8              (reserves)
//            + 8 + 8 + 8          (collateral, supplies)
//            + 1 + 1              (state, outcome)
//            + 32 + 1            (vault, vault_bump)
//            + 8 + 8            (kickoff, freeze)
//            + 32               (usdc_mint)
//            + 2 + 8 + 8        (fee state)
//            + 1 + 64           (bump, reserved)
//            = 246

// ===========================================================================
// Position — seeds [b"position", market, owner]  (space 8 + 132 = 140)
// ===========================================================================

/// Per-user internal accounting. NO SPL mints for YES/NO — balances live here.
#[account]
#[derive(InitSpace)]
pub struct Position {
    /// Binds; part of seeds.
    pub market: Pubkey,
    /// Binds; part of seeds.
    pub owner: Pubkey,

    /// YES balance.
    pub yes_tokens: u64,
    /// NO balance.
    pub no_tokens: u64,

    /// Net USDC basis deposited (buys − sell proceeds). Used for Void refund (D-4)
    /// and reserved for v1 leverage collateral.
    pub collateral: u64,
    /// v1 reserved; v0 writes 1.
    pub leverage: u16,
    /// v1 reserved.
    pub notional: u64,
    /// v1 reserved (leverage time-fee accrual origin). v0 = 0.
    pub entry_slot: u64,
    /// v1 reserved (theta rate snapshot). v0 = 0.
    pub fee_rate_snapshot: u64,

    /// Double-redeem guard.
    pub redeemed: bool,
    /// Canonical bump.
    pub bump: u8,
    /// Future.
    pub _reserved: [u8; 16],
}
// INIT_SPACE = 32 + 32 + 8 + 8 + 8 + 2 + 8 + 8 + 8 + 1 + 1 + 16 = 132 (space = 140)

// ===========================================================================
// Events (plan §9)
// ===========================================================================

#[event]
pub struct MarketCreated {
    pub fixture_id: i64,
    pub config: Pubkey,
    pub yes_reserve: u64,
    pub no_reserve: u64,
    pub price_bps: u16,
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
    /// Residual vault USDC swept to the admin.
    pub swept: u64,
}

#[event]
pub struct Trade {
    pub fixture_id: i64,
    pub owner: Pubkey,
    /// true = YES, false = NO.
    pub side_yes: bool,
    /// true = buy, false = sell.
    pub is_buy: bool,
    pub usdc: u64,
    pub tokens: u64,
    pub price_bps: u16,
    pub fee_bps: u16,
}

//! Seed byte-strings and fixed-point denominators.
//!
//! These are the contract boundary: keeper/indexer/frontend re-derive PDAs from
//! these exact values (mirrored into `libs/shared`). Never hardcode them elsewhere.

use anchor_lang::prelude::*;

// ---------------------------------------------------------------------------
// PDA seeds (see plan §2.6)
// ---------------------------------------------------------------------------

/// `GlobalConfig` singleton — seeds `[b"config"]`.
#[constant]
pub const CONFIG_SEED: &[u8] = b"config";

/// `MarketConfig` — seeds `[b"mkt_config", config_id: u16 LE]`.
#[constant]
pub const MKT_CONFIG_SEED: &[u8] = b"mkt_config";

/// `Market` — seeds `[b"market", fixture_id: i64 LE]` (D-7).
#[constant]
pub const MARKET_SEED: &[u8] = b"market";

/// `Position` — seeds `[b"position", market: Pubkey, owner: Pubkey]`.
#[constant]
pub const POSITION_SEED: &[u8] = b"position";

/// `EscrowVault` token account — seeds `[b"vault", market: Pubkey]`.
#[constant]
pub const VAULT_SEED: &[u8] = b"vault";

// ---------------------------------------------------------------------------
// Fixed-point denominators (see plan §5)
// ---------------------------------------------------------------------------

/// Basis-point denominator. All bps values live in `0..=10_000`.
pub const BPS_DENOM: u64 = 10_000;

/// Volatility-accumulator scale: stored `v_acc` = `price_delta_bps * SCALE`.
pub const VOLATILITY_ACCUMULATOR_SCALE: u64 = 10_000;

/// Reduction-factor denominator for the three-zone decay (`reduction_bps / R_DENOM`).
pub const REDUCTION_FACTOR_DENOMINATOR: u64 = 10_000;

/// Dynamic-fee-control denominator (variable-fee slope normalization).
pub const DYNAMIC_FEE_CONTROL_DENOMINATOR: u64 = 100_000;

/// Hard upper bound on any configured fee (bps). `max_fee_bps <= MAX_FEE_BPS_CAP`.
pub const MAX_FEE_BPS_CAP: u16 = 9_900;

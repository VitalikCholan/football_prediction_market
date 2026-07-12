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

/// `Market` — seeds `[b"market_v2", fixture_id: i64 LE]` (D-7). The 3-way (1X2)
/// LMSR market is the program's sole market type. The `_v2` suffix keeps the
/// PDA namespace distinct from pre-refactor accounts (old binary `b"market"`
/// and old 1X2 `b"market3"`), so canonical markets never collide with ghosts.
#[constant]
pub const MARKET_SEED: &[u8] = b"market_v2";

/// `Position` — seeds `[b"position", market: Pubkey, owner: Pubkey]`.
#[constant]
pub const POSITION_SEED: &[u8] = b"position";

/// `EscrowVault` token account — seeds `[b"vault", market: Pubkey]`.
#[constant]
pub const VAULT_SEED: &[u8] = b"vault";

// ---------------------------------------------------------------------------
// TxLINE PDA seeds (their program — we only READ this PDA; plan §11.1)
// ---------------------------------------------------------------------------

/// TxLINE `daily_scores_merkle_roots` PDA — seeds
/// `[b"daily_scores_roots", epoch_day: u16 LE]`, owned by the TxLINE program.
pub const DAILY_SCORES_ROOTS_SEED: &[u8] = b"daily_scores_roots";

/// Milliseconds per epoch day (`epoch_day = ts / 86_400_000`).
///
/// **TxLINE timestamps are MILLISECONDS** — verified empirically against the
/// real devnet `txoracle` binary (2026-07-04, Surfpool fork): its seeds
/// constraint derives the daily roots PDA as `ts / 86_400_000`. A
/// seconds-based derivation can never match (caught by the §10.2 test).
pub const MILLIS_PER_DAY: i64 = 86_400_000;

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

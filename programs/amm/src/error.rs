//! Single `#[error_code]` block — Anchor 1.0 permits only ONE per program.

use anchor_lang::prelude::*;

#[error_code]
pub enum AmmError {
    // ---- math / arithmetic ------------------------------------------------
    #[msg("Arithmetic overflow / underflow")]
    MathOverflow,
    #[msg("Division by zero")]
    DivideByZero,
    #[msg("Value did not fit in target integer type")]
    NumericConversion,

    // ---- CPMM curve -------------------------------------------------------
    #[msg("Reserve must be greater than zero")]
    ZeroReserve,
    #[msg("Amount must be greater than zero")]
    ZeroAmount,
    #[msg("Output would drain the reserve")]
    OutputExceedsReserve,
    #[msg("Slippage exceeded: output below min_out")]
    SlippageExceeded,

    // ---- solvency (D-2 virtual-reserve invariant) -------------------------
    #[msg("Solvency invariant violated: vault < max(yes_supply, no_supply)")]
    SolvencyViolation,

    // ---- fee --------------------------------------------------------------
    #[msg("Clock moved backwards (now < last_ts)")]
    MonotonicClock,

    // ---- config / params --------------------------------------------------
    #[msg("Invalid fee parameters")]
    InvalidFeeParams,
    #[msg("Invalid market timing (kickoff/freeze) parameters")]
    InvalidTiming,
    #[msg("Invalid seed liquidity")]
    InvalidSeedLiquidity,

    // ---- state machine ----------------------------------------------------
    #[msg("Market is not in the required state for this action")]
    InvalidMarketState,
    #[msg("Kickoff time has not been reached yet")]
    KickoffNotReached,
    #[msg("Freeze time has not been reached yet")]
    FreezeNotReached,

    // ---- position ---------------------------------------------------------
    #[msg("Insufficient token balance in position")]
    InsufficientPositionBalance,

    // ---- authorization ----------------------------------------------------
    #[msg("Unauthorized: signer is not the required authority")]
    Unauthorized,

    // ---- resolution (Phase 2) --------------------------------------------
    #[msg("TxLINE proof rejected or not yet available")]
    ProofRejected,
    #[msg("Already redeemed")]
    AlreadyRedeemed,
}

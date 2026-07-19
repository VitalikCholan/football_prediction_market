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
    #[msg("Solvency invariant violated: vault < max_i(supply_i)")]
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
    #[msg("Proof fixture id does not match this market")]
    FixtureMismatch,
    #[msg("Timestamp maps to an invalid epoch day")]
    InvalidEpochDay,
    #[msg("daily_scores_merkle_roots owner/PDA mismatch")]
    InvalidMerkleRootsAccount,
    #[msg("Stat keys / operator do not match the stored resolution predicate")]
    PredicateMismatch,
    #[msg("Stored predicate cannot be soundly negated (EqualTo)")]
    PredicateNotNegatable,
    #[msg("Resolution grace period has not elapsed yet")]
    GraceNotElapsed,

    // ---- LMSR (SPEC §3.1, 3-way 1X2 — appended, do not reorder) -----------
    #[msg("LMSR: liquidity parameter b outside supported range")]
    LmsrLiquidityOutOfRange,
    #[msg("LMSR: outcome quantity exceeds supported maximum")]
    LmsrQuantityTooLarge,
    #[msg("LMSR: sell exceeds outstanding outcome quantity")]
    LmsrInsufficientOutcomeSupply,
    #[msg("LMSR: outcome index out of range (must be 0..3)")]
    LmsrInvalidOutcomeIndex,
    #[msg("LMSR: fixed-point argument outside supported domain")]
    LmsrDomain,

    // ---- 1X2 market (SPEC §3.1) -------------------------------------------
    #[msg("Proof stat period does not match the config's pinned resolution period")]
    ResolutionPeriodMismatch,

    // ---- v1 leverage (leverage-v1.md §4 — appended, do not reorder) --------
    #[msg("Leverage is disabled for this market config")]
    LeverageDisabled,
    #[msg("Leverage exceeds the tapered maximum for the current mark")]
    LeverageTooHigh,
    #[msg("Leverage must be at least 2x")]
    LeverageTooLow,
    #[msg("No mark has been posted for this pool yet")]
    MarkNotPosted,
    #[msg("Posted mark is older than max_mark_age_secs")]
    MarkStale,
    #[msg("Mark out of range (each must be in 1..BPS-1)")]
    MarkOutOfRange,
    #[msg("Risk valve: leveraged opens are paused")]
    RiskValvePaused,
    #[msg("Risk valve parameters exceed the hard bounds")]
    ValveOutOfBounds,
    #[msg("Too close to freeze: within the leverage cutoff window")]
    LeverageCutoff,
    #[msg("Open interest cap exceeded")]
    OpenInterestExceeded,
    #[msg("Pool coverage ratio would fall below min_coverage_bps")]
    CoverageBreached,
    #[msg("Leveraged position already settled")]
    PositionSettled,
    #[msg("Position not expired: accrued funding below collateral")]
    PositionNotExpired,
    #[msg("Withdrawal is still locked (unlock_ts not reached)")]
    WithdrawLocked,
    #[msg("No pending withdrawal to claim")]
    NothingPending,
    #[msg("Insufficient free LP shares")]
    InsufficientShares,
    #[msg("Funding math overflow / domain error")]
    FundingMath,
}

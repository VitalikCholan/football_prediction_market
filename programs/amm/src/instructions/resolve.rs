//! `resolve` — verify the market outcome against the TxLINE oracle via CPI
//! `validate_stat` and lock in `Outcome` (plan §4.7).
//!
//! Trust model:
//! - The **predicate comes from `market_config` (D-8), never from the keeper.**
//! - The keeper only *hints* the outcome direction (`Side::Yes | Side::No`):
//!   - `Yes` → the STORED predicate is validated;
//!   - `No`  → the sound integer NEGATION of the stored predicate is validated
//!     (`negate_predicate`, pure fn below).
//!   Either way the CPI must return `true` against the on-chain Merkle root —
//!   **the keeper cannot choose an outcome the proof doesn't prove.**
//! - `stat_a`/`stat_b` keys and the combining operator are pinned to the
//!   stored `stat_key_a`/`stat_key_b`/`stat_op` (goalpost guard); the stat
//!   *values* are pinned by the Merkle proof itself.
//!
//! Failure modes for the keeper (plan §4.7):
//! - TxLINE CPI errors propagate VERBATIM (a failed CPI aborts the tx), so the
//!   keeper distinguishes retryable `RootNotAvailable (6007)` from terminal
//!   proof errors (6004/6021/6023/6062…) straight from the tx logs/error code.
//! - A CPI that *returns* `false` (proof fine, predicate direction not proven)
//!   surfaces as our `AmmError::ProofRejected` — keeper retries with the other
//!   outcome hint or refetches the proof.

/// 1-of-3 (1X2) predicate derivation — pure prototype for the future
/// 3-way market's `resolve_1x2` (SPEC §3.1, `plans/resolve-1x2.md`).
/// Not called by this binary handler.
pub mod predicate_1x2;

use anchor_lang::prelude::*;

use crate::constants::{CONFIG_SEED, DAILY_SCORES_ROOTS_SEED, MARKET_SEED, MILLIS_PER_DAY};
use crate::error::AmmError;
use crate::state::{GlobalConfig, Market, MarketConfig, MarketResolved, MarketState, Outcome, Side};
use crate::txline;
use crate::txline_types::{
    self as tt, comparison_from_u8, COMPARISON_EQUAL_TO, COMPARISON_GREATER_THAN,
    COMPARISON_LESS_THAN, STAT_OP_ADD, STAT_OP_NONE, STAT_OP_SUBTRACT,
};

#[derive(Accounts)]
pub struct Resolve<'info> {
    pub keeper: Signer<'info>,

    #[account(
        seeds = [CONFIG_SEED],
        bump = global.bump,
        // keeper gate (D-1): signer must be the stored keeper
        constraint = global.keeper == keeper.key() @ AmmError::Unauthorized,
    )]
    pub global: Box<Account<'info, GlobalConfig>>,

    #[account(
        mut,
        seeds = [MARKET_SEED, &market.fixture_id.to_le_bytes()],
        bump = market.bump,
    )]
    pub market: Box<Account<'info, Market>>,

    #[account(address = market.config)]
    pub market_config: Box<Account<'info, MarketConfig>>,

    /// CHECK: arbitrary-CPI guard — pinned to the trusted TxLINE program id
    /// stored on `GlobalConfig` (plan §6). Only used as the CPI callee.
    #[account(address = global.txline_program @ AmmError::Unauthorized)]
    pub txline_program: UncheckedAccount<'info>,

    /// CHECK: TxLINE-owned read-only PDA. Validated in the handler: owner must
    /// be `global.txline_program` AND the address must re-derive from
    /// `["daily_scores_roots", epoch_day u16 LE]` for the target day.
    pub daily_scores_merkle_roots: UncheckedAccount<'info>,
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn handler(
    ctx: Context<Resolve>,
    outcome_hint: Side,
    ts: i64,
    fixture_summary: tt::ScoresBatchSummary,
    fixture_proof: Vec<tt::ProofNode>,
    main_tree_proof: Vec<tt::ProofNode>,
    stat_a: tt::StatTerm,
    stat_b: Option<tt::StatTerm>,
    op: Option<tt::BinaryExpression>,
) -> Result<()> {
    // ---- 1. state gate (double-resolve guard) + fixture binding ----
    require!(
        ctx.accounts.market.state == MarketState::Locked,
        AmmError::InvalidMarketState
    );
    require!(
        fixture_summary.fixture_id == ctx.accounts.market.fixture_id,
        AmmError::FixtureMismatch
    );

    // ---- 2. daily_scores_merkle_roots: owner + PDA re-derivation ----
    let txline_id = ctx.accounts.global.txline_program;
    require!(
        *ctx.accounts.daily_scores_merkle_roots.owner == txline_id,
        AmmError::InvalidMerkleRootsAccount
    );
    // TxLINE `ts` is in MILLISECONDS (verified vs the real devnet binary):
    // epoch_day = ts / 86_400_000, matching its own seeds constraint exactly.
    let epoch_day = u16::try_from(ts.div_euclid(MILLIS_PER_DAY))
        .map_err(|_| AmmError::InvalidEpochDay)?;
    let (expected_roots, _) = Pubkey::find_program_address(
        &[DAILY_SCORES_ROOTS_SEED, &epoch_day.to_le_bytes()],
        &txline_id,
    );
    require!(
        expected_roots == ctx.accounts.daily_scores_merkle_roots.key(),
        AmmError::InvalidMerkleRootsAccount
    );

    // ---- 3. pin stat keys + operator to the stored predicate (D-8) ----
    let mc = &ctx.accounts.market_config;
    require!(
        stat_a.stat_to_prove.key == mc.stat_key_a,
        AmmError::PredicateMismatch
    );
    let op_byte = match op {
        None => STAT_OP_NONE,
        Some(tt::BinaryExpression::Add) => STAT_OP_ADD,
        Some(tt::BinaryExpression::Subtract) => STAT_OP_SUBTRACT,
    };
    if mc.stat_key_b != 0 {
        let b = stat_b.as_ref().ok_or(AmmError::PredicateMismatch)?;
        require!(
            b.stat_to_prove.key == mc.stat_key_b,
            AmmError::PredicateMismatch
        );
        require!(op_byte == mc.stat_op && op_byte != STAT_OP_NONE, AmmError::PredicateMismatch);
    } else {
        require!(
            stat_b.is_none() && op_byte == STAT_OP_NONE,
            AmmError::PredicateMismatch
        );
    }

    // ---- 4. predicate direction from the STORED predicate + hint ----
    let (threshold, comparison) = match outcome_hint {
        Side::Yes => (mc.resolution_threshold, mc.resolution_comparison),
        Side::No => negate_predicate(mc.resolution_threshold, mc.resolution_comparison)?,
    };
    let predicate = txline::types::TraderPredicate {
        threshold,
        comparison: comparison_from_u8(comparison)?,
    };

    // ---- 5. CPI into TxLINE validate_stat, read the returned bool ----
    let cpi_ctx = CpiContext::new(
        ctx.accounts.txline_program.key(),
        txline::cpi::accounts::ValidateStat {
            daily_scores_merkle_roots: ctx
                .accounts
                .daily_scores_merkle_roots
                .to_account_info(),
        },
    );
    // Return data is cleared before every CPI — read `.get()` immediately
    // (this handler makes no other CPI, so this is the only read).
    let is_valid: bool = txline::cpi::validate_stat(
        cpi_ctx,
        ts,
        fixture_summary.into(),
        fixture_proof.into_iter().map(Into::into).collect(),
        main_tree_proof.into_iter().map(Into::into).collect(),
        predicate,
        stat_a.into(),
        stat_b.map(Into::into),
        op.map(Into::into),
    )?
    .get();
    require!(is_valid, AmmError::ProofRejected);

    // ---- 6. outcome derived from what the proof proved ----
    let outcome = match outcome_hint {
        Side::Yes => Outcome::Yes,
        Side::No => Outcome::No,
    };
    let market = &mut ctx.accounts.market;
    market.outcome = outcome;
    market.state = MarketState::Resolved;

    emit!(MarketResolved { fixture_id: market.fixture_id, outcome });
    Ok(())
}

// ---------------------------------------------------------------------------
// Pure predicate negation (unit-tested, no Anchor account types)
// ---------------------------------------------------------------------------

/// Sound integer negation of a stored `(threshold, comparison)` predicate:
/// - `¬(x > t)` ≡ `x <= t` ≡ `x < t + 1`
/// - `¬(x < t)` ≡ `x >= t` ≡ `x > t - 1`
/// - `¬(x == t)` is a disjunction — NOT expressible as one TxLINE comparison →
///   `PredicateNotNegatable`. Author markets with GT/LT predicates if the NO
///   side must be provable by negation.
///
/// Threshold shifts are checked: `t == i32::MAX/MIN` cannot shift.
pub fn negate_predicate(threshold: i32, comparison: u8) -> std::result::Result<(i32, u8), AmmError> {
    match comparison {
        COMPARISON_GREATER_THAN => {
            let t = threshold.checked_add(1).ok_or(AmmError::MathOverflow)?;
            Ok((t, COMPARISON_LESS_THAN))
        }
        COMPARISON_LESS_THAN => {
            let t = threshold.checked_sub(1).ok_or(AmmError::MathOverflow)?;
            Ok((t, COMPARISON_GREATER_THAN))
        }
        COMPARISON_EQUAL_TO => Err(AmmError::PredicateNotNegatable),
        _ => Err(AmmError::PredicateMismatch),
    }
}

#[cfg(test)]
mod tests;

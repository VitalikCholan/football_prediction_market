//! `resolve_1x2` — hint-and-prove-positively resolution of a 3-way (1X2)
//! market (SPEC §3.1 phase C; protocol in `plans/resolve-1x2.md`).
//!
//! Trust model (D-8 preserved):
//! - The keeper's ONLY input is the outcome `hint ∈ {0=Team1, 1=Draw,
//!   2=Team2}`. The comparator is derived ON-CHAIN from the hint
//!   (`derive_predicate_for_outcome`): Team1→GreaterThan, Draw→EqualTo,
//!   Team2→LessThan, on the same stored `stat_a − stat_b` vs `threshold`.
//!   Draw is a POSITIVE `EqualTo` proof — `negate_predicate` never runs, the
//!   EqualTo wall is dissolved on this path.
//! - Exactly ONE `validate_stat` CPI must return `true`;
//!   `market.outcome = hint` only then. Integer trichotomy makes the three
//!   derived predicates mutually exclusive + exhaustive (unit-proven in
//!   `predicate_1x2.rs`): a wrong hint yields `false` → `ProofRejected`, no
//!   state change (liveness-only cost).
//! - Stat keys/op pinned to the stored config; stat VALUES pinned by the
//!   Merkle proof; `stat_to_prove.period` pinned to the config's
//!   `resolution_period` (stale-batch replay guard, O-1x2-1 — a mid-match
//!   batch's stats cannot masquerade as the final whistle).
//! - Same arbitrary-CPI guard (`address = global.txline_program`), same roots
//!   PDA re-derivation, and the returned bool is read via `Return::get()`
//!   before any other CPI (this handler makes none) — all as the binary
//!   `resolve`.

use anchor_lang::prelude::*;

use crate::constants::{
    CONFIG_SEED, DAILY_SCORES_ROOTS_SEED, MARKET_1X2_SEED, MARKET_KIND_1X2, MILLIS_PER_DAY,
};
use crate::error::AmmError;
use crate::instructions::resolve::predicate_1x2::{
    derive_predicate_for_outcome, Outcome1x2 as Hint1x2, Stored1x2Predicate,
};
use crate::state::{
    GlobalConfig, Market1x2, Market1x2Resolved, MarketConfig, MarketState, Outcome1x2,
};
use crate::txline;
use crate::txline_types::{
    self as tt, comparison_from_u8, STAT_OP_ADD, STAT_OP_NONE, STAT_OP_SUBTRACT,
};

#[derive(Accounts)]
pub struct Resolve1x2<'info> {
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
        seeds = [MARKET_1X2_SEED, &market.fixture_id.to_le_bytes()],
        bump = market.bump,
    )]
    pub market: Box<Account<'info, Market1x2>>,

    #[account(address = market.config)]
    pub market_config: Box<Account<'info, MarketConfig>>,

    /// CHECK: arbitrary-CPI guard — pinned to the trusted TxLINE program id
    /// stored on `GlobalConfig`. Only used as the CPI callee.
    #[account(address = global.txline_program @ AmmError::Unauthorized)]
    pub txline_program: UncheckedAccount<'info>,

    /// CHECK: TxLINE-owned read-only PDA. Validated in the handler: owner must
    /// be `global.txline_program` AND the address must re-derive from
    /// `["daily_scores_roots", epoch_day u16 LE]` for the target day.
    pub daily_scores_merkle_roots: UncheckedAccount<'info>,
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn handler(
    ctx: Context<Resolve1x2>,
    hint: u8,
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

    // ---- 2. market-kind gate + defensive 1X2 config shape re-check ----
    let mc = &ctx.accounts.market_config;
    require!(mc.market_kind == MARKET_KIND_1X2, AmmError::MarketKindMismatch);
    let stored = Stored1x2Predicate {
        resolution_threshold: mc.resolution_threshold,
        stat_key_a: mc.stat_key_a,
        stat_key_b: mc.stat_key_b,
        stat_op: mc.stat_op,
    };

    // ---- 3. daily_scores_merkle_roots: owner + PDA re-derivation ----
    let txline_id = ctx.accounts.global.txline_program;
    require!(
        *ctx.accounts.daily_scores_merkle_roots.owner == txline_id,
        AmmError::InvalidMerkleRootsAccount
    );
    // TxLINE `ts` is in MILLISECONDS: epoch_day = ts / 86_400_000.
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

    // ---- 4. pin stat keys + operator to the stored predicate (D-8) ----
    // validate_1x2_config (inside the derivation below) guarantees the stored
    // shape is two distinct keys + Subtract; here we pin the PASSED terms.
    require!(
        stat_a.stat_to_prove.key == mc.stat_key_a,
        AmmError::PredicateMismatch
    );
    let b_term = stat_b.as_ref().ok_or(AmmError::PredicateMismatch)?;
    require!(
        b_term.stat_to_prove.key == mc.stat_key_b,
        AmmError::PredicateMismatch
    );
    let op_byte = match op {
        None => STAT_OP_NONE,
        Some(tt::BinaryExpression::Add) => STAT_OP_ADD,
        Some(tt::BinaryExpression::Subtract) => STAT_OP_SUBTRACT,
    };
    require!(
        op_byte == mc.stat_op && op_byte == STAT_OP_SUBTRACT,
        AmmError::PredicateMismatch
    );

    // ---- 5. pin the stat PERIOD (stale-batch replay guard, O-1x2-1) ----
    require!(
        stat_a.stat_to_prove.period == mc.resolution_period
            && b_term.stat_to_prove.period == mc.resolution_period,
        AmmError::ResolutionPeriodMismatch
    );

    // ---- 6. derive THIS hint's positive predicate on-chain ----
    let hint_outcome = match hint {
        0 => Hint1x2::Team1,
        1 => Hint1x2::Draw,
        2 => Hint1x2::Team2,
        _ => return err!(AmmError::LmsrInvalidOutcomeIndex),
    };
    let derived = derive_predicate_for_outcome(&stored, hint_outcome)?;
    let predicate = txline::types::TraderPredicate {
        threshold: derived.threshold,
        comparison: comparison_from_u8(derived.comparison)?,
    };

    // ---- 7. exactly ONE CPI into validate_stat; read the returned bool ----
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

    // ---- 8. outcome = the hint the proof just PROVED ----
    let outcome = match hint_outcome {
        Hint1x2::Team1 => Outcome1x2::Team1,
        Hint1x2::Draw => Outcome1x2::Draw,
        Hint1x2::Team2 => Outcome1x2::Team2,
    };
    let market = &mut ctx.accounts.market;
    market.outcome = outcome;
    market.state = MarketState::Resolved;

    emit!(Market1x2Resolved { fixture_id: market.fixture_id, outcome });
    Ok(())
}

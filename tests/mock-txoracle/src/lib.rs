//! **Test fixture only — never deployed.** Minimal mock of the TxLINE
//! txoracle program for LiteSVM (plan §10.1 case 9).
//!
//! Interface compatibility with the real `validate_stat` (idls/txline.json):
//! - `declare_id!` = the real TxLINE **devnet** program id, so tests load this
//!   .so at the exact id the AMM's `GlobalConfig.txline_program` pins.
//! - The instruction is *named* `validate_stat`, so Anchor derives the exact
//!   same 8-byte discriminator (`sha256("global:validate_stat")[..8]` =
//!   `[107,197,232,90,191,136,105,185]`, verified against the devnet IDL).
//! - Arg structs below are byte-for-byte Borsh-identical to the IDL types.
//! - Returns `bool` via `set_return_data` (Anchor typed return), exactly like
//!   the real program.
//!
//! Behaviour (controllable by the test):
//! - **Error mode:** if the first byte of `daily_scores_merkle_roots` data is
//!   `0xFF` (sentinel written via `svm.set_account`), fail with custom error
//!   6007 (`RootNotAvailable`) — mirrors the "oracle hasn't posted this
//!   epoch-day's root yet, keeper retries" mode of the real oracle.
//! - **Normal mode:** treat the Merkle proofs as valid and *evaluate the
//!   passed predicate against the passed stat values* (`stat_a`/`stat_b`
//!   combined with `op`), returning the boolean verdict. This is the sound
//!   mock of a proof-checked oracle: the test controls the outcome purely
//!   through the stat values it "proves".
//!
//! Build (once, before `cargo test -p tests`):
//!   `cargo build-sbf --manifest-path tests/mock-txoracle/Cargo.toml`
//! → `target/deploy/mock_txoracle.so` (the LiteSVM harness loads it from
//! there). `anchor build` does NOT build this crate (it lives under `tests/`,
//! outside the `programs/` dir Anchor scans) and its IDL is never generated.

use anchor_lang::prelude::*;

// Real TxLINE devnet program id (plan §11.1 / O-1).
declare_id!("6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J");

/// Sentinel first byte of the fabricated roots account that flips the mock
/// into error mode (returns `RootNotAvailable`, custom code 6007).
pub const ERROR_MODE_SENTINEL: u8 = 0xFF;

#[program]
pub mod mock_txoracle {
    use super::*;

    /// Discriminator/arg/return-compatible stand-in for TxLINE `validate_stat`.
    #[allow(clippy::too_many_arguments)]
    pub fn validate_stat(
        ctx: Context<ValidateStat>,
        _ts: i64,
        _fixture_summary: ScoresBatchSummary,
        _fixture_proof: Vec<ProofNode>,
        _main_tree_proof: Vec<ProofNode>,
        predicate: TraderPredicate,
        stat_a: StatTerm,
        stat_b: Option<StatTerm>,
        op: Option<BinaryExpression>,
    ) -> Result<bool> {
        // ---- error mode: sentinel byte in the fabricated roots account ----
        let data = ctx.accounts.daily_scores_merkle_roots.try_borrow_data()?;
        if data.first() == Some(&ERROR_MODE_SENTINEL) {
            return err!(MockOracleError::RootNotAvailable);
        }

        // ---- normal mode: proofs assumed valid; evaluate the predicate ----
        let a = i64::from(stat_a.stat_to_prove.value);
        let value = match (&stat_b, &op) {
            (Some(b), Some(BinaryExpression::Add)) => a + i64::from(b.stat_to_prove.value),
            (Some(b), Some(BinaryExpression::Subtract)) => a - i64::from(b.stat_to_prove.value),
            (None, None) => a,
            _ => return err!(MockOracleError::UnsupportedArgs),
        };
        let threshold = i64::from(predicate.threshold);
        Ok(match predicate.comparison {
            Comparison::GreaterThan => value > threshold,
            Comparison::LessThan => value < threshold,
            Comparison::EqualTo => value == threshold,
        })
    }
}

#[derive(Accounts)]
pub struct ValidateStat<'info> {
    /// CHECK: mock — the real program reads Merkle roots from this PDA; the
    /// mock only peeks at the first byte for the error-mode sentinel.
    pub daily_scores_merkle_roots: UncheckedAccount<'info>,
}

// ---------------------------------------------------------------------------
// Borsh mirrors of the TxLINE IDL types (layouts verified vs idls/txline.json)
// ---------------------------------------------------------------------------

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct ProofNode {
    pub hash: [u8; 32],
    pub is_right_sibling: bool,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug)]
pub struct ScoreStat {
    pub key: u32,
    pub value: i32,
    pub period: i32,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct StatTerm {
    pub stat_to_prove: ScoreStat,
    pub event_stat_root: [u8; 32],
    pub stat_proof: Vec<ProofNode>,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug)]
pub struct ScoresUpdateStats {
    pub update_count: i32,
    pub min_timestamp: i64,
    pub max_timestamp: i64,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug)]
pub struct ScoresBatchSummary {
    pub fixture_id: i64,
    pub update_stats: ScoresUpdateStats,
    pub events_sub_tree_root: [u8; 32],
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug)]
pub enum BinaryExpression {
    Add,
    Subtract,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug)]
pub enum Comparison {
    GreaterThan,
    LessThan,
    EqualTo,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug)]
pub struct TraderPredicate {
    pub threshold: i32,
    pub comparison: Comparison,
}

/// Variant indices chosen so `RootNotAvailable` lands on custom code **6007**,
/// matching the real TxLINE error the AMM keeper must treat as retryable
/// (`InvalidMainTreeProof` likewise lands on 6004).
#[error_code]
pub enum MockOracleError {
    Reserved0, // 6000
    Reserved1, // 6001
    Reserved2, // 6002
    Reserved3, // 6003
    #[msg("Invalid main tree proof")]
    InvalidMainTreeProof, // 6004
    Reserved5, // 6005
    Reserved6, // 6006
    #[msg("Merkle root for this epoch day is not available yet")]
    RootNotAvailable, // 6007
    #[msg("Mock: unsupported stat_b/op combination")]
    UnsupportedArgs, // 6008 (mock-only)
}

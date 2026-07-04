//! Mirrors of the TxLINE `validate_stat` argument types (plan §11.1).
//!
//! We mirror the types instead of exposing the `declare_program!`-generated
//! ones in our instruction signature so that:
//! - our own IDL stays self-contained (the Codama/Kit client needs no TxLINE
//!   IDL knowledge), and
//! - `idl-build` never has to walk the foreign generated module.
//!
//! Field order/types are byte-for-byte identical to `idls/txline.json`
//! (Borsh layout must match — verified against the devnet IDL v1.5.2).
//! Conversions into the generated `crate::txline::types::*` live here.

use anchor_lang::prelude::*;

use crate::txline;

/// One Merkle-proof step (TxLINE `ProofNode`).
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct ProofNode {
    pub hash: [u8; 32],
    pub is_right_sibling: bool,
}

/// A single provable key-value statistic (TxLINE `ScoreStat`).
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug)]
pub struct ScoreStat {
    pub key: u32,
    pub value: i32,
    pub period: i32,
}

/// A stat + its inner-tree Merkle proof (TxLINE `StatTerm`).
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct StatTerm {
    pub stat_to_prove: ScoreStat,
    pub event_stat_root: [u8; 32],
    pub stat_proof: Vec<ProofNode>,
}

/// Per-batch update stats (TxLINE `ScoresUpdateStats`).
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug)]
pub struct ScoresUpdateStats {
    pub update_count: i32,
    pub min_timestamp: i64,
    pub max_timestamp: i64,
}

/// One fixture's scores summary within a 5-minute batch (TxLINE
/// `ScoresBatchSummary`).
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug)]
pub struct ScoresBatchSummary {
    pub fixture_id: i64,
    pub update_stats: ScoresUpdateStats,
    pub events_sub_tree_root: [u8; 32],
}

/// How `stat_a`/`stat_b` combine (TxLINE `BinaryExpression`).
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub enum BinaryExpression {
    Add,
    Subtract,
}

// ---------------------------------------------------------------------------
// Comparison encoding (matches MarketConfig.resolution_comparison, D-8)
// ---------------------------------------------------------------------------

/// `MarketConfig.resolution_comparison` byte → TxLINE `Comparison` variant.
pub const COMPARISON_GREATER_THAN: u8 = 0;
pub const COMPARISON_LESS_THAN: u8 = 1;
pub const COMPARISON_EQUAL_TO: u8 = 2;

/// `MarketConfig.stat_op` byte encoding (0 = none/single stat).
pub const STAT_OP_NONE: u8 = 0;
pub const STAT_OP_ADD: u8 = 1;
pub const STAT_OP_SUBTRACT: u8 = 2;

// ---------------------------------------------------------------------------
// Conversions into the declare_program!-generated types
// ---------------------------------------------------------------------------

impl From<ProofNode> for txline::types::ProofNode {
    fn from(n: ProofNode) -> Self {
        Self { hash: n.hash, is_right_sibling: n.is_right_sibling }
    }
}

impl From<ScoreStat> for txline::types::ScoreStat {
    fn from(s: ScoreStat) -> Self {
        Self { key: s.key, value: s.value, period: s.period }
    }
}

impl From<StatTerm> for txline::types::StatTerm {
    fn from(t: StatTerm) -> Self {
        Self {
            stat_to_prove: t.stat_to_prove.into(),
            event_stat_root: t.event_stat_root,
            stat_proof: t.stat_proof.into_iter().map(Into::into).collect(),
        }
    }
}

impl From<ScoresUpdateStats> for txline::types::ScoresUpdateStats {
    fn from(u: ScoresUpdateStats) -> Self {
        Self {
            update_count: u.update_count,
            min_timestamp: u.min_timestamp,
            max_timestamp: u.max_timestamp,
        }
    }
}

impl From<ScoresBatchSummary> for txline::types::ScoresBatchSummary {
    fn from(s: ScoresBatchSummary) -> Self {
        Self {
            fixture_id: s.fixture_id,
            update_stats: s.update_stats.into(),
            events_sub_tree_root: s.events_sub_tree_root,
        }
    }
}

impl From<BinaryExpression> for txline::types::BinaryExpression {
    fn from(op: BinaryExpression) -> Self {
        match op {
            BinaryExpression::Add => Self::Add,
            BinaryExpression::Subtract => Self::Subtract,
        }
    }
}

/// Stored `resolution_comparison` byte → TxLINE `Comparison`.
/// `create_market_config` validates the byte ≤ 2, so `Err` is unreachable for
/// stored configs; keep it checked anyway.
pub fn comparison_from_u8(v: u8) -> std::result::Result<txline::types::Comparison, crate::error::AmmError> {
    match v {
        COMPARISON_GREATER_THAN => Ok(txline::types::Comparison::GreaterThan),
        COMPARISON_LESS_THAN => Ok(txline::types::Comparison::LessThan),
        COMPARISON_EQUAL_TO => Ok(txline::types::Comparison::EqualTo),
        _ => Err(crate::error::AmmError::PredicateMismatch),
    }
}

//! 1-of-3 (1X2) predicate derivation — pure prototype for the 3-way
//! Team1/Draw/Team2 market (`plans/SPEC.md` §3.1, design in
//! `plans/resolve-1x2.md`). **Not yet wired into any instruction** — the
//! shipped binary `resolve` (`super`) is untouched; a future `resolve_1x2`
//! handler will call these fns.
//!
//! Core insight — the EqualTo wall dissolves under positive proof:
//! `negate_predicate` (binary path) cannot negate `EqualTo` because
//! `¬(x == t)` is a disjunction TxLINE cannot express in one comparison
//! (`PredicateNotNegatable`). But a 1X2 resolve never needs negation: each of
//! the three outcomes is proven POSITIVELY on the same `stat_a − stat_b`
//! subtraction pinned by D-8:
//!
//! - `Team1` → `(s1 − s2) >  t`   (`GreaterThan`)
//! - `Draw`  → `(s1 − s2) == t`   (`EqualTo` — used positively, natively
//!   supported by TxLINE `validate_stat`; no negation anywhere)
//! - `Team2` → `(s1 − s2) <  t`   (`LessThan`)
//!
//! with `t = MarketConfig.resolution_threshold` (canonical 1X2: `t = 0`;
//! `t ≠ 0` yields a handicap 1X2, still a valid trichotomy). By integer
//! trichotomy exactly one of the three holds for any final score, so the
//! derived predicates are mutually exclusive (the keeper can prove at most
//! one outcome — the stat values are pinned by the Merkle proof) and
//! exhaustive (some hint always succeeds — liveness).
//!
//! Trust model (D-8 preserved): the keeper's ONLY input is the hint. The
//! comparator is derived on-chain from the hint; threshold, stat keys, and
//! the combining operator come from the stored `MarketConfig`. A wrong hint
//! makes the CPI return `false` → `AmmError::ProofRejected`, tx aborts with
//! no state change — a liveness hiccup, never a safety loss.
//!
//! Unlike `negate_predicate`, derivation performs NO threshold arithmetic, so
//! there is no overflow path: the only error is a config that is not
//! 1X2-shaped (`validate_1x2_config`).

use crate::error::AmmError;
use crate::txline_types::{
    COMPARISON_EQUAL_TO, COMPARISON_GREATER_THAN, COMPARISON_LESS_THAN, STAT_OP_SUBTRACT,
};

/// The three football results of a 1X2 market. Future `resolve_1x2` takes
/// this as the keeper's outcome hint (and `Outcome` gains matching variants).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Outcome1x2 {
    /// Home win: `(stat_a − stat_b) > threshold`.
    Team1,
    /// Draw: `(stat_a − stat_b) == threshold`.
    Draw,
    /// Away win: `(stat_a − stat_b) < threshold`.
    Team2,
}

/// All three hints, for exhaustive iteration (tests, keeper retry order).
pub const ALL_OUTCOMES_1X2: [Outcome1x2; 3] =
    [Outcome1x2::Team1, Outcome1x2::Draw, Outcome1x2::Team2];

/// The D-8 fields a 1X2 derivation reads from `MarketConfig`. Deliberately
/// EXCLUDES `resolution_comparison` — the comparator is derived per-hint, so
/// the stored one is structurally unreadable by this path (nothing to trust).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Stored1x2Predicate {
    /// `MarketConfig.resolution_threshold` (0 for canonical 1X2).
    pub resolution_threshold: i32,
    /// `MarketConfig.stat_key_a` (e.g. full-time P1 goals).
    pub stat_key_a: u32,
    /// `MarketConfig.stat_key_b` (e.g. full-time P2 goals; 0 = unused → invalid here).
    pub stat_key_b: u32,
    /// `MarketConfig.stat_op` — must be `STAT_OP_SUBTRACT` for 1X2.
    pub stat_op: u8,
}

/// A derived `(threshold, comparison)` pair, byte-encoded exactly like
/// `MarketConfig.resolution_comparison` (convert with `comparison_from_u8`
/// before the CPI).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct DerivedPredicate {
    pub threshold: i32,
    pub comparison: u8,
}

/// A 1X2 market's stored predicate must be a two-stat SUBTRACTION
/// (`s1 − s2 vs t`): both keys set, distinct, `stat_op = Subtract`.
/// Enforce at `create_market_config` time for 3-way configs AND defensively
/// re-check in `resolve_1x2`.
pub fn validate_1x2_config(cfg: &Stored1x2Predicate) -> std::result::Result<(), AmmError> {
    if cfg.stat_key_a == 0 || cfg.stat_key_b == 0 || cfg.stat_key_a == cfg.stat_key_b {
        return Err(AmmError::PredicateMismatch);
    }
    if cfg.stat_op != STAT_OP_SUBTRACT {
        return Err(AmmError::PredicateMismatch);
    }
    Ok(())
}

/// Derive the positive predicate proving `hint` from the stored config.
///
/// Pure function of `(stored config, hint)` — the keeper injects nothing
/// else: no comparator, no threshold, no keys. The returned predicate is
/// what `resolve_1x2` hands to the `validate_stat` CPI (one CPI per tx);
/// `market.outcome = hint` only if the CPI returns `true`.
pub fn derive_predicate_for_outcome(
    cfg: &Stored1x2Predicate,
    hint: Outcome1x2,
) -> std::result::Result<DerivedPredicate, AmmError> {
    validate_1x2_config(cfg)?;
    let comparison = match hint {
        Outcome1x2::Team1 => COMPARISON_GREATER_THAN,
        Outcome1x2::Draw => COMPARISON_EQUAL_TO,
        Outcome1x2::Team2 => COMPARISON_LESS_THAN,
    };
    Ok(DerivedPredicate { threshold: cfg.resolution_threshold, comparison })
}

#[cfg(test)]
mod tests {
    use super::*;

    const P1_GOALS_FT: u32 = 1; // full-time home goals (SPEC §5 stat-key encoding)
    const P2_GOALS_FT: u32 = 2; // full-time away goals

    fn canonical_cfg() -> Stored1x2Predicate {
        Stored1x2Predicate {
            resolution_threshold: 0,
            stat_key_a: P1_GOALS_FT,
            stat_key_b: P2_GOALS_FT,
            stat_op: STAT_OP_SUBTRACT,
        }
    }

    /// Reference evaluation of a derived predicate over an integer goal diff
    /// (mirrors the real oracle's comparison semantics and the mock's).
    /// Pure integer comparison — no code execution of any kind.
    fn eval_predicate(diff: i64, p: &DerivedPredicate) -> bool {
        match p.comparison {
            COMPARISON_GREATER_THAN => diff > i64::from(p.threshold),
            COMPARISON_LESS_THAN => diff < i64::from(p.threshold),
            COMPARISON_EQUAL_TO => diff == i64::from(p.threshold),
            _ => unreachable!(),
        }
    }

    #[test]
    fn team1_derives_greater_than() {
        let p = derive_predicate_for_outcome(&canonical_cfg(), Outcome1x2::Team1).unwrap();
        assert_eq!(p, DerivedPredicate { threshold: 0, comparison: COMPARISON_GREATER_THAN });
    }

    #[test]
    fn draw_derives_equal_to_no_negation_needed() {
        // Draw is a POSITIVE EqualTo proof — negate_predicate never runs,
        // so PredicateNotNegatable is unreachable on the 1X2 path.
        let p = derive_predicate_for_outcome(&canonical_cfg(), Outcome1x2::Draw).unwrap();
        assert_eq!(p, DerivedPredicate { threshold: 0, comparison: COMPARISON_EQUAL_TO });
    }

    #[test]
    fn team2_derives_less_than() {
        let p = derive_predicate_for_outcome(&canonical_cfg(), Outcome1x2::Team2).unwrap();
        assert_eq!(p, DerivedPredicate { threshold: 0, comparison: COMPARISON_LESS_THAN });
    }

    #[test]
    fn threshold_passes_through_unchanged_incl_handicap_and_extremes() {
        // No threshold arithmetic → no overflow path, even at i32::MIN/MAX.
        for t in [-2, -1, 0, 1, 3, i32::MIN, i32::MAX] {
            let cfg = Stored1x2Predicate { resolution_threshold: t, ..canonical_cfg() };
            for hint in ALL_OUTCOMES_1X2 {
                let p = derive_predicate_for_outcome(&cfg, hint).unwrap();
                assert_eq!(p.threshold, t, "threshold must pass through for {hint:?}");
            }
        }
    }

    #[test]
    fn non_1x2_config_shapes_rejected() {
        let bad = [
            Stored1x2Predicate { stat_key_b: 0, ..canonical_cfg() }, // single-stat
            Stored1x2Predicate { stat_key_a: 0, ..canonical_cfg() }, // key_a unset
            Stored1x2Predicate { stat_key_b: P1_GOALS_FT, ..canonical_cfg() }, // a == b
            Stored1x2Predicate { stat_op: 0, ..canonical_cfg() },    // STAT_OP_NONE
            Stored1x2Predicate { stat_op: 1, ..canonical_cfg() },    // STAT_OP_ADD
        ];
        for cfg in bad {
            for hint in ALL_OUTCOMES_1X2 {
                assert!(
                    matches!(
                        derive_predicate_for_outcome(&cfg, hint),
                        Err(AmmError::PredicateMismatch)
                    ),
                    "cfg {cfg:?} hint {hint:?} must be rejected"
                );
            }
        }
    }

    #[test]
    fn derivation_is_deterministic_pure_fn_of_config_and_hint() {
        // The keeper can inject only the hint: same (config, hint) → same
        // predicate, every time; and the fn signature admits no comparator.
        let cfg = canonical_cfg();
        for hint in ALL_OUTCOMES_1X2 {
            let a = derive_predicate_for_outcome(&cfg, hint).unwrap();
            let b = derive_predicate_for_outcome(&cfg, hint).unwrap();
            assert_eq!(a, b);
        }
    }

    #[test]
    fn three_hints_derive_three_distinct_comparators() {
        let cfg = canonical_cfg();
        let mut cmps: Vec<u8> = ALL_OUTCOMES_1X2
            .iter()
            .map(|&h| derive_predicate_for_outcome(&cfg, h).unwrap().comparison)
            .collect();
        cmps.sort_unstable();
        cmps.dedup();
        assert_eq!(cmps.len(), 3);
    }

    /// THE soundness property (integer trichotomy): for every threshold and
    /// every integer goal diff, EXACTLY ONE of the three derived predicates
    /// holds — mutual exclusivity (keeper can prove at most one outcome) +
    /// exhaustiveness (some hint always verifies → liveness).
    #[test]
    fn derived_predicates_partition_integer_goal_diffs() {
        for t in -10..=10i32 {
            let cfg = Stored1x2Predicate { resolution_threshold: t, ..canonical_cfg() };
            for diff in -25..=25i64 {
                let holds: Vec<Outcome1x2> = ALL_OUTCOMES_1X2
                    .into_iter()
                    .filter(|&h| {
                        eval_predicate(diff, &derive_predicate_for_outcome(&cfg, h).unwrap())
                    })
                    .collect();
                assert_eq!(
                    holds.len(),
                    1,
                    "diff={diff} t={t}: expected exactly one outcome, got {holds:?}"
                );
                // And the one that holds is the truthful result.
                let expected = match diff.cmp(&i64::from(t)) {
                    std::cmp::Ordering::Greater => Outcome1x2::Team1,
                    std::cmp::Ordering::Equal => Outcome1x2::Draw,
                    std::cmp::Ordering::Less => Outcome1x2::Team2,
                };
                assert_eq!(holds[0], expected);
            }
        }
    }
}

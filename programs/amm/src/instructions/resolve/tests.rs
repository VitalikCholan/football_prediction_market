//! Unit tests for `negate_predicate` (`resolve.rs`).
//! Declared via `#[cfg(test)] mod tests;` (default child-module path),
//! so `super` is the `resolve` module; compiled ONLY under `cargo test`.

use super::*;

/// Reference evaluation of a predicate over an integer stat value.
fn eval_predicate(value: i64, threshold: i32, comparison: u8) -> bool {
    match comparison {
        COMPARISON_GREATER_THAN => value > threshold as i64,
        COMPARISON_LESS_THAN => value < threshold as i64,
        COMPARISON_EQUAL_TO => value == threshold as i64,
        _ => unreachable!(),
    }
}

#[test]
fn negate_gt_is_lt_plus_one() {
    assert_eq!(negate_predicate(0, COMPARISON_GREATER_THAN).unwrap(), (1, COMPARISON_LESS_THAN));
    assert_eq!(negate_predicate(5, COMPARISON_GREATER_THAN).unwrap(), (6, COMPARISON_LESS_THAN));
    assert_eq!(
        negate_predicate(-3, COMPARISON_GREATER_THAN).unwrap(),
        (-2, COMPARISON_LESS_THAN)
    );
}

#[test]
fn negate_lt_is_gt_minus_one() {
    assert_eq!(negate_predicate(0, COMPARISON_LESS_THAN).unwrap(), (-1, COMPARISON_GREATER_THAN));
    assert_eq!(negate_predicate(3, COMPARISON_LESS_THAN).unwrap(), (2, COMPARISON_GREATER_THAN));
}

#[test]
fn negate_eq_rejected() {
    assert!(matches!(
        negate_predicate(2, COMPARISON_EQUAL_TO),
        Err(AmmError::PredicateNotNegatable)
    ));
}

#[test]
fn negate_overflow_edges() {
    assert!(matches!(
        negate_predicate(i32::MAX, COMPARISON_GREATER_THAN),
        Err(AmmError::MathOverflow)
    ));
    assert!(matches!(
        negate_predicate(i32::MIN, COMPARISON_LESS_THAN),
        Err(AmmError::MathOverflow)
    ));
}

#[test]
fn negate_unknown_comparison_rejected() {
    assert!(matches!(negate_predicate(0, 9), Err(AmmError::PredicateMismatch)));
}

/// Exhaustive soundness: over a range of values/thresholds, exactly one of
/// {predicate, negated predicate} holds (they partition the integers).
#[test]
fn negation_partitions_the_integers() {
    for comparison in [COMPARISON_GREATER_THAN, COMPARISON_LESS_THAN] {
        for threshold in -10..=10i32 {
            let (nt, nc) = negate_predicate(threshold, comparison).unwrap();
            for value in -25..=25i64 {
                let yes = eval_predicate(value, threshold, comparison);
                let no = eval_predicate(value, nt, nc);
                assert!(
                    yes ^ no,
                    "value={value} threshold={threshold} cmp={comparison}: yes={yes} no={no}"
                );
            }
        }
    }
}

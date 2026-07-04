//! Unit tests for the pure CPMM math (`math.rs`) — §10.1 cases 5, 8.
//! Declared via `#[cfg(test)] mod tests;` (default child-module path),
//! so `super` is the `math` module; compiled ONLY under `cargo test`.

use super::*;

#[test]
fn price_is_half_when_reserves_equal() {
    assert_eq!(price_yes_bps(1_000_000, 1_000_000).unwrap(), 5_000);
}

#[test]
fn price_rises_when_no_dominates() {
    // more NO reserve => YES scarcer => YES more expensive
    let p = price_yes_bps(500_000, 1_500_000).unwrap();
    assert_eq!(p, 7_500);
}

#[test]
fn zero_reserve_rejected() {
    assert!(matches!(compute_out(0, 100, 10), Err(AmmError::ZeroReserve)));
    assert!(matches!(compute_out(100, 0, 10), Err(AmmError::ZeroReserve)));
}

#[test]
fn zero_amount_rejected() {
    assert!(matches!(compute_out(100, 100, 0), Err(AmmError::ZeroAmount)));
}

#[test]
fn output_less_than_reserve() {
    let out = compute_out(1_000_000, 1_000_000, 1_000).unwrap();
    assert!(out < 1_000_000);
    assert!(out > 0);
}

#[test]
fn k_never_decreases_on_swap() {
    let (x, y) = (1_000_000u64, 1_000_000u64);
    let k0 = k_of(x, y).unwrap();
    let out = compute_out(x, y, 12_345).unwrap();
    let new_x = x + 12_345;
    let new_y = y - out;
    let k1 = k_of(new_x, new_y).unwrap();
    // floored output → k must not decrease
    assert!(k1 >= k0, "k1={k1} k0={k0}");
}

#[test]
fn overflow_on_huge_input() {
    // u64::MAX added to a reserve → mul overflow caught somewhere in the chain.
    let r = buy(true, u64::MAX, u64::MAX, u64::MAX);
    assert!(r.is_err());
}

#[test]
fn buy_yields_positive_tokens_and_preserves_k() {
    let n = 10_000u64;
    let res = buy(true, 1_000_000, 1_000_000, n).unwrap();
    assert!(res.tokens_out > 0);
    // reserves preserve k (non-decreasing under pool-favorable ceil rounding)
    let k0 = k_of(1_000_000, 1_000_000).unwrap();
    let k1 = k_of(res.new_yes_reserve, res.new_no_reserve).unwrap();
    assert!(k1 >= k0, "k1={k1} k0={k0}");
}

#[test]
fn buy_yes_raises_yes_price() {
    let p0 = price_yes_bps(1_000_000, 1_000_000).unwrap();
    let res = buy(true, 1_000_000, 1_000_000, 50_000).unwrap();
    let p1 = price_yes_bps(res.new_yes_reserve, res.new_no_reserve).unwrap();
    assert!(p1 > p0, "p0={p0} p1={p1}");
}

#[test]
fn round_trip_never_profits() {
    // buy YES then immediately sell the tokens back: usdc_gross <= usdc_in.
    let usdc_in = 20_000u64;
    let b = buy(true, 1_000_000, 1_000_000, usdc_in).unwrap();
    let s = sell(true, b.new_yes_reserve, b.new_no_reserve, b.tokens_out).unwrap();
    assert!(s.usdc_gross <= usdc_in, "gross={} in={}", s.usdc_gross, usdc_in);
}

#[test]
fn solvency_invariant() {
    assert!(assert_solvent(100, 100, 50).is_ok());
    assert!(assert_solvent(100, 50, 100).is_ok());
    assert!(matches!(
        assert_solvent(99, 100, 50),
        Err(AmmError::SolvencyViolation)
    ));
}

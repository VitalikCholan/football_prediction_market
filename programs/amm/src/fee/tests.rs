//! Unit tests for the pure dynamic volatility fee (`fee.rs`) — §10.1 case 7.
//! Declared via `#[cfg(test)] mod tests;` (default child-module path),
//! so `super` is the `fee` module; compiled ONLY under `cargo test`.

use super::*;

fn params() -> FeeParams {
    FeeParams {
        base_fee_bps: 30,
        max_fee_bps: 1_000,
        vfc_num: 10,
        filter_period: 10,
        decay_period: 100,
        reduction_bps: 5_000, // ×0.5
        max_v_acc: 100_000 * SCALE,
    }
}

#[test]
fn burst_window_no_decay() {
    let p = params();
    let s = FeeState { last_price_bps: 5_000, last_ts: 100, v_acc: 50_000 };
    // elapsed 5 < filter_period 10 → no decay
    assert_eq!(decay_v_ref(&p, &s, 105).unwrap(), 50_000);
}

#[test]
fn mid_window_halves() {
    let p = params();
    let s = FeeState { last_price_bps: 5_000, last_ts: 100, v_acc: 50_000 };
    // filter 10 <= elapsed 50 < decay 100 → ×0.5
    assert_eq!(decay_v_ref(&p, &s, 150).unwrap(), 25_000);
}

#[test]
fn stale_resets() {
    let p = params();
    let s = FeeState { last_price_bps: 5_000, last_ts: 100, v_acc: 50_000 };
    // elapsed 200 >= decay 100 → 0
    assert_eq!(decay_v_ref(&p, &s, 300).unwrap(), 0);
}

#[test]
fn monotonic_clock_rejected() {
    let p = params();
    let s = FeeState { last_price_bps: 5_000, last_ts: 100, v_acc: 0 };
    assert!(matches!(decay_v_ref(&p, &s, 99), Err(AmmError::MonotonicClock)));
}

#[test]
fn base_fee_when_no_volatility() {
    let p = params();
    assert_eq!(fee_bps_from_v_ref(&p, 0).unwrap(), 30);
}

#[test]
fn fee_increases_quadratically_and_caps() {
    let p = params();
    // denom = CONTROL(100_000) * SCALE^2(1e8) = 1e13; vfc_num = 10.
    // variable ≈ vfc_num * v_ref^2 / denom. Pick v_ref large enough to move it.
    let low = fee_bps_from_v_ref(&p, 3_000_000).unwrap(); // ~9 variable
    let mid = fee_bps_from_v_ref(&p, 6_000_000).unwrap(); // ~36 variable (4x)
    // doubling v_ref ⇒ ~4x the variable term (quadratic), so mid - base > low - base
    let base = p.base_fee_bps;
    assert!(mid > low && low > base, "base={base} low={low} mid={mid}");
    assert!((mid - base) > 2 * (low - base), "quadratic growth expected");
    // very large accumulator saturates at max_fee_bps
    let big = fee_bps_from_v_ref(&p, p.max_v_acc).unwrap();
    assert_eq!(big, p.max_fee_bps);
}

#[test]
fn ceil_div_never_zero_for_tiny_nonzero() {
    // craft params so a tiny v_ref still yields variable >= 1
    let p = FeeParams { vfc_num: 1, ..params() };
    // denom = 100_000 * SCALE^2. Pick v_ref so v_sq*vfc_num > 0 but < denom.
    let f = fee_bps_from_v_ref(&p, 1).unwrap();
    // base 30 + ceil(tiny) = 31 (never rounds the variable term to 0)
    assert_eq!(f, 31);
}

#[test]
fn v_acc_accumulates_and_caps() {
    let p = params();
    // price moved 200 bps → contribution 200 * SCALE
    let v = next_v_acc(&p, 0, 5_000, 5_200).unwrap();
    assert_eq!(v, 200 * SCALE);
    // near the cap it saturates
    let v2 = next_v_acc(&p, p.max_v_acc, 5_000, 9_000).unwrap();
    assert_eq!(v2, p.max_v_acc);
}

#[test]
fn u128_square_no_overflow_at_configured_max() {
    let p = params();
    // At the CONFIGURED cap (max_v_acc) the u128 square path must not overflow.
    assert!(fee_bps_from_v_ref(&p, p.max_v_acc).is_ok());
}

#[test]
fn extreme_v_ref_overflow_is_caught_not_ub() {
    // Beyond any sane cap, the checked u128 square returns an error (no panic,
    // no wraparound) — proving the checked-math discipline holds.
    let p = params();
    assert!(matches!(
        fee_bps_from_v_ref(&p, u64::MAX),
        Err(AmmError::MathOverflow)
    ));
}

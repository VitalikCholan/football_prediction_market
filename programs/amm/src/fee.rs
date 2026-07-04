//! Pure dynamic volatility fee — no Anchor types, unit-testable + replayable
//! offline for keeper calibration (plan §5.2).
//!
//! Three-zone decay + quadratic variable fee (Raydium CLMM / Orca adaptive-fee
//! conventions). All bps in `0..=10_000`. `v_acc` stores `price_delta_bps * SCALE`.

use crate::constants::{
    DYNAMIC_FEE_CONTROL_DENOMINATOR, REDUCTION_FACTOR_DENOMINATOR,
    VOLATILITY_ACCUMULATOR_SCALE as SCALE,
};
use crate::error::AmmError;

/// Immutable fee params (mirror of the `MarketConfig` fee fields).
#[derive(Clone, Copy, Debug)]
pub struct FeeParams {
    pub base_fee_bps: u16,
    pub max_fee_bps: u16,
    pub vfc_num: u32,
    pub filter_period: u32,
    pub decay_period: u32,
    pub reduction_bps: u16,
    pub max_v_acc: u64,
}

/// Mutable per-market fee state entering a trade.
#[derive(Clone, Copy, Debug)]
pub struct FeeState {
    pub last_price_bps: u16,
    pub last_ts: i64,
    pub v_acc: u64,
}

/// Step A — three-zone decay. Returns the reference accumulator `v_ref` used to
/// charge THIS trade. Rejects a backward clock.
pub fn decay_v_ref(params: &FeeParams, state: &FeeState, now: i64) -> Result<u64, AmmError> {
    if now < state.last_ts {
        return Err(AmmError::MonotonicClock);
    }
    let elapsed = now
        .checked_sub(state.last_ts)
        .ok_or(AmmError::MathOverflow)? as u64;

    let v_ref = if elapsed < params.filter_period as u64 {
        // burst window: no decay
        state.v_acc
    } else if elapsed < params.decay_period as u64 {
        // decay ×R
        ((state.v_acc as u128)
            .checked_mul(params.reduction_bps as u128)
            .ok_or(AmmError::MathOverflow)?
            .checked_div(REDUCTION_FACTOR_DENOMINATOR as u128)
            .ok_or(AmmError::DivideByZero)?) as u64
    } else {
        // stale: reset
        0
    };
    Ok(v_ref)
}

/// Step B — fee (bps) charged on this trade, from `v_ref`. Quadratic, ceil-div,
/// clamped to `[base_fee_bps, max_fee_bps]`.
pub fn fee_bps_from_v_ref(params: &FeeParams, v_ref: u64) -> Result<u16, AmmError> {
    let v_sq = (v_ref as u128)
        .checked_mul(v_ref as u128)
        .ok_or(AmmError::MathOverflow)?;
    let fee_num = (params.vfc_num as u128)
        .checked_mul(v_sq)
        .ok_or(AmmError::MathOverflow)?;
    // denom = CONTROL_DENOM * SCALE^2 (undoes accumulator scaling)
    let denom = (DYNAMIC_FEE_CONTROL_DENOMINATOR as u128)
        .checked_mul(SCALE as u128)
        .ok_or(AmmError::MathOverflow)?
        .checked_mul(SCALE as u128)
        .ok_or(AmmError::MathOverflow)?;

    // ceiling division so the fee never rounds to zero under load
    let variable = if fee_num == 0 {
        0u128
    } else {
        fee_num
            .checked_add(denom - 1)
            .ok_or(AmmError::MathOverflow)?
            .checked_div(denom)
            .ok_or(AmmError::DivideByZero)?
    };

    let fee = (params.base_fee_bps as u128)
        .checked_add(variable)
        .ok_or(AmmError::MathOverflow)?;
    let capped = fee.min(params.max_fee_bps as u128);
    // capped <= max_fee_bps <= 9900 fits in u16
    u16::try_from(capped).map_err(|_| AmmError::NumericConversion)
}

/// Step C — arm the accumulator for the NEXT trade with this trade's price move.
/// `v_acc_new = min(v_ref + |Δprice_bps| * SCALE, max_v_acc)`.
pub fn next_v_acc(
    params: &FeeParams,
    v_ref: u64,
    old_price_bps: u16,
    new_price_bps: u16,
) -> Result<u64, AmmError> {
    let delta = (old_price_bps as i32 - new_price_bps as i32).unsigned_abs() as u64;
    let contribution = delta.checked_mul(SCALE).ok_or(AmmError::MathOverflow)?;
    let candidate = v_ref.checked_add(contribution).ok_or(AmmError::MathOverflow)?;
    Ok(candidate.min(params.max_v_acc))
}

/// Convenience: full Step A+B in one call — the fee charged on this trade.
pub fn compute_fee_bps(
    params: &FeeParams,
    state: &FeeState,
    now: i64,
) -> Result<(u16, u64), AmmError> {
    let v_ref = decay_v_ref(params, state, now)?;
    let fee = fee_bps_from_v_ref(params, v_ref)?;
    Ok((fee, v_ref))
}

// ===========================================================================
// Unit tests (§10.1 case 7)
// ===========================================================================
#[cfg(test)]
mod tests {
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
}

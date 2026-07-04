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

#[cfg(test)]
mod tests;

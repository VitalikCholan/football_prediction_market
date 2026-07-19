//! Pure math for the v1 no-liquidation leverage layer — plans/leverage-v1.md
//! §1 (LOCKED formulas) / §3 (this module). No Anchor account types; mirrors
//! `lmsr.rs`/`fee.rs`: unit-testable in a plain harness, checked math with
//! `u128`/`i128` intermediates, own error enum (handlers map it to
//! `AmmError::FundingMath` / a domain error).
//!
//! ## Model (one paragraph)
//!
//! A leveraged position is a cash-settled binary option on one outcome,
//! written by the LP-funded `LeveragePool`. Trader deposits collateral `C`,
//! picks leverage `L` and outcome `i`; exposure is `U` $1-payout-equivalent
//! units marked to the posted TxLINE mark (never our own LMSR spot). No price
//! liquidation: the trader pays funding = theta accrued via a cumulative
//! funding index (Drift pattern); the position dies only by fee-death
//! (`F >= C`) or settles at close/resolution. Max trader loss = `C`.
//!
//! ## Formulas (prices in bps, `BPS_DENOM = 10_000`; money in USDT 6dp u64)
//!
//! ```text
//! N (notional)       = C * L
//! U (units)          = floor(N * BPS / p_entry_bps)
//! pnl(p)             = floor_signed(U * (p - p_entry_bps) / BPS)     i128 -> i64
//! F (funding)        = floor(N * (idx_now - idx_snap) / INDEX_SCALE)
//! payout             = max(0, C + pnl(p) - F)                        saturating
//! max_gain           = floor(U * (BPS - p_entry_bps) / BPS)          pool liability bound
//!
//! funding index (per outcome, updated only in post_mark, over the segment
//! priced at the PREVIOUS stored mark p_prev):
//!   t_rem     = max(t_remaining, MIN_T_REMAINING_SECS)
//!   rate_num  = time_fee_num * p_prev * (BPS - p_prev)
//!   idx_delta = ceil(rate_num * INDEX_SCALE * elapsed / (BPS * BPS * t_rem))
//!   valve:      idx_delta = ceil(idx_delta * valve_multiplier_bps / BPS)
//!               (applied ONLY while valve_multiplier_bps > BPS; <= BPS = neutral)
//! ```
//!
//! Theta = `time_fee_num * p(1-p) / t_rem` is the option time-decay shape:
//! it peaks at `p = 5_000` and grows as expiry approaches (see tests).
//!
//! ## Rounding policy — pool-favorable at every boundary
//!
//! * `idx_delta`: CEIL (funding revenue is never under-accrued; never 0 for a
//!   nonzero segment, so time always costs something).
//! * `pnl`: signed FLOOR (toward −∞) — shaves trader gains AND deepens trader
//!   losses by ≤ 1 unit; both directions favor the pool.
//! * `funding_accrued`: FLOOR per position (spec-locked; the sub-unit dust the
//!   trader keeps is bounded by 1 unit and already paid for by the index CEIL).
//! * `units_for` / `max_gain`: FLOOR (exposure and liability never over-count
//!   in the trader's favor).
//! * `shares_for_deposit` / `value_for_shares`: FLOOR (a deposit/withdraw
//!   round-trip can never mint value out of the pool — see round-trip test).
//!
//! ## Caller-guard contract (this module computes; handlers gate)
//!
//! * `units_for(_, 0, _)` and `units_for(0, _, _)` return `Ok(0)` — zero
//!   collateral / leverage floors are `open_leverage`'s guards, not domain
//!   errors here.
//! * `shares_for_deposit` may return `Ok(0)` for a dust deposit into a large
//!   pool — rejecting a 0-share deposit is the CALLER's guard.
//! * `value_for_shares` does not check `shares <= total_shares`; the LP
//!   accounting in `request_withdraw`/`withdraw_lp` guarantees it.
//! * `max_leverage_for_p` with `max_leverage == 0` (leverage disabled) is
//!   gated by the handler BEFORE calling; the taper itself never returns
//!   above `max_leverage` and never below 1 on the tapered branch.

use crate::constants::{BPS_DENOM, INDEX_SCALE, MIN_T_REMAINING_SECS};

/// Pure-math error for the funding module (no Anchor types — handlers map
/// `Overflow -> AmmError::FundingMath`, `Domain` likewise; same pattern as
/// the lmsr error mapping).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FundingError {
    /// A checked mul/add or a downcast to the target width failed.
    Overflow,
    /// An input is outside its documented domain (e.g. mark bps out of range,
    /// funding index moving backwards, zero share supply).
    Domain,
}

/// `BPS_DENOM` widened once — every formula below works in `u128`/`i128`.
const BPS_U128: u128 = BPS_DENOM as u128;

/// Edge (distance to the nearer price boundary, bps) at and beyond which the
/// full configured `max_leverage` is allowed; inside it the cap tapers
/// linearly down to 1x at the boundary (plan §1).
const TAPER_FULL_EDGE_BPS: u64 = 2_000;

/// Explicit ceil division on `u128`: `(num + den - 1) / den`.
/// `den` must be nonzero (all call sites pass a constant-positive denominator).
fn ceil_div_u128(num: u128, den: u128) -> Result<u128, FundingError> {
    Ok(num.checked_add(den - 1).ok_or(FundingError::Overflow)? / den)
}

/// Signed floor division (toward −∞) on `i128`, `den > 0`.
/// Rust `/` truncates toward zero; correct the negative-remainder case so
/// negative pnl rounds AWAY from the trader (pool-favorable).
fn div_floor_i128(num: i128, den: i128) -> i128 {
    let q = num / den;
    if num % den != 0 && num < 0 {
        q - 1
    } else {
        q
    }
}

/// $1-payout-equivalent units for a new position:
/// `U = floor(C * L * BPS / p_entry_bps)`.
///
/// Domain: `p_entry_bps` must be a postable mark, `1..=BPS-1` (marks are
/// range-checked in `post_mark`; 0 would divide by zero, BPS+ would be a
/// settled price, not an entry). The notional `C * L` must also fit `u64`
/// (it is stored in `LevPosition.notional`).
pub fn units_for(
    collateral: u64,
    leverage: u16,
    entry_mark_bps: u16,
) -> Result<u64, FundingError> {
    if entry_mark_bps == 0 || u64::from(entry_mark_bps) >= BPS_DENOM {
        return Err(FundingError::Domain);
    }
    // N = C * L: fits u128 unconditionally (2^64 * 2^16), but must fit the
    // u64 `notional` account field.
    let notional = (collateral as u128)
        .checked_mul(leverage as u128)
        .ok_or(FundingError::Overflow)?;
    u64::try_from(notional).map_err(|_| FundingError::Overflow)?;
    // U = N * BPS / p: N < 2^64, * 10^4 < 2^78 — fits u128; checked anyway.
    let units = notional
        .checked_mul(BPS_U128)
        .ok_or(FundingError::Overflow)?
        / u128::from(entry_mark_bps);
    u64::try_from(units).map_err(|_| FundingError::Overflow)
}

/// Pool-liability bound of a position: `floor(U * (BPS - p_entry) / BPS)` —
/// what the pool pays on top of returning `C` if the outcome resolves to the
/// trader (`p = BPS` ⇒ `pnl = max_gain`, see `pnl`). Result ≤ `units`.
///
/// Domain: `p_entry_bps ∈ 1..=BPS-1` (same as `units_for`).
pub fn max_gain(units: u64, entry_mark_bps: u16) -> Result<u64, FundingError> {
    if entry_mark_bps == 0 || u64::from(entry_mark_bps) >= BPS_DENOM {
        return Err(FundingError::Domain);
    }
    // U * (BPS - p) < 2^64 * 10^4 — fits u128; result ≤ U → fits u64.
    let g = (units as u128)
        .checked_mul(BPS_U128 - u128::from(entry_mark_bps))
        .ok_or(FundingError::Overflow)?
        / BPS_U128;
    u64::try_from(g).map_err(|_| FundingError::Overflow)
}

/// Mark-to-market pnl: `floor_signed(U * (mark - entry) / BPS)` in `i128`,
/// checked downcast to `i64` (errors on overflow — a position whose |pnl|
/// exceeds `i64` cannot be represented and must not settle silently).
///
/// Domain: `entry_mark_bps ∈ 1..=BPS-1`; `mark_bps ∈ 0..=BPS` (0 = resolved
/// against, BPS = resolved for; anything in between is a posted mark).
pub fn pnl(units: u64, entry_mark_bps: u16, mark_bps: u16) -> Result<i64, FundingError> {
    if entry_mark_bps == 0 || u64::from(entry_mark_bps) >= BPS_DENOM {
        return Err(FundingError::Domain);
    }
    if u64::from(mark_bps) > BPS_DENOM {
        return Err(FundingError::Domain);
    }
    // |U * diff| ≤ 2^64 * 10^4 < 2^78 — fits i128 exactly.
    let diff = i128::from(mark_bps) - i128::from(entry_mark_bps);
    let num = (units as i128)
        .checked_mul(diff)
        .ok_or(FundingError::Overflow)?;
    let q = div_floor_i128(num, BPS_U128 as i128);
    i64::try_from(q).map_err(|_| FundingError::Overflow)
}

/// Funding accrued by a position since open:
/// `F = floor(N * (idx_now - idx_snap) / INDEX_SCALE)`.
///
/// Domain: the cumulative index is monotone — `idx_now < idx_snap` is a
/// domain error (corrupt snapshot), never a silent 0.
pub fn funding_accrued(
    notional: u64,
    idx_now: u128,
    idx_snap: u128,
) -> Result<u64, FundingError> {
    let delta = idx_now.checked_sub(idx_snap).ok_or(FundingError::Domain)?;
    let f = (notional as u128)
        .checked_mul(delta)
        .ok_or(FundingError::Overflow)?
        / INDEX_SCALE;
    u64::try_from(f).map_err(|_| FundingError::Overflow)
}

/// Cumulative-funding-index advance for one elapsed segment priced at the
/// previous stored mark `p_prev_bps` (plan §1):
///
/// ```text
/// t_rem     = max(t_remaining_secs, MIN_T_REMAINING_SECS)
/// idx_delta = ceil(time_fee_num * p_prev * (BPS - p_prev) * INDEX_SCALE
///                  * elapsed / (BPS * BPS * t_rem))
/// if valve_multiplier_bps > BPS: idx_delta = ceil(idx_delta * mult / BPS)
/// ```
///
/// * `elapsed_secs <= 0` → `Ok(0)` (clock skew / same-slot repost accrues
///   nothing; `post_mark` additionally requires `elapsed >= 0`).
/// * `t_remaining_secs` is floored at `MIN_T_REMAINING_SECS` — no division
///   by zero and no theta blow-up at expiry.
/// * Valve: `BPS_DENOM` (or anything below) is NEUTRAL; only `mult > BPS`
///   amplifies, and it is capped at `VALVE_MAX_MULTIPLIER_BPS` by
///   `set_risk_valve` (not re-checked here — pure fn).
/// * CEIL end to end: a nonzero segment (`time_fee_num > 0`,
///   `0 < p_prev < BPS`, `elapsed > 0`) NEVER contributes 0 — time is never
///   free (see `idx_delta_never_zero` test).
///
/// Domain: `p_prev_bps <= BPS` (at exactly 0 or BPS the rate is 0 by shape).
pub fn idx_delta(
    time_fee_num: u32,
    p_prev_bps: u16,
    elapsed_secs: i64,
    t_remaining_secs: i64,
    valve_multiplier_bps: u16,
) -> Result<u128, FundingError> {
    if elapsed_secs <= 0 {
        return Ok(0);
    }
    if u64::from(p_prev_bps) > BPS_DENOM {
        return Err(FundingError::Domain);
    }
    let t_rem = t_remaining_secs.max(MIN_T_REMAINING_SECS) as u128;
    let p = u128::from(p_prev_bps);

    // rate_num = tfn * p * (BPS - p) ≤ 2^32 * 10^8 < 2^59 — fits; checked anyway.
    let rate_num = (time_fee_num as u128)
        .checked_mul(p)
        .ok_or(FundingError::Overflow)?
        .checked_mul(BPS_U128 - p)
        .ok_or(FundingError::Overflow)?;
    let num = rate_num
        .checked_mul(INDEX_SCALE)
        .ok_or(FundingError::Overflow)?
        .checked_mul(elapsed_secs as u128)
        .ok_or(FundingError::Overflow)?;
    // den = BPS² * t_rem ≤ 10^8 * 2^63 < 2^90 — fits u128.
    let den = BPS_U128 * BPS_U128 * t_rem;
    let mut delta = ceil_div_u128(num, den)?;

    if u64::from(valve_multiplier_bps) > BPS_DENOM {
        let scaled = delta
            .checked_mul(u128::from(valve_multiplier_bps))
            .ok_or(FundingError::Overflow)?;
        delta = ceil_div_u128(scaled, BPS_U128)?;
    }
    Ok(delta)
}

/// Unified settlement payout: `max(0, C + pnl - F)`, saturating — INFALLIBLE.
///
/// Computed in `i128` (`u64 + i64 - u64` always fits), then clamped to
/// `[0, u64::MAX]`. The zero floor is exactly the "max trader loss = C"
/// guarantee: leveraged pnl can be far below `-C`, the payout cannot.
pub fn settle_payout(collateral: u64, pnl: i64, funding: u64) -> u64 {
    let equity = collateral as i128 + pnl as i128 - funding as i128;
    if equity <= 0 {
        0
    } else if equity > u64::MAX as i128 {
        u64::MAX
    } else {
        equity as u64
    }
}

/// Leverage cap taper (plan §1): full `max_leverage` while the mark is at
/// least `TAPER_FULL_EDGE_BPS` away from BOTH price boundaries; inside that
/// band the cap falls linearly to 1x at the boundary:
///
/// ```text
/// edge = min(p, BPS - p)
/// edge >= 2_000 -> max_leverage
/// else          -> max(1, 1 + (max_leverage - 1) * edge / 2_000)
/// ```
///
/// Infallible and total: `p_bps > BPS` saturates to `edge = 0` → 1x;
/// `max_leverage == 0` (disabled) is the handler's gate (the tapered branch
/// still returns ≥ 1 via the saturating span).
pub fn max_leverage_for_p(p_bps: u16, max_leverage: u16) -> u16 {
    let p = u64::from(p_bps);
    let edge = p.min(BPS_DENOM.saturating_sub(p));
    if edge >= TAPER_FULL_EDGE_BPS {
        return max_leverage;
    }
    let span = u64::from(max_leverage).saturating_sub(1);
    // 1 + span*edge/2000 ≤ max_leverage ≤ u16::MAX — the cast is lossless.
    (1 + span * edge / TAPER_FULL_EDGE_BPS) as u16
}

/// Coverage guard (plan §1), division-free cross-multiplication:
/// `vault_balance * BPS >= min_coverage_bps * (total_max_payout + new_max_payout)`.
///
/// Both sides fit `u128` structurally (`2^64·10^4 < 2^78`; `2^16·2^65 < 2^82`);
/// checked anyway so a widening regression can never wrap.
pub fn coverage_ok(
    vault_balance: u64,
    min_coverage_bps: u16,
    total_max_payout: u64,
    new_max_payout: u64,
) -> Result<bool, FundingError> {
    let lhs = (vault_balance as u128)
        .checked_mul(BPS_U128)
        .ok_or(FundingError::Overflow)?;
    let liability = (total_max_payout as u128)
        .checked_add(new_max_payout as u128)
        .ok_or(FundingError::Overflow)?;
    let rhs = u128::from(min_coverage_bps)
        .checked_mul(liability)
        .ok_or(FundingError::Overflow)?;
    Ok(lhs >= rhs)
}

/// LP shares minted for a deposit of `amount` into a pool holding
/// `vault_balance` against `total_shares` outstanding:
/// first deposit (`total_shares == 0` OR `vault_balance == 0`) mints 1:1;
/// otherwise `floor(amount * total_shares / vault_balance)`.
///
/// FLOOR favors the pool. May return `Ok(0)` for a dust deposit into a large
/// pool — rejecting a 0-share deposit is the CALLER's guard (`deposit_lp`),
/// not a domain error here.
pub fn shares_for_deposit(
    amount: u64,
    total_shares: u64,
    vault_balance: u64,
) -> Result<u64, FundingError> {
    if total_shares == 0 || vault_balance == 0 {
        return Ok(amount);
    }
    let s = (amount as u128)
        .checked_mul(total_shares as u128)
        .ok_or(FundingError::Overflow)?
        / (vault_balance as u128);
    u64::try_from(s).map_err(|_| FundingError::Overflow)
}

/// USDT value of `shares`: `floor(shares * vault_balance / total_shares)`.
///
/// FLOOR favors the pool (paired with `shares_for_deposit`'s floor, a
/// deposit→withdraw round-trip never exceeds the amount put in — see test).
/// Domain: `total_shares == 0` (no supply to value against) is an error.
pub fn value_for_shares(
    shares: u64,
    total_shares: u64,
    vault_balance: u64,
) -> Result<u64, FundingError> {
    if total_shares == 0 {
        return Err(FundingError::Domain);
    }
    let v = (shares as u128)
        .checked_mul(vault_balance as u128)
        .ok_or(FundingError::Overflow)?
        / (total_shares as u128);
    u64::try_from(v).map_err(|_| FundingError::Overflow)
}

// ---------------------------------------------------------------------------
// Tests (plan §3 required list — every bullet has at least one #[test])
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::constants::VALVE_MAX_MULTIPLIER_BPS;

    const BPS: u64 = BPS_DENOM;
    const NEUTRAL: u16 = BPS_DENOM as u16;

    // -- units_for ----------------------------------------------------------

    #[test]
    fn units_for_basic() {
        // C = 100 USDT (6dp), L = 5, p = 5000 → N = 500 USDT, U = N*2.
        assert_eq!(units_for(100_000_000, 5, 5_000).unwrap(), 1_000_000_000);
        // Floor: N*BPS not divisible by p.
        assert_eq!(units_for(1_000, 3, 7_777).unwrap(), 3_857); // 3000*10^4/7777
        // Zero collateral / zero leverage → 0 units (caller guards, not Domain).
        assert_eq!(units_for(0, 5, 5_000).unwrap(), 0);
        assert_eq!(units_for(1_000, 0, 5_000).unwrap(), 0);
    }

    #[test]
    fn units_for_domain_and_overflow() {
        assert_eq!(units_for(1_000, 2, 0), Err(FundingError::Domain));
        assert_eq!(units_for(1_000, 2, 10_000), Err(FundingError::Domain));
        assert_eq!(units_for(1_000, 2, u16::MAX), Err(FundingError::Domain));
        // N = C*L must fit u64 (stored notional).
        assert_eq!(units_for(u64::MAX, 2, 5_000), Err(FundingError::Overflow));
        // U itself can overflow u64 at extreme low entry.
        assert_eq!(units_for(u64::MAX, 1, 1), Err(FundingError::Overflow));
    }

    #[test]
    fn units_for_entry_extremes() {
        // p_entry = 1: deep longshot, U = N * 10_000.
        assert_eq!(units_for(1_000_000, 5, 1).unwrap(), 50_000_000_000);
        // p_entry = 9_999: near-certain, U ≈ N (floor).
        assert_eq!(units_for(1_000_000, 5, 9_999).unwrap(), 5_000_500);
    }

    // -- max_gain / pnl consistency ------------------------------------------

    #[test]
    fn max_gain_matches_pnl_at_resolution_win() {
        for &(c, l, e) in &[
            (1_000_000u64, 5u16, 1u16),
            (1_000_000, 5, 5_000),
            (1_000_000, 5, 9_999),
            (123_456_789, 20, 3_333),
        ] {
            let u = units_for(c, l, e).unwrap();
            let g = max_gain(u, e).unwrap();
            // Resolved-for: p = BPS ⇒ pnl == max_gain (same floor, same formula).
            assert_eq!(pnl(u, e, 10_000).unwrap(), i64::try_from(g).unwrap());
        }
        assert_eq!(max_gain(1_000, 0), Err(FundingError::Domain));
        assert_eq!(max_gain(1_000, 10_000), Err(FundingError::Domain));
    }

    // -- pnl -----------------------------------------------------------------

    #[test]
    fn pnl_zero_at_entry_and_domain() {
        assert_eq!(pnl(1_000_000, 4_200, 4_200).unwrap(), 0);
        assert_eq!(pnl(1_000, 0, 5_000), Err(FundingError::Domain));
        assert_eq!(pnl(1_000, 10_000, 5_000), Err(FundingError::Domain));
        assert_eq!(pnl(1_000, 5_000, 10_001), Err(FundingError::Domain));
        // mark = 0 (resolved against) and mark = BPS (resolved for) are legal.
        assert_eq!(pnl(10_000, 5_000, 0).unwrap(), -5_000);
        assert_eq!(pnl(10_000, 5_000, 10_000).unwrap(), 5_000);
    }

    #[test]
    fn pnl_sign_symmetry() {
        // floor(x) + floor(-x) == 0 when exact, -1 otherwise; equal-magnitude
        // moves in opposite directions can differ by AT MOST the 1-unit floor
        // bias, and that bias is always against the trader (more negative).
        let u = 1_234_567u64;
        for d in (100u16..=4_000).step_by(100) {
            let e = 5_000u16;
            let up = pnl(u, e, e + d).unwrap();
            let down = pnl(u, e, e - d).unwrap();
            let s = i128::from(up) + i128::from(down);
            assert!(s == 0 || s == -1, "d={d} up={up} down={down}");
            if (u as u128 * d as u128) % (BPS as u128) == 0 {
                assert_eq!(up, -down);
            }
        }
        // Exactly divisible case is exactly symmetric.
        assert_eq!(pnl(10_000, 5_000, 6_000).unwrap(), 1_000);
        assert_eq!(pnl(10_000, 5_000, 4_000).unwrap(), -1_000);
    }

    #[test]
    fn pnl_floor_is_toward_negative_infinity() {
        // U=3, entry=5000, mark=4999: exact = -3/10000 → floor = -1 (NOT 0).
        assert_eq!(pnl(3, 5_000, 4_999).unwrap(), -1);
        // Positive side floors toward zero: +3/10000 → 0.
        assert_eq!(pnl(3, 5_000, 5_001).unwrap(), 0);
    }

    #[test]
    fn pnl_overflow_downcast() {
        // U = u64::MAX, entry=1 → pnl at BPS ≈ u64::MAX > i64::MAX.
        assert_eq!(pnl(u64::MAX, 1, 10_000), Err(FundingError::Overflow));
    }

    // -- settle_payout --------------------------------------------------------

    #[test]
    fn settle_payout_paths() {
        // Win path: C + max_gain - F.
        assert_eq!(settle_payout(1_000_000, 4_000_000, 300_000), 4_700_000);
        // Void-style: pnl = 0, refund C - F.
        assert_eq!(settle_payout(1_000_000, 0, 300_000), 700_000);
        // Exact zero equity.
        assert_eq!(settle_payout(1_000_000, -700_000, 300_000), 0);
    }

    #[test]
    fn settle_payout_loss_capped_at_collateral() {
        // Levered pnl far below -C: payout floors at 0, never underflows.
        assert_eq!(settle_payout(1_000_000, -50_000_000, 0), 0);
        assert_eq!(settle_payout(1_000_000, i64::MIN, u64::MAX), 0);
        // Upper clamp (unreachable economically, but infallible by contract).
        assert_eq!(settle_payout(u64::MAX, i64::MAX, 0), u64::MAX);
    }

    #[test]
    fn settle_units_pnl_round_trip_extremes() {
        // Entry 9_999, resolved against: floor makes pnl = -5_000_000 (just
        // past -C for this L=5 position) — the clamp caps the loss at C.
        let c = 1_000_000u64;
        let u = units_for(c, 5, 9_999).unwrap(); // 5_000_500
        let p = pnl(u, 9_999, 0).unwrap();
        assert_eq!(p, -5_000_000);
        assert_eq!(settle_payout(c, p, 0), 0);

        // Entry 1, resolved for: payout = C + max_gain.
        let u = units_for(c, 5, 1).unwrap();
        let g = max_gain(u, 1).unwrap();
        let p = pnl(u, 1, 10_000).unwrap();
        assert_eq!(p, i64::try_from(g).unwrap());
        assert_eq!(settle_payout(c, p, 0), c + g);
    }

    // -- funding_accrued -------------------------------------------------------

    #[test]
    fn funding_accrued_basic_and_floor() {
        // N * Δidx / SCALE, floored.
        assert_eq!(
            funding_accrued(10_000_000, 2 * INDEX_SCALE, INDEX_SCALE).unwrap(),
            10_000_000
        );
        // Dust below one unit floors to 0.
        assert_eq!(funding_accrued(1, 999_999_999_999, 0).unwrap(), 0);
        assert_eq!(funding_accrued(1, INDEX_SCALE, 0).unwrap(), 1);
        // No accrual over a zero segment.
        assert_eq!(funding_accrued(10_000_000, 42, 42).unwrap(), 0);
    }

    #[test]
    fn funding_accrued_domain_backwards_index() {
        assert_eq!(funding_accrued(1_000, 5, 6), Err(FundingError::Domain));
    }

    // -- idx_delta -------------------------------------------------------------

    #[test]
    fn idx_delta_zero_or_negative_elapsed_is_zero() {
        assert_eq!(idx_delta(1_000, 5_000, 0, 1_000, NEUTRAL).unwrap(), 0);
        assert_eq!(idx_delta(1_000, 5_000, -5, 1_000, NEUTRAL).unwrap(), 0);
    }

    #[test]
    fn idx_delta_domain_and_boundary_marks() {
        assert_eq!(
            idx_delta(1_000, 10_001, 10, 1_000, NEUTRAL),
            Err(FundingError::Domain)
        );
        // p = 0 / BPS: rate shape p(BPS-p) is exactly 0 — allowed, accrues 0.
        assert_eq!(idx_delta(1_000, 0, 10, 1_000, NEUTRAL).unwrap(), 0);
        assert_eq!(idx_delta(1_000, 10_000, 10, 1_000, NEUTRAL).unwrap(), 0);
    }

    #[test]
    fn idx_delta_never_zero_for_nonzero_inputs() {
        // Minimal fee slope, minimal elapsed, huge t_rem: CEIL still ≥ 1 for
        // every interior mark — time is never free.
        for p in 1..BPS as u16 {
            let d = idx_delta(1, p, 1, 1_000_000_000_000_000_000, NEUTRAL).unwrap();
            assert!(d >= 1, "p={p} delta=0");
        }
    }

    #[test]
    fn theta_peaks_at_p_5000_and_is_symmetric() {
        let peak = idx_delta(1_000, 5_000, 100, 1_000, NEUTRAL).unwrap();
        for p in (100u16..=9_900).step_by(100) {
            let d = idx_delta(1_000, p, 100, 1_000, NEUTRAL).unwrap();
            if p != 5_000 {
                assert!(d < peak, "p={p} d={d} peak={peak}");
            }
            // Symmetry of p(BPS-p): theta(p) == theta(BPS - p).
            let mirror = idx_delta(1_000, (BPS as u16) - p, 100, 1_000, NEUTRAL).unwrap();
            assert_eq!(d, mirror, "p={p}");
        }
    }

    #[test]
    fn theta_grows_as_t_remaining_shrinks_and_floors_at_min() {
        let mut prev = 0u128;
        for &t_rem in &[100_000i64, 10_000, 1_000, 300, 60] {
            let d = idx_delta(1_000, 5_000, 100, t_rem, NEUTRAL).unwrap();
            assert!(d > prev, "t_rem={t_rem}: theta must grow toward expiry");
            prev = d;
        }
        // Below the floor everything is priced as MIN_T_REMAINING_SECS.
        let at_min = idx_delta(1_000, 5_000, 100, MIN_T_REMAINING_SECS, NEUTRAL).unwrap();
        for &t_rem in &[59i64, 1, 0, -100] {
            assert_eq!(
                idx_delta(1_000, 5_000, 100, t_rem, NEUTRAL).unwrap(),
                at_min
            );
        }
    }

    #[test]
    fn idx_delta_valve_multiplier() {
        let base = idx_delta(1_000, 5_000, 100, 1_000, NEUTRAL).unwrap();
        // Neutral and below-neutral multipliers change nothing (only > BPS applies).
        assert_eq!(idx_delta(1_000, 5_000, 100, 1_000, 0).unwrap(), base);
        assert_eq!(idx_delta(1_000, 5_000, 100, 1_000, 5_000).unwrap(), base);
        // Max valve = exactly ×5 of the base (base*50_000 divisible by 10_000).
        let maxed = idx_delta(1_000, 5_000, 100, 1_000, VALVE_MAX_MULTIPLIER_BPS).unwrap();
        assert_eq!(maxed, base * 5);
        // Ceil on a non-divisible multiplier: delta=1, mult=10_001 → ceil = 2.
        let one = idx_delta(1, 1, 1, 1_000_000_000_000_000_000, NEUTRAL).unwrap();
        assert_eq!(one, 1);
        let bumped = idx_delta(1, 1, 1, 1_000_000_000_000_000_000, 10_001).unwrap();
        assert_eq!(bumped, 2);
    }

    #[test]
    fn idx_delta_overflow_is_an_error_not_a_wrap() {
        assert_eq!(
            idx_delta(u32::MAX, 5_000, i64::MAX, 60, NEUTRAL),
            Err(FundingError::Overflow)
        );
    }

    #[test]
    fn epoch_vs_full_life_economic_sanity() {
        // A winning path (mark rising away from a 5000 entry): rolling accrual
        // priced per epoch at the CURRENT mark must cost less than a one-shot
        // lifetime premium priced at the entry mark — the rolling design
        // rewards positions that move toward certainty (SPEC §2.2 rationale).
        let tfn = 1_000u32;
        // 5 epochs × 100s against a 1000s horizon; marks rise 5000 → 9500.
        let p_prev = [5_000u16, 8_000, 8_500, 9_000, 9_500];
        let mut rolling: u128 = 0;
        for (k, &p) in p_prev.iter().enumerate() {
            let t_rem = 1_000 - 100 * (k as i64 + 1); // freeze_ts - now at post
            rolling += idx_delta(tfn, p, 100, t_rem, NEUTRAL).unwrap();
        }
        // One-shot: theta at entry (p=5000, full 1000s horizon) over the same
        // 500s of life, paid up-front.
        let one_shot = idx_delta(tfn, 5_000, 500, 1_000, NEUTRAL).unwrap();
        assert!(
            rolling < one_shot,
            "rolling={rolling} one_shot={one_shot}"
        );
        // Same ordering in position money terms.
        let n = 10_000_000u64;
        let f_roll = funding_accrued(n, rolling, 0).unwrap();
        let f_shot = funding_accrued(n, one_shot, 0).unwrap();
        assert!(f_roll < f_shot);
    }

    #[test]
    fn fee_death_monotonicity() {
        // Index only grows ⇒ F nondecreasing ⇒ equity nonincreasing; once
        // F ≥ C the position is dead (payout 0 at flat mark) and STAYS dead.
        let c = 1_000_000u64;
        let n = 10_000_000u64; // 10x
        let per_epoch = idx_delta(1, 5_000, 100, 10_000, NEUTRAL).unwrap();
        assert!(per_epoch > 0);
        let mut idx: u128 = 0;
        let mut prev_f = 0u64;
        let mut prev_payout = settle_payout(c, 0, 0);
        let mut died = false;
        for _ in 0..60 {
            idx += per_epoch;
            let f = funding_accrued(n, idx, 0).unwrap();
            assert!(f >= prev_f, "funding must be nondecreasing");
            let payout = settle_payout(c, 0, f);
            assert!(payout <= prev_payout, "equity must be nonincreasing");
            if f >= c {
                died = true;
            }
            if died {
                assert_eq!(payout, 0, "fee-death is permanent at flat mark");
            }
            prev_f = f;
            prev_payout = payout;
        }
        assert!(died, "10x at max theta must fee-die within the horizon");
    }

    // -- leverage taper ----------------------------------------------------------

    #[test]
    fn taper_edges() {
        let l = 10u16;
        // Boundaries: 1x.
        assert_eq!(max_leverage_for_p(0, l), 1);
        assert_eq!(max_leverage_for_p(10_000, l), 1);
        // Full band [2000, 8000]: max.
        assert_eq!(max_leverage_for_p(2_000, l), l);
        assert_eq!(max_leverage_for_p(5_000, l), l);
        assert_eq!(max_leverage_for_p(8_000, l), l);
        // Just inside the taper: 1 + 9*1999/2000 = 9.
        assert_eq!(max_leverage_for_p(1_999, l), 9);
        assert_eq!(max_leverage_for_p(8_001, l), 9);
        // Deep taper floors at 1 (1 + 9*100/2000 = 1).
        assert_eq!(max_leverage_for_p(100, l), 1);
        // Out-of-range p saturates to edge 0 → 1x (total function).
        assert_eq!(max_leverage_for_p(u16::MAX, l), 1);
    }

    #[test]
    fn taper_symmetry_property() {
        for l in [2u16, 5, 10, 100, u16::MAX] {
            for p in (0u32..=10_000).step_by(100) {
                let p = p as u16;
                assert_eq!(
                    max_leverage_for_p(p, l),
                    max_leverage_for_p(10_000 - p, l),
                    "p={p} l={l}"
                );
            }
        }
    }

    #[test]
    fn taper_degenerate_max_leverage() {
        // max_leverage = 1: taper can never go below 1 nor above 1.
        for p in (0u32..=10_000).step_by(500) {
            assert_eq!(max_leverage_for_p(p as u16, 1), 1);
        }
        // max_leverage = 0 is "disabled" — handler gates before calling; the
        // pure fn stays total (0 in the full band, 1 on the tapered branch).
        assert_eq!(max_leverage_for_p(5_000, 0), 0);
        assert_eq!(max_leverage_for_p(100, 0), 1);
    }

    // -- coverage ------------------------------------------------------------------

    #[test]
    fn coverage_basic_and_boundary() {
        // 120% requirement: vault 120 covers liability 100 exactly.
        assert!(coverage_ok(120, 12_000, 60, 40).unwrap());
        assert!(!coverage_ok(119, 12_000, 60, 40).unwrap());
        // Empty book is always covered.
        assert!(coverage_ok(0, 12_000, 0, 0).unwrap());
        assert!(!coverage_ok(0, 12_000, 0, 1).unwrap());
    }

    #[test]
    fn coverage_cross_multiply_overflow_safety() {
        // Extremes fit the u128 cross-multiply — no wrap, no error, correct sign.
        assert!(!coverage_ok(u64::MAX, u16::MAX, u64::MAX, u64::MAX).unwrap());
        assert!(coverage_ok(u64::MAX, 10_000, u64::MAX, 0).unwrap());
        assert!(coverage_ok(u64::MAX, 0, u64::MAX, u64::MAX).unwrap());
    }

    // -- LP shares -------------------------------------------------------------------

    #[test]
    fn shares_first_deposit_branches() {
        assert_eq!(shares_for_deposit(1_000, 0, 0).unwrap(), 1_000);
        // Vault emptied but shares outstanding (pool blown): re-seed 1:1.
        assert_eq!(shares_for_deposit(1_000, 500, 0).unwrap(), 1_000);
        // Donation before first deposit (vault > 0, shares 0): still 1:1.
        assert_eq!(shares_for_deposit(1_000, 0, 999).unwrap(), 1_000);
    }

    #[test]
    fn shares_floor_and_dust() {
        // floor(999 * 100 / 1_000_000) = 0 — documented; caller guards.
        assert_eq!(shares_for_deposit(999, 100, 1_000_000).unwrap(), 0);
        assert_eq!(shares_for_deposit(10_000, 100, 1_000_000).unwrap(), 1);
    }

    #[test]
    fn value_for_shares_domain_and_floor() {
        assert_eq!(value_for_shares(1, 0, 1_000), Err(FundingError::Domain));
        assert_eq!(value_for_shares(1, 3, 1_000).unwrap(), 333);
        assert_eq!(value_for_shares(3, 3, 1_000).unwrap(), 1_000);
        assert_eq!(value_for_shares(0, 3, 1_000).unwrap(), 0);
    }

    #[test]
    fn share_round_trip_floor_favors_pool() {
        // Deposit then immediately withdraw the minted shares: never receive
        // more than deposited, for a grid of pool states.
        for &(total, vault) in &[
            (0u64, 0u64),
            (1_000, 1_000),
            (1_000, 3_337),
            (7, 1_000_000_007),
            (1_000_000, 999_999),
            (123_456_789, 987_654_321),
        ] {
            for &amount in &[1u64, 999, 10_000, 123_457, 100_000_000] {
                let s = shares_for_deposit(amount, total, vault).unwrap();
                let new_total = total + s;
                let new_vault = vault + amount;
                if new_total == 0 {
                    continue; // 0-share dust deposit into empty pool — caller rejects
                }
                let v = value_for_shares(s, new_total, new_vault).unwrap();
                assert!(
                    v <= amount,
                    "round trip minted value: total={total} vault={vault} \
                     amount={amount} shares={s} value={v}"
                );
            }
        }
    }
}

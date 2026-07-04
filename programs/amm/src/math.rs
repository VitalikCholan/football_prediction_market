//! Pure CPMM math — no Anchor account types, unit-testable in a plain harness.
//!
//! ## Reserve model (DECISION D-2: virtual reserves)
//!
//! `yes_reserve` (x) and `no_reserve` (y) are **virtual**: they exist ONLY to set
//! the price via the constant product `x·y = k`. They do NOT hold real money.
//!
//! A trade is a pure constant-product swap over the two virtual reserves:
//!   * It MOVES THE PRICE and sets the token/USDC amount (`buy`/`sell` helpers).
//!   * It never holds value — ALL real USDC lives in the vault. 1 winning token
//!     redeems for exactly 1 USDC at resolution.
//!
//! ## Hard solvency invariant (re-checked after every buy/sell/redeem)
//!
//! `vault_usdc >= max(yes_supply, no_supply)`
//!
//! Because at resolution exactly one side wins and each winning token redeems for
//! 1 USDC, the vault must cover the larger of the two supplies. `assert_solvent`
//! enforces this; every mutating instruction calls it at the tail.
//!
//! ## Rounding
//! All intermediates are `u128`. `new_y` is CEIL-rounded (pool-favorable), which
//! shrinks the trader's output so `k = new_x * new_y` never DECREASES due to
//! rounding — the pool can only gain from rounding, never leak value.

use crate::constants::BPS_DENOM;
use crate::error::AmmError;

/// Constant-product swap: tokens out for a net (post-fee) amount in.
///
/// `out = reserve_out - ceil(k / (reserve_in + amount_in_net))` (output
/// pool-favorable — floored by construction of the ceil on `new_y`).
/// `reserve_in`  = the reserve the input is added to,
/// `reserve_out` = the reserve tokens are removed from.
pub fn compute_out(
    reserve_in: u64,
    reserve_out: u64,
    amount_in_net: u64,
) -> Result<u64, AmmError> {
    if reserve_in == 0 || reserve_out == 0 {
        return Err(AmmError::ZeroReserve);
    }
    if amount_in_net == 0 {
        return Err(AmmError::ZeroAmount);
    }

    let x = reserve_in as u128;
    let y = reserve_out as u128;
    let dx = amount_in_net as u128;

    let k = x.checked_mul(y).ok_or(AmmError::MathOverflow)?;
    let new_x = x.checked_add(dx).ok_or(AmmError::MathOverflow)?;
    // CEIL division of new_y → pool-favorable: rounding new_y UP shrinks `out`,
    // so `k` (= new_x * new_y) never decreases due to rounding.
    let new_y = k
        .checked_add(new_x - 1)
        .ok_or(AmmError::MathOverflow)?
        .checked_div(new_x)
        .ok_or(AmmError::DivideByZero)?;
    // new_y <= y always (adding to x shrinks y), so this cannot underflow.
    let out = y.checked_sub(new_y).ok_or(AmmError::MathOverflow)?;

    // Output must strictly leave the pool with a positive reserve.
    if out >= y {
        return Err(AmmError::OutputExceedsReserve);
    }

    u64::try_from(out).map_err(|_| AmmError::NumericConversion)
}

/// YES price in bps (0..=10_000) from the reserves.
///
/// YES becomes more expensive as YES gets scarcer, i.e. price rises when
/// `no_reserve` dominates: `price = no_reserve / (yes_reserve + no_reserve)`.
pub fn price_yes_bps(yes_reserve: u64, no_reserve: u64) -> Result<u16, AmmError> {
    let total = (yes_reserve as u128)
        .checked_add(no_reserve as u128)
        .ok_or(AmmError::MathOverflow)?;
    if total == 0 {
        return Err(AmmError::ZeroReserve);
    }
    let price = (no_reserve as u128)
        .checked_mul(BPS_DENOM as u128)
        .ok_or(AmmError::MathOverflow)?
        .checked_div(total)
        .ok_or(AmmError::DivideByZero)?;
    // price <= BPS_DENOM by construction.
    u16::try_from(price).map_err(|_| AmmError::NumericConversion)
}

/// D-2 solvency invariant: `vault_usdc >= max(yes_supply, no_supply)`.
pub fn assert_solvent(
    vault_usdc: u64,
    yes_supply: u64,
    no_supply: u64,
) -> Result<(), AmmError> {
    let max_supply = yes_supply.max(no_supply);
    if vault_usdc < max_supply {
        return Err(AmmError::SolvencyViolation);
    }
    Ok(())
}

/// The constant product `k = x * y` in u128, for invariant assertions/tests.
pub fn k_of(x: u64, y: u64) -> Result<u128, AmmError> {
    (x as u128).checked_mul(y as u128).ok_or(AmmError::MathOverflow)
}

// ---------------------------------------------------------------------------
// Buy / sell helpers (virtual-reserve swap model, D-2)
// ---------------------------------------------------------------------------
//
// Reserves are virtual; the vault (not the reserves) holds the real USDC.
// A trade is a pure constant-product swap over the two reserves that MOVES THE
// PRICE and determines the token/USDC amount. Solvency (`vault >= max(supply)`)
// is enforced separately by `assert_solvent` at the instruction tail.
//
// YES price `p = no/(yes+no)`.
//   * Buy YES: add USDC to `no_reserve`, remove YES from `yes_reserve`
//     (yes↓, no↑ ⇒ p↑). tokens_out = compute_out(no, yes, usdc).
//   * Buy NO : add USDC to `yes_reserve`, remove NO from `no_reserve` (p↓).
//   * Sell YES: return YES to `yes_reserve`, remove USDC from `no_reserve`
//     (yes↑, no↓ ⇒ p↓) — the exact inverse curve, so a round trip is always
//     loss-making (ceil rounding is pool-favorable on every leg).

/// Result of a buy: tokens credited to the trader and the new reserves.
pub struct BuyResult {
    pub tokens_out: u64,
    pub new_yes_reserve: u64,
    pub new_no_reserve: u64,
}

/// Buy `side` for a net (post-fee) USDC amount.
pub fn buy(
    side_yes: bool,
    yes_reserve: u64,
    no_reserve: u64,
    amount_in_net: u64,
) -> Result<BuyResult, AmmError> {
    if amount_in_net == 0 {
        return Err(AmmError::ZeroAmount);
    }

    if side_yes {
        // add USDC to NO reserve, remove YES
        let tokens_out = compute_out(no_reserve, yes_reserve, amount_in_net)?;
        let new_no_reserve = no_reserve
            .checked_add(amount_in_net)
            .ok_or(AmmError::MathOverflow)?;
        let new_yes_reserve = yes_reserve
            .checked_sub(tokens_out)
            .ok_or(AmmError::MathOverflow)?;
        Ok(BuyResult {
            tokens_out,
            new_yes_reserve,
            new_no_reserve,
        })
    } else {
        // add USDC to YES reserve, remove NO
        let tokens_out = compute_out(yes_reserve, no_reserve, amount_in_net)?;
        let new_yes_reserve = yes_reserve
            .checked_add(amount_in_net)
            .ok_or(AmmError::MathOverflow)?;
        let new_no_reserve = no_reserve
            .checked_sub(tokens_out)
            .ok_or(AmmError::MathOverflow)?;
        Ok(BuyResult {
            tokens_out,
            new_yes_reserve,
            new_no_reserve,
        })
    }
}

/// Result of a sell: gross USDC (before fee) and the new reserves.
pub struct SellResult {
    pub usdc_gross: u64,
    pub new_yes_reserve: u64,
    pub new_no_reserve: u64,
}

/// Sell `tokens_in` of `side` back to the pool — the exact inverse of `buy`.
pub fn sell(
    side_yes: bool,
    yes_reserve: u64,
    no_reserve: u64,
    tokens_in: u64,
) -> Result<SellResult, AmmError> {
    if tokens_in == 0 {
        return Err(AmmError::ZeroAmount);
    }

    if side_yes {
        // return YES to YES reserve, remove USDC from NO reserve
        let usdc_gross = compute_out(yes_reserve, no_reserve, tokens_in)?;
        let new_yes_reserve = yes_reserve
            .checked_add(tokens_in)
            .ok_or(AmmError::MathOverflow)?;
        let new_no_reserve = no_reserve
            .checked_sub(usdc_gross)
            .ok_or(AmmError::MathOverflow)?;
        Ok(SellResult {
            usdc_gross,
            new_yes_reserve,
            new_no_reserve,
        })
    } else {
        // return NO to NO reserve, remove USDC from YES reserve
        let usdc_gross = compute_out(no_reserve, yes_reserve, tokens_in)?;
        let new_no_reserve = no_reserve
            .checked_add(tokens_in)
            .ok_or(AmmError::MathOverflow)?;
        let new_yes_reserve = yes_reserve
            .checked_sub(usdc_gross)
            .ok_or(AmmError::MathOverflow)?;
        Ok(SellResult {
            usdc_gross,
            new_yes_reserve,
            new_no_reserve,
        })
    }
}

// ===========================================================================
// Unit tests (§10.1 cases 5, 8)
// ===========================================================================
#[cfg(test)]
mod tests {
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
}

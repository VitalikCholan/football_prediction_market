//! Pure fixed-point LMSR for the 3-way (1X2) market — SPEC §3.1, phase A.
//! No Anchor account types; unit-testable in a plain harness (mirrors
//! `math.rs`/`fee.rs`). Nothing on-chain calls this yet — it is the math
//! foundation for the Team1/Draw/Team2 market rework.
//!
//! ## Model (Hanson LMSR, N = 3 outcomes)
//!
//! ```text
//! cost:   C(q) = b · ln( Σ_i exp(q_i / b) )        q_i = net tokens minted of outcome i
//! price:  p_i  = exp(q_i/b) / Σ_j exp(q_j/b)       softmax → Σ p_i = 1 BY CONSTRUCTION
//! trade:  buy Δ of i costs  C(q + Δ·e_i) − C(q)
//! loss:   bounded ≤ b · ln(3)                      max subsidy the vault can lose
//! ```
//!
//! ## Representation: Q64.64 fixed point in `u128` (SPEC default)
//!
//! 64 integer bits, 64 fractional bits; `ONE_Q64 = 2^64`. All transcendental
//! work happens on SHIFTED exponents (see below) so every `exp` value lives in
//! `(0, 1]` and every `ln` argument in `[1, 3]` — comfortably inside Q64.64.
//! Products use a full 256-bit intermediate (`mul_q64`, 64-bit limb split), so
//! no intermediate can silently wrap; every step is checked.
//!
//! ## Numeric hygiene: softmax shift-invariance (max-subtraction)
//!
//! `C(q) = max(q) + b·ln(Σ exp((q_i − max(q))/b))`. All exponents are ≤ 0, so
//! `exp` never overflows; the max term is EXACTLY `exp(0) = 1`, so the sum is
//! in `[1, 3]` and `ln(sum) ∈ [0, ln 3]`. Deeply dominated outcomes underflow
//! to 0 (contribution < 2^-64 — documented, pool-safe). Shift-invariance of
//! prices is structural: equal shifts of all `q_i` cancel in the subtraction.
//!
//! ## Kernels and error bounds
//!
//! * `exp_neg_q64(x) = e^(−x)`: range-reduce by ln 2 (`x = k·ln2 + r`,
//!   `r ∈ [0, ln2)`), then the sign-free paired Taylor series
//!   `e^(−r) = Σ_j r^(2j)/(2j)! · (1 − r/(2j+1))` (every pair positive — no
//!   alternating-sign cancellation in unsigned math), then `>> k`.
//!   Converges to < 2^-64 within 13 pairs; measured absolute error vs an f64
//!   oracle < 2e-16 (bounded ≤ 2^-57 by op-count analysis).
//! * `ln_q64(y)`, `y ≥ 1`: normalize `y = 2^e·m`, `m ∈ [1,2)`, then the atanh
//!   series `ln m = 2·Σ z^(2n+1)/(2n+1)`, `z = (m−1)/(m+1) ∈ [0, 1/3)`.
//!   Converges to < 2^-64 within 21 terms; measured absolute error < 3e-16.
//! * `cost_q64` absolute error ≤ `b · 2^-55` (conservative), i.e. < 1 base
//!   unit for every `b < 2^55`; relative error vs f64 measured < 1e-12.
//!
//! ## Supported ranges (enforced with errors, never panics)
//!
//! * `b ∈ [B_MIN, B_MAX] = [10^3, 2^60]` base units.
//! * `q_i ≤ Q_MAX = 2^60` base units (also caps `q_i + delta` on buys).
//!
//! These guarantee every intermediate fits: `(m − q_i) << 64 ≤ 2^124`,
//! `m << 64 ≤ 2^124`, `b·ln(sum) ≤ 2^60 · 1.1·2^64 < 2^125`, and the u64
//! `cost` result ≤ `Q_MAX + b·ln3 < 2^62`.
//!
//! ## Rounding policy — ALWAYS pool-favorable
//!
//! * `buy_cost` = CEIL of the cost delta, floored at 1 (a buy is never free).
//! * `sell_refund` = FLOOR of the cost delta.
//! * `cost` (u64) = CEIL (reserve enough, never under-count the liability).
//! * `prices_bps` = FLOOR per outcome → `Σ prices ∈ [10_000 − 3, 10_000]`
//!   (documented rounding band; the deficit is the pool's spread).
//!
//! Both trade legs evaluate the SAME deterministic `cost_q64`, so a
//! buy-then-sell round trip of the same delta telescopes to
//! `ceil(d) ≥ floor(d)` — the trader can never profit from rounding or from
//! approximation error.
//!
//! ## Bounded loss (structural, approximation-proof)
//!
//! `cost_q64(q) ≥ max_i(q_i)` EXACTLY: the max term of the shifted sum is
//! exactly `ONE`, so `sum ≥ 1` and the (floor-rounded) `ln ≥ 0`. Collected
//! premiums telescope to ≥ `C(q_final) − C(q_0)` (ceil on buys, floor on
//! refunds), so LP loss = `max(q_final) − collected ≤ C(q_0)`; from
//! `q_0 = 0` that is `b·ln̂(3) ≤ b·ln 3` up to one rounding unit — the classic
//! `b·ln(N)` bound survives fixed-point truncation.

use crate::constants::BPS_DENOM;
use crate::error::AmmError;

/// Number of outcomes: Team1 / Draw / Team2.
pub const N_OUTCOMES: usize = 3;

/// Q64.64 fixed-point one (`2^64`).
pub const ONE_Q64: u128 = 1u128 << 64;

/// `floor(ln(2) · 2^64)` — range-reduction constant. Off by < 1 ulp from true
/// ln 2; the induced result error is ≤ 64 ulp ≈ 2^-58 (inside the stated bounds).
pub const LN2_Q64: u128 = 12_786_308_645_202_655_659; // 0xB17217F7D1CF79AB

/// Max supported net outcome quantity (base units): `2^60`.
pub const Q_MAX: u64 = 1 << 60;

/// Min supported liquidity parameter `b` (base units). Below this the
/// per-unit price granularity dwarfs the curve.
pub const B_MIN: u64 = 1_000;

/// Max supported liquidity parameter `b` (base units): `2^60`.
pub const B_MAX: u64 = 1 << 60;

/// Iteration caps — both series converge to < 2^-64 well inside these
/// (13 pairs / 21 terms); the caps are a belt against a logic regression.
const EXP_MAX_PAIRS: u128 = 20;
const LN_MAX_TERMS: u128 = 40;

// ---------------------------------------------------------------------------
// Q64.64 primitives
// ---------------------------------------------------------------------------

/// `(a · b) >> 64` with a full 256-bit intermediate (64-bit limb split),
/// floor-rounded. Errors only if the RESULT exceeds `u128`.
fn mul_q64(a: u128, b: u128) -> Result<u128, AmmError> {
    const MASK: u128 = (1u128 << 64) - 1;
    let (a_hi, a_lo) = (a >> 64, a & MASK);
    let (b_hi, b_lo) = (b >> 64, b & MASK);

    // (a·b) >> 64 = (a_hi·b_hi) << 64 + a_hi·b_lo + a_lo·b_hi + ((a_lo·b_lo) >> 64)
    // Each cross product has both factors < 2^64, so it fits u128 exactly.
    let hh = a_hi.checked_mul(b_hi).ok_or(AmmError::MathOverflow)?;
    if hh > (u128::MAX >> 64) {
        return Err(AmmError::MathOverflow);
    }
    (hh << 64)
        .checked_add(a_hi * b_lo)
        .ok_or(AmmError::MathOverflow)?
        .checked_add(a_lo * b_hi)
        .ok_or(AmmError::MathOverflow)?
        .checked_add((a_lo * b_lo) >> 64)
        .ok_or(AmmError::MathOverflow)
}

/// `exp(−x)` for `x ≥ 0` in Q64.64 → Q64.64 in `[0, ONE]`.
///
/// Range-reduce `x = k·ln2 + r` (`r ∈ [0, ln2)`), evaluate the sign-free
/// paired Taylor series for `e^(−r) ∈ (1/2, 1]`, then shift by `k`.
/// For `k ≥ 64` the true value is < 2^-64 and UNDERFLOWS TO 0 (documented;
/// pool-safe because callers only ever ADD these terms to a sum ≥ 1).
pub fn exp_neg_q64(x: u128) -> Result<u128, AmmError> {
    let k = x / LN2_Q64;
    if k >= 64 {
        return Ok(0);
    }
    // r ∈ [0, LN2_Q64) — cannot underflow by construction of k.
    let r = x - k * LN2_Q64;

    // e^(−r) = Σ_j t_j · (1 − r/(2j+1)),  t_j = r^(2j)/(2j)!  (all pairs ≥ 0)
    let r_sq = mul_q64(r, r)?;
    let mut t = ONE_Q64;
    let mut sum: u128 = 0;
    let mut j: u128 = 0;
    loop {
        let frac = r / (2 * j + 1); // < ONE since r < ONE
        let pair = mul_q64(t, ONE_Q64 - frac)?;
        sum = sum.checked_add(pair).ok_or(AmmError::MathOverflow)?;
        t = mul_q64(t, r_sq)? / ((2 * j + 1) * (2 * j + 2));
        if t == 0 || j >= EXP_MAX_PAIRS {
            break;
        }
        j += 1;
    }
    // Clamp: per-op floor rounding can overshoot by ≤ ~21 ulp near r → 0;
    // e^(−r) ≤ 1 must hold so the shifted-max term stays exactly ONE.
    Ok(sum.min(ONE_Q64) >> k)
}

/// `ln(y)` for `y ≥ 1` in Q64.64 → Q64.64 (unsigned; domain error below 1).
///
/// Normalize `y = 2^e · m` with `m ∈ [1, 2)`, then the atanh series
/// `ln m = 2·Σ z^(2n+1)/(2n+1)` with `z = (m−1)/(m+1) ∈ [0, 1/3)`.
pub fn ln_q64(y: u128) -> Result<u128, AmmError> {
    if y < ONE_Q64 {
        return Err(AmmError::LmsrDomain);
    }
    let mut m = y;
    let mut e: u128 = 0;
    while m >= 2 * ONE_Q64 {
        m >>= 1;
        e += 1;
    }

    // z = (m − 1)/(m + 1); m − 1 < ONE so the << 64 fits u128.
    let num = m - ONE_Q64;
    let den = m.checked_add(ONE_Q64).ok_or(AmmError::MathOverflow)?;
    let z = (num << 64) / den;

    let z_sq = mul_q64(z, z)?;
    let mut term = z; // z^(2n+1)
    let mut acc = z; // Σ z^(2n+1)/(2n+1)
    let mut n: u128 = 1;
    while term > 0 && n <= LN_MAX_TERMS {
        term = mul_q64(term, z_sq)?;
        acc = acc
            .checked_add(term / (2 * n + 1))
            .ok_or(AmmError::MathOverflow)?;
        n += 1;
    }

    // ln(y) = e·ln2 + 2·atanh(z); 2·acc ≤ ln2 in Q64.64, e ≤ 64 → no overflow.
    e.checked_mul(LN2_Q64)
        .ok_or(AmmError::MathOverflow)?
        .checked_add(acc.checked_mul(2).ok_or(AmmError::MathOverflow)?)
        .ok_or(AmmError::MathOverflow)
}

// ---------------------------------------------------------------------------
// LMSR core
// ---------------------------------------------------------------------------

/// Enforce the documented safe ranges (§ header): `b ∈ [B_MIN, B_MAX]`,
/// every `q_i ≤ Q_MAX`.
fn validate_inputs(q: &[u64; N_OUTCOMES], b: u64) -> Result<(), AmmError> {
    if b < B_MIN || b > B_MAX {
        return Err(AmmError::LmsrLiquidityOutOfRange);
    }
    if q.iter().any(|&qi| qi > Q_MAX) {
        return Err(AmmError::LmsrQuantityTooLarge);
    }
    Ok(())
}

/// Shifted softmax terms: `exps[i] = exp((q_i − max(q))/b) ∈ [0, ONE]` (the
/// max outcome is exactly `ONE`) and their sum `∈ [ONE, 3·ONE]`.
fn shifted_exp_sum(
    q: &[u64; N_OUTCOMES],
    b: u64,
) -> Result<(u128, [u128; N_OUTCOMES]), AmmError> {
    let m = q[0].max(q[1]).max(q[2]);
    let mut exps = [0u128; N_OUTCOMES];
    let mut sum: u128 = 0;
    for (i, &qi) in q.iter().enumerate() {
        // (m − qi) ≤ Q_MAX = 2^60 → << 64 ≤ 2^124: fits u128.
        let x = (((m - qi) as u128) << 64) / (b as u128);
        let e = exp_neg_q64(x)?;
        exps[i] = e;
        sum = sum.checked_add(e).ok_or(AmmError::MathOverflow)?;
    }
    Ok((sum, exps))
}

/// LMSR cost `C(q) = b·ln(Σ exp(q_i/b))` in Q64.64.
///
/// Computed shift-invariantly as `max(q) + b·ln(Σ exp((q_i − max)/b))`.
/// Structural lemma: result ≥ `max(q) << 64` EXACTLY (see module docs) —
/// this is what makes the `b·ln3` loss bound survive truncation.
pub fn cost_q64(q: &[u64; N_OUTCOMES], b: u64) -> Result<u128, AmmError> {
    validate_inputs(q, b)?;
    let (sum, _) = shifted_exp_sum(q, b)?;
    let ln_sum = ln_q64(sum)?; // sum ≥ ONE always → no domain error
    let m = q[0].max(q[1]).max(q[2]) as u128;
    (m << 64)
        .checked_add((b as u128).checked_mul(ln_sum).ok_or(AmmError::MathOverflow)?)
        .ok_or(AmmError::MathOverflow)
}

/// LMSR cost in whole base units, CEIL-rounded (pool-favorable: never
/// under-count the liability). Fits u64: ≤ `Q_MAX + b·ln3 < 2^62`.
pub fn cost(q: &[u64; N_OUTCOMES], b: u64) -> Result<u64, AmmError> {
    let c = cost_q64(q, b)?;
    let units = c
        .checked_add(ONE_Q64 - 1)
        .ok_or(AmmError::MathOverflow)?
        >> 64;
    u64::try_from(units).map_err(|_| AmmError::NumericConversion)
}

/// Softmax prices of all three outcomes in bps, FLOOR-rounded per outcome.
///
/// Rounding band: `Σ prices_bps ∈ [10_000 − 3, 10_000]` (the deficit is the
/// pool's spread — pool-favorable). Shift-invariant by construction.
pub fn prices_bps(q: &[u64; N_OUTCOMES], b: u64) -> Result<[u16; N_OUTCOMES], AmmError> {
    validate_inputs(q, b)?;
    let (sum, exps) = shifted_exp_sum(q, b)?;
    let mut out = [0u16; N_OUTCOMES];
    for (i, &e) in exps.iter().enumerate() {
        // e ≤ ONE = 2^64, × 10^4 < 2^78: fits u128. e ≤ sum → p ≤ BPS_DENOM.
        let p = e
            .checked_mul(BPS_DENOM as u128)
            .ok_or(AmmError::MathOverflow)?
            .checked_div(sum)
            .ok_or(AmmError::DivideByZero)?;
        out[i] = u16::try_from(p).map_err(|_| AmmError::NumericConversion)?;
    }
    Ok(out)
}

/// Softmax price of one outcome in bps (see `prices_bps`).
pub fn price_bps(q: &[u64; N_OUTCOMES], b: u64, outcome: usize) -> Result<u16, AmmError> {
    if outcome >= N_OUTCOMES {
        return Err(AmmError::LmsrInvalidOutcomeIndex);
    }
    Ok(prices_bps(q, b)?[outcome])
}

/// Cost to buy `delta` tokens of `outcome`: `C(q + Δ·e_i) − C(q)`,
/// CEIL-rounded and floored at 1 base unit (a buy is NEVER free —
/// pool-favorable even when the outcome's price has underflowed to 0).
pub fn buy_cost(
    q: &[u64; N_OUTCOMES],
    b: u64,
    outcome: usize,
    delta: u64,
) -> Result<u64, AmmError> {
    if outcome >= N_OUTCOMES {
        return Err(AmmError::LmsrInvalidOutcomeIndex);
    }
    if delta == 0 {
        return Err(AmmError::ZeroAmount);
    }
    let c0 = cost_q64(q, b)?;
    let mut q_new = *q;
    q_new[outcome] = q_new[outcome]
        .checked_add(delta)
        .ok_or(AmmError::LmsrQuantityTooLarge)?;
    let c1 = cost_q64(&q_new, b)?; // re-validates q_new[outcome] ≤ Q_MAX
    // Monotone in exact math; saturate as a belt against ulp misalignment.
    let raw = c1.saturating_sub(c0);
    let units = raw
        .checked_add(ONE_Q64 - 1)
        .ok_or(AmmError::MathOverflow)?
        >> 64;
    let units = u64::try_from(units).map_err(|_| AmmError::NumericConversion)?;
    Ok(units.max(1))
}

/// Refund for selling `delta` tokens of `outcome`: `C(q) − C(q − Δ·e_i)`,
/// FLOOR-rounded (pool-favorable). Requires `delta ≤ q[outcome]` (cannot
/// sell more than the outstanding net supply of that outcome).
pub fn sell_refund(
    q: &[u64; N_OUTCOMES],
    b: u64,
    outcome: usize,
    delta: u64,
) -> Result<u64, AmmError> {
    if outcome >= N_OUTCOMES {
        return Err(AmmError::LmsrInvalidOutcomeIndex);
    }
    if delta == 0 {
        return Err(AmmError::ZeroAmount);
    }
    if delta > q[outcome] {
        return Err(AmmError::LmsrInsufficientOutcomeSupply);
    }
    let c0 = cost_q64(q, b)?;
    let mut q_new = *q;
    q_new[outcome] -= delta; // cannot underflow: checked above
    let c1 = cost_q64(&q_new, b)?;
    // Monotone in exact math; saturate as a belt against ulp misalignment.
    let raw = c0.saturating_sub(c1);
    u64::try_from(raw >> 64).map_err(|_| AmmError::NumericConversion)
}

/// Largest `delta` such that `buy_cost(q, b, outcome, delta) <= budget`
/// (the delta-for-cost inverse `buy_1x2` needs — LMSR gives cost-for-delta).
/// Returns `Ok(0)` when even a single token exceeds the budget.
///
/// ## Algorithm: bracketed binary search (SPEC §3.1 phase C)
///
/// The cost function is monotone in exact math; the search maintains the
/// safety invariant DIRECTLY — `lo` is only ever advanced to a `mid` whose
/// cost was CHECKED `<= budget` — so the result can never overcharge even if
/// fixed-point rounding wiggles monotonicity by an ulp.
///
/// ## Upper bracket (exact, from the structural lemma)
///
/// `cost(δ) ≥ C(q+δ·e_i) − C(q) ≥ (q_i + δ) − C(q)` because
/// `C(q') ≥ max(q') ≥ q_i + δ` holds EXACTLY in fixed point. Hence any
/// affordable δ satisfies `δ ≤ budget + (⌊C(q)⌋ − q_i + 1)`; the bracket is
/// additionally capped at `Q_MAX − q_i` (supported range).
///
/// ## Iteration / CU bound
///
/// `hi ≤ min(budget + slack, 2^60)` → at most **61 halvings**, each one
/// `cost_q64` evaluation (3 fixed-point `exp` + 1 `ln`), plus the initial
/// bracket check. Callers MUST request a raised compute-unit limit for
/// `buy_1x2`: measured ~660k CU worst-case in LiteSVM (b = 100 USDT,
/// ~28 halvings) — over the 200k per-ix default, comfortably inside the
/// 1.4M requestable cap.
pub fn buy_delta_for_cost(
    q: &[u64; N_OUTCOMES],
    b: u64,
    outcome: usize,
    budget: u64,
) -> Result<u64, AmmError> {
    if outcome >= N_OUTCOMES {
        return Err(AmmError::LmsrInvalidOutcomeIndex);
    }
    validate_inputs(q, b)?;
    if budget == 0 {
        return Ok(0);
    }

    let c0 = cost_q64(q, b)?;

    // EXACT replica of `buy_cost`'s rounding (ceil, floored at 1) against the
    // cached c0, so handler-side `q[i] += delta` charges what was solved for.
    let cost_of = |delta: u64| -> Result<u64, AmmError> {
        let mut q_new = *q;
        q_new[outcome] = q_new[outcome]
            .checked_add(delta)
            .ok_or(AmmError::LmsrQuantityTooLarge)?;
        let c1 = cost_q64(&q_new, b)?;
        let raw = c1.saturating_sub(c0);
        let units = raw
            .checked_add(ONE_Q64 - 1)
            .ok_or(AmmError::MathOverflow)?
            >> 64;
        let units = u64::try_from(units).map_err(|_| AmmError::NumericConversion)?;
        Ok(units.max(1))
    };

    // slack = ⌊C(q)⌋ − q_i + 1 ≥ 0 (C(q) ≥ max(q) ≥ q_i exactly).
    let floor_c0 = u64::try_from(c0 >> 64).map_err(|_| AmmError::NumericConversion)?;
    let slack = floor_c0
        .checked_sub(q[outcome])
        .ok_or(AmmError::MathOverflow)?
        .checked_add(1)
        .ok_or(AmmError::MathOverflow)?;
    let hi_cap = Q_MAX - q[outcome]; // q[i] ≤ Q_MAX validated above
    let mut hi = budget.saturating_add(slack).min(hi_cap);
    if hi == 0 {
        return Ok(0); // q_i already at Q_MAX — nothing buyable
    }
    if cost_of(hi)? <= budget {
        return Ok(hi); // range-capped: the whole bracket is affordable
    }

    // Invariants: cost_of(hi) > budget; lo affordable (lo = 0 = "buy nothing").
    let mut lo = 0u64;
    while hi - lo > 1 {
        let mid = lo + (hi - lo) / 2;
        if cost_of(mid)? <= budget {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    Ok(lo)
}

// ---------------------------------------------------------------------------
// Solvency invariant
// ---------------------------------------------------------------------------

/// D-2 solvency invariant generalized to N outcomes (SPEC §3.1):
/// `vault_usdt >= max_i(supplies[i])` — exactly one outcome wins and each
/// winning token redeems for 1 USDT, so the vault must cover the largest
/// outstanding supply. Re-checked after every mutating instruction.
pub fn assert_solvent_multi(vault_usdt: u64, supplies: &[u64]) -> Result<(), AmmError> {
    let max_supply = supplies.iter().copied().max().unwrap_or(0);
    if vault_usdt < max_supply {
        return Err(AmmError::SolvencyViolation);
    }
    Ok(())
}

#[cfg(test)]
mod tests;

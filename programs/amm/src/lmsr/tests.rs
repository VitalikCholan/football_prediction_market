//! Unit tests for the pure fixed-point LMSR (`lmsr.rs`) — SPEC §3.1 phase A.
//! Declared via `#[cfg(test)] mod tests;` (default child-module path), so
//! `super` is the `lmsr` module; compiled ONLY under `cargo test`.
//!
//! Tests MAY use f64 as the reference oracle — only the production path is
//! float-free.

use super::*;

const LN3: f64 = 1.0986122886681098;

/// Deterministic PCG-style LCG — no `rand` dependency, reproducible sweeps.
struct Lcg(u64);

impl Lcg {
    fn next_u64(&mut self) -> u64 {
        self.0 = self
            .0
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        // xorshift the state for better high-bit quality
        let x = self.0;
        (x ^ (x >> 31)).wrapping_mul(0x2545F4914F6CDD1D)
    }

    /// Uniform in `[0, bound)`.
    fn below(&mut self, bound: u64) -> u64 {
        self.next_u64() % bound
    }
}

/// f64 reference: shifted-softmax LMSR cost in base units.
fn cost_ref(q: &[u64; 3], b: u64) -> f64 {
    let bf = b as f64;
    let m = *q.iter().max().unwrap() as f64;
    let s: f64 = q.iter().map(|&qi| ((qi as f64 - m) / bf).exp()).sum();
    m + bf * s.ln()
}

/// f64 reference: softmax prices.
fn prices_ref(q: &[u64; 3], b: u64) -> [f64; 3] {
    let bf = b as f64;
    let m = *q.iter().max().unwrap() as f64;
    let e: Vec<f64> = q.iter().map(|&qi| ((qi as f64 - m) / bf).exp()).collect();
    let s: f64 = e.iter().sum();
    [e[0] / s, e[1] / s, e[2] / s]
}

fn q64_to_f64(x: u128) -> f64 {
    x as f64 / ONE_Q64 as f64
}

// ---------------------------------------------------------------------------
// (d) fixed-point kernels vs f64 reference
// ---------------------------------------------------------------------------

#[test]
fn exp_neg_matches_f64_reference() {
    // Sweep [0, 44·ln2] — the whole representable output range — plus randoms.
    let mut rng = Lcg(0xE1);
    let max_x = 44u128 * LN2_Q64;
    for i in 0..2_000u128 {
        let x = if i < 1_000 {
            i * max_x / 1_000
        } else {
            (rng.next_u64() as u128) % max_x
        };
        let got = q64_to_f64(exp_neg_q64(x).unwrap());
        let want = (-q64_to_f64(x)).exp();
        assert!(
            (got - want).abs() < 2e-15,
            "exp(-{}) got {got} want {want}",
            q64_to_f64(x)
        );
    }
}

#[test]
fn exp_neg_exact_at_zero_and_underflows_cleanly() {
    // exp(0) must be EXACTLY one — the shifted-max term relies on it.
    assert_eq!(exp_neg_q64(0).unwrap(), ONE_Q64);
    // k >= 64 → true value < 2^-64 → underflow to 0, no panic/error.
    assert_eq!(exp_neg_q64(64 * LN2_Q64).unwrap(), 0);
    assert_eq!(exp_neg_q64(u128::MAX / 2).unwrap(), 0);
}

#[test]
fn ln_matches_f64_reference() {
    // Sweep [1, 3] — the whole range cost() feeds it — plus randoms.
    let mut rng = Lcg(0x17);
    for i in 0..2_000u128 {
        let y = if i < 1_000 {
            ONE_Q64 + i * (2 * ONE_Q64) / 1_000
        } else {
            ONE_Q64 + (rng.next_u64() as u128) % (2 * ONE_Q64)
        };
        let got = q64_to_f64(ln_q64(y).unwrap());
        let want = q64_to_f64(y).ln();
        assert!(
            (got - want).abs() < 2e-15,
            "ln({}) got {got} want {want}",
            q64_to_f64(y)
        );
    }
    // exact anchor points: ln(1) = 0; ln(2) reduces to e=1, z=0 → exactly LN2_Q64
    assert_eq!(ln_q64(ONE_Q64).unwrap(), 0);
    assert_eq!(ln_q64(2 * ONE_Q64).unwrap(), LN2_Q64);
}

#[test]
fn ln_domain_error_below_one() {
    assert!(matches!(ln_q64(0), Err(AmmError::LmsrDomain)));
    assert!(matches!(ln_q64(ONE_Q64 - 1), Err(AmmError::LmsrDomain)));
}

#[test]
fn cost_matches_f64_reference_randomized() {
    let mut rng = Lcg(0xC0);
    for _ in 0..500 {
        let b = B_MIN + rng.below(1u64 << 40);
        let q = [
            rng.below(1u64 << 40),
            rng.below(1u64 << 40),
            rng.below(1u64 << 40),
        ];
        let got = q64_to_f64(cost_q64(&q, b).unwrap());
        let want = cost_ref(&q, b);
        let rel = ((got - want) / want).abs();
        assert!(rel < 1e-12, "cost({q:?}, {b}) got {got} want {want} rel {rel}");
    }
}

#[test]
fn cost_at_origin_is_b_ln3() {
    for b in [B_MIN, 1_000_000u64, 123_456_789, 1u64 << 40] {
        let c = cost(&[0, 0, 0], b).unwrap();
        let want = b as f64 * LN3;
        assert!(
            (c as f64 - want).abs() <= 1.0,
            "cost(0, {b}) = {c}, want ~{want}"
        );
    }
}

// ---------------------------------------------------------------------------
// (a) Σ prices ≈ 10_000 within the documented band
// ---------------------------------------------------------------------------

#[test]
fn prices_sum_within_rounding_band() {
    let mut rng = Lcg(0xA5);
    for _ in 0..1_000 {
        let b = B_MIN + rng.below(1u64 << 44);
        let q = [
            rng.below(1u64 << 44),
            rng.below(1u64 << 44),
            rng.below(1u64 << 44),
        ];
        let p = prices_bps(&q, b).unwrap();
        let sum: u32 = p.iter().map(|&x| x as u32).sum();
        // documented band: floor rounding loses at most 1 bps per outcome
        assert!(
            (9_997..=10_000).contains(&sum),
            "Σ prices = {sum} for q={q:?} b={b}"
        );
    }
}

#[test]
fn prices_match_f64_softmax_within_one_bps() {
    let mut rng = Lcg(0xF5);
    for _ in 0..500 {
        let b = B_MIN + rng.below(1u64 << 40);
        let q = [
            rng.below(1u64 << 40),
            rng.below(1u64 << 40),
            rng.below(1u64 << 40),
        ];
        let got = prices_bps(&q, b).unwrap();
        let want = prices_ref(&q, b);
        for i in 0..3 {
            let w = want[i] * BPS_DENOM as f64;
            assert!(
                (got[i] as f64 - w).abs() <= 1.0,
                "price[{i}] got {} want {w} (q={q:?} b={b})",
                got[i]
            );
        }
    }
}

#[test]
fn prices_uniform_at_origin() {
    let p = prices_bps(&[0, 0, 0], 1_000_000).unwrap();
    assert_eq!(p, [3_333, 3_333, 3_333]); // floor(10_000/3) each; band -1 bps
}

// ---------------------------------------------------------------------------
// (b) monotonicity
// ---------------------------------------------------------------------------

#[test]
fn cost_monotone_in_each_outcome() {
    let mut rng = Lcg(0xB0);
    for _ in 0..300 {
        let b = B_MIN + rng.below(1u64 << 32);
        // keep every outcome within 20·b of the max so no exp underflows to 0
        // (a > 44·b dominated outcome has ZERO marginal cost by the documented
        // underflow — covered by `buy_cost_always_positive` instead)
        let base = rng.below(1u64 << 32);
        let q = [
            base + rng.below(20 * b),
            base + rng.below(20 * b),
            base + rng.below(20 * b),
        ];
        let c0 = cost_q64(&q, b).unwrap();
        for i in 0..3 {
            // meaningful delta: b/16 moves the traded price visibly
            let mut q_up = q;
            q_up[i] += b / 16 + 1;
            let c1 = cost_q64(&q_up, b).unwrap();
            assert!(c1 > c0, "cost not strictly monotone in q[{i}] (q={q:?} b={b})");
            // tiny delta: never DECREASES (non-strict)
            let mut q_eps = q;
            q_eps[i] += 1;
            assert!(cost_q64(&q_eps, b).unwrap() >= c0);
        }
    }
    // arbitrary states (incl. deeply dominated): still never decreases
    for _ in 0..300 {
        let b = B_MIN + rng.below(1u64 << 32);
        let q = [
            rng.below(1u64 << 44),
            rng.below(1u64 << 44),
            rng.below(1u64 << 44),
        ];
        let c0 = cost_q64(&q, b).unwrap();
        for i in 0..3 {
            let mut q_up = q;
            q_up[i] += b;
            assert!(cost_q64(&q_up, b).unwrap() >= c0);
        }
    }
}

#[test]
fn buy_cost_always_positive() {
    // even a deeply dominated outcome (price underflowed to 0) charges ≥ 1
    let q = [1u64 << 50, 0, 0];
    let b = B_MIN;
    for i in 0..3 {
        assert!(buy_cost(&q, b, i, 1).unwrap() >= 1);
    }
    // and a normal buy charges roughly price × delta
    let b = 1_000_000u64;
    let c = buy_cost(&[0, 0, 0], b, 0, 1_000).unwrap();
    let want = cost_ref(&[1_000, 0, 0], b) - cost_ref(&[0, 0, 0], b);
    assert!((c as f64 - want).abs() <= 2.0, "buy_cost {c} want ~{want}");
}

// ---------------------------------------------------------------------------
// (c) bounded loss ≤ b·ln(3)
// ---------------------------------------------------------------------------

#[test]
fn bounded_loss_never_exceeds_b_ln3() {
    let mut rng = Lcg(0x105);
    for round in 0..30 {
        let b = B_MIN + rng.below(1u64 << 36);
        let mut q = [0u64; 3];
        let mut vault: i128 = 0; // Σ collected − Σ refunded

        for _ in 0..200 {
            let i = (rng.below(3)) as usize;
            if rng.below(4) == 0 && q[i] > 0 {
                // sell up to the outstanding supply
                let delta = 1 + rng.below(q[i]);
                vault -= sell_refund(&q, b, i, delta).unwrap() as i128;
                q[i] -= delta;
            } else {
                let delta = 1 + rng.below(4 * b);
                vault += buy_cost(&q, b, i, delta).unwrap() as i128;
                q[i] += delta;
            }
        }

        // worst case: the largest outstanding outcome wins, 1 token = 1 unit
        let worst_payout = *q.iter().max().unwrap() as i128;
        let loss = worst_payout - vault;
        let bound = (b as f64 * LN3).ceil() as i128 + 1;
        assert!(
            loss <= bound,
            "round {round}: loss {loss} > b·ln3 {bound} (b={b}, q={q:?})"
        );
    }
}

// ---------------------------------------------------------------------------
// (e) shift-invariance
// ---------------------------------------------------------------------------

#[test]
fn prices_shift_invariant() {
    let mut rng = Lcg(0xE5);
    for _ in 0..300 {
        let b = B_MIN + rng.below(1u64 << 40);
        let q = [
            rng.below(1u64 << 40),
            rng.below(1u64 << 40),
            rng.below(1u64 << 40),
        ];
        let shift = rng.below(1u64 << 50);
        let shifted = [q[0] + shift, q[1] + shift, q[2] + shift];
        // exactly equal — the max-subtraction cancels the shift bit-for-bit
        assert_eq!(prices_bps(&q, b).unwrap(), prices_bps(&shifted, b).unwrap());
    }
}

#[test]
fn cost_shifts_by_exactly_the_shift() {
    // C(q + s·1) = C(q) + s — shift adds s to max(q), leaves the ln term as-is.
    let b = 1_000_000u64;
    let q = [500_000u64, 1_200_000, 900_000];
    let s = 10_000_000u64;
    let c0 = cost_q64(&q, b).unwrap();
    let c1 = cost_q64(&[q[0] + s, q[1] + s, q[2] + s], b).unwrap();
    assert_eq!(c1 - c0, (s as u128) << 64);
}

// ---------------------------------------------------------------------------
// (f) pool-favorable rounding: round trips never profit the trader
// ---------------------------------------------------------------------------

#[test]
fn buy_then_sell_never_profits() {
    let mut rng = Lcg(0xF00D);
    for _ in 0..500 {
        let b = B_MIN + rng.below(1u64 << 36);
        let q = [
            rng.below(1u64 << 36),
            rng.below(1u64 << 36),
            rng.below(1u64 << 36),
        ];
        let i = (rng.below(3)) as usize;
        let delta = 1 + rng.below(8 * b);

        let paid = buy_cost(&q, b, i, delta).unwrap();
        let mut q_after = q;
        q_after[i] += delta;
        let refund = sell_refund(&q_after, b, i, delta).unwrap();
        assert!(
            refund <= paid,
            "round trip profited: paid {paid} refund {refund} (q={q:?} b={b} i={i} Δ={delta})"
        );
    }
}

// ---------------------------------------------------------------------------
// (g) edge cases: no panics, clean errors outside the supported range
// ---------------------------------------------------------------------------

#[test]
fn dominant_outcome_price_saturates() {
    // q0/b ≈ 2^50/2^10 huge → price0 → 1, others underflow to exactly 0
    let q = [1u64 << 50, 0, 0];
    let b = B_MIN;
    let p = prices_bps(&q, b).unwrap();
    assert_eq!(p, [10_000, 0, 0]);
    // cost collapses to the dominant quantity (ln term ≈ 0)
    let c = cost(&q, b).unwrap();
    assert!(c >= 1u64 << 50 && c <= (1u64 << 50) + 1, "c = {c}");
}

#[test]
fn cost_never_below_max_q() {
    // the structural solvency lemma: C(q) ≥ max(q), exactly, ALWAYS
    let mut rng = Lcg(0x51);
    for _ in 0..500 {
        let b = B_MIN + rng.below(1u64 << 40);
        let q = [
            rng.below(1u64 << 44),
            rng.below(1u64 << 44),
            rng.below(1u64 << 44),
        ];
        let m = *q.iter().max().unwrap() as u128;
        assert!(cost_q64(&q, b).unwrap() >= m << 64);
    }
}

#[test]
fn b_bounds_enforced() {
    let q = [0u64; 3];
    // in-range extremes: fine, no panics
    assert!(cost(&q, B_MIN).is_ok());
    assert!(cost(&q, B_MAX).is_ok());
    assert!(prices_bps(&[Q_MAX, 0, Q_MAX], B_MAX).is_ok());
    // out of range: clean errors
    assert!(matches!(
        cost(&q, B_MIN - 1),
        Err(AmmError::LmsrLiquidityOutOfRange)
    ));
    assert!(matches!(
        cost(&q, B_MAX + 1),
        Err(AmmError::LmsrLiquidityOutOfRange)
    ));
    assert!(matches!(
        cost(&q, 0),
        Err(AmmError::LmsrLiquidityOutOfRange)
    ));
}

#[test]
fn q_bounds_enforced() {
    let b = 1_000_000u64;
    assert!(cost(&[Q_MAX, Q_MAX, Q_MAX], b).is_ok());
    assert!(matches!(
        cost(&[Q_MAX + 1, 0, 0], b),
        Err(AmmError::LmsrQuantityTooLarge)
    ));
    // a buy that would push past Q_MAX is rejected, not wrapped
    assert!(matches!(
        buy_cost(&[Q_MAX, 0, 0], b, 0, 1),
        Err(AmmError::LmsrQuantityTooLarge)
    ));
    assert!(matches!(
        buy_cost(&[u64::MAX - 1, 0, 0], b, 0, 2),
        Err(AmmError::LmsrQuantityTooLarge)
    ));
}

#[test]
fn trade_input_validation() {
    let b = 1_000_000u64;
    let q = [1_000u64, 0, 0];
    // zero delta
    assert!(matches!(buy_cost(&q, b, 0, 0), Err(AmmError::ZeroAmount)));
    assert!(matches!(sell_refund(&q, b, 0, 0), Err(AmmError::ZeroAmount)));
    // bad outcome index
    assert!(matches!(
        buy_cost(&q, b, 3, 1),
        Err(AmmError::LmsrInvalidOutcomeIndex)
    ));
    assert!(matches!(
        sell_refund(&q, b, 3, 1),
        Err(AmmError::LmsrInvalidOutcomeIndex)
    ));
    assert!(matches!(
        price_bps(&q, b, 3),
        Err(AmmError::LmsrInvalidOutcomeIndex)
    ));
    // selling more than the outstanding supply
    assert!(matches!(
        sell_refund(&q, b, 0, 1_001),
        Err(AmmError::LmsrInsufficientOutcomeSupply)
    ));
    assert!(matches!(
        sell_refund(&q, b, 1, 1),
        Err(AmmError::LmsrInsufficientOutcomeSupply)
    ));
    // selling exactly the outstanding supply is fine (back to q_i = 0)
    assert!(sell_refund(&q, b, 0, 1_000).is_ok());
}

#[test]
fn price_bps_single_matches_array() {
    let b = 5_000_000u64;
    let q = [1_000_000u64, 3_000_000, 2_000_000];
    let all = prices_bps(&q, b).unwrap();
    for i in 0..3 {
        assert_eq!(price_bps(&q, b, i).unwrap(), all[i]);
    }
}


// ---------------------------------------------------------------------------
// buy_delta_for_cost — the delta-for-cost inverse used by `buy_1x2` (phase C)
// ---------------------------------------------------------------------------

#[test]
fn buy_delta_for_cost_is_maximal_and_affordable() {
    // Across random states: the returned delta is affordable AND maximal —
    // buy_cost(delta) <= budget < buy_cost(delta + 1).
    let mut rng = Lcg(0xD4);
    for _ in 0..200 {
        let b = B_MIN + rng.below(1u64 << 32);
        let q = [
            rng.below(4 * b + 1),
            rng.below(4 * b + 1),
            rng.below(4 * b + 1),
        ];
        let i = (rng.next_u64() % 3) as usize;
        let budget = 1 + rng.below(2 * b);
        let delta = buy_delta_for_cost(&q, b, i, budget).unwrap();
        if delta > 0 {
            assert!(
                buy_cost(&q, b, i, delta).unwrap() <= budget,
                "affordability: q={q:?} b={b} i={i} budget={budget} delta={delta}"
            );
        }
        // maximality: one more token must not fit (unless range-capped)
        if q[i] + delta < Q_MAX {
            assert!(
                buy_cost(&q, b, i, delta + 1).unwrap() > budget,
                "maximality: q={q:?} b={b} i={i} budget={budget} delta={delta}"
            );
        }
    }
}

#[test]
fn buy_delta_for_cost_edges() {
    let b = 1_000_000u64;
    let q = [0u64, 0, 0];
    // zero budget buys nothing
    assert_eq!(buy_delta_for_cost(&q, b, 0, 0).unwrap(), 0);
    // a symmetric market prices ~1/3: budget 1 affords at least 1 token
    // (buy_cost's ceil keeps cost(1) = 1 at these scales)
    assert!(buy_delta_for_cost(&q, b, 0, 1).unwrap() >= 1);
    // bad outcome index
    assert!(matches!(
        buy_delta_for_cost(&q, b, 3, 100),
        Err(AmmError::LmsrInvalidOutcomeIndex)
    ));
    // out-of-range inputs rejected like the rest of the API
    assert!(matches!(
        buy_delta_for_cost(&q, B_MIN - 1, 0, 100),
        Err(AmmError::LmsrLiquidityOutOfRange)
    ));
    assert!(matches!(
        buy_delta_for_cost(&[Q_MAX + 1, 0, 0], b, 0, 100),
        Err(AmmError::LmsrQuantityTooLarge)
    ));
}

#[test]
fn buy_delta_for_cost_respects_q_max_cap() {
    // q_i already at Q_MAX → nothing buyable regardless of budget.
    let b = B_MAX;
    let q = [Q_MAX, 0, 0];
    assert_eq!(buy_delta_for_cost(&q, b, 0, u64::MAX).unwrap(), 0);
    // near the cap: delta never pushes q_i past Q_MAX.
    let q = [Q_MAX - 5, 0, 0];
    let delta = buy_delta_for_cost(&q, b, 0, u64::MAX / 2).unwrap();
    assert!(delta <= 5, "delta={delta} must respect Q_MAX");
}

#[test]
fn buy_delta_then_buy_cost_round_trips_with_handler_flow() {
    // Exactly what buy_1x2 does: solve delta for net, then q[i] += delta.
    // The charged amount (net) must always cover buy_cost(delta).
    let b = 50_000_000u64; // 50 USDT-scale liquidity in 6dp base units
    let mut q = [0u64, 0, 0];
    let mut rng = Lcg(0xB1);
    for _ in 0..50 {
        let i = (rng.next_u64() % 3) as usize;
        let net = 1_000 + rng.below(20_000_000);
        let delta = buy_delta_for_cost(&q, b, i, net).unwrap();
        if delta == 0 {
            continue;
        }
        let cost = buy_cost(&q, b, i, delta).unwrap();
        assert!(cost <= net, "pool must never charge more than solved-for");
        q[i] += delta;
    }
}

#[test]
fn solvency_invariant_multi() {
    // 3-way generalization (SPEC §3.1): vault >= max_i(supplies[i]).
    assert!(assert_solvent_multi(100, &[100, 50, 30]).is_ok());
    assert!(assert_solvent_multi(100, &[30, 100, 50]).is_ok());
    assert!(assert_solvent_multi(100, &[0, 0, 0]).is_ok());
    assert!(assert_solvent_multi(0, &[]).is_ok());
    assert!(matches!(
        assert_solvent_multi(99, &[100, 50, 30]),
        Err(AmmError::SolvencyViolation)
    ));
    assert!(matches!(
        assert_solvent_multi(99, &[30, 50, 100]),
        Err(AmmError::SolvencyViolation)
    ));
    // exactly-at-max is solvent (boundary).
    assert!(assert_solvent_multi(100, &[100, 100, 100]).is_ok());
}

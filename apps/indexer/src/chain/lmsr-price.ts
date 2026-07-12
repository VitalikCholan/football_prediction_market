/**
 * Pure fixed-point LMSR softmax pricing for the 3-way (1X2) market — a faithful
 * TypeScript port of `programs/amm/src/lmsr.rs` `prices_bps` (SPEC §3.1). The
 * on-chain `Market` account stores only `q` (net tokens per outcome,
 * INCLUDING the admin seed offsets) and `b` (liquidity), so the indexer derives
 * the three display prices exactly the way the program does rather than trusting
 * a single cached `last_price_bps` (which only tracks the last-traded outcome).
 *
 * Byte-for-byte parity with the Rust kernel matters: prices shown to the web must
 * equal the on-chain softmax so buy/sell quotes reconcile. This is a direct
 * transliteration — same Q64.64 representation, same range reduction, same
 * floor-rounding band (`Σ prices ∈ [10_000 − 3, 10_000]`, the pool's spread).
 *
 * BigInt is arbitrary-precision so the u128 intermediates the Rust code guards
 * against overflow simply cannot wrap here — we keep the same clamps for parity.
 *
 * NOTE: this module is pure math with no other `@fpm/shared` dependency, so it
 * carries its own `BPS_DENOM` (kept equal to `@fpm/shared`'s and the on-chain
 * `constants.rs` value) rather than importing the package — that keeps it, and
 * its unit test, out of the `@fpm/shared` ESM/import-map graph under ts-jest.
 */

/** Basis-point denominator (10_000 = 100%); mirrors `@fpm/shared` `BPS_DENOM`. */
const BPS_DENOM = 10_000;

/** Number of outcomes: Team1 / Draw / Team2. */
export const N_OUTCOMES = 3;

/** Q64.64 fixed-point one (`2^64`). */
const ONE_Q64 = 1n << 64n;

/** `floor(ln(2) · 2^64)` — matches `LN2_Q64` in lmsr.rs byte-for-byte. */
const LN2_Q64 = 12_786_308_645_202_655_659n;

const EXP_MAX_PAIRS = 20n;

/** `(a · b) >> 64`, floor-rounded (BigInt is exact, so no overflow guard needed). */
function mulQ64(a: bigint, b: bigint): bigint {
  return (a * b) >> 64n;
}

/**
 * `exp(−x)` for `x ≥ 0` in Q64.64 → Q64.64 in `[0, ONE]`. Direct port of
 * `exp_neg_q64`: range-reduce `x = k·ln2 + r`, paired Taylor series, shift by k.
 */
function expNegQ64(x: bigint): bigint {
  const k = x / LN2_Q64;
  if (k >= 64n) return 0n;
  const r = x - k * LN2_Q64;
  const rSq = mulQ64(r, r);
  let t = ONE_Q64;
  let sum = 0n;
  let j = 0n;
  for (;;) {
    const frac = r / (2n * j + 1n);
    sum += mulQ64(t, ONE_Q64 - frac);
    t = mulQ64(t, rSq) / ((2n * j + 1n) * (2n * j + 2n));
    if (t === 0n || j >= EXP_MAX_PAIRS) break;
    j += 1n;
  }
  const clamped = sum < ONE_Q64 ? sum : ONE_Q64;
  return clamped >> k;
}

/**
 * Shifted softmax terms: `exps[i] = exp((q_i − max(q))/b)` and their sum.
 * Port of `shifted_exp_sum` (the max outcome is exactly ONE; sum ∈ [ONE, 3·ONE]).
 * Returns null if `b` is zero (degenerate — caller falls back to a 50/50 split).
 */
function shiftedExpSum(
  q: readonly [bigint, bigint, bigint],
  b: bigint,
): { sum: bigint; exps: [bigint, bigint, bigint] } | null {
  if (b <= 0n) return null;
  const m =
    q[0] > q[1] ? (q[0] > q[2] ? q[0] : q[2]) : q[1] > q[2] ? q[1] : q[2];
  const exps: [bigint, bigint, bigint] = [0n, 0n, 0n];
  let sum = 0n;
  for (let i = 0; i < N_OUTCOMES; i += 1) {
    const x = ((m - q[i]) << 64n) / b;
    const e = expNegQ64(x);
    exps[i] = e;
    sum += e;
  }
  return { sum, exps };
}

/**
 * Softmax prices of all three outcomes in bps, FLOOR-rounded per outcome —
 * exact port of `prices_bps` in lmsr.rs. `q` and `b` are read straight off the
 * decoded `Market` account (`q` includes seed offsets — that is what sets the
 * odds). Degenerate `b`/`sum` falls back to an even 1/3 split.
 */
export function prices1x2Bps(
  q: readonly [bigint, bigint, bigint],
  b: bigint,
): [number, number, number] {
  const shifted = shiftedExpSum(q, b);
  if (!shifted || shifted.sum <= 0n) {
    const third = Math.floor(BPS_DENOM / N_OUTCOMES);
    return [third, third, third];
  }
  const { sum, exps } = shifted;
  const out: [number, number, number] = [0, 0, 0];
  for (let i = 0; i < N_OUTCOMES; i += 1) {
    const p = (exps[i] * BigInt(BPS_DENOM)) / sum;
    out[i] = Number(p);
  }
  return out;
}

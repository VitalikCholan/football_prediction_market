/**
 * Pure reserve math for the persister (unit-testable, no deps).
 *
 * The on-chain `Trade` event carries the post-trade YES price but not the
 * reserves. Trades preserve the constant product k = yes_reserve * no_reserve
 * (the fee is taken from the collateral leg before the swap), so post-trade
 * reserves are recoverable from k + price (anchor-programs-plan §4.3):
 *
 *   p = no / (yes + no)   =>   no = sqrt(k * p / (1 - p)),  yes = k / no
 */

/**
 * Recover post-trade reserves from the constant product and the post-trade
 * YES price (bps). Falls back to the previous reserves when the price is
 * degenerate (0 or 10000 bps) or k is unknown (0).
 */
export function deriveReservesFromPrice(
  k: bigint,
  yesPriceBps: number,
  fallback: { yesReserve: bigint; noReserve: bigint },
): { yesReserve: bigint; noReserve: bigint } {
  const p = BigInt(yesPriceBps);
  if (k <= 0n || p <= 0n || p >= 10_000n) return fallback;
  const noReserve = bigintSqrt((k * p) / (10_000n - p));
  if (noReserve <= 0n) return fallback;
  return { yesReserve: k / noReserve, noReserve };
}

/** Integer sqrt (Newton's method) for bigint. */
export function bigintSqrt(n: bigint): bigint {
  if (n < 0n) throw new Error('sqrt of negative');
  if (n < 2n) return n;
  let x = n;
  let y = (x + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + n / x) / 2n;
  }
  return x;
}

/**
 * Client-side quote math — a mirror of the on-chain CPMM used to preview a
 * trade BEFORE signing (the DESIGN_SPEC 1d summary box: shares, avg price,
 * slippage, payout). This is a v0 approximation of the program's math and MUST
 * be kept in parity with `programs/amm/src/math.rs` once the buy/sell
 * instructions land (see lib/tx). Amounts here are in whole USDT / shares for
 * legibility; the tx layer converts to base units.
 *
 * Model (constant-product share AMM, Polymarket/CPMM style):
 *   - The market holds `yesReserve` and `noReserve` of collateral-backed
 *     outcome tokens; instantaneous YES price p = noReserve / (yes + no).
 *   - Buying $X of YES adds collateral to both sides and mints YES shares such
 *     that the invariant holds; the marginal price rises with size → impact.
 *   - Winning shares redeem at $1.00 each → payout = shares * $1.00.
 * We derive the same numbers from reserves + the quoted price so the preview
 * tracks the odds tape. `p(1-p)` scales the effective spread/impact term.
 */
import { BPS_DENOM } from "@fpm/shared";
import type { Side } from "@fpm/shared";

export interface QuoteInput {
  /** Trade side. */
  side: Side;
  /** Buy or sell. */
  action: "buy" | "sell";
  /** USDT in (buy) or shares in (sell). */
  amount: number;
  /** Current YES price in bps (0–10000). */
  yesPriceBps: number;
  /** Pool YES reserve (whole units). */
  yesReserve: number;
  /** Pool NO reserve (whole units). */
  noReserve: number;
  /** Effective fee for this trade, bps. */
  feeBps: number;
  /** Slippage tolerance, fraction (0.005 = 0.5%). */
  slippageTolerance?: number;
}

export interface Quote {
  /** Shares received (buy) or shares sold (sell). */
  shares: number;
  /** Average fill price per share, in cents (0–100). */
  avgPriceCents: number;
  /** Instantaneous price for the side, cents. */
  markPriceCents: number;
  /** Price impact vs mark, fraction. */
  priceImpact: number;
  /** Fee paid, whole USDT. */
  feePaid: number;
  /** Payout if the position wins ($1.00/share), whole USDT. */
  payoutIfWins: number;
  /** min_out guard from slippage tolerance (shares on buy, USDT on sell). */
  minOut: number;
  /** USDT returned (sell only). */
  usdtOut: number;
}

/** Price of the chosen side in fraction (0..1) from the YES bps. */
function sidePriceFraction(side: Side, yesPriceBps: number): number {
  const yes = yesPriceBps / BPS_DENOM;
  return side === "YES" ? yes : 1 - yes;
}

/**
 * Quote a trade. Uses a bounded CPMM approximation: marginal price is `p`, and
 * price impact grows with trade size relative to the side's reserve, scaled by
 * `p(1-p)` (max liquidity sensitivity at 50¢, as in the AMM curve).
 */
export function quoteTrade(input: QuoteInput): Quote {
  const {
    side,
    action,
    amount,
    yesPriceBps,
    yesReserve,
    noReserve,
    feeBps,
    slippageTolerance = 0.01,
  } = input;

  const p = sidePriceFraction(side, yesPriceBps); // 0..1
  const markPriceCents = p * 100;
  const feeRate = feeBps / BPS_DENOM;

  // Depth of the side we push against.
  const sideReserve = side === "YES" ? yesReserve : noReserve;
  const totalReserve = Math.max(1, yesReserve + noReserve);

  if (!Number.isFinite(amount) || amount <= 0 || p <= 0 || p >= 1) {
    return {
      shares: 0,
      avgPriceCents: markPriceCents,
      markPriceCents,
      priceImpact: 0,
      feePaid: 0,
      payoutIfWins: 0,
      minOut: 0,
      usdtOut: 0,
    };
  }

  // Convexity term — sharpest impact near 50/50, flat at the extremes.
  const convexity = p * (1 - p);

  if (action === "buy") {
    const feePaid = amount * feeRate;
    const spendable = amount - feePaid;
    // Impact fraction: trade collateral relative to opposing depth, scaled by
    // curvature. Bounded so the preview never goes non-monotonic.
    const impact = Math.min(
      0.5,
      (spendable / (totalReserve * p)) * (0.5 + convexity),
    );
    const avgPrice = p * (1 + impact);
    const shares = spendable / avgPrice;
    return {
      shares,
      avgPriceCents: avgPrice * 100,
      markPriceCents,
      priceImpact: impact,
      feePaid,
      payoutIfWins: shares, // $1.00/share
      minOut: shares * (1 - slippageTolerance),
      usdtOut: 0,
    };
  }

  // SELL: user sells `amount` shares back to the pool for USDT.
  const impact = Math.min(
    0.5,
    (amount / Math.max(1, sideReserve)) * (0.5 + convexity),
  );
  const avgPrice = p * (1 - impact);
  const gross = amount * avgPrice;
  const feePaid = gross * feeRate;
  const usdtOut = gross - feePaid;
  const minOut = usdtOut * (1 - slippageTolerance);
  return {
    shares: amount,
    avgPriceCents: avgPrice * 100,
    markPriceCents,
    priceImpact: impact,
    feePaid,
    payoutIfWins: amount, // if held to resolution instead
    minOut,
    usdtOut,
  };
}

/* --------------------------------------------------------------- 1X2 (LMSR) */

export interface Quote1x2Input {
  action: "buy" | "sell";
  /** USDT in (buy) or outcome tokens in (sell). */
  amount: number;
  /** Current softmax price of the CHOSEN outcome, bps (0..10000). */
  outcomePriceBps: number;
  /** LMSR liquidity parameter b, whole units (the DTO `b` scaled to USDT). */
  b: number;
  /** Effective fee for this trade, bps. */
  feeBps: number;
  /** Slippage tolerance, fraction (0.005 = 0.5%). */
  slippageTolerance?: number;
}

/**
 * Client-side 1X2 (LMSR) quote — a PREVIEW ONLY approximation for the ticket
 * summary box; the on-chain simulation in `lib/tx` is the authoritative output
 * shown alongside it (the panel renders `prepared.sim.outBase`). We linearize
 * the LMSR around the current price: a buy of `x` USDT clears at roughly the
 * current price `p` plus a convex impact that scales with `x/b` (larger `b` =
 * deeper book = less impact), so `tokens ≈ (x − fee) / avgPrice`. This tracks
 * the direction/curvature of the real fill without re-deriving the exp/ln math.
 */
export function quoteTrade1x2(input: Quote1x2Input): Quote {
  const {
    action,
    amount,
    outcomePriceBps,
    b,
    feeBps,
    slippageTolerance = 0.01,
  } = input;

  const p = Math.min(0.999, Math.max(0.001, outcomePriceBps / BPS_DENOM));
  const markPriceCents = p * 100;
  const feeRate = feeBps / BPS_DENOM;
  const depth = Math.max(1, b);

  if (!Number.isFinite(amount) || amount <= 0) {
    return {
      shares: 0,
      avgPriceCents: markPriceCents,
      markPriceCents,
      priceImpact: 0,
      feePaid: 0,
      payoutIfWins: 0,
      minOut: 0,
      usdtOut: 0,
    };
  }

  // LMSR curvature is largest where the outcome is uncertain; `p(1-p)` peaks at
  // 50%. Impact grows with trade size relative to the book depth `b`.
  const convexity = p * (1 - p);

  if (action === "buy") {
    const feePaid = amount * feeRate;
    const spendable = amount - feePaid;
    const impact = Math.min(
      0.5,
      (spendable / (depth * Math.max(p, 0.05))) * (0.5 + convexity),
    );
    const avgPrice = Math.min(0.999, p * (1 + impact));
    const shares = spendable / avgPrice;
    return {
      shares,
      avgPriceCents: avgPrice * 100,
      markPriceCents,
      priceImpact: impact,
      feePaid,
      payoutIfWins: shares, // $1.00/winning token
      minOut: shares * (1 - slippageTolerance),
      usdtOut: 0,
    };
  }

  // SELL: user returns `amount` outcome tokens for USDT.
  const impact = Math.min(0.5, (amount / depth) * (0.5 + convexity));
  const avgPrice = Math.max(0.001, p * (1 - impact));
  const gross = amount * avgPrice;
  const feePaid = gross * feeRate;
  const usdtOut = gross - feePaid;
  return {
    shares: amount,
    avgPriceCents: avgPrice * 100,
    markPriceCents,
    priceImpact: impact,
    feePaid,
    payoutIfWins: amount,
    minOut: usdtOut * (1 - slippageTolerance),
    usdtOut,
  };
}

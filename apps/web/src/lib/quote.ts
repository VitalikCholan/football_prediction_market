/**
 * Client-side quote math — a mirror of the on-chain LMSR used to preview a
 * trade BEFORE signing (the DESIGN_SPEC 1d summary box: shares, avg price,
 * slippage, payout). This is a v0 approximation of the program's math and MUST
 * be kept in rough parity with `programs/amm/src/lmsr.rs`; the authoritative
 * output shown alongside it is the on-chain simulation in `lib/tx`. Amounts
 * here are in whole USDT / shares for legibility; the tx layer converts to base
 * units.
 *
 * Model (3-way LMSR, one outcome traded at a time):
 *   - Each outcome carries a softmax price p = e^{q_i/b} / Σ e^{q_j/b}; the
 *     three prices sum to ~1.00. Winning shares redeem at $1.00 each.
 *   - We linearize the LMSR around the current outcome price: a buy of `x` USDT
 *     clears at roughly `p` plus a convex impact scaling with `x/b` (larger `b`
 *     = deeper book = less impact), so `tokens ≈ (x − fee) / avgPrice`. This
 *     tracks the direction/curvature of the real fill without re-deriving exp/ln.
 */
import { BPS_DENOM } from "@fpm/shared";

export interface Quote {
  /** Shares received (buy) or shares sold (sell). */
  shares: number;
  /** Average fill price per share, in cents (0–100). */
  avgPriceCents: number;
  /** Instantaneous price for the outcome, cents. */
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

export interface QuoteInput {
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
 * Client-side 3-way (LMSR) quote — a PREVIEW ONLY approximation for the ticket
 * summary box; the on-chain simulation in `lib/tx` is the authoritative output
 * shown alongside it (the panel renders `prepared.sim.outBase`). We linearize
 * the LMSR around the current price: a buy of `x` USDT clears at roughly the
 * current price `p` plus a convex impact that scales with `x/b` (larger `b` =
 * deeper book = less impact), so `tokens ≈ (x − fee) / avgPrice`. This tracks
 * the direction/curvature of the real fill without re-deriving the exp/ln math.
 */
export function quoteTrade(input: QuoteInput): Quote {
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

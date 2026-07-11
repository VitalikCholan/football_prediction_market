import type { MarketDto } from "@fpm/shared";
import { quoteTrade } from "@/lib/quote";
import { usd } from "@/lib/format";
import { Card } from "@/components/ui/card";

/**
 * Liquidity depth (1c sidebar). A constant-product AMM has NO order book, so
 * instead of a fake bid/ask ladder we show REAL price-impact derived from the
 * market's on-chain reserves via the same CPMM math the trade ticket uses
 * (`lib/quote.ts`): what it costs to buy a few share sizes on each side, and
 * how far each fill pushes the price. Honest and fully on-chain-derived.
 */
const SCALE = 1_000_000;
const SIZES = [100, 500, 1_000]; // shares

export function OrderBook({ market }: { market: MarketDto }) {
  const yesReserve = Number(market.yesReserve) / SCALE;
  const noReserve = Number(market.noReserve) / SCALE;
  const feeBps = market.currentFeeBps ?? market.baseFeeBps ?? 0;

  const quoteRow = (side: "YES" | "NO", size: number) => {
    const q = quoteTrade({
      side,
      action: "buy",
      amount: size, // treat as whole-USDT notional at ~mark for a depth probe
      yesPriceBps: market.yesPriceBps,
      yesReserve,
      noReserve,
      feeBps,
    });
    return {
      size,
      avgCents: q.avgPriceCents,
      impactPct: q.priceImpact * 100,
    };
  };

  const side = (label: "YES" | "NO") => (
    <div className="px-3 py-2">
      <div className="mb-1 flex items-center justify-between">
        <span
          className={`chip ${label === "YES" ? "yc" : "nc"} px-2 py-0.5 text-[11px] font-600`}
        >
          {label}
        </span>
        <span className="th">avg · impact</span>
      </div>
      {SIZES.map((sz) => {
        const r = quoteRow(label, sz);
        return (
          <div
            key={`${label}-${sz}`}
            className="flex items-center justify-between py-0.5 text-[12px]"
          >
            <span className="tnum text-muted">{usd(sz)}</span>
            <span className="tnum">
              <span className="font-600">{r.avgCents.toFixed(1)}¢</span>
              <span
                className={`ml-2 ${r.impactPct >= 1 ? "neg" : "text-muted"}`}
              >
                +{r.impactPct.toFixed(2)}%
              </span>
            </span>
          </div>
        );
      })}
    </div>
  );

  return (
    <Card className="overflow-hidden">
      <div className="flex items-center justify-between border-b border-box-border px-3 py-2">
        <h3 className="text-[13px] font-700">Liquidity depth</h3>
        <span className="th">on-chain reserves</span>
      </div>
      {side("YES")}
      <div className="border-y border-box-border bg-skeleton px-3 py-1.5 text-[11px] text-muted">
        Price impact to buy at each size · CPMM, no order book
      </div>
      {side("NO")}
    </Card>
  );
}

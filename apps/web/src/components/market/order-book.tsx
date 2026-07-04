import type { MarketDto } from "@fpm/shared";
import { getOrderBook } from "@/lib/fixtures";
import { shares } from "@/lib/format";

/** Order book ladder (1c sidebar). Asks above the last mark, bids below. */
export function OrderBook({ market }: { market: MarketDto }) {
  const book = getOrderBook(market);
  const maxShares = Math.max(
    ...book.asks.map((l) => l.shares),
    ...book.bids.map((l) => l.shares),
  );

  const row = (
    price: number,
    sz: number,
    side: "ask" | "bid",
  ) => (
    <div
      key={`${side}-${price}`}
      className="relative flex items-center justify-between px-3 py-1 text-[12px]"
    >
      <span
        className="absolute inset-y-0.5 right-0 rounded"
        style={{
          width: `${(sz / maxShares) * 100}%`,
          background:
            side === "ask" ? "var(--no-btn-bg)" : "var(--yes-btn-bg)",
        }}
        aria-hidden
      />
      <span
        className={`tnum relative font-600 ${side === "ask" ? "neg" : "pos"}`}
      >
        {price}¢
      </span>
      <span className="tnum relative text-muted">{shares(sz)}</span>
    </div>
  );

  return (
    <div className="scr overflow-hidden">
      <div className="flex items-center justify-between border-b border-box-border px-3 py-2">
        <h3 className="text-[13px] font-700">Order book</h3>
        <span className="th">price · shares</span>
      </div>
      <div className="py-1">{book.asks.map((l) => row(l.priceCents, l.shares, "ask"))}</div>
      <div className="flex items-center justify-between border-y border-box-border bg-skeleton px-3 py-1.5">
        <span className="th">Last</span>
        <span className="tnum text-[13px] font-700">{book.lastCents}¢</span>
      </div>
      <div className="py-1">{book.bids.map((l) => row(l.priceCents, l.shares, "bid"))}</div>
    </div>
  );
}

import Link from "next/link";
import type { MarketDto } from "@fpm/shared";
import { StateBadge } from "@/components/market/state-badge";

/** Match detail header (1c): breadcrumb, verified feed, title, score. */
export function MarketHeader({ market }: { market: MarketDto }) {
  const live = market.state === "Trading";
  return (
    <div className="flex flex-col gap-3">
      <nav className="flex items-center gap-1.5 text-[12px] text-muted">
        <Link href="/" className="link no-underline">
          Markets
        </Link>
        <span>›</span>
        <span>Group C</span>
        <span>›</span>
        <span className="text-ink">
          {market.homeTeam} vs {market.awayTeam}
        </span>
      </nav>

      <div className="flex flex-wrap items-center gap-2">
        <StateBadge state={market.state} />
        <span className="verified">◆ TxLINE verified feed</span>
      </div>

      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[24px] font-700 tracking-tight">
            {market.homeTeam} <span className="text-muted">vs</span>{" "}
            {market.awayTeam}
          </h1>
          <p className="text-[13px] text-muted">Who wins the match?</p>
        </div>
        {live ? (
          <div className="text-right">
            <div className="tnum text-[26px] font-700 leading-none">
              1 <span className="text-muted">–</span> 1
            </div>
            <div className="text-[11px] text-muted">
              Score · updates ~60s delay
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

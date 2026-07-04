import Link from "next/link";
import type { MarketDto } from "@fpm/shared";
import { StateBadge } from "@/components/market/state-badge";
import { Sparkline } from "@/components/market/sparkline";
import { volumeLabel, bpsToCents } from "@/lib/format";
import { getFixtureHistory } from "@/lib/fixtures";

/**
 * Match card (DESIGN_SPEC 1b). Our DTO is a 2-way YES/NO market per fixture;
 * the wireframe shows a 3-chip Home/Draw/Away read. For v0 we derive the
 * three outcome cents from the YES price (Home = YES, Away = NO minus a small
 * draw allocation, Draw = residual) so the card matches the reference look.
 * Whole-market trading still routes to the per-team YES/NO market on detail.
 */
function threeWayCents(yesBps: number): {
  home: number;
  draw: number;
  away: number;
} {
  const home = bpsToCents(yesBps);
  const rest = 100 - home;
  const draw = Math.round(rest * 0.42);
  const away = rest - draw;
  return { home, draw, away };
}

export function MatchCard({
  market,
  index = 0,
}: {
  market: MarketDto;
  index?: number;
}) {
  const { home, draw, away } = threeWayCents(market.yesPriceBps);
  const leader = home >= away ? "home" : "away";
  const spark = getFixtureHistory(market.id).points.map((p) => p.yesPriceBps);

  const chip = (
    label: string,
    cents: number,
    tint: "yc" | "nc" | null,
  ) => (
    <div className={`chip ${tint ?? ""} min-w-0 flex-1`}>
      <div className="truncate text-[11px] text-muted">{label}</div>
      <div className="tnum text-[18px] font-700 leading-tight">{cents}¢</div>
    </div>
  );

  return (
    <Link
      href={`/markets/${market.id}`}
      className="scr reveal flex flex-col gap-3 p-4 no-underline transition-shadow hover:shadow-[0_4px_14px_rgba(0,0,0,0.08)]"
      style={{ animationDelay: `${Math.min(index, 8) * 45}ms` }}
    >
      <div className="flex items-center justify-between">
        <StateBadge state={market.state} />
        <span className="tag">World Cup</span>
      </div>

      <div>
        <div className="text-[16px] font-700 leading-tight">
          {market.homeTeam} <span className="text-muted">vs</span>{" "}
          {market.awayTeam}
        </div>
        <div className="mt-0.5 text-[12px] text-muted">
          Match winner · settles at full time
        </div>
      </div>

      <div className="flex gap-2">
        {chip(market.homeTeam ?? "Home", home, leader === "home" ? "yc" : null)}
        {chip("Draw", draw, null)}
        {chip(market.awayTeam ?? "Away", away, leader === "away" ? "nc" : null)}
      </div>

      <div className="mt-1 flex items-center justify-between">
        <span className="text-[12px] text-muted">
          Vol {volumeLabel(market.totalVolume)}
        </span>
        <Sparkline points={spark} />
      </div>
    </Link>
  );
}

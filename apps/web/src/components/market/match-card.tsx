import Link from "next/link";
import type { MarketDto } from "@fpm/shared";
import { StateBadge } from "@/components/market/state-badge";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  volumeLabel,
  bpsToCents,
  scoreLabel,
  matchStatusLine,
  kickoffLabel,
} from "@/lib/format";

/**
 * Match card (DESIGN_SPEC 1b). Renders a 3-chip Home/Draw/Away read carrying the
 * TRUE on-chain softmax prices (team1/draw/team2 PriceBps → cents).
 */
export function MatchCard({
  market,
  index = 0,
}: {
  market: MarketDto;
  index?: number;
}) {
  const home = bpsToCents(market.team1PriceBps);
  const draw = bpsToCents(market.drawPriceBps);
  const away = bpsToCents(market.team2PriceBps);
  const leader = home >= away ? "home" : "away";

  const score = scoreLabel(market.homeScore, market.awayScore);
  const status = matchStatusLine(
    market.statusId,
    market.gameState,
    market.matchClock,
  );
  const kickoff = kickoffLabel(market.kickoffTs);
  // Card caption: prefer live status when we have a score, else kickoff time,
  // else the generic settlement note.
  const caption = score
    ? `Match winner · ${status ?? "in play"}`
    : kickoff && market.state === "Open"
      ? `Match winner · kickoff ${kickoff}`
      : "Match winner · settles at full time";

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
    <Card
      asChild
      className="reveal transition-shadow hover:shadow-[0_4px_14px_rgba(0,0,0,0.08)]"
    >
      <Link
        href={`/markets/${market.id}`}
        className="flex flex-col gap-3 p-4 no-underline"
        style={{ animationDelay: `${Math.min(index, 8) * 45}ms` }}
      >
        <div className="flex items-center justify-between">
          <StateBadge state={market.state} />
          {score ? (
            <Badge variant="score" className="tnum" title={status ?? undefined}>
              {score}
            </Badge>
          ) : market.competition ? (
            <Badge>{market.competition}</Badge>
          ) : null}
        </div>

      <div>
        <div className="text-[16px] font-700 leading-tight">
          {market.homeTeam ? (
            <>
              {market.homeTeam} <span className="text-muted">vs</span>{" "}
              {market.awayTeam ?? "Away"}
            </>
          ) : (
            <>Fixture {market.fixtureId}</>
          )}
        </div>
        <div className="mt-0.5 text-[12px] text-muted">{caption}</div>
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
        </div>
      </Link>
    </Card>
  );
}

import Link from "next/link";
import type { MarketDto } from "@fpm/shared";
import { StateBadge } from "@/components/market/state-badge";
import { Badge } from "@/components/ui/badge";
import { scoreLabel, matchStatusLine, kickoffLabel } from "@/lib/format";

/**
 * Match detail header (1c): breadcrumb, verified feed, title, score.
 */
export function MarketHeader({ market }: { market: MarketDto }) {
  const score = scoreLabel(market.homeScore, market.awayScore);
  // Status line only makes sense once a match has scores/finalised; fall back
  // to a plain "Score · updates ~60s delay" caption while a match is in play.
  const status =
    matchStatusLine(market.statusId, market.gameState, market.matchClock) ??
    "Score · updates ~60s delay";
  const kickoff = kickoffLabel(market.kickoffTs);
  const upcoming = market.state === "Open" || market.state === "Trading";
  return (
    <div className="flex flex-col gap-3">
      <nav className="flex items-center gap-1.5 text-[12px] text-muted">
        <Link href="/" className="text-link no-underline hover:underline">
          Markets
        </Link>
        {market.competition ? (
          <>
            <span>›</span>
            <span>{market.competition}</span>
          </>
        ) : null}
        <span>›</span>
        <span className="text-ink">
          {market.homeTeam
            ? `${market.homeTeam} vs ${market.awayTeam ?? "Away"}`
            : `Fixture ${market.fixtureId}`}
        </span>
      </nav>

      <div className="flex flex-wrap items-center gap-2">
        <StateBadge state={market.state} />
        <Badge variant="verified">◆ TxLINE verified feed</Badge>
      </div>

      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[24px] font-700 tracking-tight">
            {market.homeTeam ? (
              <>
                {market.homeTeam} <span className="text-muted">vs</span>{" "}
                {market.awayTeam ?? "Away"}
              </>
            ) : (
              <>Fixture {market.fixtureId}</>
            )}
          </h1>
          <p className="text-[13px] text-muted">Who wins the match?</p>
          {kickoff && upcoming && !score ? (
            <p className="mt-0.5 text-[12px] text-muted">
              Kickoff {kickoff} · settles at full time
            </p>
          ) : null}
        </div>
        {score ? (
          <div className="text-right">
            <div className="tnum text-[26px] font-700 leading-none">
              {market.homeScore}{" "}
              <span className="text-muted">–</span> {market.awayScore}
            </div>
            <div className="text-[11px] text-muted">{status}</div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

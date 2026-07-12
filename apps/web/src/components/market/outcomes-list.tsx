"use client";

import type { MarketDto, Outcome } from "@fpm/shared";
import { centsLabel, percentLabel, volumeLabel, bpsToCents } from "@/lib/format";
import type { TradeIntent } from "@/components/trade/trade-panel";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

/**
 * Outcomes list (1c). One row per outcome — Team1 (home), Draw, Team2 (away) —
 * each carrying its true on-chain softmax price. A single Buy button per row
 * opens the ticket pre-filled with that outcome; each outcome is a distinct
 * buyable token.
 */
export function OutcomesList({
  market,
  onTrade,
}: {
  market: MarketDto;
  onTrade: (intent: TradeIntent) => void;
}) {
  const outcomes: {
    label: string;
    outcome: Exclude<Outcome, "Void">;
    bps: number;
  }[] = [
    {
      label: market.homeTeam ?? "Home",
      outcome: "Team1",
      bps: market.team1PriceBps,
    },
    { label: "Draw", outcome: "Draw", bps: market.drawPriceBps },
    {
      label: market.awayTeam ?? "Away",
      outcome: "Team2",
      bps: market.team2PriceBps,
    },
  ];

  // Reference "Market" cents per outcome, ONLY when the demargined odds feed
  // carries data (null on devnet today). Home → team1, Draw → draw, Away → team2.
  const odds = market.marketOdds;
  const marketCents: Record<string, number> | null = odds
    ? {
        Team1: bpsToCents(odds.homeBps),
        Draw: bpsToCents(odds.drawBps),
        Team2: bpsToCents(odds.awayBps),
      }
    : null;

  return (
    <Card className="divide-y divide-box-border">
      <div className="flex items-center justify-between px-4 py-3">
        <h2 className="text-[14px] font-700">Who wins the match?</h2>
        <span className="th">Buy</span>
      </div>
      {outcomes.map((o) => (
        <div
          key={o.outcome}
          className="flex items-center justify-between gap-3 px-4 py-3"
        >
          <div className="min-w-0">
            <div className="truncate text-[15px] font-600">{o.label}</div>
            <div className="text-[12px] text-muted">
              {percentLabel(o.bps)} implied · Vol{" "}
              {volumeLabel(market.totalVolume)}
            </div>
            {marketCents ? (
              <div className="mt-0.5 text-[11px] text-muted">
                Pool {bpsToCents(o.bps)}¢ · Market {marketCents[o.outcome]}¢
              </div>
            ) : null}
          </div>
          <div className="flex shrink-0 gap-2">
            <Button
              variant="yes"
              className="px-3 py-2 text-[13px]"
              onClick={() => onTrade({ outcome: o.outcome, action: "buy" })}
            >
              Buy {centsLabel(o.bps)}
            </Button>
          </div>
        </div>
      ))}
    </Card>
  );
}

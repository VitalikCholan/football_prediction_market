"use client";

import type { MarketDto, Side } from "@fpm/shared";
import { centsLabel, percentLabel, volumeLabel, bpsToCents } from "@/lib/format";
import type { TradeIntent } from "@/components/trade/trade-panel";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

/**
 * Outcomes list (1c). One row per side: name + implied % · volume, with
 * Buy Yes / No buttons that open the trade ticket pre-filled.
 */
export function OutcomesList({
  market,
  onTrade,
}: {
  market: MarketDto;
  onTrade: (intent: TradeIntent) => void;
}) {
  const yesBps = market.yesPriceBps;
  const noBps = 10000 - yesBps;

  // Reference "Market (StablePrice)" cents per outcome, ONLY when the demargined
  // odds feed carries data (null on devnet today — the whole readout stays
  // absent, no empty box). Home → YES, Away → NO.
  const odds = market.marketOdds;
  const marketCents: { YES: number; NO: number } | null = odds
    ? { YES: bpsToCents(odds.homeBps), NO: bpsToCents(odds.awayBps) }
    : null;

  const outcomes: { label: string; side: Side; bps: number }[] = [
    { label: market.homeTeam ?? "Home", side: "YES", bps: yesBps },
    { label: market.awayTeam ?? "Away", side: "NO", bps: noBps },
  ];

  return (
    <Card className="divide-y divide-box-border">
      <div className="flex items-center justify-between px-4 py-3">
        <h2 className="text-[14px] font-700">Who wins the match?</h2>
        <span className="th">Buy</span>
      </div>
      {outcomes.map((o) => (
        <div
          key={o.side}
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
                Pool {bpsToCents(o.bps)}¢ · Market {marketCents[o.side]}¢
              </div>
            ) : null}
          </div>
          <div className="flex shrink-0 gap-2">
            <Button
              variant="yes"
              className="px-3 py-2 text-[13px]"
              onClick={() => onTrade({ side: o.side, action: "buy" })}
            >
              Yes {centsLabel(o.bps)}
            </Button>
            <Button
              variant="no"
              className="px-3 py-2 text-[13px]"
              onClick={() =>
                onTrade({
                  side: o.side === "YES" ? "NO" : "YES",
                  action: "buy",
                })
              }
            >
              No {centsLabel(10000 - o.bps)}
            </Button>
          </div>
        </div>
      ))}
    </Card>
  );
}

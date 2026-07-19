"use client";

import { useEffect, useState } from "react";
import type { HistoryPointDto, MarketDto } from "@fpm/shared";
import { fetchHistory } from "@/lib/data";
import { useLiveMarket } from "@/lib/use-live";
import { MarketHeader } from "@/components/market/market-header";
import { ChartCard } from "@/components/market/chart-card";
import { OutcomesList } from "@/components/market/outcomes-list";
import { MarketInfo } from "@/components/market/market-info";
import { ResolutionPanel } from "@/components/market/resolution-panel";
import { TradePanel, type TradeIntent } from "@/components/trade/trade-panel";
import { LeveragePanel } from "@/components/trade/leverage-panel";
import { Button } from "@/components/ui/button";

/**
 * Match detail (DESIGN_SPEC 1c) client shell. Server passes the SSR market +
 * history for fast first paint; in live mode the market re-polls every 5s
 * (plus after every confirmed tx) and the chart series refetches whenever the
 * on-chain snapshot advances (frontend-plan §6.2 reconcile).
 *
 * Every market is a 3-way (Team1/Draw/Team2) LMSR market — three real outcomes
 * plus the trade/resolution panels.
 */
export function MarketDetail({
  market: initialMarket,
  points: initialPoints,
}: {
  market: MarketDto;
  points: HistoryPointDto[];
}) {
  const market = useLiveMarket(initialMarket);

  const [freshPoints, setFreshPoints] = useState<HistoryPointDto[] | null>(
    null,
  );
  const points = freshPoints ?? initialPoints;
  useEffect(() => {
    fetchHistory(initialMarket.id, { fresh: true })
      .then((h) => setFreshPoints(h.points))
      .catch(() => {});
  }, [initialMarket.id, market.updatedSlot]);

  const [intent, setIntent] = useState<TradeIntent | null>(null);
  const resolved = market.state === "Resolved";
  const homeLabel = market.homeTeam ?? "Home";
  const awayLabel = market.awayTeam ?? "Away";

  return (
    <div className="flex flex-col gap-5">
      <MarketHeader market={market} />

      {resolved ? (
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-[1fr_360px]">
          <div className="flex flex-col gap-5">
            <ChartCard
              points={points}
              homeLabel={homeLabel}
              awayLabel={awayLabel}
            />
          </div>
          <div className="flex flex-col gap-5">
            <ResolutionPanel market={market} />
            <MarketInfo market={market} />
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-[1fr_320px]">
          <div className="flex flex-col gap-5">
            <ChartCard
              points={points}
              homeLabel={homeLabel}
              awayLabel={awayLabel}
            />
            <OutcomesList market={market} onTrade={setIntent} />
          </div>
          <div className="flex flex-col gap-5">
            <Button
              variant="primary"
              onClick={() => setIntent({ outcome: "Team1", action: "buy" })}
            >
              Trade this market
            </Button>
            <MarketInfo market={market} />
          </div>
        </div>
      )}

      <TradePanel
        market={market}
        intent={intent}
        onClose={() => setIntent(null)}
      />

      {/* Leverage layer (leverage-v1 wave F) — renders only when this
          market's LeveragePool PDA exists on-chain. */}
      <LeveragePanel market={market} />
    </div>
  );
}

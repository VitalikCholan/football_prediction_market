"use client";

import { useEffect, useState } from "react";
import type { MarketDto, HistoryPointDto } from "@fpm/shared";
import { fetchHistory } from "@/lib/data";
import { useLiveMarket } from "@/lib/use-live";
import { MarketHeader } from "@/components/market/market-header";
import { OddsTape } from "@/components/market/odds-tape";
import { ChartCard } from "@/components/market/chart-card";
import { OutcomesList } from "@/components/market/outcomes-list";
import { OrderBook } from "@/components/market/order-book";
import { MarketInfo } from "@/components/market/market-info";
import { ResolutionPanel } from "@/components/market/resolution-panel";
import { TradePanel, type TradeIntent } from "@/components/trade/trade-panel";
import { Button } from "@/components/ui/button";

/**
 * Match detail (DESIGN_SPEC 1c) client shell. Server passes the SSR market +
 * history for fast first paint; in live mode the market re-polls every 5s
 * (plus after every confirmed tx) and the chart series refetches whenever the
 * on-chain snapshot advances (frontend-plan §6.2 reconcile).
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

  return (
    <div className="flex flex-col gap-5">
      <MarketHeader market={market} />

      {resolved ? (
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-[1fr_360px]">
          <div className="flex flex-col gap-5">
            <OddsTape market={market} />
            <ChartCard
              points={points}
              homeLabel={market.homeTeam ?? "Home"}
              awayLabel={market.awayTeam ?? "Away"}
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
            <OddsTape market={market} />
            <ChartCard
              points={points}
              homeLabel={market.homeTeam ?? "Home"}
              awayLabel={market.awayTeam ?? "Away"}
            />
            <OutcomesList market={market} onTrade={setIntent} />
          </div>
          <div className="flex flex-col gap-5">
            <Button
              variant="primary"
              onClick={() => setIntent({ side: "YES", action: "buy" })}
            >
              Trade this market
            </Button>
            <OrderBook market={market} />
            <MarketInfo market={market} />
          </div>
        </div>
      )}

      <TradePanel
        market={market}
        intent={intent}
        onClose={() => setIntent(null)}
      />
    </div>
  );
}

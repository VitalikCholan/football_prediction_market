"use client";

import { useEffect, useState } from "react";
import type { AnyMarketDto, HistoryPointDto } from "@fpm/shared";
import { fetchHistory, isMarket1x2 } from "@/lib/data";
import { useLiveMarket } from "@/lib/use-live";
import { MarketHeader } from "@/components/market/market-header";
import { OddsTape } from "@/components/market/odds-tape";
import { ChartCard } from "@/components/market/chart-card";
import { OutcomesList } from "@/components/market/outcomes-list";
import { OutcomesList1x2 } from "@/components/market/outcomes-list-1x2";
import { OrderBook } from "@/components/market/order-book";
import { MarketInfo } from "@/components/market/market-info";
import { MarketInfo1x2 } from "@/components/market/market-info-1x2";
import { ResolutionPanel } from "@/components/market/resolution-panel";
import { ResolutionPanel1x2 } from "@/components/market/resolution-panel-1x2";
import {
  TradePanel,
  type TradeIntent,
  type Trade1x2Intent,
} from "@/components/trade/trade-panel";
import { Button } from "@/components/ui/button";

/**
 * Match detail (DESIGN_SPEC 1c) client shell. Server passes the SSR market +
 * history for fast first paint; in live mode the market re-polls every 5s
 * (plus after every confirmed tx) and the chart series refetches whenever the
 * on-chain snapshot advances (frontend-plan §6.2 reconcile).
 *
 * Branches on market kind (C2): a 1X2 market renders three real outcomes +
 * the 1X2 trade/resolution panels; a binary market keeps the YES/NO detail.
 */
export function MarketDetail({
  market: initialMarket,
  points: initialPoints,
}: {
  market: AnyMarketDto;
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

  const [intent, setIntent] = useState<TradeIntent | Trade1x2Intent | null>(
    null,
  );
  const resolved = market.state === "Resolved";
  const homeLabel = market.homeTeam ?? "Home";
  const awayLabel = market.awayTeam ?? "Away";

  return (
    <div className="flex flex-col gap-5">
      <MarketHeader market={market} />

      {resolved ? (
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-[1fr_360px]">
          <div className="flex flex-col gap-5">
            {isMarket1x2(market) ? null : <OddsTape market={market} />}
            <ChartCard
              points={points}
              homeLabel={homeLabel}
              awayLabel={awayLabel}
            />
          </div>
          <div className="flex flex-col gap-5">
            {isMarket1x2(market) ? (
              <>
                <ResolutionPanel1x2 market={market} />
                <MarketInfo1x2 market={market} />
              </>
            ) : (
              <>
                <ResolutionPanel market={market} />
                <MarketInfo market={market} />
              </>
            )}
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-[1fr_320px]">
          <div className="flex flex-col gap-5">
            {isMarket1x2(market) ? null : <OddsTape market={market} />}
            <ChartCard
              points={points}
              homeLabel={homeLabel}
              awayLabel={awayLabel}
            />
            {isMarket1x2(market) ? (
              <OutcomesList1x2 market={market} onTrade={setIntent} />
            ) : (
              <OutcomesList market={market} onTrade={setIntent} />
            )}
          </div>
          <div className="flex flex-col gap-5">
            <Button
              variant="primary"
              onClick={() =>
                setIntent(
                  isMarket1x2(market)
                    ? { outcome: "Team1", action: "buy" }
                    : { side: "YES", action: "buy" },
                )
              }
            >
              Trade this market
            </Button>
            {isMarket1x2(market) ? (
              <MarketInfo1x2 market={market} />
            ) : (
              <>
                <OrderBook market={market} />
                <MarketInfo market={market} />
              </>
            )}
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

"use client";

import { useState } from "react";
import type { MarketDto, HistoryPointDto } from "@fpm/shared";
import { MarketHeader } from "@/components/market/market-header";
import { OddsTape } from "@/components/market/odds-tape";
import { ChartCard } from "@/components/market/chart-card";
import { OutcomesList } from "@/components/market/outcomes-list";
import { OrderBook } from "@/components/market/order-book";
import { MarketInfo } from "@/components/market/market-info";
import { ResolutionPanel } from "@/components/market/resolution-panel";
import { TradePanel, type TradeIntent } from "@/components/trade/trade-panel";

/**
 * Match detail (DESIGN_SPEC 1c) client shell. Server passes the market +
 * history; this wires the trade ticket slide-in and swaps to the resolved
 * (1g) layout when the market has settled.
 */
export function MarketDetail({
  market,
  points,
}: {
  market: MarketDto;
  points: HistoryPointDto[];
}) {
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
            <button
              className="btn btn-p"
              onClick={() => setIntent({ side: "YES", action: "buy" })}
            >
              Trade this market
            </button>
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

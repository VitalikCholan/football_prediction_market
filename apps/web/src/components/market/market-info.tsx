import type { MarketDto } from "@fpm/shared";
import { volumeLabel, baseToUsdc, usdCompactLabel } from "@/lib/format";
import { FeeBar } from "@/components/market/fee-bar";

/** Market info sidebar (1c): volume, liquidity, resolution source, fee. */
export function MarketInfo({ market }: { market: MarketDto }) {
  const liquidity =
    baseToUsdc(market.yesReserve) + baseToUsdc(market.noReserve);

  const rows: [string, string][] = [
    ["Total volume", volumeLabel(market.totalVolume)],
    ["Liquidity", usdCompactLabel(liquidity)],
    ["Resolves", "At full time"],
    ["Source", "TxLINE oracle"],
  ];

  return (
    <div className="scr flex flex-col gap-3 p-4">
      <h3 className="text-[13px] font-700">Market info</h3>
      <dl className="flex flex-col gap-2">
        {rows.map(([k, v]) => (
          <div key={k} className="flex items-center justify-between text-[13px]">
            <dt className="text-muted">{k}</dt>
            <dd className="tnum font-600">{v}</dd>
          </div>
        ))}
      </dl>

      <FeeBar
        currentFeeBps={market.currentFeeBps}
        baseFeeBps={market.baseFeeBps}
      />

      <div className="verified mt-1 justify-center">
        ◆ Settlement verified on-chain
      </div>
    </div>
  );
}

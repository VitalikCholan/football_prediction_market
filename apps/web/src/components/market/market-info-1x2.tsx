import type { Market1x2Dto } from "@fpm/shared";
import { volumeLabel, baseToUsdt, usdCompactLabel } from "@/lib/format";
import { FeeBar } from "@/components/market/fee-bar";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

/**
 * 1X2 market info sidebar (1c, C2): volume, LMSR depth (the `b` liquidity
 * parameter), resolution source, fee. Mirrors the binary `MarketInfo` — the
 * liquidity readout uses `b` since a 1X2 market has no yes/no reserves.
 */
export function MarketInfo1x2({ market }: { market: Market1x2Dto }) {
  const rows: [string, string][] = [
    ["Total volume", volumeLabel(market.totalVolume)],
    ["LMSR depth (b)", usdCompactLabel(baseToUsdt(market.b))],
    ["Resolves", "At full time"],
    ["Source", "TxLINE oracle"],
  ];

  return (
    <Card className="flex flex-col gap-3 p-4">
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

      <Badge variant="verified" className="mt-1 self-center">
        ◆ Settlement verified on-chain
      </Badge>
    </Card>
  );
}

"use client";

import { useMemo, useState } from "react";
import dynamic from "next/dynamic";
import type { HistoryPointDto } from "@fpm/shared";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

const PriceChart = dynamic(() => import("@/components/market/price-chart"), {
  ssr: false,
  loading: () => <Skeleton className="h-[320px] w-full rounded-lg" />,
});

type TF = "1H" | "Match" | "All";

/** Hero chart card with timeframe pills (1c). */
export function ChartCard({
  points,
  homeLabel,
  awayLabel,
}: {
  points: HistoryPointDto[];
  homeLabel: string;
  awayLabel: string;
}) {
  const [tf, setTf] = useState<TF>("Match");

  const filtered = useMemo(() => {
    if (points.length === 0) return points;
    const last = points[points.length - 1].time;
    if (tf === "1H") return points.filter((p) => p.time >= last - 3600);
    if (tf === "Match") return points.filter((p) => p.time >= last - 3 * 3600);
    return points;
  }, [points, tf]);

  return (
    <Card className="p-4">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-[14px] font-700">Price history</h2>
        <div className="flex gap-1.5">
          {(["1H", "Match", "All"] as TF[]).map((t) => (
            <Button
              key={t}
              variant={tf === t ? "pillOn" : "pill"}
              size="pill"
              className="px-3 py-1 text-[12px]"
              onClick={() => setTf(t)}
            >
              {t}
            </Button>
          ))}
        </div>
      </div>
      <PriceChart
        points={filtered}
        homeLabel={homeLabel}
        awayLabel={awayLabel}
      />
    </Card>
  );
}

"use client";

import { useEffect, useRef, useState } from "react";
import type { MarketDto } from "@fpm/shared";
import { centsLabel, percentLabel } from "@/lib/format";
import { Card } from "@/components/ui/card";

/**
 * Odds tape (signature element). The two sides' live prices, tabular, that
 * flash green/red on change like a scoreboard flip. aria-live for screen
 * readers; reduced-motion disables the flash (see globals.css).
 */
export function OddsTape({ market }: { market: MarketDto }) {
  const yesBps = market.yesPriceBps;
  const noBps = 10000 - yesBps;
  const prev = useRef(yesBps);
  const [flash, setFlash] = useState<"up" | "down" | null>(null);

  useEffect(() => {
    if (yesBps === prev.current) return;
    setFlash(yesBps > prev.current ? "up" : "down");
    prev.current = yesBps;
    const t = setTimeout(() => setFlash(null), 600);
    return () => clearTimeout(t);
  }, [yesBps]);

  return (
    <Card
      className="grid grid-cols-2 divide-x divide-box-border"
      aria-live="polite"
    >
      <Side
        team={market.homeTeam ?? "Home"}
        tone="yes"
        cents={centsLabel(yesBps)}
        implied={percentLabel(yesBps)}
        flash={flash === "up" ? "flash-up" : ""}
      />
      <Side
        team={market.awayTeam ?? "Away"}
        tone="no"
        cents={centsLabel(noBps)}
        implied={percentLabel(noBps)}
        flash={flash === "down" ? "flash-down" : ""}
      />
    </Card>
  );
}

function Side({
  team,
  tone,
  cents,
  implied,
  flash,
}: {
  team: string;
  tone: "yes" | "no";
  cents: string;
  implied: string;
  flash: string;
}) {
  return (
    <div className={`flex items-center justify-between px-5 py-4 ${flash}`}>
      <div>
        <div className="text-[13px] font-600">{team}</div>
        <div className="text-[11px] text-muted">{implied} implied</div>
      </div>
      <div
        className={`tnum text-[28px] font-700 ${
          tone === "yes" ? "text-yes-strong" : "text-no-strong"
        }`}
      >
        {cents}
      </div>
    </div>
  );
}

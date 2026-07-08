"use client";

import { useMemo, useState } from "react";
import type { MarketDto } from "@fpm/shared";
import { MatchCard } from "@/components/market/match-card";

type Filter = "all" | "group" | "knockout" | "live";
type Sort = "volume" | "closing";

const FILTERS: { id: Filter; label: string }[] = [
  { id: "all", label: "All markets" },
  { id: "group", label: "Group stage" },
  { id: "knockout", label: "Knockout" },
  { id: "live", label: "● Live now" },
];

export function MarketsBrowse({ markets }: { markets: MarketDto[] }) {
  const [filter, setFilter] = useState<Filter>("all");
  const [sort, setSort] = useState<Sort>("volume");

  const shown = useMemo(() => {
    let list = markets;
    if (filter === "live") list = list.filter((m) => m.state === "Trading");
    list = [...list].sort((a, b) =>
      sort === "volume"
        ? Number(b.totalVolume) - Number(a.totalVolume)
        : (a.freezeTs ?? Infinity) - (b.freezeTs ?? Infinity),
    );
    return list;
  }, [markets, filter, sort]);

  return (
    <div>
      <div className="mb-5 flex flex-wrap items-center gap-2">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            className={`pill ${filter === f.id ? "pill-on" : ""}`}
            onClick={() => setFilter(f.id)}
          >
            {f.label}
          </button>
        ))}
        <div className="ml-auto">
          <button
            className="pill"
            onClick={() =>
              setSort((s) => (s === "volume" ? "closing" : "volume"))
            }
          >
            Sort: {sort === "volume" ? "Volume" : "Closing soon"} ▾
          </button>
        </div>
      </div>

      {shown.length === 0 ? (
        <div className="scr p-10 text-center text-[14px] text-muted">
          No markets in this filter yet.
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {shown.map((m, i) => (
            <MatchCard key={m.id} market={m} index={i} />
          ))}
        </div>
      )}
    </div>
  );
}

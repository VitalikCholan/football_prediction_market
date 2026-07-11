"use client";

import { useMemo, useState } from "react";
import type { MarketDto } from "@fpm/shared";
import { MatchCard } from "@/components/market/match-card";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

type Sort = "volume" | "closing";

// A filter is either the "all" catch-all, a state predicate (Live/Resolved),
// or a competition-name match. Encoded as a tagged id so the pill list can be
// built dynamically from the loaded markets.
type Filter =
  | { kind: "all" }
  | { kind: "state"; state: MarketDto["state"] }
  | { kind: "competition"; competition: string };

interface Pill {
  id: string;
  label: string;
  filter: Filter;
}

const ALL_PILL: Pill = { id: "all", label: "All markets", filter: { kind: "all" } };

/** Build the pill list from the markets actually loaded (null-safe, no empties). */
function buildPills(markets: MarketDto[]): Pill[] {
  const pills: Pill[] = [ALL_PILL];

  // One pill per distinct non-null competition, in first-seen order.
  const seen = new Set<string>();
  for (const m of markets) {
    const c = m.competition;
    if (!c || seen.has(c)) continue;
    seen.add(c);
    pills.push({
      id: `competition:${c}`,
      label: c,
      filter: { kind: "competition", competition: c },
    });
  }

  // State pills — only shown when at least one market qualifies.
  if (markets.some((m) => m.state === "Trading")) {
    pills.push({
      id: "live",
      label: "● Live now",
      filter: { kind: "state", state: "Trading" },
    });
  }
  if (markets.some((m) => m.state === "Resolved")) {
    pills.push({
      id: "resolved",
      label: "Resolved",
      filter: { kind: "state", state: "Resolved" },
    });
  }

  return pills;
}

function matches(m: MarketDto, filter: Filter): boolean {
  switch (filter.kind) {
    case "all":
      return true;
    case "state":
      return m.state === filter.state;
    case "competition":
      return m.competition === filter.competition;
  }
}

export function MarketsBrowse({ markets }: { markets: MarketDto[] }) {
  const [activeId, setActiveId] = useState<string>(ALL_PILL.id);
  const [sort, setSort] = useState<Sort>("volume");

  const pills = useMemo(() => buildPills(markets), [markets]);

  // Fall back to "all" if the active pill vanished (e.g. markets reloaded).
  const active =
    pills.find((p) => p.id === activeId)?.filter ?? ALL_PILL.filter;

  const shown = useMemo(() => {
    const list = markets.filter((m) => matches(m, active));
    return [...list].sort((a, b) =>
      sort === "volume"
        ? Number(b.totalVolume) - Number(a.totalVolume)
        : (a.freezeTs ?? Infinity) - (b.freezeTs ?? Infinity),
    );
  }, [markets, active, sort]);

  return (
    <div>
      <div className="mb-5 flex flex-wrap items-center gap-2">
        {pills.map((p) => (
          <Button
            key={p.id}
            variant={activeId === p.id ? "pillOn" : "pill"}
            size="pill"
            onClick={() => setActiveId(p.id)}
          >
            {p.label}
          </Button>
        ))}
        <div className="ml-auto">
          <Select value={sort} onValueChange={(v) => setSort(v as Sort)}>
            <SelectTrigger aria-label="Sort markets">
              <span className="text-muted">Sort:</span>
              <SelectValue />
            </SelectTrigger>
            <SelectContent align="end">
              <SelectItem value="volume">Volume</SelectItem>
              <SelectItem value="closing">Closing soon</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {shown.length === 0 ? (
        <Card className="p-10 text-center text-[14px] text-muted">
          No markets in this filter yet.
        </Card>
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

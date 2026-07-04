"use client";

import { useState } from "react";
import { LEADERBOARD, ACTIVITY } from "@/lib/fixtures";
import { usdCompactLabel, usd, timeAgo } from "@/lib/format";

type Range = "today" | "week" | "all";

/** Leaderboard + live activity (DESIGN_SPEC 1f), side by side. */
export function LeaderboardView() {
  const [range, setRange] = useState<Range>("week");

  return (
    <div className="grid grid-cols-1 gap-5 lg:grid-cols-[1fr_340px]">
      {/* Leaderboard */}
      <div className="scr overflow-hidden">
        <div className="flex items-center justify-between border-b border-box-border px-4 py-3">
          <h2 className="text-[14px] font-700">Leaderboard</h2>
          <div className="flex gap-1.5">
            {(["today", "week", "all"] as Range[]).map((r) => (
              <button
                key={r}
                className={`pill px-3 py-1 text-[12px] capitalize ${
                  range === r ? "pill-on" : ""
                }`}
                onClick={() => setRange(r)}
              >
                {r}
              </button>
            ))}
          </div>
        </div>
        <table className="w-full border-collapse">
          <thead>
            <tr className="border-b border-box-border text-left">
              <th className="th px-4 py-2 w-10">#</th>
              <th className="th px-4 py-2">Trader</th>
              <th className="th px-4 py-2 text-right">Volume</th>
              <th className="th px-4 py-2 text-right">Profit</th>
            </tr>
          </thead>
          <tbody>
            {LEADERBOARD.map((row) => (
              <tr
                key={row.rank}
                className={`border-b border-box-border last:border-0 ${
                  row.you ? "bg-tag-bg" : ""
                }`}
              >
                <td className="td tnum px-4 py-2.5 text-muted">{row.rank}</td>
                <td className="td px-4 py-2.5">
                  <span className="flex items-center gap-2">
                    <span
                      className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-skeleton text-[11px] font-700"
                      aria-hidden
                    >
                      {row.name.slice(0, 2).toUpperCase()}
                    </span>
                    <span className={row.you ? "font-700" : "font-500"}>
                      {row.name}
                      {row.you ? (
                        <span className="ml-1.5 text-[11px] text-link">
                          (you)
                        </span>
                      ) : null}
                    </span>
                  </span>
                </td>
                <td className="td tnum px-4 py-2.5 text-right">
                  {usdCompactLabel(row.volume)}
                </td>
                <td className="td tnum px-4 py-2.5 text-right font-700 pos">
                  +{usdCompactLabel(row.profit)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Activity */}
      <div className="scr flex flex-col overflow-hidden">
        <div className="flex items-center gap-2 border-b border-box-border px-4 py-3">
          <span className="dot dot-pulse" aria-hidden />
          <h2 className="text-[14px] font-700">Live activity</h2>
        </div>
        <ul className="divide-y divide-box-border" aria-live="polite">
          {ACTIVITY.map((a) => (
            <li key={a.id} className="flex items-center justify-between px-4 py-2.5">
              <div className="min-w-0">
                <div className="truncate text-[13px]">
                  <span className="font-600">{a.user}</span>{" "}
                  <span
                    className={a.action === "bought" ? "pos" : "neg"}
                  >
                    {a.action}
                  </span>{" "}
                  {a.outcome}{" "}
                  <span className="tnum text-muted">{a.cents}¢</span>
                </div>
                <div className="text-[11px] text-muted">
                  {usd(a.amount)} · {timeAgo(a.ts, 1_720_000_000 * 1000 + 5000)}
                </div>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

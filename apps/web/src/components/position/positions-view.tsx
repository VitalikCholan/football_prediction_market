"use client";

import { useState } from "react";
import Link from "next/link";
import { PORTFOLIO } from "@/lib/fixtures";
import { usd, shares as fmtShares, signedPercent } from "@/lib/format";

type Tab = "open" | "history" | "claims";

/**
 * Portfolio / positions (DESIGN_SPEC 1e). Value header + tabs + positions
 * table with colored P/L. Fixtures drive the demo; live positions come from
 * on-chain Position PDA reads once the program IDL lands.
 */
export function PositionsView() {
  const [tab, setTab] = useState<Tab>("open");

  return (
    <div className="flex flex-col gap-5">
      {/* Value header */}
      <div className="scr flex flex-wrap items-center gap-x-8 gap-y-4 p-5">
        <div>
          <div className="th">Portfolio value</div>
          <div className="tnum text-[26px] font-700">{usd(PORTFOLIO.value)}</div>
        </div>
        <Stat label="Cash" value={usd(PORTFOLIO.cash)} />
        <Stat label="In positions" value={usd(PORTFOLIO.inPositions)} />
        <div>
          <div className="th">All-time P/L</div>
          <div className="tnum text-[20px] font-700 pos">
            +{usd(PORTFOLIO.allTimePnl)}
          </div>
        </div>
        <div className="ml-auto flex gap-2">
          <button className="btn btn-p">Deposit</button>
          <button className="btn">Withdraw</button>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1.5">
        {(["open", "history", "claims"] as Tab[]).map((t) => (
          <button
            key={t}
            className={`pill capitalize ${tab === t ? "pill-on" : ""}`}
            onClick={() => setTab(t)}
          >
            {t === "open" ? "Open positions" : t}
          </button>
        ))}
      </div>

      {/* Positions table */}
      {tab === "open" ? (
        <div className="scr overflow-x-auto">
          <table className="w-full min-w-[720px] border-collapse">
            <thead>
              <tr className="border-b border-box-border text-left">
                <th className="th px-4 py-3">Market</th>
                <th className="th px-4 py-3">Outcome</th>
                <th className="th px-4 py-3 text-right">Shares</th>
                <th className="th px-4 py-3 text-right">Avg</th>
                <th className="th px-4 py-3 text-right">Now</th>
                <th className="th px-4 py-3 text-right">Value</th>
                <th className="th px-4 py-3 text-right">P/L</th>
              </tr>
            </thead>
            <tbody>
              {PORTFOLIO.positions.map((p) => {
                const value = (p.shares * p.nowCents) / 100;
                const cost = (p.shares * p.avgCents) / 100;
                const pnl = value - cost;
                const pnlPct = (pnl / cost) * 100;
                const cls =
                  pnl > 0 ? "pos" : pnl < 0 ? "neg" : "text-muted";
                return (
                  <tr
                    key={p.marketId + p.outcome}
                    className="border-b border-box-border last:border-0"
                  >
                    <td className="td px-4 py-3">
                      <Link
                        href={`/markets/${p.marketId}`}
                        className="font-600 no-underline hover:underline"
                      >
                        {p.market}
                      </Link>
                      <div className="flex items-center gap-1 text-[11px] text-muted">
                        {p.live ? (
                          <span className="dot dot-pulse" aria-hidden />
                        ) : null}
                        {p.sub}
                      </div>
                    </td>
                    <td className="td px-4 py-3">
                      <span
                        className={`chip ${
                          p.side === "YES" ? "yc" : "nc"
                        } inline-block px-2 py-0.5 text-[12px] font-600`}
                      >
                        {p.outcome} {p.side}
                      </span>
                    </td>
                    <td className="td tnum px-4 py-3 text-right">
                      {fmtShares(p.shares)}
                    </td>
                    <td className="td tnum px-4 py-3 text-right">
                      {p.avgCents}¢
                    </td>
                    <td className="td tnum px-4 py-3 text-right">
                      {p.nowCents}¢
                    </td>
                    <td className="td tnum px-4 py-3 text-right font-600">
                      {usd(value)}
                    </td>
                    <td
                      className={`td tnum px-4 py-3 text-right font-700 ${cls}`}
                    >
                      {pnl >= 0 ? "+" : ""}
                      {usd(pnl)}
                      <span className="ml-1 text-[11px] font-500">
                        {signedPercent(pnlPct)}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="scr p-10 text-center text-[14px] text-muted">
          {tab === "history"
            ? "No settled trades yet. Your trade history will appear here."
            : "No claims available. Winning positions become claimable after a market resolves."}
        </div>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="th">{label}</div>
      <div className="tnum text-[20px] font-700">{value}</div>
    </div>
  );
}

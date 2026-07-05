"use client";

import { useState } from "react";
import Link from "next/link";
import { PORTFOLIO } from "@/lib/fixtures";
import { usd, shares as fmtShares, signedPercent } from "@/lib/format";
import { dataMode } from "@/lib/data";
import {
  notifyTxConfirmed,
  useUsdtBalance,
  useUserPositions,
} from "@/lib/use-live";
import { winningTokens, type UserPosition } from "@/lib/positions";
import { prepareClaim } from "@/lib/tx";
import { explorerTx } from "@/lib/solana";
import { useAccountAddress, useTxAuthority } from "@/components/wallet/use-account";
import { useFaucet } from "@/components/wallet/use-faucet";
import { useToast } from "@/components/ui/toast";

type Tab = "open" | "history" | "claims";

/**
 * Portfolio / positions (DESIGN_SPEC 1e). Value header + tabs + positions
 * table with colored P/L. Live mode decodes the wallet's on-chain `Position`
 * PDAs (authoritative balances, @fpm/idl); demo mode renders fixtures.
 */
export function PositionsView() {
  return dataMode === "live" ? <LivePositions /> : <DemoPositions />;
}

/* -------------------------------------------------------------- live view */

const SCALE = 1_000_000;

/** Mark value of a position at current odds, whole USDT. */
function markValue(p: UserPosition): number {
  const yes = Number(p.yesTokens) / SCALE;
  const no = Number(p.noTokens) / SCALE;
  if (p.market.state === "Resolved") {
    return p.redeemed ? 0 : Number(winningTokens(p)) / SCALE;
  }
  const yesPrice = p.market.yesPriceBps / 10_000;
  return yes * yesPrice + no * (1 - yesPrice);
}

function LivePositions() {
  const address = useAccountAddress();
  const [tab, setTab] = useState<Tab>("open");
  const { positions, loading, refresh } = useUserPositions(address);
  const { balanceBase, refresh: refreshBalance } = useUsdtBalance(address);
  const faucet = useFaucet(() => {
    refreshBalance();
    refresh();
  });

  const open = positions.filter(
    (p) =>
      p.market.state !== "Resolved" && (p.yesTokens > 0n || p.noTokens > 0n),
  );
  const claims = positions.filter(
    (p) => p.market.state === "Resolved" && !p.redeemed && winningTokens(p) > 0n,
  );

  const cash = balanceBase === null ? 0 : Number(balanceBase) / SCALE;
  const inPositions = open.reduce((s, p) => s + markValue(p), 0);
  const claimable = claims.reduce(
    (s, p) => s + Number(winningTokens(p)) / SCALE,
    0,
  );

  return (
    <div className="flex flex-col gap-5">
      {/* Value header */}
      <div className="scr flex flex-wrap items-center gap-x-8 gap-y-4 p-5">
        <div>
          <div className="th">Portfolio value</div>
          <div className="tnum text-[26px] font-700">
            {usd(cash + inPositions + claimable)}
          </div>
        </div>
        <Stat
          label="Cash (USDT)"
          value={balanceBase === null ? "…" : usd(cash)}
        />
        <Stat label="In positions" value={usd(inPositions)} />
        <div>
          <div className="th">Claimable</div>
          <div
            className={`tnum text-[20px] font-700 ${claimable > 0 ? "pos" : ""}`}
          >
            {usd(claimable)}
          </div>
        </div>
        <div className="ml-auto flex gap-2">
          <button
            className="btn btn-p"
            disabled={faucet.busy}
            onClick={faucet.run}
          >
            {faucet.busy ? "Requesting…" : "Get test USDT"}
          </button>
        </div>
      </div>
      {faucet.error ? (
        <p className="text-[12px] font-600 text-no-strong" role="alert">
          {faucet.error}
        </p>
      ) : null}

      {/* Tabs */}
      <div className="flex gap-1.5">
        {(["open", "history", "claims"] as Tab[]).map((t) => (
          <button
            key={t}
            className={`pill capitalize ${tab === t ? "pill-on" : ""}`}
            onClick={() => setTab(t)}
          >
            {t === "open"
              ? "Open positions"
              : t === "claims"
                ? `Claims${claims.length ? ` (${claims.length})` : ""}`
                : t}
          </button>
        ))}
      </div>

      {tab === "open" ? (
        loading ? (
          <div className="scr p-10 text-center text-[14px] text-muted">
            Loading on-chain positions…
          </div>
        ) : open.length === 0 ? (
          <div className="scr p-10 text-center text-[14px] text-muted">
            No open positions. Buy YES or NO on a market to get started.
          </div>
        ) : (
          <LiveTable positions={open} />
        )
      ) : tab === "claims" ? (
        claims.length === 0 ? (
          <div className="scr p-10 text-center text-[14px] text-muted">
            No claims available. Winning positions become claimable after a
            market resolves.
          </div>
        ) : (
          <ClaimsList positions={claims} onClaimed={refresh} />
        )
      ) : (
        <div className="scr p-10 text-center text-[14px] text-muted">
          No settled trades yet. Your trade history will appear here.
        </div>
      )}
    </div>
  );
}

function marketLabel(p: UserPosition): string {
  return p.market.homeTeam
    ? `${p.market.homeTeam} vs ${p.market.awayTeam ?? "Away"}`
    : `Fixture ${p.market.fixtureId}`;
}

function LiveTable({ positions }: { positions: UserPosition[] }) {
  // One row per held side so YES and NO books read separately.
  const rows = positions.flatMap((p) =>
    (["YES", "NO"] as const)
      .filter((side) => (side === "YES" ? p.yesTokens : p.noTokens) > 0n)
      .map((side) => {
        const tokens =
          Number(side === "YES" ? p.yesTokens : p.noTokens) / SCALE;
        const priceBps =
          side === "YES"
            ? p.market.yesPriceBps
            : 10_000 - p.market.yesPriceBps;
        const nowCents = priceBps / 100;
        const totalTokens = Number(p.yesTokens + p.noTokens) / SCALE;
        const avgCents =
          totalTokens > 0
            ? (Number(p.collateralBase) / SCALE / totalTokens) * 100
            : 0;
        const value = (tokens * nowCents) / 100;
        const cost = (tokens * avgCents) / 100;
        return { p, side, tokens, avgCents, nowCents, value, pnl: value - cost, cost };
      }),
  );

  return (
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
          {rows.map((r) => {
            const cls = r.pnl > 0 ? "pos" : r.pnl < 0 ? "neg" : "text-muted";
            const pnlPct = r.cost > 0 ? (r.pnl / r.cost) * 100 : 0;
            return (
              <tr
                key={r.p.address + r.side}
                className="border-b border-box-border last:border-0"
              >
                <td className="td px-4 py-3">
                  <Link
                    href={`/markets/${r.p.market.id}`}
                    className="font-600 no-underline hover:underline"
                  >
                    {marketLabel(r.p)}
                  </Link>
                  <div className="flex items-center gap-1 text-[11px] text-muted">
                    {r.p.market.state === "Trading" ? (
                      <span className="dot dot-pulse" aria-hidden />
                    ) : null}
                    {r.p.market.state}
                  </div>
                </td>
                <td className="td px-4 py-3">
                  <span
                    className={`chip ${
                      r.side === "YES" ? "yc" : "nc"
                    } inline-block px-2 py-0.5 text-[12px] font-600`}
                  >
                    {r.side}
                  </span>
                </td>
                <td className="td tnum px-4 py-3 text-right">
                  {fmtShares(r.tokens)}
                </td>
                <td className="td tnum px-4 py-3 text-right">
                  {r.avgCents > 0 ? `${r.avgCents.toFixed(0)}¢` : "—"}
                </td>
                <td className="td tnum px-4 py-3 text-right">
                  {r.nowCents.toFixed(0)}¢
                </td>
                <td className="td tnum px-4 py-3 text-right font-600">
                  {usd(r.value)}
                </td>
                <td className={`td tnum px-4 py-3 text-right font-700 ${cls}`}>
                  {r.pnl >= 0 ? "+" : ""}
                  {usd(r.pnl)}
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
  );
}

/** Claims tab — redeem winning positions (1 token = 1 USDT). */
function ClaimsList({
  positions,
  onClaimed,
}: {
  positions: UserPosition[];
  onClaimed: () => void;
}) {
  const { getAuthority } = useTxAuthority();
  const toast = useToast();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function claim(p: UserPosition) {
    setBusyId(p.market.id);
    setError(null);
    try {
      const authority = await getAuthority();
      if (!authority) throw new Error("Wallet cannot sign — reconnect");
      const prepared = await prepareClaim(authority, { marketId: p.market.id });
      if (!prepared.sim.ok) {
        throw new Error(prepared.sim.error ?? "Simulation failed");
      }
      const res = await prepared.send();
      toast.push({
        title: `Redeemed ${usd(Number(winningTokens(p)) / SCALE)}`,
        href: explorerTx(res.signature),
        hrefLabel: "View tx ↗",
      });
      notifyTxConfirmed();
      onClaimed();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      {error ? (
        <p className="text-[12px] font-600 text-no-strong" role="alert">
          {error}
        </p>
      ) : null}
      {positions.map((p) => {
        const payout = Number(winningTokens(p)) / SCALE;
        return (
          <div
            key={p.market.id}
            className="scr flex items-center justify-between p-4"
          >
            <div>
              <Link
                href={`/markets/${p.market.id}`}
                className="font-600 no-underline hover:underline"
              >
                {marketLabel(p)}
              </Link>
              <div className="text-[12px] text-muted">
                Resolved {p.market.outcome} ·{" "}
                {fmtShares(payout)} winning shares · $1.00 / share
              </div>
            </div>
            <button
              className="btn btn-p"
              disabled={busyId !== null}
              onClick={() => claim(p)}
            >
              {busyId === p.market.id ? "Redeeming…" : `Redeem ${usd(payout)}`}
            </button>
          </div>
        );
      })}
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

/* -------------------------------------------------------------- demo view */

function DemoPositions() {
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

"use client";

import { useState } from "react";
import Link from "next/link";
import { usd, shares as fmtShares, signedPercent } from "@/lib/format";
import {
  notifyTxConfirmed,
  useUsdtBalance,
  useUserPositions,
} from "@/lib/use-live";
import {
  winningTokens,
  totalTokens,
  type UserPosition,
} from "@/lib/positions";
import { friendlyTxError } from "@fpm/shared";
import { prepareClaim, prepareClaim1x2 } from "@/lib/tx";
import { explorerTx } from "@/lib/solana";
import { useAccountAddress, useTxAuthority } from "@/components/wallet/use-account";
import { useFaucet } from "@/components/wallet/use-faucet";
import { useToast } from "@/components/ui/toast";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

type Tab = "open" | "history" | "claims";

/**
 * Portfolio / positions (DESIGN_SPEC 1e). Value header + tabs + positions
 * table with colored P/L. Decodes the wallet's on-chain `Position` PDAs
 * (authoritative balances, @fpm/idl) — no demo/fixture path.
 */
export function PositionsView() {
  return <LivePositions />;
}

const SCALE = 1_000_000;

/** Mark value of a position at current odds, whole USDT (both market kinds). */
function markValue(p: UserPosition): number {
  if (p.market.state === "Resolved") {
    return p.redeemed ? 0 : Number(winningTokens(p)) / SCALE;
  }
  if (p.kind === "binary") {
    const yes = Number(p.yesTokens) / SCALE;
    const no = Number(p.noTokens) / SCALE;
    const yesPrice = p.market.yesPriceBps / 10_000;
    return yes * yesPrice + no * (1 - yesPrice);
  }
  // 1X2: each outcome token marked at its own softmax price.
  const [t1, td, t2] = p.tokens;
  return (
    (Number(t1) / SCALE) * (p.market.team1PriceBps / 10_000) +
    (Number(td) / SCALE) * (p.market.drawPriceBps / 10_000) +
    (Number(t2) / SCALE) * (p.market.team2PriceBps / 10_000)
  );
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
    (p) => p.market.state !== "Resolved" && totalTokens(p) > 0n,
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
      <Card className="flex flex-wrap items-center gap-x-8 gap-y-4 p-5">
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
          <Button variant="primary" disabled={faucet.busy} onClick={faucet.run}>
            {faucet.busy ? "Requesting…" : "Get test USDT"}
          </Button>
        </div>
      </Card>
      {faucet.error ? (
        <p className="text-[12px] font-600 text-no-strong" role="alert">
          {faucet.error}
        </p>
      ) : null}

      {/* Tabs */}
      <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
        <TabsList variant="pills">
          {(["open", "history", "claims"] as Tab[]).map((t) => (
            <TabsTrigger key={t} value={t} variant="pills" className="capitalize">
              {t === "open"
                ? "Open positions"
                : t === "claims"
                  ? `Claims${claims.length ? ` (${claims.length})` : ""}`
                  : t}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      {tab === "open" ? (
        loading ? (
          <Card className="p-10 text-center text-[14px] text-muted">
            Loading on-chain positions…
          </Card>
        ) : open.length === 0 ? (
          <Card className="p-10 text-center text-[14px] text-muted">
            No open positions. Buy YES or NO on a market to get started.
          </Card>
        ) : (
          <LiveTable positions={open} />
        )
      ) : tab === "claims" ? (
        claims.length === 0 ? (
          <Card className="p-10 text-center text-[14px] text-muted">
            No claims available. Winning positions become claimable after a
            market resolves.
          </Card>
        ) : (
          <ClaimsList positions={claims} onClaimed={refresh} />
        )
      ) : (
        <Card className="p-10 text-center text-[14px] text-muted">
          No settled trades yet. Your trade history will appear here.
        </Card>
      )}
    </div>
  );
}

function marketLabel(p: UserPosition): string {
  return p.market.homeTeam
    ? `${p.market.homeTeam} vs ${p.market.awayTeam ?? "Away"}`
    : `Fixture ${p.market.fixtureId}`;
}

/** Per-outcome legs of a position (binary YES/NO or 1X2 Team1/Draw/Team2). */
function positionLegs(
  p: UserPosition,
): { label: string; tint: "yc" | "nc"; tokensBase: bigint; priceBps: number }[] {
  if (p.kind === "binary") {
    return [
      {
        label: "YES",
        tint: "yc" as const,
        tokensBase: p.yesTokens,
        priceBps: p.market.yesPriceBps,
      },
      {
        label: "NO",
        tint: "nc" as const,
        tokensBase: p.noTokens,
        priceBps: 10_000 - p.market.yesPriceBps,
      },
    ];
  }
  return [
    {
      label: p.market.homeTeam ?? "Team 1",
      tint: "yc" as const,
      tokensBase: p.tokens[0],
      priceBps: p.market.team1PriceBps,
    },
    {
      label: "Draw",
      tint: "nc" as const,
      tokensBase: p.tokens[1],
      priceBps: p.market.drawPriceBps,
    },
    {
      label: p.market.awayTeam ?? "Team 2",
      tint: "nc" as const,
      tokensBase: p.tokens[2],
      priceBps: p.market.team2PriceBps,
    },
  ];
}

function LiveTable({ positions }: { positions: UserPosition[] }) {
  // One row per held outcome so each book reads separately (both market kinds).
  const rows = positions.flatMap((p) => {
    const totalBase = Number(totalTokens(p)) / SCALE;
    const avgCents =
      totalBase > 0 ? (Number(p.collateralBase) / SCALE / totalBase) * 100 : 0;
    return positionLegs(p)
      .filter((leg) => leg.tokensBase > 0n)
      .map((leg, li) => {
        const tokens = Number(leg.tokensBase) / SCALE;
        const nowCents = leg.priceBps / 100;
        const value = (tokens * nowCents) / 100;
        const cost = (tokens * avgCents) / 100;
        return {
          p,
          key: `${p.address}-${li}`,
          side: leg.label,
          tint: leg.tint,
          tokens,
          avgCents,
          nowCents,
          value,
          pnl: value - cost,
          cost,
        };
      });
  });

  return (
    <Card className="overflow-x-auto">
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
                key={r.key}
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
                    className={`chip ${r.tint} inline-block px-2 py-0.5 text-[12px] font-600`}
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
    </Card>
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
      const prepared =
        p.kind === "1x2"
          ? await prepareClaim1x2(authority, { marketId: p.market.id })
          : await prepareClaim(authority, { marketId: p.market.id });
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
      setError(friendlyTxError(e, "amm"));
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
          <Card
            key={p.market.id}
            className="flex items-center justify-between p-4"
          >
            <div>
              <Link
                href={`/markets/${p.market.id}`}
                className="font-600 no-underline hover:underline"
              >
                {marketLabel(p)}
              </Link>
              <div className="text-[12px] text-muted">
                Resolved{" "}
                {p.kind === "1x2" ? p.market.outcome1x2 : p.market.outcome} ·{" "}
                {fmtShares(payout)} winning shares · $1.00 / share
              </div>
            </div>
            <Button
              variant="primary"
              disabled={busyId !== null}
              onClick={() => claim(p)}
            >
              {busyId === p.market.id ? "Redeeming…" : `Redeem ${usd(payout)}`}
            </Button>
          </Card>
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

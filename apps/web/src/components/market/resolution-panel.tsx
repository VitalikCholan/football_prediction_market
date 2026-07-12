"use client";

import { useState } from "react";
import type { MarketDto } from "@fpm/shared";
import { friendlyTxError } from "@fpm/shared";
import { usd, shares as fmtShares } from "@/lib/format";
import { explorerTx } from "@/lib/solana";
import { prepareClaim } from "@/lib/tx";
import { notifyTxConfirmed, useMarketPosition } from "@/lib/use-live";
import { winningTokens } from "@/lib/positions";
import { useTxAuthority } from "@/components/wallet/use-account";
import { useToast } from "@/components/ui/toast";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";

/**
 * Resolution & payout (1g). Shown when a market is Resolved: the resolved
 * `outcome` (Team1 / Draw / Team2, or Void → refund), the user's winning-outcome
 * balance (REAL on-chain `Position` decode), and Claim → `redeem` (1 winning
 * token = 1 USDT). Simulates before signing.
 */
export function ResolutionPanel({ market }: { market: MarketDto }) {
  const { address, getAuthority } = useTxAuthority();
  const toast = useToast();
  const [claimed, setClaimed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { position, refresh } = useMarketPosition(market.id, address);
  const pos = position;

  const outcome = market.outcome;
  const isVoid = outcome === "Void";
  const winnerLabel =
    outcome === "Team1"
      ? market.homeTeam ?? "Home"
      : outcome === "Team2"
        ? market.awayTeam ?? "Away"
        : outcome === "Draw"
          ? "Draw"
          : isVoid
            ? "Void — refunded"
            : "—";

  // Authoritative on-chain winning balance (0 for Void; that path refunds
  // pro-rata basis rather than paying a single winning side).
  const tokens = pos ? winningTokens(pos) : 0n;
  const heldShares = Number(tokens) / 1_000_000;
  const totalHeld = pos
    ? (Number(pos.tokens[0]) + Number(pos.tokens[1]) + Number(pos.tokens[2])) /
      1_000_000
    : 0;
  const collateral = pos ? Number(pos.collateralBase) / 1_000_000 : 0;
  const alreadyRedeemed = pos?.redeemed ?? false;

  // Void refunds net basis; a decided outcome pays $1/winning token.
  const payout = isVoid ? collateral : heldShares * 1.0;
  const claimable =
    (isVoid ? totalHeld > 0 : heldShares > 0) &&
    !alreadyRedeemed &&
    !claimed;

  async function claim() {
    if (!address) return;
    setBusy(true);
    setError(null);
    try {
      const authority = await getAuthority();
      if (!authority) throw new Error("Wallet cannot sign — reconnect");
      const prepared = await prepareClaim(authority, { marketId: market.id });
      if (!prepared.sim.ok) {
        throw new Error(prepared.sim.error ?? "Simulation failed");
      }
      const res = await prepared.send();
      setClaimed(true);
      const paid =
        prepared.sim.outBase !== undefined && prepared.sim.outBase > 0n
          ? Number(prepared.sim.outBase) / 1_000_000
          : payout;
      toast.push({
        title: `Claimed ${usd(paid)}`,
        href: explorerTx(res.signature),
        hrefLabel: "View tx ↗",
      });
      notifyTxConfirmed();
      refresh();
    } catch (e) {
      setError(friendlyTxError(e, "amm"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="overflow-hidden">
      <div className="flex items-center gap-2 bg-verified-bg px-4 py-3 text-verified-fg">
        <span className="dot" style={{ background: "var(--verified-fg)" }} />
        <span className="text-[14px] font-700">
          Resolved · {isVoid ? "Void" : `${winnerLabel} won`}
        </span>
      </div>

      <div className="flex flex-col gap-4 p-4">
        <div className="text-[13px]">
          <span className="text-muted">Final result: </span>
          <span className="font-700">{winnerLabel}</span>
        </div>

        {(!pos || (!isVoid && heldShares === 0)) && !alreadyRedeemed ? (
          <div className="box p-3 text-[13px] text-muted">
            {address
              ? "No winning position to claim on this market."
              : "Connect a wallet to check for claimable winnings."}
          </div>
        ) : (
          <div className="box flex flex-col gap-2 p-3">
            <h3 className="text-[13px] font-700">Your position</h3>
            {isVoid ? (
              <Row k="Held (all outcomes)" v={`${fmtShares(totalHeld)} shares`} />
            ) : (
              <Row
                k="Held"
                v={`${fmtShares(heldShares)} × ${winnerLabel}`}
              />
            )}
            <Row
              k="Resolved at"
              v={isVoid ? "Net basis refund" : "$1.00 / share"}
            />
            <Separator className="my-1" />
            <div className="flex items-center justify-between">
              <span className="text-[13px] font-600">Payout</span>
              <span className="tnum text-[17px] font-700 text-yes-strong">
                {usd(payout)}
              </span>
            </div>
          </div>
        )}

        <Button
          variant="primary"
          className="w-full"
          disabled={!claimable || busy || !address}
          onClick={claim}
        >
          {alreadyRedeemed || claimed
            ? "Claimed"
            : busy
              ? "Claiming…"
              : !address
                ? "Connect to claim"
                : !claimable
                  ? "Nothing to claim"
                  : `Claim ${usd(payout)}`}
        </Button>

        {error ? (
          <p className="text-[12px] font-600 text-no-strong" role="alert">
            {error}
          </p>
        ) : null}

        <div className="flex items-center justify-between text-[12px]">
          <Badge variant="verified">◆ Resolved via TxLINE oracle</Badge>
          <a
            className="text-link no-underline hover:underline"
            href={explorerTx(market.id)}
            target="_blank"
            rel="noreferrer"
          >
            View tx ↗
          </a>
        </div>
      </div>
    </Card>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex items-center justify-between text-[13px]">
      <span className="text-muted">{k}</span>
      <span className="tnum font-600">{v}</span>
    </div>
  );
}

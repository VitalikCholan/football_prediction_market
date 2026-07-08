"use client";

import { useState } from "react";
import type { MarketDto } from "@fpm/shared";
import { usd, shares as fmtShares } from "@/lib/format";
import { explorerTx } from "@/lib/solana";
import { prepareClaim } from "@/lib/tx";
import { notifyTxConfirmed, useMarketPosition } from "@/lib/use-live";
import { winningTokens } from "@/lib/positions";
import { useTxAuthority } from "@/components/wallet/use-account";
import { useToast } from "@/components/ui/toast";

/**
 * Resolution & payout (DESIGN_SPEC 1g). Shown when the market is Resolved:
 * green banner + final result, the user's winning position (REAL on-chain
 * `Position` decode), and Claim → redeem (1 token = 1 USDT). Claim simulates
 * first and only signs when the simulation passes.
 */
export function ResolutionPanel({ market }: { market: MarketDto }) {
  const { address, getAuthority } = useTxAuthority();
  const toast = useToast();
  const [claimed, setClaimed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { position, refresh } = useMarketPosition(market.id, address);

  const winnerSide = market.outcome ?? "YES";
  const winner =
    (winnerSide === "YES" ? market.homeTeam : market.awayTeam) ??
    (winnerSide === "YES" ? "Yes" : "No");

  // Authoritative on-chain balances from the decoded Position PDA.
  const tokens = position ? winningTokens(position) : 0n;
  const heldShares = Number(tokens) / 1_000_000;
  const totalTokens = position
    ? Number(position.yesTokens + position.noTokens)
    : 0;
  const avgCents =
    position && totalTokens > 0
      ? Math.round((Number(position.collateralBase) / totalTokens) * 100)
      : 0;
  const alreadyRedeemed = position?.redeemed ?? false;
  const payout = heldShares * 1.0;
  const profit = payout - (heldShares * avgCents) / 100;
  const claimable = heldShares > 0 && !alreadyRedeemed && !claimed;

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
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="scr overflow-hidden">
      <div className="flex items-center gap-2 bg-verified-bg px-4 py-3 text-verified-fg">
        <span className="dot" style={{ background: "var(--verified-fg)" }} />
        <span className="text-[14px] font-700">Resolved · {winner} won</span>
      </div>

      <div className="flex flex-col gap-4 p-4">
        <div className="text-[13px]">
          <span className="text-muted">Final result: </span>
          <span className="font-700">{winner}</span>
        </div>

        {(!position || heldShares === 0) && !alreadyRedeemed ? (
          <div className="box p-3 text-[13px] text-muted">
            {address
              ? "No winning position to claim on this market."
              : "Connect a wallet to check for claimable winnings."}
          </div>
        ) : (
          <div className="box flex flex-col gap-2 p-3">
            <h3 className="text-[13px] font-700">Your position</h3>
            <Row
              k="Held"
              v={`${fmtShares(heldShares)} × ${winner} ${
                winnerSide === "YES" ? "Yes" : "No"
              }`}
            />
            <Row k="Avg cost" v={avgCents > 0 ? `${avgCents}¢` : "—"} />
            <Row k="Resolved at" v="$1.00 / share" />
            <div className="my-1 h-px bg-box-border" />
            <div className="flex items-center justify-between">
              <span className="text-[13px] font-600">Payout</span>
              <span className="tnum text-[17px] font-700 text-yes-strong">
                {usd(payout)}
              </span>
            </div>
            {avgCents > 0 ? <Row k="Profit" v={usd(profit)} pos /> : null}
          </div>
        )}

        <button
          className="btn btn-p w-full"
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
        </button>

        {error ? (
          <p className="text-[12px] font-600 text-no-strong" role="alert">
            {error}
          </p>
        ) : null}

        <div className="flex items-center justify-between text-[12px]">
          <span className="verified">◆ Resolved via TxLINE oracle</span>
          <a
            className="link no-underline"
            href={explorerTx(market.id)}
            target="_blank"
            rel="noreferrer"
          >
            View tx ↗
          </a>
        </div>
      </div>
    </div>
  );
}

function Row({ k, v, pos }: { k: string; v: string; pos?: boolean }) {
  return (
    <div className="flex items-center justify-between text-[13px]">
      <span className="text-muted">{k}</span>
      <span className={`tnum font-600 ${pos ? "pos" : ""}`}>{v}</span>
    </div>
  );
}

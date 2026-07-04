"use client";

import { useState } from "react";
import type { MarketDto } from "@fpm/shared";
import { usd } from "@/lib/format";
import { explorerTx } from "@/lib/solana";
import { submitClaim } from "@/lib/tx";
import { useAccountAddress } from "@/components/wallet/use-account";
import { useToast } from "@/components/ui/toast";
import { PORTFOLIO } from "@/lib/fixtures";

/**
 * Resolution & payout (DESIGN_SPEC 1g). Shown when the market is Resolved:
 * green banner + final result, the user's winning position, and Claim.
 * "View tx ↗" is the discreet on-chain proof. Claim uses the stubbed redeem tx.
 */
export function ResolutionPanel({ market }: { market: MarketDto }) {
  const address = useAccountAddress();
  const toast = useToast();
  const [claimed, setClaimed] = useState(false);
  const [busy, setBusy] = useState(false);

  const winner =
    market.outcome === "YES" ? market.homeTeam : market.awayTeam;

  // Demo: pull the user's held position for this market if present.
  const held = PORTFOLIO.positions.find((p) => p.marketId === market.id);
  const heldShares = held?.shares ?? 640;
  const avgCents = held?.avgCents ?? 63;
  const payout = heldShares * 1.0;
  const profit = payout - (heldShares * avgCents) / 100;

  async function claim() {
    if (!address) return;
    setBusy(true);
    try {
      const res = await submitClaim({
        marketId: market.id,
        fixtureId: market.fixtureId,
        owner: address,
      });
      setClaimed(true);
      toast.push({
        title: `Claimed ${usd(payout)}`,
        href: explorerTx(res.signature),
        hrefLabel: "View tx ↗",
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="scr overflow-hidden">
      <div className="flex items-center gap-2 bg-verified-bg px-4 py-3 text-verified-fg">
        <span className="dot" style={{ background: "var(--verified-fg)" }} />
        <span className="text-[14px] font-700">
          Resolved · {winner} won 2–1
        </span>
      </div>

      <div className="flex flex-col gap-4 p-4">
        <div className="text-[13px]">
          <span className="text-muted">Final result: </span>
          <span className="font-700">{winner}</span>
        </div>

        <div className="box flex flex-col gap-2 p-3">
          <h3 className="text-[13px] font-700">Your position</h3>
          <Row k="Held" v={`${heldShares} × ${winner} Yes`} />
          <Row k="Avg cost" v={`${avgCents}¢`} />
          <Row k="Resolved at" v="$1.00 / share" />
          <div className="my-1 h-px bg-box-border" />
          <div className="flex items-center justify-between">
            <span className="text-[13px] font-600">Payout</span>
            <span className="tnum text-[17px] font-700 text-yes-strong">
              {usd(payout)}
            </span>
          </div>
          <Row k="Profit" v={usd(profit)} pos />
        </div>

        <button
          className="btn btn-p w-full"
          disabled={claimed || busy || !address}
          onClick={claim}
        >
          {claimed
            ? "Claimed"
            : busy
              ? "Claiming…"
              : !address
                ? "Connect to claim"
                : `Claim ${usd(payout)}`}
        </button>

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

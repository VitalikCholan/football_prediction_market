"use client";

import { useMemo, useState } from "react";
import type { MarketDto, Side } from "@fpm/shared";
import { quoteTrade } from "@/lib/quote";
import { prepareTrade, type PreparedTx } from "@/lib/tx";
import { dataMode } from "@/lib/data";
import { notifyTxConfirmed, useUsdtBalance, useMarketPosition } from "@/lib/use-live";
import { baseToUsdc, usd, shares as fmtShares, centsLabel } from "@/lib/format";
import { explorerTx } from "@/lib/solana";
import { useTxAuthority } from "@/components/wallet/use-account";
import { useFaucet } from "@/components/wallet/use-faucet";
import { useToast } from "@/components/ui/toast";
import { ConnectModal } from "@/components/wallet/connect-modal";

const QUICK = [10, 50, 100];

export interface TradeIntent {
  side: Side;
  action: "buy" | "sell";
}

/**
 * Trade ticket (DESIGN_SPEC 1d). Slides in from the right. The outer panel
 * owns open/close; the inner ticket is keyed by the intent so a new Buy click
 * remounts it with the right side/action — no state-syncing effect needed.
 */
export function TradePanel({
  market,
  intent,
  onClose,
}: {
  market: MarketDto;
  intent: TradeIntent | null;
  onClose: () => void;
}) {
  const open = intent !== null;

  return (
    <>
      <div
        className={`fixed inset-0 z-40 bg-black/25 transition-opacity ${
          open ? "opacity-100" : "pointer-events-none opacity-0"
        }`}
        onClick={onClose}
        aria-hidden
      />
      <aside
        className={`fixed right-0 top-0 z-50 flex h-full w-[360px] max-w-full flex-col bg-surface shadow-[-6px_0_24px_rgba(0,0,0,0.12)] ${
          open ? "slide-in" : "translate-x-full"
        }`}
        role="dialog"
        aria-modal="true"
        aria-label="Trade ticket"
        aria-hidden={!open}
      >
        {open && intent ? (
          <TradeTicket
            key={`${intent.side}-${intent.action}`}
            market={market}
            intent={intent}
            onClose={onClose}
          />
        ) : null}
      </aside>
    </>
  );
}

function TradeTicket({
  market,
  intent,
  onClose,
}: {
  market: MarketDto;
  intent: TradeIntent;
  onClose: () => void;
}) {
  const { address, getAuthority } = useTxAuthority();
  const toast = useToast();
  const [action, setAction] = useState<"buy" | "sell">(intent.action);
  const [side, setSide] = useState<Side>(intent.side);
  const [amount, setAmount] = useState<string>("50");
  const slippage = 0.01;
  const [connectOpen, setConnectOpen] = useState(false);

  // Simulate-before-sign flow: input → preparing (build+simulate) → review
  // (sim result rendered in the summary box) → sending. Never sign first.
  const [prepared, setPrepared] = useState<PreparedTx | null>(null);
  const [busy, setBusy] = useState<"prepare" | "send" | null>(null);
  const [flowError, setFlowError] = useState<string | null>(null);

  const { balanceBase, refresh: refreshBalance } = useUsdtBalance(address);
  const faucet = useFaucet(refreshBalance);
  const { position, refresh: refreshPosition } = useMarketPosition(
    market.id,
    address,
  );

  const homeTeam = market.homeTeam ?? "Home";
  const awayTeam = market.awayTeam ?? "Away";
  const matchLabel = market.homeTeam
    ? `${homeTeam} vs ${awayTeam}`
    : `Fixture ${market.fixtureId}`;
  const sideTeam = side === "YES" ? homeTeam : awayTeam;

  const heldSideBase =
    position === null
      ? null
      : side === "YES"
        ? position.yesTokens
        : position.noTokens;

  const quote = useMemo(
    () =>
      quoteTrade({
        side,
        action,
        amount: Number(amount) || 0,
        yesPriceBps: market.yesPriceBps,
        yesReserve: baseToUsdc(market.yesReserve),
        noReserve: baseToUsdc(market.noReserve),
        feeBps: market.currentFeeBps ?? market.baseFeeBps ?? 30,
        slippageTolerance: slippage,
      }),
    [side, action, amount, market],
  );

  const tradable = market.state === "Trading" || market.state === "Open";
  const validAmount = Number(amount) > 0;
  const live = dataMode === "live";
  const showFaucet = live && address !== null && balanceBase === 0n;

  /** Any input change invalidates the pending review. */
  function resetReview() {
    setPrepared(null);
    setFlowError(null);
  }

  async function review() {
    if (!address) {
      setConnectOpen(true);
      return;
    }
    setBusy("prepare");
    setFlowError(null);
    try {
      const authority = await getAuthority();
      if (!authority) throw new Error("Wallet cannot sign — reconnect");
      const p = await prepareTrade(authority, {
        marketId: market.id,
        configId: market.configId,
        side,
        action,
        amountBase: String(Math.round((Number(amount) || 0) * 1_000_000)),
        minOutBase: String(Math.round(quote.minOut * 1_000_000)),
      });
      setPrepared(p);
      if (!p.sim.ok) setFlowError(p.sim.error ?? "Simulation failed");
    } catch (e) {
      setFlowError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function confirm() {
    if (!prepared) return;
    setBusy("send");
    setFlowError(null);
    try {
      const res = await prepared.send();
      toast.push({
        title: `${action === "buy" ? "Bought" : "Sold"} ${fmtShares(
          prepared.sim.outBase !== undefined && action === "buy"
            ? Number(prepared.sim.outBase) / 1_000_000
            : quote.shares,
        )} ${sideTeam} ${side}`,
        href: explorerTx(res.signature),
        hrefLabel: "View tx ↗",
      });
      notifyTxConfirmed();
      refreshBalance();
      refreshPosition();
      onClose();
    } catch (e) {
      setFlowError(e instanceof Error ? e.message : String(e));
      setPrepared(null); // blockhash likely stale — re-review
    } finally {
      setBusy(null);
    }
  }

  function setMax() {
    if (action === "buy") {
      if (balanceBase !== null && balanceBase > 0n) {
        setAmount(String(Math.floor(Number(balanceBase) / 1_000_000)));
      } else {
        setAmount("500");
      }
    } else if (heldSideBase !== null && heldSideBase > 0n) {
      setAmount((Number(heldSideBase) / 1_000_000).toFixed(1));
    } else {
      setAmount("0");
    }
    resetReview();
  }

  const inReview = prepared !== null && prepared.sim.ok;
  const buttonLabel = !tradable
    ? "Market not trading"
    : busy === "send"
      ? "Confirming…"
      : busy === "prepare"
        ? "Simulating…"
        : !address
          ? "Connect to trade"
          : inReview
            ? "Confirm & sign"
            : "Review order";

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-box-border px-4 py-3">
        <h2 className="text-[15px] font-700">Trade</h2>
        <button
          className="text-muted hover:text-ink"
          onClick={onClose}
          aria-label="Close"
        >
          ✕
        </button>
      </div>

      <div className="flex flex-1 flex-col gap-4 overflow-y-auto px-4 py-4">
        {/* Buy / Sell */}
        <div className="grid grid-cols-2 gap-1 rounded-lg bg-skeleton p-1">
          {(["buy", "sell"] as const).map((a) => (
            <button
              key={a}
              className={`rounded-md py-1.5 text-[13px] font-600 capitalize ${
                action === a ? "bg-surface shadow-sm" : "text-muted"
              }`}
              onClick={() => {
                setAction(a);
                resetReview();
              }}
            >
              {a}
            </button>
          ))}
        </div>

        {/* Market row */}
        <div className="box flex items-center justify-between p-3">
          <div>
            <div className="text-[13px] font-600">{matchLabel}</div>
            <div className="text-[12px] text-muted">
              {sideTeam} — {side === "YES" ? "Yes" : "No"}
            </div>
          </div>
          <span className="tnum text-[16px] font-700">
            {centsLabel(
              side === "YES" ? market.yesPriceBps : 10000 - market.yesPriceBps,
            )}
          </span>
        </div>

        {/* Yes / No */}
        <div className="grid grid-cols-2 gap-2">
          <button
            className={`btn btn-y ${side === "YES" ? "" : "opacity-60"}`}
            onClick={() => {
              setSide("YES");
              resetReview();
            }}
          >
            {homeTeam} · Yes
          </button>
          <button
            className={`btn btn-n ${side === "NO" ? "" : "opacity-60"}`}
            onClick={() => {
              setSide("NO");
              resetReview();
            }}
          >
            {awayTeam} · No
          </button>
        </div>

        {/* Wallet balances (live mode) */}
        {live && address ? (
          <div className="box flex items-center justify-between gap-2 p-3 text-[12px]">
            <div className="flex flex-col gap-0.5">
              <span className="text-muted">
                USDT balance:{" "}
                <span className="tnum font-600 text-ink">
                  {balanceBase === null
                    ? "…"
                    : usd(Number(balanceBase) / 1_000_000)}
                </span>
              </span>
              {position ? (
                <span className="text-muted">
                  Held:{" "}
                  <span className="tnum font-600 text-ink">
                    {fmtShares(Number(position.yesTokens) / 1_000_000)} YES ·{" "}
                    {fmtShares(Number(position.noTokens) / 1_000_000)} NO
                  </span>
                </span>
              ) : null}
            </div>
            {showFaucet ? (
              <button
                className="btn px-2 py-1 text-[12px]"
                disabled={busy !== null || faucet.busy}
                onClick={faucet.run}
              >
                {faucet.busy ? "Requesting…" : "Get test USDT"}
              </button>
            ) : null}
          </div>
        ) : null}

        {/* Amount */}
        <div>
          <label className="th">Amount</label>
          <div className="mt-1 flex items-center rounded-lg border-[1.5px] border-box-border px-3 py-2">
            <span className="text-muted">$</span>
            <input
              className="tnum w-full bg-transparent px-2 text-[20px] font-700 outline-none"
              inputMode="decimal"
              value={amount}
              onChange={(e) => {
                setAmount(e.target.value.replace(/[^0-9.]/g, ""));
                resetReview();
              }}
              aria-label="Trade amount in USDC"
            />
            <span className="text-[12px] text-muted">
              {action === "buy" ? "USDC" : "shares"} ▾
            </span>
          </div>
          <div className="mt-2 flex gap-1.5">
            {QUICK.map((q) => (
              <button
                key={q}
                className="pill flex-1 justify-center px-0 py-1 text-[12px]"
                onClick={() => {
                  setAmount(String(q));
                  resetReview();
                }}
              >
                ${q}
              </button>
            ))}
            <button
              className="pill flex-1 justify-center px-0 py-1 text-[12px]"
              onClick={setMax}
            >
              Max
            </button>
          </div>
        </div>

        {/* Summary box (1d) — client quote + pre-sign simulation result */}
        <div className="box flex flex-col gap-2 p-3">
          <Row
            k={action === "buy" ? "Shares" : "USDC out"}
            v={action === "buy" ? fmtShares(quote.shares) : usd(quote.usdcOut)}
          />
          <Row k="Avg price" v={`${quote.avgPriceCents.toFixed(0)}¢`} />
          <Row
            k="Est. slippage"
            v={`${(quote.priceImpact * 100).toFixed(1)}%`}
          />
          {inReview && prepared ? (
            <>
              <div className="my-1 h-px bg-box-border" />
              <Row
                k={
                  action === "buy"
                    ? "Simulated shares out"
                    : "Simulated USDC out"
                }
                v={
                  prepared.sim.outBase !== undefined
                    ? action === "buy"
                      ? fmtShares(Number(prepared.sim.outBase) / 1_000_000)
                      : usd(Number(prepared.sim.outBase) / 1_000_000)
                    : "—"
                }
              />
              <div className="flex items-center justify-between text-[12px]">
                <span className="verified">◆ Simulation passed</span>
                <span className="tnum text-muted">
                  {prepared.sim.computeUnits
                    ? `${prepared.sim.computeUnits.toLocaleString()} CU`
                    : ""}
                </span>
              </div>
            </>
          ) : null}
          <div className="my-1 h-px bg-box-border" />
          <div className="flex items-center justify-between">
            <span className="text-[13px] font-600">Payout if wins</span>
            <span className="tnum text-[17px] font-700 text-yes-strong">
              {usd(quote.payoutIfWins)}
            </span>
          </div>
        </div>

        {flowError || faucet.error ? (
          <p className="text-[12px] font-600 text-no-strong" role="alert">
            {flowError ?? faucet.error}
          </p>
        ) : null}
      </div>

      <div className="border-t border-box-border px-4 py-3">
        <button
          className="btn btn-p w-full"
          disabled={!tradable || !validAmount || busy !== null}
          onClick={inReview ? confirm : review}
        >
          {buttonLabel}
        </button>
        <p className="mt-2 text-center text-[11px] text-muted">
          {inReview
            ? "Simulated on devnet · signs 1 Solana tx"
            : "Simulates before you sign · 1 Solana tx"}
        </p>
      </div>
      <ConnectModal open={connectOpen} onClose={() => setConnectOpen(false)} />
    </div>
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

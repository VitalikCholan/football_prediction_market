"use client";

import { useMemo, useState } from "react";
import type { MarketDto, Outcome } from "@fpm/shared";
import { friendlyTxError } from "@fpm/shared";
import { quoteTrade } from "@/lib/quote";
import { prepareTrade, type PreparedTx } from "@/lib/tx";
import { notifyTxConfirmed, useUsdtBalance, useMarketPosition } from "@/lib/use-live";
import { baseToUsdt, usd, shares as fmtShares, centsLabel } from "@/lib/format";
import { explorerTx } from "@/lib/solana";
import { useTxAuthority } from "@/components/wallet/use-account";
import { useFaucet } from "@/components/wallet/use-faucet";
import { useToast } from "@/components/ui/toast";
import { ConnectModal } from "@/components/wallet/connect-modal";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

const QUICK = [10, 50, 100];

/** Which of the three outcomes to trade. */
export interface TradeIntent {
  outcome: Exclude<Outcome, "Void">;
  action: "buy" | "sell";
}

/**
 * Trade ticket (DESIGN_SPEC 1d). Slides in from the right. The outer panel
 * owns open/close; the inner ticket is keyed by the intent so a new Buy click
 * remounts it with the right outcome/action — no state-syncing effect needed.
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
            key={`${intent.outcome}-${intent.action}`}
            market={market}
            intent={intent}
            onClose={onClose}
          />
        ) : null}
      </aside>
    </>
  );
}

const OUTCOME_ORDER = ["Team1", "Draw", "Team2"] as const;
type TradeOutcome = (typeof OUTCOME_ORDER)[number];

/**
 * Trade ticket (1d). Simulate-before-sign flow: the user picks ONE of three
 * real outcomes (Team1 / Draw / Team2) and buys/sells that outcome's token via
 * `getBuy`/`getSell` (a raised compute-unit budget is set inside `prepareTrade`).
 * Keeps the BUG-3 `state === "Trading"` gate and BUG-5 friendlyTxError decode.
 */
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
  const [outcome, setOutcome] = useState<TradeOutcome>(intent.outcome);
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

  const outcomeMeta: Record<
    TradeOutcome,
    { label: string; bps: number; idx: number }
  > = {
    Team1: { label: homeTeam, bps: market.team1PriceBps, idx: 0 },
    Draw: { label: "Draw", bps: market.drawPriceBps, idx: 1 },
    Team2: { label: awayTeam, bps: market.team2PriceBps, idx: 2 },
  };
  const active = outcomeMeta[outcome];

  const heldBase = position ? position.tokens[active.idx] ?? 0n : null;

  const quote = useMemo(() => {
    const bps =
      outcome === "Team1"
        ? market.team1PriceBps
        : outcome === "Draw"
          ? market.drawPriceBps
          : market.team2PriceBps;
    return quoteTrade({
      action,
      amount: Number(amount) || 0,
      outcomePriceBps: bps,
      b: baseToUsdt(market.b),
      feeBps: market.currentFeeBps ?? market.baseFeeBps ?? 30,
      slippageTolerance: slippage,
    });
  }, [action, amount, outcome, market]);

  // Only a Trading market accepts buy/sell on-chain. Open (not yet activated),
  // Locked, Resolved, Closed all reject with AmmError::InvalidMarketState (6012),
  // so gate the panel rather than let the user submit a doomed tx (BUG-3).
  const tradable = market.state === "Trading";
  const validAmount = Number(amount) > 0;
  const showFaucet = address !== null && balanceBase === 0n;

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
        outcome,
        action,
        amountBase: String(Math.round((Number(amount) || 0) * 1_000_000)),
        minOutBase: String(Math.round(quote.minOut * 1_000_000)),
      });
      setPrepared(p);
      if (!p.sim.ok) setFlowError(p.sim.error ?? "Simulation failed");
    } catch (e) {
      setFlowError(friendlyTxError(e, "amm"));
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
        )} ${active.label}`,
        href: explorerTx(res.signature),
        hrefLabel: "View tx ↗",
      });
      notifyTxConfirmed();
      refreshBalance();
      refreshPosition();
      onClose();
    } catch (e) {
      setFlowError(friendlyTxError(e, "amm"));
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
    } else if (heldBase !== null && heldBase > 0n) {
      setAmount((Number(heldBase) / 1_000_000).toFixed(1));
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
          type="button"
          className="text-muted transition-colors hover:text-ink"
          onClick={onClose}
          aria-label="Close"
        >
          ✕
        </button>
      </div>

      <div className="flex flex-1 flex-col gap-4 overflow-y-auto px-4 py-4">
        {/* Buy / Sell */}
        <Tabs
          value={action}
          onValueChange={(v) => {
            setAction(v as "buy" | "sell");
            resetReview();
          }}
        >
          <TabsList>
            <TabsTrigger value="buy" className="capitalize">
              Buy
            </TabsTrigger>
            <TabsTrigger value="sell" className="capitalize">
              Sell
            </TabsTrigger>
          </TabsList>
        </Tabs>

        {/* Market row */}
        <div className="box flex items-center justify-between p-3">
          <div>
            <div className="text-[13px] font-600">{matchLabel}</div>
            <div className="text-[12px] text-muted">{active.label}</div>
          </div>
          <span className="tnum text-[16px] font-700">
            {centsLabel(active.bps)}
          </span>
        </div>

        {/* Team1 / Draw / Team2 */}
        <div className="grid grid-cols-3 gap-2">
          {OUTCOME_ORDER.map((o) => {
            const m = outcomeMeta[o];
            return (
              <Button
                key={o}
                variant="yes"
                className={`flex-col gap-0.5 px-2 py-2 ${
                  outcome === o ? "" : "opacity-60"
                }`}
                onClick={() => {
                  setOutcome(o);
                  resetReview();
                }}
              >
                <span className="max-w-full truncate text-[12px]">
                  {m.label}
                </span>
                <span className="tnum text-[13px] font-700">
                  {centsLabel(m.bps)}
                </span>
              </Button>
            );
          })}
        </div>

        {/* Wallet balances */}
        {address ? (
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
                    {fmtShares(Number(position.tokens[0]) / 1_000_000)}{" "}
                    {homeTeam} ·{" "}
                    {fmtShares(Number(position.tokens[1]) / 1_000_000)} Draw ·{" "}
                    {fmtShares(Number(position.tokens[2]) / 1_000_000)}{" "}
                    {awayTeam}
                  </span>
                </span>
              ) : null}
            </div>
            {showFaucet ? (
              <Button
                size="sm"
                className="px-2 py-1 text-[12px]"
                disabled={busy !== null || faucet.busy}
                onClick={faucet.run}
              >
                {faucet.busy ? "Requesting…" : "Get test USDT"}
              </Button>
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
              aria-label="Trade amount in USDT"
            />
            <span className="text-[12px] text-muted">
              {action === "buy" ? "USDT" : "shares"} ▾
            </span>
          </div>
          <div className="mt-2 flex gap-1.5">
            {QUICK.map((q) => (
              <Button
                key={q}
                variant="pill"
                size="pill"
                className="flex-1 justify-center px-0 py-1 text-[12px]"
                onClick={() => {
                  setAmount(String(q));
                  resetReview();
                }}
              >
                ${q}
              </Button>
            ))}
            <Button
              variant="pill"
              size="pill"
              className="flex-1 justify-center px-0 py-1 text-[12px]"
              onClick={setMax}
            >
              Max
            </Button>
          </div>
        </div>

        {/* Summary box (1d) — client quote + pre-sign simulation result */}
        <div className="box flex flex-col gap-2 p-3">
          <Row
            k={action === "buy" ? "Shares" : "USDT out"}
            v={action === "buy" ? fmtShares(quote.shares) : usd(quote.usdtOut)}
          />
          <Row k="Avg price" v={`${quote.avgPriceCents.toFixed(0)}¢`} />
          <Row
            k="Est. slippage"
            v={`${(quote.priceImpact * 100).toFixed(1)}%`}
          />
          {inReview && prepared ? (
            <>
              <Separator className="my-1" />
              <Row
                k={
                  action === "buy"
                    ? "Simulated shares out"
                    : "Simulated USDT out"
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
                <Badge variant="verified">◆ Simulation passed</Badge>
                <span className="tnum text-muted">
                  {prepared.sim.computeUnits
                    ? `${prepared.sim.computeUnits.toLocaleString()} CU`
                    : ""}
                </span>
              </div>
            </>
          ) : null}
          <Separator className="my-1" />
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
        <Button
          variant="primary"
          className="w-full"
          disabled={!tradable || !validAmount || busy !== null}
          onClick={inReview ? confirm : review}
        >
          {buttonLabel}
        </Button>
        <p className="mt-2 text-center text-[11px] text-muted">
          {!tradable
            ? market.state === "Open"
              ? "Trading opens at kickoff."
              : `Trading is closed (${market.state.toLowerCase()}).`
            : inReview
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

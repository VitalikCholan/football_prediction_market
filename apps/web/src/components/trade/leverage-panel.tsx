"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { address as toAddress } from "@solana/kit";
import {
  fetchMaybeLevPosition,
  fetchMaybeLeveragePool,
  fetchMaybeMarketConfig,
  type LevPosition,
  type LeveragePool,
  type MarketConfig,
} from "@fpm/idl";
import {
  findLevPoolPda,
  findLevPositionPda,
  friendlyTxError,
  type MarketDto,
  type Outcome,
} from "@fpm/shared";
import {
  prepareCloseLeverage,
  prepareOpenLeverage,
  type PreparedTx,
} from "@/lib/tx";
import { getRpc, explorerTx } from "@/lib/solana";
import { notifyTxConfirmed, useLiveTask, useUsdtBalance } from "@/lib/use-live";
import { usd, centsLabel, shares as fmtShares } from "@/lib/format";
import {
  BPS,
  durationLabel,
  equityOf,
  feeDeathSecs,
  fundingAccruedBase,
  fundingPerHour,
  maxGain,
  maxLeverageForP,
  pnlAt,
  unitsFor,
} from "@/lib/leverage";
import { useTxAuthority } from "@/components/wallet/use-account";
import { useToast } from "@/components/ui/toast";
import { ConnectModal } from "@/components/wallet/connect-modal";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";

/**
 * Leverage panel (leverage-v1 wave F). Renders ONLY when the market's
 * LeveragePool PDA exists on-chain, so markets without a pool see zero UI
 * change. Two states:
 *   - OPEN: outcome + collateral + 2×–5× leverage, client-side preview from
 *     the posted mark (entry, units, max profit, funding/hr), guard-mirrored
 *     disabled reasons, then the same simulate-before-sign flow as trades.
 *   - POSITION: live equity = max(0, C + pnl − F) with BigInt-exact funding
 *     against the pool's cumulative index, plus Close (or Settle when the
 *     market is Resolved — same instruction, lazy settlement).
 */
export function LeveragePanel({ market }: { market: MarketDto }) {
  const { address, getAuthority } = useTxAuthority();
  const pool = useLeveragePool(market.id);
  const config = useLevConfig(market.configId, pool != null);
  const { position, refresh: refreshPosition } = useLevPosition(
    market.id,
    address,
  );
  const now = useNowSecs(5_000);

  // No pool on-chain (or leverage disabled in config) → render nothing.
  if (!pool || !config || config.maxLeverage < 2) return null;

  return (
    <Card className="flex flex-col gap-4 p-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h3 className="text-[13px] font-700">Leverage</h3>
          <Badge variant="verified">◆ TxLINE mark price</Badge>
        </div>
        <span className="text-[11px] text-muted">
          No liquidations · max loss = collateral
        </span>
      </div>

      {position ? (
        <LevPositionView
          market={market}
          pool={pool}
          config={config}
          position={position}
          now={now}
          getAuthority={getAuthority}
          onSettled={refreshPosition}
        />
      ) : (
        <LevOpenForm
          market={market}
          pool={pool}
          config={config}
          now={now}
          address={address}
          getAuthority={getAuthority}
          onOpened={refreshPosition}
        />
      )}
    </Card>
  );
}

/* ---------------------------------------------------------------- helpers */

const OUTCOME_ORDER = ["Team1", "Draw", "Team2"] as const;
type LevOutcome = (typeof OUTCOME_ORDER)[number];
const OUTCOME_IDX: Record<LevOutcome, number> = { Team1: 0, Draw: 1, Team2: 2 };

type GetAuthority = ReturnType<typeof useTxAuthority>["getAuthority"];

function outcomeLabels(market: MarketDto): Record<LevOutcome, string> {
  return {
    Team1: market.homeTeam ?? "Home",
    Draw: "Draw",
    Team2: market.awayTeam ?? "Away",
  };
}

/** Ticking unix-seconds clock for staleness/cutoff/funding readouts. */
function useNowSecs(intervalMs: number): number {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const t = setInterval(
      () => setNow(Math.floor(Date.now() / 1000)),
      intervalMs,
    );
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

/** LeveragePool for this market: undefined while loading, null when absent. */
function useLeveragePool(marketId: string): LeveragePool | null | undefined {
  const [pool, setPool] = useState<LeveragePool | null | undefined>(undefined);

  const [lastId, setLastId] = useState(marketId);
  if (lastId !== marketId) {
    setLastId(marketId);
    setPool(undefined);
  }

  const task = useCallback(() => {
    findLevPoolPda(toAddress(marketId))
      .then(([pda]) => fetchMaybeLeveragePool(getRpc(), pda))
      .then((acc) => setPool(acc.exists ? acc.data : null))
      .catch(() => {});
  }, [marketId]);

  useLiveTask(task, 10_000);
  return pool;
}

/** MarketConfig (static leverage params) — fetched once the pool exists. */
function useLevConfig(
  configId: string,
  enabled: boolean,
): MarketConfig | null {
  const [config, setConfig] = useState<MarketConfig | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    fetchMaybeMarketConfig(getRpc(), toAddress(configId))
      .then((acc) => {
        if (!cancelled && acc.exists) setConfig(acc.data);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [configId, enabled]);
  return config;
}

/**
 * The connected wallet's LevPosition on this market. Account existence IS the
 * position state: `close_leverage` deletes the account, so no settled filter.
 */
function useLevPosition(
  marketId: string,
  address: string | null,
): { position: LevPosition | null; refresh: () => void } {
  const [position, setPosition] = useState<LevPosition | null>(null);

  const [lastKey, setLastKey] = useState(`${marketId}:${address}`);
  if (lastKey !== `${marketId}:${address}`) {
    setLastKey(`${marketId}:${address}`);
    setPosition(null);
  }

  const task = useCallback(() => {
    if (!address) return;
    findLevPositionPda(toAddress(marketId), toAddress(address))
      .then(([pda]) => fetchMaybeLevPosition(getRpc(), pda))
      .then((acc) => setPosition(acc.exists ? acc.data : null))
      .catch(() => {});
  }, [marketId, address]);

  useLiveTask(address ? task : null, 10_000);
  return { position: address ? position : null, refresh: task };
}

/** Valve multiplier in force right now (BPS = neutral outside the window). */
function activeValveMultiplier(pool: LeveragePool, now: number): number {
  return now < Number(pool.valveUntilTs) ? pool.valveMultiplierBps : BPS;
}

/* -------------------------------------------------------------- open form */

const QUICK_COLLATERAL = [10, 50, 100];

function LevOpenForm({
  market,
  pool,
  config,
  now,
  address,
  getAuthority,
  onOpened,
}: {
  market: MarketDto;
  pool: LeveragePool;
  config: MarketConfig;
  now: number;
  address: string | null;
  getAuthority: GetAuthority;
  onOpened: () => void;
}) {
  const toast = useToast();
  const [outcome, setOutcome] = useState<LevOutcome>("Team1");
  const [collateral, setCollateral] = useState<string>("50");
  const [leverage, setLeverage] = useState(2);
  const [connectOpen, setConnectOpen] = useState(false);

  // Simulate-before-sign, same 3-phase flow as the trade ticket.
  const [prepared, setPrepared] = useState<PreparedTx | null>(null);
  const [busy, setBusy] = useState<"prepare" | "send" | null>(null);
  const [flowError, setFlowError] = useState<string | null>(null);

  const { refresh: refreshBalance } = useUsdtBalance(address);

  const labels = outcomeLabels(market);
  const outcomeIdx = OUTCOME_IDX[outcome];
  const markBps = pool.markBps[outcomeIdx] ?? 0;
  const markTs = Number(pool.markTs);
  const collateralNum = Number(collateral) || 0;

  // Leverage choices: 2× up to the config cap (UI caps the chips at 5×).
  const levChoices = useMemo(() => {
    const top = Math.min(config.maxLeverage, 5);
    const out: number[] = [];
    for (let l = 2; l <= top; l++) out.push(l);
    return out;
  }, [config.maxLeverage]);

  // Taper cap at the CURRENT mark for the chosen outcome (§1 max_leverage_for_p).
  const taperCap = maxLeverageForP(markBps, config.maxLeverage);

  /**
   * Mirror the on-chain `open_leverage` guard chain (leverage-v1 §4), in the
   * same order, as a user-facing disable reason. Null = openable.
   */
  const guardReason = useMemo((): string | null => {
    if (market.state !== "Trading") return "Market is not trading";
    if (markTs === 0) return "Waiting for the first mark price";
    if (now - markTs > config.maxMarkAgeSecs)
      return "Mark price is stale — waiting for the keeper";
    if (
      market.freezeTs != null &&
      now > market.freezeTs - config.leverageCutoffSecs
    )
      return "Too close to freeze — leveraged opens are closed";
    if (now < Number(pool.valvePausedUntil))
      return "Risk valve active — opens are paused";
    if (leverage > taperCap)
      return `Max ${taperCap}× at the current ${centsLabel(markBps)} mark`;
    return null;
  }, [
    market.state,
    market.freezeTs,
    now,
    markTs,
    markBps,
    pool,
    config,
    leverage,
    taperCap,
  ]);

  // Client-side preview from pool.markBps + inputs (plan §1, float display math).
  const preview = useMemo(() => {
    const notional = collateralNum * leverage;
    const units = unitsFor(collateralNum, leverage, markBps);
    const tRem = market.freezeTs != null ? market.freezeTs - now : null;
    return {
      notional,
      units,
      maxProfit: maxGain(units, markBps),
      burnPerHour:
        tRem != null
          ? fundingPerHour(
              config.timeFeeNum,
              markBps,
              tRem,
              notional,
              activeValveMultiplier(pool, now),
            )
          : null,
    };
  }, [collateralNum, leverage, markBps, market.freezeTs, now, config, pool]);

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
      const p = await prepareOpenLeverage(authority, {
        marketId: market.id,
        configId: market.configId,
        outcome,
        collateralBase: String(Math.round(collateralNum * 1_000_000)),
        leverage,
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
        title: `Opened ${leverage}× ${labels[outcome]} with ${usd(collateralNum)}`,
        href: explorerTx(res.signature),
        hrefLabel: "View tx ↗",
      });
      notifyTxConfirmed();
      refreshBalance();
      onOpened();
      resetReview();
    } catch (e) {
      setFlowError(friendlyTxError(e, "amm"));
      setPrepared(null); // blockhash likely stale — re-review
    } finally {
      setBusy(null);
    }
  }

  const inReview = prepared !== null && prepared.sim.ok;
  const validAmount = collateralNum > 0;
  const disabled = guardReason !== null || !validAmount || busy !== null;
  const buttonLabel = guardReason
    ? guardReason
    : busy === "send"
      ? "Confirming…"
      : busy === "prepare"
        ? "Simulating…"
        : !address
          ? "Connect to open"
          : inReview
            ? "Confirm & sign"
            : `Open ${leverage}× position`;

  return (
    <div className="flex flex-col gap-4">
      {/* Outcome — same 3-chip Team1/Draw/Team2 pattern as the trade ticket,
          but priced at the POSTED MARK, not the LMSR spot. */}
      <div className="grid grid-cols-3 gap-2">
        {OUTCOME_ORDER.map((o) => {
          const bps = pool.markBps[OUTCOME_IDX[o]] ?? 0;
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
                {labels[o]}
              </span>
              <span className="tnum text-[13px] font-700">
                {centsLabel(bps)}
              </span>
            </Button>
          );
        })}
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {/* Collateral */}
        <div>
          <label className="th">Collateral</label>
          <div className="mt-1 flex items-center rounded-lg border-[1.5px] border-box-border px-3 py-2">
            <span className="text-muted">$</span>
            <input
              className="tnum w-full bg-transparent px-2 text-[18px] font-700 outline-none"
              inputMode="decimal"
              value={collateral}
              onChange={(e) => {
                setCollateral(e.target.value.replace(/[^0-9.]/g, ""));
                resetReview();
              }}
              aria-label="Collateral in USDT"
            />
            <span className="text-[12px] text-muted">USDT</span>
          </div>
          <div className="mt-2 flex gap-1.5">
            {QUICK_COLLATERAL.map((q) => (
              <Button
                key={q}
                variant="pill"
                size="pill"
                className="flex-1 justify-center px-0 py-1 text-[12px]"
                onClick={() => {
                  setCollateral(String(q));
                  resetReview();
                }}
              >
                ${q}
              </Button>
            ))}
          </div>
        </div>

        {/* Leverage 2×–5× — pill chips, taper-capped ones disabled. */}
        <div>
          <label className="th">Leverage</label>
          <div className="mt-1 flex gap-1.5">
            {levChoices.map((l) => (
              <Button
                key={l}
                variant={leverage === l ? "pillOn" : "pill"}
                size="pill"
                className="flex-1 justify-center px-0"
                disabled={l > taperCap}
                onClick={() => {
                  setLeverage(l);
                  resetReview();
                }}
              >
                {l}×
              </Button>
            ))}
          </div>
          {taperCap < config.maxLeverage ? (
            <p className="mt-2 text-[11px] text-muted">
              Capped at {taperCap}× near {centsLabel(markBps)} (price-edge
              taper).
            </p>
          ) : null}
        </div>
      </div>

      {/* Preview — client-side from the posted mark (plan §1). */}
      <div className="box flex flex-col gap-2 p-3">
        <LevRow k="Entry mark" v={centsLabel(markBps)} />
        <LevRow k="Notional" v={usd(preview.notional)} />
        <LevRow k="Units ($1-payout)" v={fmtShares(preview.units)} />
        <LevRow
          k="Est. funding burn"
          v={
            preview.burnPerHour != null
              ? `${usd(preview.burnPerHour)}/hr`
              : "—"
          }
        />
        {inReview && prepared ? (
          <>
            <Separator className="my-1" />
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
          <span className="text-[13px] font-600">Max profit if wins</span>
          <span className="tnum text-[16px] font-700 text-yes-strong">
            {usd(preview.maxProfit)}
          </span>
        </div>
      </div>

      {flowError ? (
        <p className="text-[12px] font-600 text-no-strong" role="alert">
          {flowError}
        </p>
      ) : null}

      <div>
        <Button
          variant="primary"
          className="w-full"
          disabled={disabled}
          onClick={inReview ? confirm : review}
        >
          {buttonLabel}
        </Button>
        <p className="mt-2 text-center text-[11px] text-muted">
          {guardReason
            ? "Leveraged opens resume when the condition clears."
            : "Funding accrues until close · max loss is your collateral"}
        </p>
      </div>
      <ConnectModal open={connectOpen} onClose={() => setConnectOpen(false)} />
    </div>
  );
}

/* ---------------------------------------------------------- position view */

function LevPositionView({
  market,
  pool,
  config,
  position,
  now,
  getAuthority,
  onSettled,
}: {
  market: MarketDto;
  pool: LeveragePool;
  config: MarketConfig;
  position: LevPosition;
  now: number;
  getAuthority: GetAuthority;
  onSettled: () => void;
}) {
  const toast = useToast();
  const [prepared, setPrepared] = useState<PreparedTx | null>(null);
  const [busy, setBusy] = useState<"prepare" | "send" | null>(null);
  const [flowError, setFlowError] = useState<string | null>(null);

  const labels = outcomeLabels(market);
  const outcome = OUTCOME_ORDER[position.outcomeIdx] ?? "Team1";
  const resolved = market.state === "Resolved";
  const voided = resolved && market.outcome === "Void";
  const won =
    resolved && !voided && market.outcome === (outcome as Outcome);

  const collateralUsdt = Number(position.collateral) / 1_000_000;
  const notionalUsdt = Number(position.notional) / 1_000_000;
  const unitsUsdt = Number(position.units) / 1_000_000;

  // F — BigInt-exact against the live cumulative funding index (plan §1).
  const idxNow = pool.cumFundingIndex[position.outcomeIdx] ?? 0n;
  const fundingBase = fundingAccruedBase(
    position.notional,
    idxNow,
    position.fundingIndexSnap,
  );
  const fundingUsdt = Number(fundingBase) / 1_000_000;

  // Settle price p per §1: Resolved win → BPS, lose → 0, Void → basis refund;
  // otherwise the current posted mark.
  const currentMarkBps = resolved
    ? won
      ? BPS
      : 0
    : pool.markBps[position.outcomeIdx] ?? position.entryMarkBps;
  const pnl = voided
    ? 0
    : pnlAt(unitsUsdt, position.entryMarkBps, currentMarkBps);
  const equity = equityOf(collateralUsdt, pnl, fundingUsdt);

  // Burn rate + rough fee-death countdown at the current mark (open markets).
  const tRem = market.freezeTs != null ? market.freezeTs - now : null;
  const burnPerHour =
    !resolved && tRem != null
      ? fundingPerHour(
          config.timeFeeNum,
          currentMarkBps,
          tRem,
          notionalUsdt,
          activeValveMultiplier(pool, now),
        )
      : null;
  const deathSecs =
    burnPerHour != null
      ? feeDeathSecs(collateralUsdt, fundingUsdt, burnPerHour)
      : null;

  async function review() {
    setBusy("prepare");
    setFlowError(null);
    try {
      const authority = await getAuthority();
      if (!authority) throw new Error("Wallet cannot sign — reconnect");
      const p = await prepareCloseLeverage(authority, {
        marketId: market.id,
        configId: market.configId,
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
        title: resolved
          ? `Settled leveraged ${labels[outcome]} position`
          : `Closed leveraged ${labels[outcome]} position`,
        href: explorerTx(res.signature),
        hrefLabel: "View tx ↗",
      });
      notifyTxConfirmed();
      onSettled();
      setPrepared(null);
    } catch (e) {
      setFlowError(friendlyTxError(e, "amm"));
      setPrepared(null);
    } finally {
      setBusy(null);
    }
  }

  const inReview = prepared !== null && prepared.sim.ok;
  const actionWord = resolved ? "Settle" : "Close position";
  const buttonLabel =
    busy === "send"
      ? "Confirming…"
      : busy === "prepare"
        ? "Simulating…"
        : inReview
          ? "Confirm & sign"
          : actionWord;

  return (
    <div className="flex flex-col gap-4">
      <div className="box flex items-center justify-between p-3">
        <div>
          <div className="text-[13px] font-600">
            {position.leverage}× {labels[outcome]}
          </div>
          <div className="text-[12px] text-muted">
            {usd(collateralUsdt)} collateral · {usd(notionalUsdt)} notional
          </div>
        </div>
        <div className="text-right">
          <div className="tnum text-[16px] font-700">
            {centsLabel(position.entryMarkBps)} →{" "}
            {voided ? "void" : centsLabel(currentMarkBps)}
          </div>
          <div className="text-[11px] text-muted">entry → mark</div>
        </div>
      </div>

      <div className="box flex flex-col gap-2 p-3">
        <LevRow
          k="Unrealized P/L"
          v={`${pnl >= 0 ? "+" : "−"}${usd(Math.abs(pnl))}`}
          tone={pnl > 0 ? "pos" : pnl < 0 ? "neg" : undefined}
        />
        <LevRow k="Funding accrued (F)" v={usd(fundingUsdt)} />
        {burnPerHour != null ? (
          <LevRow k="Burn rate" v={`${usd(burnPerHour)}/hr`} />
        ) : null}
        {deathSecs != null ? (
          <LevRow k="Time to fee-death" v={durationLabel(deathSecs)} />
        ) : null}
        {inReview && prepared?.sim.outBase !== undefined ? (
          <LevRow
            k="Simulated payout"
            v={usd(Number(prepared.sim.outBase) / 1_000_000)}
          />
        ) : null}
        <Separator className="my-1" />
        <div className="flex items-center justify-between">
          <span className="text-[13px] font-600">
            {resolved
              ? voided
                ? "Void refund (C − F)"
                : won
                  ? "Payout"
                  : "Payout (lost)"
              : "Current equity"}
          </span>
          <span
            className={`tnum text-[16px] font-700 ${
              equity > collateralUsdt
                ? "text-yes-strong"
                : equity < collateralUsdt
                  ? "text-no-strong"
                  : ""
            }`}
          >
            {usd(voided ? Math.max(0, collateralUsdt - fundingUsdt) : equity)}
          </span>
        </div>
      </div>

      {flowError ? (
        <p className="text-[12px] font-600 text-no-strong" role="alert">
          {flowError}
        </p>
      ) : null}

      <div>
        <Button
          variant="primary"
          className="w-full"
          disabled={busy !== null}
          onClick={inReview ? confirm : review}
        >
          {buttonLabel}
        </Button>
        <p className="mt-2 text-center text-[11px] text-muted">
          {resolved
            ? "Settlement pays max(0, collateral + P/L − funding)."
            : "Closing pays your equity at the current mark · 1 Solana tx"}
        </p>
      </div>
    </div>
  );
}

function LevRow({
  k,
  v,
  tone,
}: {
  k: string;
  v: string;
  tone?: "pos" | "neg";
}) {
  return (
    <div className="flex items-center justify-between text-[13px]">
      <span className="text-muted">{k}</span>
      <span
        className={`tnum font-600 ${
          tone === "pos" ? "text-yes-strong" : tone === "neg" ? "text-no-strong" : ""
        }`}
      >
        {v}
      </span>
    </div>
  );
}

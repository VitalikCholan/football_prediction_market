"use client";

/**
 * Client-side live-data layer: light polling + a tx-confirm refresh signal
 * (no SWR dep — framework-kit brings its own; this stays a ~1-file custom
 * dedupe per the client-swr-dedup guidance). Everything is a no-op in demo
 * data mode so the fixture build stays hermetic for CI/Vercel.
 *
 * - `notifyTxConfirmed()` — call after any confirmed tx; every subscribed
 *   hook refetches immediately (market, balances, positions).
 * - Poll intervals: market 5s, balances/positions 15s. Timers pause when the
 *   tab is hidden (visibilitychange) to spare the public RPC.
 */
import { useCallback, useEffect, useState } from "react";
import type { MarketDto } from "@fpm/shared";
import { fetchMarket, fetchMarkets, dataMode } from "@/lib/data";
import { getUsdtBalanceBase } from "@/lib/tx";
import { fetchUserPositions, type UserPosition } from "@/lib/positions";

/* ------------------------------------------------- tx-confirm refresh bus */

const txListeners = new Set<() => void>();

/** Broadcast that a tx landed — all live hooks revalidate immediately. */
export function notifyTxConfirmed(): void {
  txListeners.forEach((l) => l());
}

/**
 * Core loop: run `task` now, on every tx-confirm signal, and on an interval
 * (skipped while the tab is hidden). Tasks must be memoized (useCallback) —
 * the loop re-arms whenever the task identity changes. Callers guard
 * `dataMode` themselves.
 */
function useLiveTask(task: (() => void) | null, intervalMs: number): void {
  useEffect(() => {
    if (!task) return;
    task();
    txListeners.add(task);
    const timer = setInterval(() => {
      if (typeof document === "undefined" || !document.hidden) task();
    }, intervalMs);
    return () => {
      txListeners.delete(task);
      clearInterval(timer);
    };
  }, [task, intervalMs]);
}

/* ------------------------------------------------------------ live market */

/**
 * Keep a server-rendered market fresh: 5s poll + tx-confirm revalidate.
 * Demo mode returns the SSR value untouched.
 */
export function useLiveMarket(initial: MarketDto): MarketDto {
  const [market, setMarket] = useState(initial);
  const live = dataMode === "live";

  const task = useCallback(() => {
    fetchMarket(initial.id, { fresh: true })
      .then((m) => {
        if (m) setMarket(m);
      })
      .catch(() => {});
  }, [initial.id]);

  useLiveTask(live ? task : null, 5_000);
  return live ? market : initial;
}

/* ------------------------------------------------------------ USDT balance */

/**
 * Trader's USDT balance in base units. `null` while loading / no address.
 * Live mode only — the demo build never touches RPC.
 */
export function useUsdtBalance(address: string | null): {
  balanceBase: bigint | null;
  refresh: () => void;
} {
  const [balanceBase, setBalance] = useState<bigint | null>(null);
  const live = dataMode === "live";

  // Render-time reset when the wallet switches (react.dev "you might not
  // need an effect" derived-state pattern).
  const [lastAddress, setLastAddress] = useState(address);
  if (lastAddress !== address) {
    setLastAddress(address);
    setBalance(null);
  }

  const task = useCallback(() => {
    if (!address) return;
    getUsdtBalanceBase(address)
      .then(setBalance)
      .catch(() => {});
  }, [address]);

  useLiveTask(live && address ? task : null, 15_000);

  return { balanceBase: address ? balanceBase : null, refresh: task };
}

/* -------------------------------------------------------------- positions */

export interface UserPositionsState {
  positions: UserPosition[];
  loading: boolean;
  refresh: () => void;
}

/**
 * On-chain `Position` PDAs for the connected wallet across all indexer
 * markets (authoritative balances — the indexer may lag a block).
 */
export function useUserPositions(address: string | null): UserPositionsState {
  const [positions, setPositions] = useState<UserPosition[]>([]);
  const [loading, setLoading] = useState(true);
  const live = dataMode === "live";

  const task = useCallback(() => {
    if (!address) return;
    fetchMarkets(undefined, { fresh: true })
      .then(({ markets }) => fetchUserPositions(address, markets))
      .then((ps) => {
        setPositions(ps);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [address]);

  useLiveTask(live && address ? task : null, 15_000);

  return { positions, loading: live ? loading : false, refresh: task };
}

/**
 * The connected wallet's position on ONE market (trade ticket / 1g panel).
 * Returns null when no position exists (or demo mode).
 */
export function useMarketPosition(
  marketId: string,
  address: string | null,
): { position: UserPosition | null; refresh: () => void } {
  const [position, setPosition] = useState<UserPosition | null>(null);
  const live = dataMode === "live";

  const [lastKey, setLastKey] = useState(`${marketId}:${address}`);
  if (lastKey !== `${marketId}:${address}`) {
    setLastKey(`${marketId}:${address}`);
    setPosition(null);
  }

  const task = useCallback(() => {
    if (!address) return;
    fetchMarket(marketId, { fresh: true })
      .then((m) => (m ? fetchUserPositions(address, [m]) : []))
      .then((ps) => setPosition(ps[0] ?? null))
      .catch(() => {});
  }, [marketId, address]);

  useLiveTask(live && address ? task : null, 10_000);

  return { position: address ? position : null, refresh: task };
}

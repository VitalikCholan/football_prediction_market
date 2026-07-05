"use client";

import { useCallback, useState } from "react";
import { prepareFaucet } from "@/lib/tx";
import { notifyTxConfirmed } from "@/lib/use-live";
import { explorerTx } from "@/lib/solana";
import { usd } from "@/lib/format";
import { useTxAuthority } from "@/components/wallet/use-account";
import { useToast } from "@/components/ui/toast";

/**
 * "Get test USDT" action (trader onboarding): devnet-SOL gas check/airdrop,
 * idempotent ATA create, TxLINE `request_devnet_faucet` (100 USDT) — via the
 * standard simulate → sign → confirm chain in lib/tx. Shared by the trade
 * ticket, the wallet modal, and the portfolio header.
 */
export function useFaucet(onConfirmed?: () => void): {
  run: () => Promise<void>;
  busy: boolean;
  error: string | null;
} {
  const { getAuthority } = useTxAuthority();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const authority = await getAuthority();
      if (!authority) throw new Error("Wallet cannot sign — reconnect");
      const prepared = await prepareFaucet(authority);
      const res = await prepared.send();
      toast.push({
        title: `Received ${usd(
          Number(prepared.sim.outBase ?? 100_000_000n) / 1_000_000,
        )} test USDT`,
        href: explorerTx(res.signature),
        hrefLabel: "View tx ↗",
      });
      notifyTxConfirmed();
      onConfirmed?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [getAuthority, toast, onConfirmed]);

  return { run, busy, error };
}

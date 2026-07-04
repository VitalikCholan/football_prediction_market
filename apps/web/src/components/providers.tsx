"use client";

import { SolanaProvider } from "@solana/react-hooks";
import type { ClusterUrl } from "@solana/kit";
import { RPC_URL } from "@/lib/solana";
import { ToastProvider } from "@/components/ui/toast";

/**
 * App providers. framework-kit `SolanaProvider` composes the Solana client
 * (Wallet-Standard auto-discovery: Phantom / Solflare / Backpack) with its SWR
 * query layer. Cluster RPC comes from env (devnet default). Wallet persistence
 * keeps the session across reloads so demos don't re-prompt.
 */
export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <SolanaProvider
      config={{ endpoint: RPC_URL as ClusterUrl }}
      walletPersistence={{ autoConnect: true }}
    >
      <ToastProvider>{children}</ToastProvider>
    </SolanaProvider>
  );
}

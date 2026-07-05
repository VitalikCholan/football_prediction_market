"use client";

import { useCallback } from "react";
import { useWalletSession } from "@solana/react-hooks";
import { useWalletUi } from "@/components/wallet/use-wallet-ui";
import { useDemoWallet, loadDemoSigner } from "@/components/wallet/demo-wallet";
import type { TxAuthority, WalletTxSession } from "@/lib/tx";

/** The effective connected address: real Wallet-Standard wallet, else demo. */
export function useAccountAddress(): string | null {
  const wallet = useWalletUi();
  const demo = useDemoWallet();
  return wallet.address ?? demo.address;
}

/**
 * Signing authority for lib/tx: the framework-kit wallet session when a real
 * wallet is connected, otherwise the demo custodial keypair. `getAuthority` is
 * async because the demo signer is rebuilt from storage via WebCrypto.
 */
export function useTxAuthority(): {
  address: string | null;
  getAuthority: () => Promise<TxAuthority | null>;
} {
  const session = useWalletSession();
  const demo = useDemoWallet();

  const sessionAddress = session?.account.address?.toString() ?? null;
  const address = sessionAddress ?? demo.address;

  const getAuthority = useCallback(async (): Promise<TxAuthority | null> => {
    if (session) {
      // kit v5 (client) → kit v2 (this app) boundary: structural cast, the
      // wire Transaction shape is identical. See lib/tx.ts WalletTxSession.
      return { kind: "wallet", session: session as unknown as WalletTxSession };
    }
    const signer = await loadDemoSigner();
    if (signer) return { kind: "keypair", signer };
    return null;
  }, [session]);

  return { address, getAuthority };
}

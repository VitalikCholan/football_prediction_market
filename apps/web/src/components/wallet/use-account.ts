"use client";

import { useWalletUi } from "@/components/wallet/use-wallet-ui";
import { useDemoWallet } from "@/components/wallet/demo-wallet";

/** The effective connected address: real Wallet-Standard wallet, else demo. */
export function useAccountAddress(): string | null {
  const wallet = useWalletUi();
  const demo = useDemoWallet();
  return wallet.address ?? demo.address;
}

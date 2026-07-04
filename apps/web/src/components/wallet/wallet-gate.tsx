"use client";

import { useState } from "react";
import { useAccountAddress } from "@/components/wallet/use-account";
import { ConnectModal } from "@/components/wallet/connect-modal";

/**
 * Wallet gate. Renders children when an address is present, otherwise a
 * "connect to continue" empty state that opens the 1a modal.
 */
export function WalletGate({
  children,
  title = "Connect to trade",
  hint = "Connect a Solana wallet to see your balances and place orders.",
}: {
  children: React.ReactNode;
  title?: string;
  hint?: string;
}) {
  const address = useAccountAddress();
  const [open, setOpen] = useState(false);

  if (address) return <>{children}</>;

  return (
    <div className="scr flex flex-col items-center gap-3 p-10 text-center">
      <div className="text-2xl" aria-hidden>
        ◎
      </div>
      <h2 className="text-[17px] font-700">{title}</h2>
      <p className="max-w-sm text-[13px] text-muted">{hint}</p>
      <button className="btn btn-p mt-1" onClick={() => setOpen(true)}>
        Connect wallet
      </button>
      <ConnectModal open={open} onClose={() => setOpen(false)} />
    </div>
  );
}

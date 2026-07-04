"use client";

import { useState } from "react";
import { useWalletUi } from "@/components/wallet/use-wallet-ui";
import { ConnectModal } from "@/components/wallet/connect-modal";
import { useDemoWallet } from "@/components/wallet/demo-wallet";
import { shortAddress } from "@/lib/format";

/**
 * Wallet chip in the top nav. Shows `◎ 4xK…9Fa` when connected (real wallet or
 * demo custodial wallet), otherwise a Connect button that opens the 1a modal.
 */
export function WalletChip() {
  const wallet = useWalletUi();
  const demo = useDemoWallet();
  const [open, setOpen] = useState(false);

  const address = wallet.address ?? demo.address;

  if (address) {
    return (
      <button
        className="pill tnum"
        onClick={() => setOpen(true)}
        title="Wallet"
      >
        <span aria-hidden>◎</span>
        {shortAddress(address)}
        {demo.address && !wallet.address ? (
          <span className="text-muted">· demo</span>
        ) : null}
        <ConnectModal
          open={open}
          onClose={() => setOpen(false)}
          onDisconnect={() => {
            demo.disconnect();
            if (wallet.address) void wallet.disconnect();
          }}
        />
      </button>
    );
  }

  return (
    <>
      <button className="btn btn-p" onClick={() => setOpen(true)}>
        Connect
      </button>
      <ConnectModal open={open} onClose={() => setOpen(false)} />
    </>
  );
}

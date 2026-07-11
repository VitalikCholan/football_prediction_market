"use client";

import { useState } from "react";
import { useWalletUi } from "@/components/wallet/use-wallet-ui";
import { ConnectModal } from "@/components/wallet/connect-modal";
import { useDemoWallet } from "@/components/wallet/demo-wallet";
import { shortAddress } from "@/lib/format";
import { Button } from "@/components/ui/button";

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
      <>
        <Button
          variant="pill"
          size="pill"
          className="tnum"
          onClick={() => setOpen(true)}
          title="Wallet"
        >
          <span aria-hidden>◎</span>
          {shortAddress(address)}
          {demo.address && !wallet.address ? (
            <span className="text-muted">· demo</span>
          ) : null}
        </Button>
        <ConnectModal
          open={open}
          onClose={() => setOpen(false)}
          onDisconnect={() => {
            demo.disconnect();
            if (wallet.address) void wallet.disconnect();
          }}
        />
      </>
    );
  }

  return (
    <>
      <Button variant="primary" onClick={() => setOpen(true)}>
        Connect
      </Button>
      <ConnectModal open={open} onClose={() => setOpen(false)} />
    </>
  );
}

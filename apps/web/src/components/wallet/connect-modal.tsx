"use client";

import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { Badge } from "@/components/ui/badge";
import { useWalletUi } from "@/components/wallet/use-wallet-ui";
import { useDemoWallet } from "@/components/wallet/demo-wallet";
import { useFaucet } from "@/components/wallet/use-faucet";
import { explorerTx, CLUSTER } from "@/lib/solana";
import { shortAddress, usd } from "@/lib/format";
import { useUsdtBalance } from "@/lib/use-live";

const KNOWN = [
  { match: "phantom", name: "Phantom", glyph: "👻" },
  { match: "solflare", name: "Solflare", glyph: "🔆" },
  { match: "backpack", name: "Backpack", glyph: "🎒" },
];

/**
 * Screen 1a — wallet connect / onboarding, reused as a modal gate.
 * "Continue with Solana wallet" (discovered connectors), an OR divider, and an
 * email path that auto-provisions a custodial demo wallet. When connected, it
 * flips to a compact account view with disconnect.
 */
export function ConnectModal({
  open,
  onClose,
  onDisconnect,
}: {
  open: boolean;
  onClose: () => void;
  onDisconnect?: () => void;
}) {
  const wallet = useWalletUi();
  const demo = useDemoWallet();
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  const address = wallet.address ?? demo.address;
  const { balanceBase, refresh: refreshBalance } = useUsdtBalance(
    open ? address : null,
  );
  const faucet = useFaucet(refreshBalance);

  if (address) {
    return (
      <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
        <DialogContent className="max-w-[460px]">
          <DialogHeader>
            <DialogTitle>Your wallet</DialogTitle>
          </DialogHeader>
          <div className="box flex items-center justify-between p-3">
            <div>
              <div className="tnum text-[15px] font-600">
                ◎ {shortAddress(address, 6, 6)}
              </div>
              <div className="text-[12px] text-muted">
                {wallet.address ? "Connected" : "Demo custodial wallet"} ·{" "}
                {CLUSTER}
              </div>
            </div>
            <a
              className="text-link text-[12px] font-600 no-underline hover:underline"
              href={explorerTx(address)}
              target="_blank"
              rel="noreferrer"
            >
              View ↗
            </a>
          </div>
          <div className="box flex items-center justify-between p-3">
            <div>
              <div className="th">USDT balance</div>
              <div className="tnum text-[15px] font-700">
                {balanceBase === null
                  ? "…"
                  : usd(Number(balanceBase) / 1_000_000)}
              </div>
            </div>
            <Button
              size="sm"
              disabled={faucet.busy}
              onClick={faucet.run}
            >
              {faucet.busy ? "Requesting…" : "Get test USDT"}
            </Button>
          </div>
          {faucet.error ? (
            <p className="text-[12px] font-600 text-no-strong" role="alert">
              {faucet.error}
            </p>
          ) : null}
          <Button
            className="w-full"
            onClick={() => {
              onDisconnect?.();
              onClose();
            }}
          >
            Disconnect
          </Button>
        </DialogContent>
      </Dialog>
    );
  }

  const discovered = wallet.connectors.map((c) => {
    const known = KNOWN.find((k) => c.id.toLowerCase().includes(k.match));
    return { ...c, glyph: known?.glyph ?? "◎", label: known?.name ?? c.name };
  });

  async function onConnect(id: string) {
    setBusy(id);
    try {
      await wallet.connect(id);
      onClose();
    } catch {
      // Interactive fallback / user cancelled — leave the modal open.
    } finally {
      setBusy(null);
    }
  }

  async function onEmail() {
    setBusy("demo");
    try {
      // Provisions a REAL local devnet keypair (can sign transactions).
      await demo.connect();
      onClose();
    } finally {
      setBusy(null);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-[460px]">
        <DialogHeader className="text-center sm:text-center">
          <div className="text-[15px]" aria-hidden>
            ◆
          </div>
          <DialogTitle className="text-[19px]">TXL·Markets</DialogTitle>
          <DialogDescription>
            Trade the outcome of every World Cup match
          </DialogDescription>
        </DialogHeader>

        <Button
          variant="primary"
          className="w-full"
          onClick={() =>
            discovered[0] ? onConnect(discovered[0].id) : onEmail()
          }
        >
          ◎ Continue with Solana wallet
        </Button>

        <div className="space-y-2">
          {discovered.length > 0 ? (
            discovered.map((c) => (
              <Button
                key={c.id}
                className="w-full justify-between"
                disabled={busy !== null}
                onClick={() => onConnect(c.id)}
              >
                <span className="flex items-center gap-2">
                  <span aria-hidden>{c.glyph}</span>
                  {c.label}
                </span>
                <span className="text-[12px] font-500 text-muted">
                  {busy === c.id ? "Connecting…" : "Detected"}
                </span>
              </Button>
            ))
          ) : (
            <div className="box p-3 text-center text-[12px] text-muted">
              No Solana wallet detected. Use email below to get a wallet created
              for you.
            </div>
          )}
        </div>

        <div className="flex items-center gap-3 text-[11px] text-muted">
          <Separator className="flex-1" />
          OR
          <Separator className="flex-1" />
        </div>

        <div className="flex gap-2">
          <Input
            className="flex-1"
            type="email"
            placeholder="you@email.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            aria-label="Email"
          />
          <Button onClick={onEmail}>Continue</Button>
        </div>

        <p className="flex items-start gap-2 text-[11px] leading-relaxed text-muted">
          <Badge variant="verified" className="shrink-0">
            ◆ On-chain
          </Badge>
          Balances &amp; trades settle on Solana. A wallet is created for you —
          no crypto knowledge needed.
        </p>
      </DialogContent>
    </Dialog>
  );
}

"use client";

import { useState } from "react";
import { Modal } from "@/components/ui/modal";
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
      <Modal open={open} onClose={onClose} labelledBy="wallet-account-title">
        <h2 id="wallet-account-title" className="text-[17px] font-700">
          Your wallet
        </h2>
        <div className="box mt-4 flex items-center justify-between p-3">
          <div>
            <div className="tnum text-[15px] font-600">
              ◎ {shortAddress(address, 6, 6)}
            </div>
            <div className="text-[12px] text-muted">
              {wallet.address ? "Connected" : "Demo custodial wallet"} · {CLUSTER}
            </div>
          </div>
          <a
            className="link text-[12px] font-600 no-underline"
            href={explorerTx(address)}
            target="_blank"
            rel="noreferrer"
          >
            View ↗
          </a>
        </div>
        <div className="box mt-2 flex items-center justify-between p-3">
          <div>
            <div className="th">USDT balance</div>
            <div className="tnum text-[15px] font-700">
              {balanceBase === null
                ? "…"
                : usd(Number(balanceBase) / 1_000_000)}
            </div>
          </div>
          <button
            className="btn px-3 py-1.5 text-[12px]"
            disabled={faucet.busy}
            onClick={faucet.run}
          >
            {faucet.busy ? "Requesting…" : "Get test USDT"}
          </button>
        </div>
        {faucet.error ? (
          <p className="mt-2 text-[12px] font-600 text-no-strong" role="alert">
            {faucet.error}
          </p>
        ) : null}
        <button
          className="btn mt-4 w-full"
          onClick={() => {
            onDisconnect?.();
            onClose();
          }}
        >
          Disconnect
        </button>
      </Modal>
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
    <Modal open={open} onClose={onClose} labelledBy="wallet-connect-title">
      <div className="text-center">
        <div className="text-[15px]" aria-hidden>
          ◆
        </div>
        <h2 id="wallet-connect-title" className="mt-1 text-[19px] font-700">
          TXL·Markets
        </h2>
        <p className="mt-1 text-[13px] text-muted">
          Trade the outcome of every World Cup match
        </p>
      </div>

      <button
        className="btn btn-p mt-5 w-full"
        onClick={() =>
          discovered[0] ? onConnect(discovered[0].id) : onEmail()
        }
      >
        ◎ Continue with Solana wallet
      </button>

      <div className="mt-4 space-y-2">
        {discovered.length > 0 ? (
          discovered.map((c) => (
            <button
              key={c.id}
              className="btn w-full justify-between"
              disabled={busy !== null}
              onClick={() => onConnect(c.id)}
            >
              <span className="flex items-center gap-2">
                <span aria-hidden>{c.glyph}</span>
                {c.label}
              </span>
              <span className="text-[12px] text-muted">
                {busy === c.id ? "Connecting…" : "Detected"}
              </span>
            </button>
          ))
        ) : (
          <div className="box p-3 text-center text-[12px] text-muted">
            No Solana wallet detected. Use email below to get a wallet created
            for you.
          </div>
        )}
      </div>

      <div className="my-4 flex items-center gap-3 text-[11px] text-muted">
        <span className="h-px flex-1 bg-box-border" />
        OR
        <span className="h-px flex-1 bg-box-border" />
      </div>

      <div className="flex gap-2">
        <input
          className="field flex-1"
          type="email"
          placeholder="you@email.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          aria-label="Email"
        />
        <button className="btn" onClick={onEmail}>
          Continue
        </button>
      </div>

      <p className="mt-4 flex items-start gap-2 text-[11px] leading-relaxed text-muted">
        <span className="verified shrink-0">◆ On-chain</span>
        Balances &amp; trades settle on Solana. A wallet is created for you — no
        crypto knowledge needed.
      </p>
    </Modal>
  );
}

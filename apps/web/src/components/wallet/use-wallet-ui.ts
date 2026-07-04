"use client";

import { useCallback } from "react";
import {
  useWallet,
  useConnectWallet,
  useDisconnectWallet,
  useWalletModalState,
} from "@solana/react-hooks";

/**
 * Thin UI-facing wallet hook. Wraps framework-kit's headless wallet state into
 * the shape the nav / gate / trade panel need. When no Wallet-Standard wallet is
 * installed (e.g. the standalone demo), `connectors` is empty and the UI offers
 * a "Continue as demo" path so every screen stays reachable.
 */
export interface WalletUi {
  status: "connected" | "connecting" | "disconnected" | "error";
  address: string | null;
  connectors: { id: string; name: string }[];
  connect: (connectorId: string) => Promise<void>;
  disconnect: () => Promise<void>;
  openModal: () => void;
  closeModal: () => void;
  modalOpen: boolean;
}

export function useWalletUi(): WalletUi {
  const wallet = useWallet();
  const connect = useConnectWallet();
  const disconnect = useDisconnectWallet();
  const modal = useWalletModalState({ closeOnConnect: true });

  const address =
    wallet.status === "connected"
      ? wallet.session.account.address.toString()
      : null;

  const doConnect = useCallback(
    async (connectorId: string) => {
      await connect(connectorId, { autoConnect: true });
    },
    [connect],
  );

  return {
    status: wallet.status,
    address,
    connectors: modal.connectors.map((c) => ({ id: c.id, name: c.name })),
    connect: doConnect,
    disconnect,
    openModal: modal.open,
    closeModal: modal.close,
    modalOpen: modal.isOpen,
  };
}

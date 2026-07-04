"use client";

import { useSyncExternalStore, useCallback } from "react";

/**
 * Demo custodial wallet. Screen 1a promises "a wallet is created for you — no
 * crypto knowledge needed" for the email path. For the standalone demo (and
 * when no Wallet-Standard wallet is installed), this provisions a deterministic
 * fake address so every gated screen is reachable without a real extension.
 *
 * Persisted in localStorage; a tiny external store so nav + gates stay in sync.
 */
const KEY = "txl_demo_wallet";
const DEMO_ADDRESS = "4xKq7Yd8Fah3TmwZ9Rb2Nv6Ss1Uu5Pp0Gg7Hh2Kk9Fa";

const listeners = new Set<() => void>();
function emit() {
  listeners.forEach((l) => l());
}

function read(): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(KEY);
}

export function useDemoWallet() {
  const address = useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    read,
    () => null,
  );

  const connect = useCallback((addr: string = DEMO_ADDRESS) => {
    window.localStorage.setItem(KEY, addr);
    emit();
  }, []);

  const disconnect = useCallback(() => {
    window.localStorage.removeItem(KEY);
    emit();
  }, []);

  return { address, connect, disconnect };
}

export { DEMO_ADDRESS };

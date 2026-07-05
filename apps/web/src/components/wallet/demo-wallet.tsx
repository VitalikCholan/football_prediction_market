"use client";

import { useSyncExternalStore, useCallback } from "react";
import {
  createKeyPairSignerFromPrivateKeyBytes,
  type KeyPairSigner,
} from "@solana/kit";

/**
 * Demo custodial wallet. Screen 1a promises "a wallet is created for you — no
 * crypto knowledge needed" for the email path. This provisions a REAL local
 * Ed25519 keypair (WebCrypto) that CAN sign devnet transactions: the 32-byte
 * private seed is persisted in localStorage (demo-grade custody — devnet only,
 * never mainnet) and rebuilt into a Kit `KeyPairSigner` on demand.
 *
 * A tiny external store keeps nav + gates in sync across components.
 */
const KEY = "txl_demo_wallet_v2";
const LEGACY_KEY = "txl_demo_wallet"; // pre-Phase-5 fake address — discard

interface StoredWallet {
  address: string;
  /** 32-byte Ed25519 private seed, hex. */
  seed: string;
}

const listeners = new Set<() => void>();
function emit() {
  listeners.forEach((l) => l());
}

function readStored(): StoredWallet | null {
  if (typeof window === "undefined") return null;
  window.localStorage.removeItem(LEGACY_KEY);
  const raw = window.localStorage.getItem(KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as StoredWallet;
    return parsed.address && parsed.seed ? parsed : null;
  } catch {
    return null;
  }
}

function readAddress(): string | null {
  return readStored()?.address ?? null;
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/** Generate + persist a fresh demo keypair; returns its address. */
export async function provisionDemoWallet(): Promise<string> {
  const existing = readStored();
  if (existing) return existing.address;
  const seed = crypto.getRandomValues(new Uint8Array(32));
  const signer = await createKeyPairSignerFromPrivateKeyBytes(seed);
  const stored: StoredWallet = { address: signer.address, seed: toHex(seed) };
  window.localStorage.setItem(KEY, JSON.stringify(stored));
  emit();
  return signer.address;
}

/** Rebuild the demo `KeyPairSigner` from storage; null when not provisioned. */
export async function loadDemoSigner(): Promise<KeyPairSigner | null> {
  const stored = readStored();
  if (!stored) return null;
  return createKeyPairSignerFromPrivateKeyBytes(fromHex(stored.seed));
}

export function useDemoWallet() {
  const address = useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    readAddress,
    () => null,
  );

  const connect = useCallback(async () => {
    await provisionDemoWallet();
  }, []);

  const disconnect = useCallback(() => {
    window.localStorage.removeItem(KEY);
    emit();
  }, []);

  return { address, connect, disconnect };
}

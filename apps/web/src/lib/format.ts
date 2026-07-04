/**
 * Formatting helpers for a money UI. Everything numeric renders with tabular
 * figures (see `.tnum` in globals.css). USDC has 6 decimals on-chain; the DTOs
 * carry u64 base units as strings, so parse carefully.
 */

/** USDC base-unit decimals (6). */
export const USDC_DECIMALS = 6;
const USDC_SCALE = 1_000_000;

/** Parse a u64 base-unit string into a JS number of whole USDC (demo-scale). */
export function baseToUsdc(base: string | number | bigint): number {
  const n = typeof base === "string" ? Number(base) : Number(base);
  return n / USDC_SCALE;
}

/** yesPriceBps (0–10000) → cents (0–100), rounded. */
export function bpsToCents(bps: number): number {
  return Math.round(bps / 100);
}

/** yesPriceBps → probability 0..1. */
export function bpsToProb(bps: number): number {
  return bps / 10_000;
}

/** "46¢" style price label from bps. */
export function centsLabel(bps: number): string {
  return `${bpsToCents(bps)}¢`;
}

/** "46%" implied-probability label from bps. */
export function percentLabel(bps: number, digits = 0): string {
  return `${(bps / 100).toFixed(digits)}%`;
}

const usdFmt = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const usdCompact = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  notation: "compact",
  maximumFractionDigits: 1,
});

/** $3,412.80 */
export function usd(value: number): string {
  return usdFmt.format(value);
}

/** $842k — for volume badges. */
export function usdCompactLabel(value: number): string {
  return usdCompact.format(value);
}

/** Volume string (base units) → "$842k". */
export function volumeLabel(base: string): string {
  return usdCompactLabel(baseToUsdc(base));
}

const numFmt = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});

/** 108.7 shares */
export function shares(value: number): string {
  return numFmt.format(value);
}

/** +12.4% / -3.1% signed percent. */
export function signedPercent(value: number): string {
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(1)}%`;
}

/** Truncate a base58 address to `4xK…9Fa`. */
export function shortAddress(addr: string, lead = 3, tail = 3): string {
  if (addr.length <= lead + tail + 1) return addr;
  return `${addr.slice(0, lead)}…${addr.slice(-tail)}`;
}

/** Relative "12s ago" / "3m ago" from a unix-seconds timestamp. */
export function timeAgo(tsSeconds: number, now = Date.now()): string {
  const diff = Math.max(0, Math.floor(now / 1000) - tsSeconds);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

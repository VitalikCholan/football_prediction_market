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

/**
 * "1 – 0" score label from the two nullable scores. Returns null unless BOTH
 * scores are present, so callers can hide the score UI entirely when the feed
 * has no data (devnet fixtures with no TxLINE stream).
 */
export function scoreLabel(
  homeScore: number | null | undefined,
  awayScore: number | null | undefined,
): string | null {
  if (homeScore == null || awayScore == null) return null;
  return `${homeScore} – ${awayScore}`;
}

/**
 * Human status line for a match, derived from statusId / gameState / matchClock.
 * "Full time" once finalised (statusId 100); otherwise gameState plus a clock
 * suffix ("Live · 62'") when a clock is present. Returns null when there is no
 * signal at all (so the caller can render a neutral fallback).
 */
export function matchStatusLine(
  statusId: number | null | undefined,
  gameState: string | null | undefined,
  matchClock: string | null | undefined,
): string | null {
  if (statusId === 100) return "Full time";
  const clock = clockLabel(matchClock);
  const state = gameState?.trim() || null;
  if (state && clock) return `${state} · ${clock}`;
  if (state) return state;
  if (clock) return clock;
  return null;
}

/**
 * TxLINE match clock ("77:26" mm:ss) → a compact "77'" minute label. Returns
 * null for absent/garbage clocks so nothing renders when the feed is silent.
 */
export function clockLabel(
  matchClock: string | null | undefined,
): string | null {
  if (!matchClock) return null;
  const mins = matchClock.split(":")[0]?.trim();
  if (!mins || !/^\d+$/.test(mins)) return null;
  return `${Number(mins)}'`;
}

const kickoffFmt = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  timeZone: "UTC",
  timeZoneName: "short",
});

/** "Jul 14, 3:00 PM UTC" kickoff label from a unix-seconds ts, or null. */
export function kickoffLabel(
  kickoffTs: number | null | undefined,
): string | null {
  if (kickoffTs == null || !Number.isFinite(kickoffTs)) return null;
  return kickoffFmt.format(new Date(kickoffTs * 1000));
}

/** Relative "12s ago" / "3m ago" from a unix-seconds timestamp. */
export function timeAgo(tsSeconds: number, now = Date.now()): string {
  const diff = Math.max(0, Math.floor(now / 1000) - tsSeconds);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

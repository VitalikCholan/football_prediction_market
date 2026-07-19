/**
 * Client-side leverage math — display mirrors of `plans/leverage-v1.md` §1
 * (the on-chain source of truth is `programs/amm/src/funding.rs`). Float
 * precision is fine for PREVIEWS; the one money-accurate path (accrued
 * funding F against the live cumulative index) uses BigInt so a large
 * u128 index delta never loses cents. Deliberately NOT in `libs/shared` —
 * these are UI estimates, not a contract.
 */

export const BPS = 10_000;

/** Funding-index fixed-point scale (leverage-v1 §2 INDEX_SCALE). */
export const INDEX_SCALE = 1_000_000_000_000n;

/** Funding never divides by less than this time-to-freeze (§1 t_rem floor). */
export const MIN_T_REMAINING_SECS = 60;

/** U = N·BPS/p — $1-payout-equivalent units (all args display-scale USDT / bps). */
export function unitsFor(
  collateralUsdt: number,
  leverage: number,
  entryMarkBps: number,
): number {
  if (entryMarkBps <= 0) return 0;
  return (collateralUsdt * leverage * BPS) / entryMarkBps;
}

/** max_gain = U·(BPS−p)/BPS — pool liability / trader max profit. */
export function maxGain(units: number, entryMarkBps: number): number {
  return (units * (BPS - entryMarkBps)) / BPS;
}

/** pnl(p) = U·(p − p_entry)/BPS (signed, display USDT). */
export function pnlAt(
  units: number,
  entryMarkBps: number,
  markBps: number,
): number {
  return (units * (markBps - entryMarkBps)) / BPS;
}

/** equity = max(0, C + pnl − F) — the unified settle payout (§1). */
export function equityOf(
  collateralUsdt: number,
  pnl: number,
  fundingUsdt: number,
): number {
  return Math.max(0, collateralUsdt + pnl - fundingUsdt);
}

/**
 * F = floor(N·(idx_now − idx_snap)/INDEX_SCALE) in USDT base units —
 * exact BigInt mirror of `funding_accrued` against the live pool index.
 */
export function fundingAccruedBase(
  notionalBase: bigint,
  idxNow: bigint,
  idxSnap: bigint,
): bigint {
  if (idxNow <= idxSnap) return 0n;
  return (notionalBase * (idxNow - idxSnap)) / INDEX_SCALE;
}

/**
 * Estimated funding burn in USDT per hour at the current mark:
 * from §1, F/sec = N·time_fee_num·p(BPS−p)/(BPS²·t_rem), ×valve multiplier
 * when the valve window is active. `tRemainingSecs` is clamped to the same
 * floor the program uses so the estimate never blows up near freeze.
 */
export function fundingPerHour(
  timeFeeNum: number,
  pBps: number,
  tRemainingSecs: number,
  notionalUsdt: number,
  valveMultiplierBps: number = BPS,
): number {
  const tRem = Math.max(tRemainingSecs, MIN_T_REMAINING_SECS);
  const perSec =
    (notionalUsdt * timeFeeNum * pBps * (BPS - pBps)) / (BPS * BPS * tRem);
  return (perSec * 3600 * valveMultiplierBps) / BPS;
}

/** Leverage cap taper (§1 max_leverage_for_p): linear to 1× inside a 20¢ edge. */
export function maxLeverageForP(pBps: number, maxLeverage: number): number {
  const edge = Math.min(pBps, BPS - pBps);
  if (edge >= 2_000) return maxLeverage;
  return Math.max(1, 1 + Math.floor(((maxLeverage - 1) * edge) / 2_000));
}

/**
 * Rough time until fee-death (accrued funding reaches C) at the CURRENT burn
 * rate. Null when the position isn't burning (rate 0) or is already dead.
 */
export function feeDeathSecs(
  collateralUsdt: number,
  fundingSoFarUsdt: number,
  burnPerHourUsdt: number,
): number | null {
  const remaining = collateralUsdt - fundingSoFarUsdt;
  if (remaining <= 0 || burnPerHourUsdt <= 0) return null;
  return (remaining / burnPerHourUsdt) * 3600;
}

/** "~2d 4h" / "~3h 12m" / "~45m" duration label for the fee-death estimate. */
export function durationLabel(secs: number): string {
  const s = Math.max(0, Math.floor(secs));
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `~${d}d ${h}h`;
  if (h > 0) return `~${h}h ${m}m`;
  if (m > 0) return `~${m}m`;
  return "<1m";
}

/**
 * Dynamic-fee bar. The volatility fee is the project thesis — this makes it
 * legible: a thin bar that widens and turns amber when the current fee is
 * elevated above base (protects liquidity from stale-price trades after a
 * sharp move, e.g. a goal).
 */
export function FeeBar({
  currentFeeBps,
  baseFeeBps,
}: {
  currentFeeBps: number | null;
  baseFeeBps: number | null;
}) {
  if (currentFeeBps == null) return null;
  const base = baseFeeBps ?? 30;
  const elevated = currentFeeBps > base * 1.15;
  // Scale bar 0..100% across base..3x base.
  const pct = Math.min(
    100,
    ((currentFeeBps - base) / (base * 2)) * 100 + 12,
  );

  return (
    <div className="box p-3" title="Fee rises after sharp price moves to protect liquidity from stale-price trades.">
      <div className="flex items-center justify-between text-[12px]">
        <span className="text-muted">Dynamic fee</span>
        <span
          className={`tnum font-700 ${elevated ? "text-[#b7791f]" : ""}`}
        >
          {(currentFeeBps / 100).toFixed(2)}%
        </span>
      </div>
      <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-skeleton">
        <div
          className="h-full rounded-full transition-all"
          style={{
            width: `${pct}%`,
            background: elevated ? "#f5c542" : "var(--yes)",
          }}
        />
      </div>
      {elevated ? (
        <p className="mt-1.5 text-[11px] text-[#b7791f]">
          Elevated — recent volatility. Trades cost more until it settles.
        </p>
      ) : null}
    </div>
  );
}

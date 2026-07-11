import { Card } from "@/components/ui/card";

/**
 * Leaderboard + activity (DESIGN_SPEC 1f). Both need indexer endpoints that
 * don't exist yet (no /leaderboard or /activity aggregate), so rather than
 * render mock fixtures we show honest empty states. Real, indexer-backed
 * versions land in a follow-up wave.
 */
export function LeaderboardView() {
  return (
    <div className="grid grid-cols-1 gap-5 lg:grid-cols-[1fr_340px]">
      {/* Leaderboard */}
      <Card className="overflow-hidden">
        <div className="flex items-center justify-between border-b border-box-border px-4 py-3">
          <h2 className="text-[14px] font-700">Leaderboard</h2>
        </div>
        <div className="p-10 text-center text-[14px] text-muted">
          Leaderboard coming soon. Trader rankings will appear here once the
          indexer aggregates on-chain volume and P/L.
        </div>
      </Card>

      {/* Activity */}
      <Card className="flex flex-col overflow-hidden">
        <div className="flex items-center gap-2 border-b border-box-border px-4 py-3">
          <span className="dot dot-pulse" aria-hidden />
          <h2 className="text-[14px] font-700">Live activity</h2>
        </div>
        <div className="p-8 text-center text-[13px] text-muted">
          No activity yet. Trades will stream here as markets fill.
        </div>
      </Card>
    </div>
  );
}

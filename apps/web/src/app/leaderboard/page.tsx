import { LeaderboardView } from "@/components/leaderboard/leaderboard-view";

/** Leaderboard + activity (DESIGN_SPEC 1f). */
export default function LeaderboardPage() {
  return (
    <div>
      <div className="mb-5">
        <h1 className="text-[22px] font-700 tracking-tight">Leaderboard</h1>
        <p className="text-[13px] text-muted">
          Top traders this week, and what the market is doing right now.
        </p>
      </div>
      <LeaderboardView />
    </div>
  );
}

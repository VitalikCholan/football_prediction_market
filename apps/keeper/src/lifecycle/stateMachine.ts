/**
 * Per-match lifecycle FSM (backend-plan §2.3).
 *
 *   Scheduled --kickoff--> Live(activated) --final whistle--> Ended(frozen)
 *             --root posted--> Resolved
 *
 * The FSM is a hint; the ON-CHAIN Market.state is the source of truth. Every
 * action re-reads the chain and no-ops if the transition already happened, so
 * restarts / duplicate SSE events / rebroadcasts are all safe (idempotency is
 * the key design rule).
 */
export type MatchPhase =
  | "Scheduled"
  | "Live"
  | "Ended"
  | "Resolved"
  | "Failed";

export interface MatchTracker {
  fixtureId: bigint;
  phase: MatchPhase;
  /** Set once we detect kickoff (SSE status change or scheduled time). */
  activatedAt?: number;
  /**
   * Set once we detect the final whistle — StatusId === 100 or
   * Action === "game_finalised" (or the end-time fallback).
   */
  endedAt?: number;
  /**
   * Seq of the score event that finalised the match — REQUIRED by
   * /api/scores/stat-validation. Undefined when ended via the end-time
   * fallback (the resolver then recovers it from the historical replay).
   */
  endedSeq?: number;
  /** Set once resolve lands on-chain. */
  resolvedAt?: number;
  /** Count of resolve attempts (for RootNotAvailable backoff). */
  resolveAttempts: number;
}

export class LifecycleStateMachine {
  private readonly trackers = new Map<string, MatchTracker>();

  get(fixtureId: bigint): MatchTracker {
    const key = fixtureId.toString();
    let t = this.trackers.get(key);
    if (!t) {
      t = { fixtureId, phase: "Scheduled", resolveAttempts: 0 };
      this.trackers.set(key, t);
    }
    return t;
  }

  all(): MatchTracker[] {
    return [...this.trackers.values()];
  }

  markLive(fixtureId: bigint): void {
    const t = this.get(fixtureId);
    if (t.phase === "Scheduled") {
      t.phase = "Live";
      t.activatedAt = Date.now();
    }
  }

  markEnded(fixtureId: bigint, seq?: number): void {
    const t = this.get(fixtureId);
    if (t.phase === "Scheduled" || t.phase === "Live") {
      t.phase = "Ended";
      t.endedAt = Date.now();
    }
    // Carry the finalising Seq through to resolve (stat-validation needs it).
    if (seq !== undefined) t.endedSeq = seq;
  }

  markResolved(fixtureId: bigint): void {
    const t = this.get(fixtureId);
    t.phase = "Resolved";
    t.resolvedAt = Date.now();
  }

  markFailed(fixtureId: bigint): void {
    this.get(fixtureId).phase = "Failed";
  }

  incrementResolveAttempts(fixtureId: bigint): number {
    const t = this.get(fixtureId);
    t.resolveAttempts += 1;
    return t.resolveAttempts;
  }
}

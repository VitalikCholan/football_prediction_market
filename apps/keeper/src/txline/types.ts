/**
 * TxLINE on-chain / proof types (backend-plan §2.8, CONFIRMED against the
 * TxLINE devnet IDL). These mirror the args our AMM `resolve` forwards to the
 * TxLINE `validate_stat` CPI. The `predicate` (TraderPredicate) is stored
 * on-chain in MarketConfig and is NOT passed by the keeper.
 *
 * Also home of the normalized score-event shape (VERIFIED live 2026-07-04
 * against the real API — the docs/OpenAPI were wrong; see backend-plan §2.4).
 */

/* -------------------------------------------------------------------------
 * Score events (SSE stream + historical) — REAL shape, verified live.
 *
 * Wire fields are PascalCase: FixtureId, Seq, Ts, Action, StatusId, GameState,
 * Stats, Clock, Score. `Stats` is a MAP { "<key>": value } with
 * key = period*1000 + base (e.g. "1":1,"2":0 = home 1 away 0). There is NO
 * phase_id/gamePhase. Lifecycle: StatusId 1..5 are in-play stages and
 * **100 = finalised**; Action strings include "game_finalised",
 * "halftime_finalised", etc. GameState stays "scheduled" even in play — never
 * trust it. `Ts` is MILLISECONDS.
 * ----------------------------------------------------------------------- */

/** Normalized TxLINE score event (from SSE stream or historical replay). */
export interface ScoreEvent {
  fixtureId: bigint;
  /** Stream sequence — REQUIRED by /api/scores/stat-validation (`seq` param). */
  seq: number;
  /** Event timestamp in MILLISECONDS. */
  ts: bigint;
  /** 1..5 in-play stages; 100 = finalised. */
  statusId: number;
  /** e.g. "kickoff", "goal", "halftime_finalised", "game_finalised". */
  action: string;
  /** Unreliable — observed stuck at "scheduled" even in play. */
  gameState?: string;
  /** Map of stat key ("period*1000+base") -> value. */
  stats: Record<string, number>;
  raw: unknown;
}

/** StatusId that means the match is finalised (VERIFIED live). */
export const FINALISED_STATUS_ID = 100;

/**
 * Match-end rule (replaces the docs' bogus Game Phase {5,10,13}):
 * StatusId === 100 OR Action === "game_finalised".
 */
export function isMatchEnd(e: Pick<ScoreEvent, "statusId" | "action">): boolean {
  return e.statusId === FINALISED_STATUS_ID || e.action === "game_finalised";
}

/**
 * Read a stat from the Stats map by base key + period (key = period*1000+base).
 * Full-time totals live at the bare base keys ("1", "2"). Stat-validation
 * reports final stats with `period: 100`; tolerate a missing 100xxx key by
 * falling back to the bare base key (same final total).
 */
export function readStat(
  stats: Record<string, number>,
  base: number,
  period = 0,
): number | undefined {
  const v = stats[String(period * 1000 + base)];
  if (v !== undefined) return v;
  if (period === 100) return stats[String(base)];
  return undefined;
}

export interface ProofNode {
  hash: Uint8Array; // [u8; 32]
  isRightSibling: boolean;
}

export interface ScoreStat {
  key: number; // u32
  value: number; // i32
  period: number; // i32
}

export interface StatTerm {
  statToProve: ScoreStat;
  eventStatRoot: Uint8Array; // [u8; 32]
  statProof: ProofNode[];
}

/** Per-batch update stats — matches the on-chain `ScoresUpdateStats` layout. */
export interface ScoresUpdateStats {
  updateCount: number; // i32
  minTimestamp: bigint; // i64 (ms)
  maxTimestamp: bigint; // i64 (ms)
}

export interface ScoresBatchSummary {
  fixtureId: bigint; // i64
  updateStats: ScoresUpdateStats;
  eventsSubTreeRoot: Uint8Array; // [u8; 32]
}

/** BinaryExpression enum forwarded to validate_stat (op between stat_a/stat_b). */
export type BinaryExpression = "Add" | "Subtract";

/** TraderPredicate — stored on-chain in MarketConfig (keeper never sends it). */
export interface TraderPredicate {
  threshold: number; // i32
  comparison: "GreaterThan" | "LessThan" | "EqualTo";
}

/**
 * Everything the keeper must pass to `resolve` (which CPIs validate_stat).
 * `ts` selects the epoch-day root PDA; the proofs verify the stats against it.
 */
export interface ResolveProofArgs {
  ts: bigint; // i64 — used to derive epoch_day for the roots PDA
  epochDay: number; // u16 — daily_scores_roots seed
  fixtureSummary: ScoresBatchSummary;
  fixtureProof: ProofNode[];
  mainTreeProof: ProofNode[];
  statA: StatTerm;
  statB?: StatTerm;
  op?: BinaryExpression;
}

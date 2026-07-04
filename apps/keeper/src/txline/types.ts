/**
 * TxLINE on-chain / proof types (backend-plan §2.8, CONFIRMED against the
 * TxLINE devnet IDL). These mirror the args our AMM `resolve` forwards to the
 * TxLINE `validate_stat` CPI. The `predicate` (TraderPredicate) is stored
 * on-chain in MarketConfig and is NOT passed by the keeper.
 */

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

export interface ScoresUpdateStats {
  // Opaque summary counters; carried through to validate_stat unchanged.
  raw: unknown;
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

import {
  getProgramDerivedAddress,
  getU16Encoder,
  type Address,
  type Instruction,
} from "@solana/kit";
import {
  AMM_ERROR__INVALID_MARKET_STATE,
  AMM_ERROR__PROOF_REJECTED,
  BinaryExpression,
  MarketState,
  fetchMaybeMarket1x2,
  getResolve1x2InstructionAsync,
} from "@fpm/idl";
import {
  DAILY_SCORES_ROOTS_SEED,
  TXLINE,
  findMarket1x2Pda,
} from "@fpm/shared";
import { log } from "../log.ts";
import {
  discriminateTxError,
  isTerminalTxlineCode,
  txlineErrorName,
  TXLINE_ERR,
  type DiscriminatedTxError,
} from "../solana/errors.ts";
import type { ProofFetcher, StatValidationQuery } from "../txline/proof.ts";
import { Period, StatBase } from "../txline/scoreStream.ts";
import { readStat, type ResolveProofArgs, type ScoreEvent } from "../txline/types.ts";
import { marketStateName, type ActionContext } from "./context.ts";

export { TXLINE_ERR } from "../solana/errors.ts";

/**
 * 1X2 outcome hint the keeper passes to `resolve_1x2`.
 *
 * NB: this is the on-chain HINT-BYTE space (`0=Team1, 1=Draw, 2=Team2`, per
 * `resolve_1x2.rs`), NOT the `Outcome1x2` account enum (`Unset=0, Team1=1, …`).
 * Declared as a const object (NOT a TS `enum`) because the keeper runs on Node
 * native type-stripping (`erasableSyntaxOnly` — enums are non-erasable).
 */
export const Outcome1x2Hint = {
  Team1: 0,
  Draw: 1,
  Team2: 2,
} as const;
export type Outcome1x2Hint =
  (typeof Outcome1x2Hint)[keyof typeof Outcome1x2Hint];

/** Human-readable name for a hint byte (logging). */
function hintName(hint: Outcome1x2Hint): string {
  return (
    (Object.keys(Outcome1x2Hint) as (keyof typeof Outcome1x2Hint)[]).find(
      (k) => Outcome1x2Hint[k] === hint,
    ) ?? `Hint(${hint})`
  );
}

/**
 * Compute the correct outcome hint from the FINAL score the keeper already
 * knows (from the SSE finalising frame or the historical replay):
 *   home > away -> Team1, home == away -> Draw, home < away -> Team2.
 *
 * The on-chain `derive_predicate_for_outcome` turns this hint into the positive
 * comparator (Team1→GreaterThan, Draw→EqualTo, Team2→LessThan) on the SAME
 * stored `stat_a − stat_b` vs `threshold`, so a correct hint proves positively
 * in ONE `validate_stat` CPI (Draw included — the EqualTo wall is dissolved on
 * this path, D-8/resolve-1x2.md).
 */
export function outcomeHintFromScore(
  homeGoals: number,
  awayGoals: number,
): Outcome1x2Hint {
  if (homeGoals > awayGoals) return Outcome1x2Hint.Team1;
  if (homeGoals < awayGoals) return Outcome1x2Hint.Team2;
  return Outcome1x2Hint.Draw;
}

/**
 * Extract the final (home, away) goals from a finalising score event's `stats`
 * map — the input a scheduler/SSE hook feeds to `resolveMarket1x2` so it can
 * pick the outcome hint. Full-time goals live at StatBase P1_GOALS/P2_GOALS;
 * final stats are reported under period 100 with a bare-base-key fallback (see
 * `readStat`). Returns null if either goal count is missing.
 */
export function scoreFromEvent(
  e: Pick<ScoreEvent, "stats">,
): { homeGoals: number; awayGoals: number } | null {
  const home =
    readStat(e.stats, StatBase.P1_GOALS, 100) ??
    readStat(e.stats, StatBase.P1_GOALS, Period.FULL);
  const away =
    readStat(e.stats, StatBase.P2_GOALS, 100) ??
    readStat(e.stats, StatBase.P2_GOALS, Period.FULL);
  if (home === undefined || away === undefined) return null;
  return { homeGoals: home, awayGoals: away };
}

export interface Resolve1x2Options {
  /** The FINAL score (keeper knows it) — used to pick the hint deterministically. */
  score: { homeGoals: number; awayGoals: number };
  /** Stat-validation query identifying the P1/P2 goals stats to prove. */
  statQuery: StatValidationQuery;
  /** Max attempts before giving up on RootNotAvailable. */
  maxAttempts?: number;
  /** Base backoff (ms) for the RootNotAvailable retry loop. */
  backoffMs?: number;
  /** Max proof refetches after a terminal/rejected proof snapshot. */
  maxProofRefetches?: number;
}

/**
 * resolve_1x2: Locked -> Resolved for a 3-way (1X2) market.
 *
 * The keeper KNOWS the final score, so it computes the correct outcome hint
 * (`Team1`/`Draw`/`Team2`) and passes it — the program derives the predicate
 * and does ONE `validate_stat` CPI. A correct hint proves positively.
 *
 * Ladder:
 *   1. try the score-derived hint (the expected happy path);
 *   2. TxLINE 6007 RootNotAvailable at any rung -> linear backoff, retry;
 *   3. terminal TxLINE proof errors (6004/6021/6023/6062) -> refetch the proof
 *      within budget, else alert + throw;
 *   4. our ProofRejected (6017) — the CPI said the derived predicate is false.
 *      This should NOT happen (the keeper has the score), but defensively we
 *      try the OTHER two hints in trichotomy order before giving up: a mismatch
 *      between our score view and the on-chain proof is worth surviving rather
 *      than stranding the market. If all three reject, refetch (batch maybe not
 *      final) within budget, else alert + throw.
 *
 * Idempotent: no-ops if already Resolved/Closed; treats InvalidMarketState
 * after a concurrent resolve as success.
 */
export async function resolveMarket1x2(
  ctx: ActionContext,
  fixtureId: bigint,
  opts: Resolve1x2Options,
  proofFetcher: ProofFetcher,
): Promise<string | null> {
  const [market] = await findMarket1x2Pda(fixtureId);
  const fixture = fixtureId.toString();

  const onChain = await readMarket1x2(ctx, market);
  if (!onChain) {
    log.warn({ fixtureId: fixture, market }, "resolve_1x2: market account not found, skipping");
    return null;
  }
  if (onChain.state === MarketState.Resolved || onChain.state === MarketState.Closed) {
    log.info(
      { fixtureId: fixture, state: marketStateName(onChain.state) },
      "resolve_1x2: already resolved, skipping",
    );
    return null;
  }
  const marketConfig = onChain.config;

  const maxAttempts = opts.maxAttempts ?? 20;
  const baseBackoff = opts.backoffMs ?? 15_000;
  const maxProofRefetches = opts.maxProofRefetches ?? 3;

  // Preferred hint from the score, then the other two (defensive fallback).
  const preferred = outcomeHintFromScore(
    opts.score.homeGoals,
    opts.score.awayGoals,
  );
  const hintLadder = orderedHints(preferred);
  log.info(
    {
      fixtureId: fixture,
      score: `${opts.score.homeGoals}-${opts.score.awayGoals}`,
      hint: hintName(preferred),
    },
    "resolve_1x2: score-derived hint",
  );

  let proof: ResolveProofArgs | undefined;
  let proofRefetches = 0;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (!proof) {
      proof = await proofFetcher.fetch(opts.statQuery);
    }

    let allRejected = true;
    let lastRejection: DiscriminatedTxError | undefined;

    for (const hint of hintLadder) {
      const res = await tryHint(ctx, fixtureId, market, marketConfig, proof, hint);
      if (res.sig !== undefined) return res.sig;
      const d = res.error;

      // Transient root-not-posted-yet: back off and retry the whole attempt.
      if (d.txlineCode === TXLINE_ERR.RootNotAvailable) {
        await backoff(fixture, attempt, baseBackoff, "RootNotAvailable (6007) — root not posted yet");
        allRejected = false;
        break;
      }

      // Concurrent resolve — re-read and treat as success if already resolved.
      if (d.ourError?.code === AMM_ERROR__INVALID_MARKET_STATE) {
        const now = await readMarket1x2(ctx, market);
        if (now && (now.state === MarketState.Resolved || now.state === MarketState.Closed)) {
          log.info({ fixtureId: fixture }, "resolve_1x2: resolved concurrently, treating as success");
          return null;
        }
        alertTerminal(fixture, d, "InvalidMarketState but market not resolved (not Locked yet?)");
        throw asError(d.raw);
      }

      // Terminal Merkle-proof rejection (bad proof payload) — refetch within budget.
      if (isTerminalTxlineCode(d.txlineCode)) {
        if (proofRefetches < maxProofRefetches) {
          proofRefetches += 1;
          proof = undefined;
          await backoff(
            fixture,
            attempt,
            baseBackoff,
            `terminal TxLINE ${txlineErrorName(d.txlineCode ?? -1)} — refetching proof (${proofRefetches}/${maxProofRefetches})`,
          );
          allRejected = false;
          break;
        }
        alertTerminal(fixture, d, "terminal TxLINE proof error after refetch budget");
        throw asError(d.raw);
      }

      // Our ProofRejected (6017): this hint's derived predicate is false on the
      // oracle. Keep this rejection and try the next hint in the ladder.
      if (d.ourError?.code === AMM_ERROR__PROOF_REJECTED) {
        lastRejection = d;
        continue;
      }

      // Other retryable transport/too-early error — back off, retry attempt.
      if (d.retryable) {
        await backoff(fixture, attempt, baseBackoff, describeError(d));
        allRejected = false;
        break;
      }

      // Anything else is a genuine terminal error.
      alertTerminal(fixture, d, `unexpected terminal error on hint=${hintName(hint)}`);
      throw asError(d.raw);
    }

    // If we broke out (root/refetch/retry), loop to the next attempt.
    if (!allRejected) continue;

    // All three hints rejected under this proof snapshot -> the batch was
    // likely not final (or the proof is inconsistent). Refetch within budget.
    if (proofRefetches < maxProofRefetches) {
      proofRefetches += 1;
      proof = undefined;
      await backoff(
        fixture,
        attempt,
        baseBackoff,
        `all 3 hints rejected — refetching proof (${proofRefetches}/${maxProofRefetches})`,
      );
      continue;
    }
    alertTerminal(
      fixture,
      lastRejection ?? { retryable: false, raw: undefined },
      "all 3 outcome hints rejected after refetch budget (score vs proof mismatch?)",
    );
    throw asError(lastRejection?.raw);
  }

  log.error(
    { fixtureId: fixture, maxAttempts },
    "resolve_1x2: gave up after max attempts (root never posted?)",
  );
  return null;
}

/** Order the three hints so the score-derived one is tried FIRST. */
function orderedHints(preferred: Outcome1x2Hint): Outcome1x2Hint[] {
  const all = [Outcome1x2Hint.Team1, Outcome1x2Hint.Draw, Outcome1x2Hint.Team2];
  return [preferred, ...all.filter((h) => h !== preferred)];
}

/** One rung of the ladder: build + simulate + send with a given hint. */
async function tryHint(
  ctx: ActionContext,
  fixtureId: bigint,
  market: Address,
  marketConfig: Address,
  proof: ResolveProofArgs,
  hint: Outcome1x2Hint,
): Promise<{ sig?: string; error: DiscriminatedTxError }> {
  const fixture = fixtureId.toString();
  try {
    const ix = await buildResolve1x2Instruction(ctx, fixtureId, market, marketConfig, proof, hint);
    const sig = await ctx.txSender.sendAndConfirm({
      instructions: [ix],
      writableAccounts: [market],
    });
    log.info({ fixtureId: fixture, sig, hint: hintName(hint) }, "resolve_1x2 landed");
    return { sig, error: { retryable: false, raw: undefined } };
  } catch (err) {
    const d = discriminateTxError(err);
    log.warn(
      {
        fixtureId: fixture,
        hint: hintName(hint),
        ourError: d.ourError,
        txlineCode: d.txlineCode,
        unknownCode: d.unknownCode,
        retryable: d.retryable,
      },
      "resolve_1x2 attempt failed",
    );
    return { error: d };
  }
}

/**
 * Build `resolve_1x2` via the generated getResolve1x2InstructionAsync.
 * Accounts mirror the binary `resolve`: keeper signer, global (auto-derived),
 * market1x2 PDA, marketConfig (from the decoded Market1x2.config), txlineProgram
 * (CPI callee), daily_scores_merkle_roots PDA for epoch_day = ts / 86_400_000.
 * Args: hint byte + the validate_stat forwarding set. The per-hint predicate is
 * derived ON-CHAIN (D-8) — the keeper passes only the hint.
 */
async function buildResolve1x2Instruction(
  ctx: ActionContext,
  fixtureId: bigint,
  market: Address,
  marketConfig: Address,
  proof: ResolveProofArgs,
  hint: Outcome1x2Hint,
): Promise<Instruction> {
  const txlineProgram = TXLINE[ctx.config.cluster].txlineProgram;
  const epochDay = proof.epochDay || Number(proof.ts / 86_400_000n);
  const [dailyScoresMerkleRoots] = await getProgramDerivedAddress({
    programAddress: txlineProgram,
    seeds: [DAILY_SCORES_ROOTS_SEED, getU16Encoder().encode(epochDay)],
  });

  return getResolve1x2InstructionAsync({
    keeper: ctx.signer,
    market,
    marketConfig,
    txlineProgram,
    dailyScoresMerkleRoots,
    hint,
    ts: proof.ts, // MILLISECONDS (epoch_day = ts / 86_400_000 on-chain)
    fixtureSummary: {
      fixtureId,
      updateStats: proof.fixtureSummary.updateStats,
      eventsSubTreeRoot: proof.fixtureSummary.eventsSubTreeRoot,
    },
    fixtureProof: proof.fixtureProof,
    mainTreeProof: proof.mainTreeProof,
    statA: proof.statA,
    statB: proof.statB ?? null,
    op: proof.op !== undefined ? BinaryExpression[proof.op] : null,
  });
}

/** Fetch + decode the on-chain Market1x2 account (or null if absent). */
async function readMarket1x2(
  ctx: ActionContext,
  market: Address,
): Promise<{ state: MarketState; config: Address } | null> {
  const maybe = await fetchMaybeMarket1x2(ctx.clients.rpc, market);
  if (!maybe.exists) return null;
  return { state: maybe.data.state, config: maybe.data.config };
}

function describeError(d: DiscriminatedTxError): string {
  if (d.ourError) return `amm ${d.ourError.code}: ${d.ourError.message}`;
  if (d.txlineCode !== undefined)
    return `txline ${d.txlineCode} ${txlineErrorName(d.txlineCode)}`;
  if (d.unknownCode !== undefined) return `unattributed custom ${d.unknownCode}`;
  return "transport error";
}

/** Distinct, alert-level logging for errors that need human eyes. */
function alertTerminal(
  fixtureId: string,
  d: DiscriminatedTxError,
  reason: string,
): void {
  log.fatal(
    {
      alert: true,
      fixtureId,
      reason,
      ourError: d.ourError,
      txlineCode: d.txlineCode,
      txlineName: d.txlineCode !== undefined ? txlineErrorName(d.txlineCode) : undefined,
      unknownCode: d.unknownCode,
      logsTail: d.logs?.slice(-6),
    },
    "resolve_1x2: TERMINAL — manual intervention required",
  );
}

function asError(raw: unknown): Error {
  return raw instanceof Error ? raw : new Error(JSON.stringify(raw));
}

function backoff(
  fixtureId: string,
  attempt: number,
  baseMs: number,
  why: string,
): Promise<void> {
  const wait = baseMs * Math.min(attempt, 8);
  log.warn({ fixtureId, attempt, wait, why }, "resolve_1x2: retrying after backoff");
  return sleep(wait);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

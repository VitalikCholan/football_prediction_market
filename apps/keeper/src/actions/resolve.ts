import {
  getProgramDerivedAddress,
  getU16Encoder,
  type Address,
  type Instruction,
} from "@solana/kit";
import {
  AMM_ERROR__INVALID_MARKET_STATE,
  AMM_ERROR__PREDICATE_NOT_NEGATABLE,
  AMM_ERROR__PROOF_REJECTED,
  BinaryExpression,
  MarketState,
  Side,
  getResolveInstructionAsync,
} from "@fpm/idl";
import { DAILY_SCORES_ROOTS_SEED, TXLINE, findMarketPda } from "@fpm/shared";
import { log } from "../log.ts";
import {
  discriminateTxError,
  isTerminalTxlineCode,
  txlineErrorName,
  TXLINE_ERR,
  type DiscriminatedTxError,
} from "../solana/errors.ts";
import type { ProofFetcher, StatValidationQuery } from "../txline/proof.ts";
import type { ResolveProofArgs } from "../txline/types.ts";
import { marketStateName, readMarket, type ActionContext } from "./context.ts";

export { TXLINE_ERR } from "../solana/errors.ts";

export interface ResolveOptions {
  /** Stat-validation query identifying which stat(s) prove this market. */
  statQuery: StatValidationQuery;
  /** Max attempts before giving up on RootNotAvailable. */
  maxAttempts?: number;
  /** Base backoff (ms) for the RootNotAvailable retry loop. */
  backoffMs?: number;
  /** Max proof refetches after both hints (or a terminal code) reject one. */
  maxProofRefetches?: number;
}

/**
 * resolve: Locked -> Resolved.
 *
 * Fetches the stat-validation proof from TxLINE, builds `resolve` (our program
 * CPIs validate_stat), simulates, then sends via TxSender.
 *
 * Outcome-hint ladder (D-8 semantics — hint Yes validates the STORED
 * predicate, hint No validates its sound negation):
 *   1. try outcomeHint = Yes;
 *   2. on OUR ProofRejected (6017: oracle returned false) retry hint = No;
 *   3. if BOTH hints are rejected the proof snapshot is stale/inconsistent ->
 *      refetch the proof (bounded by maxProofRefetches) and restart the ladder;
 *   4. TxLINE 6007 RootNotAvailable (root posts every 5-min batch) at any rung
 *      -> linear backoff and retry the whole attempt;
 *   5. terminal TxLINE proof errors (6004/6021/6023/6062) -> refetch once
 *      within budget, else alert-level log + throw.
 *
 * Idempotent: no-ops if the market is already Resolved/Closed, and treats
 * InvalidMarketState after a concurrent resolve as success.
 */
export async function resolveMarket(
  ctx: ActionContext,
  fixtureId: bigint,
  opts: ResolveOptions,
  proofFetcher: ProofFetcher,
): Promise<string | null> {
  const [market] = await findMarketPda(fixtureId);
  const fixture = fixtureId.toString();

  const onChain = await readMarket(ctx, market);
  if (!onChain) {
    log.warn({ fixtureId: fixture, market }, "resolve: market account not found, skipping");
    return null;
  }
  if (onChain.state === MarketState.Resolved || onChain.state === MarketState.Closed) {
    log.info(
      { fixtureId: fixture, state: marketStateName(onChain.state) },
      "resolve: already resolved, skipping",
    );
    return null;
  }
  const marketConfig = onChain.config;

  const maxAttempts = opts.maxAttempts ?? 20;
  const baseBackoff = opts.backoffMs ?? 15_000;
  const maxProofRefetches = opts.maxProofRefetches ?? 3;

  let proof: ResolveProofArgs | undefined;
  let proofRefetches = 0;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (!proof) {
      proof = await proofFetcher.fetch(opts.statQuery);
    }

    // ---- rung 1: hint = Yes (validate the stored predicate) ----
    const yes = await tryHint(ctx, fixtureId, market, marketConfig, proof, Side.Yes);
    if (yes.sig !== undefined) return yes.sig;
    const dYes = yes.error;

    if (dYes.txlineCode === TXLINE_ERR.RootNotAvailable) {
      await backoff(fixture, attempt, baseBackoff, "RootNotAvailable (6007) — root not posted yet");
      continue;
    }

    if (dYes.ourError?.code === AMM_ERROR__PROOF_REJECTED) {
      // ---- rung 2: oracle said "predicate false" -> try the negation ----
      const no = await tryHint(ctx, fixtureId, market, marketConfig, proof, Side.No);
      if (no.sig !== undefined) return no.sig;
      const dNo = no.error;

      if (dNo.txlineCode === TXLINE_ERR.RootNotAvailable) {
        await backoff(fixture, attempt, baseBackoff, "RootNotAvailable (6007) on hint=No");
        continue;
      }
      if (dNo.ourError?.code === AMM_ERROR__PREDICATE_NOT_NEGATABLE) {
        // EqualTo predicates cannot prove the NO side by negation — no amount
        // of retrying fixes this. Alert: needs a market-authoring fix.
        alertTerminal(fixture, dNo, "predicate not negatable (EqualTo) — NO side unprovable");
        throw asError(dNo.raw);
      }
      if (
        dNo.ourError?.code === AMM_ERROR__PROOF_REJECTED ||
        isTerminalTxlineCode(dNo.txlineCode)
      ) {
        // Both hints rejected with this proof snapshot -> the batch was likely
        // not final (or the proof is inconsistent). Refetch within budget.
        if (proofRefetches < maxProofRefetches) {
          proofRefetches += 1;
          proof = undefined;
          await backoff(
            fixture,
            attempt,
            baseBackoff,
            `both hints rejected — refetching proof (${proofRefetches}/${maxProofRefetches})`,
          );
          continue;
        }
        alertTerminal(fixture, dNo, "proof rejected under BOTH hints after refetch budget");
        throw asError(dNo.raw);
      }
      if (dNo.retryable) {
        await backoff(fixture, attempt, baseBackoff, describeError(dNo));
        continue;
      }
      alertTerminal(fixture, dNo, "unexpected terminal error on hint=No");
      throw asError(dNo.raw);
    }

    if (isTerminalTxlineCode(dYes.txlineCode)) {
      // Merkle-proof-level rejection (not a predicate outcome): the proof
      // payload itself is bad -> refetch within budget, else alert.
      if (proofRefetches < maxProofRefetches) {
        proofRefetches += 1;
        proof = undefined;
        await backoff(
          fixture,
          attempt,
          baseBackoff,
          `terminal TxLINE ${txlineErrorName(dYes.txlineCode ?? -1)} — refetching proof (${proofRefetches}/${maxProofRefetches})`,
        );
        continue;
      }
      alertTerminal(fixture, dYes, "terminal TxLINE proof error after refetch budget");
      throw asError(dYes.raw);
    }

    if (dYes.ourError?.code === AMM_ERROR__INVALID_MARKET_STATE) {
      // Someone else may have resolved concurrently — re-read and no-op.
      const now = await readMarket(ctx, market);
      if (now && (now.state === MarketState.Resolved || now.state === MarketState.Closed)) {
        log.info({ fixtureId: fixture }, "resolve: resolved concurrently, treating as success");
        return null;
      }
      alertTerminal(fixture, dYes, "InvalidMarketState but market not resolved (not Locked yet?)");
      throw asError(dYes.raw);
    }

    if (dYes.retryable) {
      await backoff(fixture, attempt, baseBackoff, describeError(dYes));
      continue;
    }

    alertTerminal(fixture, dYes, "unexpected terminal error on hint=Yes");
    throw asError(dYes.raw);
  }

  log.error(
    { fixtureId: fixture, maxAttempts },
    "resolve: gave up after max attempts (root never posted?)",
  );
  return null;
}

/** One rung of the ladder: build + simulate + send with a given outcome hint. */
async function tryHint(
  ctx: ActionContext,
  fixtureId: bigint,
  market: Address,
  marketConfig: Address,
  proof: ResolveProofArgs,
  hint: Side,
): Promise<{ sig?: string; error: DiscriminatedTxError }> {
  const fixture = fixtureId.toString();
  try {
    const ix = await buildResolveInstruction(ctx, fixtureId, market, marketConfig, proof, hint);
    const sig = await ctx.txSender.sendAndConfirm({
      instructions: [ix],
      writableAccounts: [market],
    });
    log.info({ fixtureId: fixture, sig, hint: Side[hint] }, "resolve landed");
    return { sig, error: { retryable: false, raw: undefined } };
  } catch (err) {
    const d = discriminateTxError(err);
    log.warn(
      {
        fixtureId: fixture,
        hint: Side[hint],
        ourError: d.ourError,
        txlineCode: d.txlineCode,
        unknownCode: d.unknownCode,
        retryable: d.retryable,
      },
      "resolve attempt failed",
    );
    return { error: d };
  }
}

/**
 * Build `resolve` via the generated getResolveInstructionAsync:
 *  - accounts: keeper signer, global (auto-derived), market PDA, marketConfig
 *    (from the decoded Market.config), txlineProgram (CPI callee, per-cluster
 *    constant), daily_scores_merkle_roots PDA derived under the TXLINE program
 *    for epoch_day = ts / 86_400_000 (TxLINE `ts` is MILLISECONDS);
 *  - args: outcomeHint + the validate_stat forwarding set from the TxLINE
 *    stat-validation proof. The predicate itself lives on-chain in
 *    MarketConfig and is NOT passed here (D-8).
 */
async function buildResolveInstruction(
  ctx: ActionContext,
  fixtureId: bigint,
  market: Address,
  marketConfig: Address,
  proof: ResolveProofArgs,
  outcomeHint: Side,
): Promise<Instruction> {
  const txlineProgram = TXLINE[ctx.config.cluster].txlineProgram;
  const epochDay = proof.epochDay || Number(proof.ts / 86_400_000n);
  const [dailyScoresMerkleRoots] = await getProgramDerivedAddress({
    programAddress: txlineProgram,
    seeds: [DAILY_SCORES_ROOTS_SEED, getU16Encoder().encode(epochDay)],
  });

  return getResolveInstructionAsync({
    keeper: ctx.signer,
    market,
    marketConfig,
    txlineProgram,
    dailyScoresMerkleRoots,
    outcomeHint,
    ts: proof.ts, // MILLISECONDS (epoch_day = ts / 86_400_000 on-chain)
    // fixtureSummary became a nested struct once ScoresBatchSummary stopped
    // being single-use (resolve_1x2 reuses it) — same wire bytes.
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
    "resolve: TERMINAL — manual intervention required",
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
  log.warn({ fixtureId, attempt, wait, why }, "resolve: retrying after backoff");
  return sleep(wait);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

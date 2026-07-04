import type { Instruction } from "@solana/kit";
import { findMarketPda, TXLINE, DAILY_SCORES_ROOTS_SEED } from "@fpm/shared";
import { log } from "../log.ts";
import type { ProofFetcher, StatValidationQuery } from "../txline/proof.ts";
import type { ResolveProofArgs } from "../txline/types.ts";
import { readMarketState, type ActionContext } from "./context.ts";

/**
 * TxLINE proof-error codes surfaced during resolve (backend-plan §2.8).
 *   6007 RootNotAvailable  -> TRANSIENT: root not posted yet -> retry
 *   6021 PredicateFailed   -> terminal (predicate evaluated false)
 *   6023 InvalidStatProof   -> terminal
 *   6004 InvalidMainTreeProof -> terminal
 *   6062 ProofTooLarge      -> terminal
 */
export const TXLINE_ERR = {
  RootNotAvailable: 6007,
  PredicateFailed: 6021,
  InvalidStatProof: 6023,
  InvalidMainTreeProof: 6004,
  ProofTooLarge: 6062,
} as const;

export interface ResolveOptions {
  /** Stat-validation query identifying which stat(s) prove this market. */
  statQuery: StatValidationQuery;
  /** Max attempts before giving up on RootNotAvailable. */
  maxAttempts?: number;
  /** Base backoff (ms) for the RootNotAvailable retry loop. */
  backoffMs?: number;
}

/**
 * resolve: Locked -> Resolved.
 *
 * Fetches the stat-validation proof, builds `resolve` (our program CPIs
 * validate_stat), simulates, then sends via TxSender. Retries on the transient
 * RootNotAvailable (6007) until the oracle posts the epoch-day Merkle root.
 * Idempotent: no-ops if the market is already Resolved.
 */
export async function resolveMarket(
  ctx: ActionContext,
  fixtureId: bigint,
  opts: ResolveOptions,
  proofFetcher: ProofFetcher,
): Promise<string | null> {
  const [market] = await findMarketPda(fixtureId);
  const state = await readMarketState(ctx, market);
  if (state === "Resolved" || state === "Closed") {
    log.info({ fixtureId: fixtureId.toString(), state }, "resolve: already resolved, skipping");
    return null;
  }

  const maxAttempts = opts.maxAttempts ?? 20;
  const baseBackoff = opts.backoffMs ?? 15_000;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const proof = await proofFetcher.fetch(opts.statQuery);
      const instructions = buildResolveInstructions(ctx, fixtureId, proof);
      const sig = await ctx.txSender.sendAndConfirm({
        instructions,
        writableAccounts: [market],
      });
      log.info({ fixtureId: fixtureId.toString(), sig }, "resolve landed");
      return sig;
    } catch (err) {
      const code = extractCustomErrorCode(err);
      if (code === TXLINE_ERR.RootNotAvailable) {
        const wait = baseBackoff * Math.min(attempt, 8);
        log.warn(
          { fixtureId: fixtureId.toString(), attempt, wait },
          "resolve: RootNotAvailable (6007) — root not posted yet, retrying",
        );
        await sleep(wait);
        continue;
      }
      // Terminal proof errors: log distinctly and stop.
      logTerminalProofError(fixtureId, code, err);
      throw err;
    }
  }
  log.error(
    { fixtureId: fixtureId.toString(), maxAttempts },
    "resolve: gave up waiting for RootNotAvailable",
  );
  return null;
}

/**
 * TODO(program-team IDL): build via getResolveInstruction(...) from `@fpm/idl`.
 * Accounts: market, marketConfig, escrowVault, globalConfig, keeper signer,
 * txlineProgram (CPI target), dailyScoresMerkleRoots (read-only PDA
 * ["daily_scores_roots", epoch_day u16 LE]). Args forwarded to validate_stat:
 * ts, fixtureSummary, fixtureProof, mainTreeProof, statA, statB?, op?.
 * The predicate lives on-chain in MarketConfig and is NOT passed here.
 *
 * Returns [] until the instruction exists so the pipeline typechecks. The proof
 * args + txline constants are referenced so the wiring point is explicit.
 */
function buildResolveInstructions(
  ctx: ActionContext,
  _fixtureId: bigint,
  proof: ResolveProofArgs,
): Instruction[] {
  const txlineProgram = TXLINE[ctx.config.cluster].txlineProgram;
  void txlineProgram; // CPI target — passed once the ix builder exists
  void DAILY_SCORES_ROOTS_SEED; // seed for the daily_scores_roots PDA
  void proof; // ts / summary / proofs / statA / statB / op forwarded to validate_stat
  return [];
}

/** Extract the numeric custom-program error code from a Kit/RPC error. */
function extractCustomErrorCode(err: unknown): number | undefined {
  const s = JSON.stringify(err ?? {});
  const m = s.match(/"Custom"\s*:\s*(\d+)/) ?? s.match(/custom program error:\s*0x([0-9a-fA-F]+)/);
  if (!m) return undefined;
  return m[0].includes("0x") ? parseInt(m[1], 16) : Number(m[1]);
}

function logTerminalProofError(
  fixtureId: bigint,
  code: number | undefined,
  err: unknown,
): void {
  const name =
    (Object.entries(TXLINE_ERR).find(([, v]) => v === code)?.[0]) ??
    "Unknown";
  log.error(
    { fixtureId: fixtureId.toString(), code, name, err },
    "resolve: terminal proof error",
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

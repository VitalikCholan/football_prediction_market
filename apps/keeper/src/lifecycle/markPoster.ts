/**
 * MarkPoster — periodic post_mark crank for the v1 leverage layer.
 *
 * Every scheduler tick, for each fixture whose Market is Trading AND has a
 * LeveragePool PDA, posts fresh marks `[Team1, Draw, Team2]` (bps) via
 * `post_mark` (keeper-gated on-chain; each mark must be 1..=9999). Posting is
 * rate-limited off-chain to the config's `funding_epoch_secs` (the on-chain
 * funding index accrues per posted segment, so posting faster just wastes fees).
 *
 * Mark source (leverage-v1.md §6):
 *   1. TxLINE StablePrice 1X2 odds snapshot (demargined implied probabilities),
 *      when the feed has a quote;
 *   2. FALLBACK — the on-chain LMSR spot prices `softmax(q_i / b)` (the NORMAL
 *      devnet case: the WC odds feed returns `[]`). Display-grade float math is
 *      fine here; the on-chain program only requires marks in 1..=9999.
 *
 * Contract (mirrors Scheduler/MarketSeeder): start() schedules a never-throw
 * tick loop at `schedulerTickMs`; stop() clears the timer. Each tick is
 *   - idempotent  — skips pools posted within funding_epoch_secs (re-reads
 *                   pool.markTs on-chain, so a restart self-heals);
 *   - never-throw — one bad fixture (RPC read, odds HTTP, build, send) logs
 *                   and continues; DRY_RUN is inherited from KitTxSender.
 */
import {
  MarketState,
  fetchMaybeLeveragePool,
  fetchMaybeMarketConfig,
  getPostMarkInstructionAsync,
  type Market,
  type MarketConfig,
} from "@fpm/idl";
import type { Address } from "@solana/kit";
import { BPS_DENOM, findLevPoolPda, findMarketPda } from "@fpm/shared";
import { log } from "../log.ts";
import { marketStateName, readMarket, type ActionContext } from "../actions/context.ts";
import type { FixtureSource } from "../txline/fixtures.ts";
import type { TxlineAuth } from "../txline/auth.ts";
import { fetchImplied1x2 } from "../txline/odds.ts";

/** Marks must be strictly inside (0, BPS): clamp to 1..=9998 per the plan. */
const MARK_MIN = 1;
const MARK_MAX = BPS_DENOM - 2; // 9_998

/**
 * Normalize three probability weights to bps summing <= 10_000: floor each,
 * clamp to 1..=9998, then adjust the last so the total lands on BPS_DENOM
 * (re-clamped — the program only enforces each mark in 1..=9999, not the sum).
 */
export function probsToMarksBps(probs: [number, number, number]): [number, number, number] {
  const sum = probs[0] + probs[1] + probs[2];
  if (!(sum > 0) || !probs.every((p) => Number.isFinite(p) && p >= 0)) {
    throw new Error(`cannot normalize probabilities [${probs.join(",")}]`);
  }
  const clamp = (n: number) => Math.min(MARK_MAX, Math.max(MARK_MIN, n));
  const a = clamp(Math.floor((probs[0] / sum) * BPS_DENOM));
  const b = clamp(Math.floor((probs[1] / sum) * BPS_DENOM));
  const c = clamp(BPS_DENOM - a - b);
  return [a, b, c];
}

/**
 * On-chain LMSR spot prices from Market.q / Market.b: shifted softmax
 * `exp((q_i - max q)/b)` normalized. Float math — display/mark-grade, mirrors
 * the indexer's lmsr-price port in spirit without importing across apps.
 */
export function spotProbsFromMarket(market: Market): [number, number, number] {
  const b = Number(market.b);
  if (!(b > 0)) throw new Error(`market.b must be > 0, got ${market.b}`);
  const q = market.q.map(Number);
  const maxQ = Math.max(...q);
  const exps = q.map((qi) => Math.exp((qi - maxQ) / b));
  const sum = exps[0] + exps[1] + exps[2];
  return [exps[0] / sum, exps[1] / sum, exps[2] / sum];
}

export class MarkPoster {
  private readonly ctx: ActionContext;
  private readonly fixtures: FixtureSource;
  private readonly auth: TxlineAuth;
  /** MarketConfig cache — configs are immutable once created. */
  private readonly configCache = new Map<Address, MarketConfig>();
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(ctx: ActionContext, fixtures: FixtureSource, auth: TxlineAuth) {
    this.ctx = ctx;
    this.fixtures = fixtures;
    this.auth = auth;
  }

  /** Schedule the never-throw tick loop (piggybacks the scheduler cadence). */
  start(): void {
    const tick = () =>
      void this.tick().catch((err) => log.error({ err }, "mark-poster tick failed"));
    tick();
    this.timer = setInterval(tick, this.ctx.config.schedulerTickMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async tick(): Promise<void> {
    if (this.running) return; // previous tick still in flight (RPC slowness)
    this.running = true;
    try {
      const fixtures = await this.fixtures.list();
      for (const f of fixtures) {
        try {
          await this.postForFixture(f.fixtureId);
        } catch (err) {
          // One bad market must not kill the loop; next tick retries.
          log.warn(
            { fixtureId: f.fixtureId.toString(), err },
            "mark-poster: post failed for fixture — continuing",
          );
        }
      }
    } finally {
      this.running = false;
    }
  }

  /** Post a mark for one fixture if its market is Trading, has a pool, and is due. */
  private async postForFixture(fixtureId: bigint): Promise<void> {
    const [marketPda] = await findMarketPda(fixtureId);
    const market = await readMarket(this.ctx, marketPda);
    if (!market) return; // no market on-chain for this fixture
    if (market.state !== MarketState.Trading) {
      log.debug(
        { fixtureId: fixtureId.toString(), state: marketStateName(market.state) },
        "mark-poster: market not Trading — skip",
      );
      return;
    }

    const [poolPda] = await findLevPoolPda(marketPda);
    const pool = await fetchMaybeLeveragePool(this.ctx.clients.rpc, poolPda);
    if (!pool.exists) return; // leverage not initialized for this market

    const config = await this.readConfig(market.config);
    if (!config || config.maxLeverage === 0) return; // leverage disabled

    // Rate limit: don't spam within a funding epoch (markTs = 0 -> first post).
    const now = Math.floor(Date.now() / 1000);
    const lastPostTs = Number(pool.data.markTs);
    if (lastPostTs > 0 && now - lastPostTs < config.fundingEpochSecs) return;

    // Marks: TxLINE 1X2 odds snapshot, else on-chain LMSR spot (devnet norm).
    const implied = await fetchImplied1x2(this.ctx.config, this.auth, fixtureId);
    const source = implied ? "odds" : "spot";
    const marks = probsToMarksBps(implied ?? spotProbsFromMarket(market));

    const ix = await getPostMarkInstructionAsync({
      keeper: this.ctx.signer,
      market: marketPda,
      marketConfig: market.config,
      pool: poolPda,
      marks,
    });
    const sig = await this.ctx.txSender.sendAndConfirm({
      instructions: [ix],
      writableAccounts: [poolPda],
    });
    log.info(
      { fixtureId: fixtureId.toString(), marks, source, signature: sig },
      "mark-poster: post_mark sent",
    );
  }

  /** Fetch + memoize the MarketConfig for a market (immutable after creation). */
  private async readConfig(configPda: Address): Promise<MarketConfig | null> {
    const cached = this.configCache.get(configPda);
    if (cached) return cached;
    const maybe = await fetchMaybeMarketConfig(this.ctx.clients.rpc, configPda);
    if (!maybe.exists) {
      log.warn({ configPda }, "mark-poster: MarketConfig not found — skip");
      return null;
    }
    this.configCache.set(configPda, maybe.data);
    return maybe.data;
  }
}

import { activateMarket } from "../actions/activate.ts";
import { freezeMarket } from "../actions/freeze.ts";
import { resolveMarket } from "../actions/resolve.ts";
import type { ActionContext } from "../actions/context.ts";
import { log } from "../log.ts";
import type { ProofFetcher, StatValidationQuery } from "../txline/proof.ts";
import type { FixtureSource } from "../txline/fixtures.ts";
import type { HistoryClient } from "../txline/history.ts";
import { statKey, Period, StatBase } from "../txline/scoreStream.ts";
import type { LifecycleStateMachine } from "./stateMachine.ts";

/**
 * setInterval crank (backend-plan §2.3). Each tick reconciles the fixture
 * schedule against wall-time and fires activate/freeze at the boundaries. Every
 * action is idempotent (re-reads on-chain state), so a missed tick or a restart
 * self-heals. Match-end resolve is triggered both here (via end-time fallback)
 * and by the SSE `ended` event (wired in index.ts).
 */
export class Scheduler {
  private readonly ctx: ActionContext;
  private readonly fixtures: FixtureSource;
  private readonly fsm: LifecycleStateMachine;
  private readonly proofFetcher: ProofFetcher;
  private readonly history: HistoryClient;
  private timer?: NodeJS.Timeout;

  constructor(
    ctx: ActionContext,
    fixtures: FixtureSource,
    fsm: LifecycleStateMachine,
    proofFetcher: ProofFetcher,
    history: HistoryClient,
  ) {
    this.ctx = ctx;
    this.fixtures = fixtures;
    this.fsm = fsm;
    this.proofFetcher = proofFetcher;
    this.history = history;
  }

  start(): void {
    const tick = () => void this.tick().catch((err) => log.error({ err }, "scheduler tick failed"));
    tick();
    this.timer = setInterval(tick, this.ctx.config.schedulerTickMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async tick(): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    const fixtures = await this.fixtures.list();

    for (const f of fixtures) {
      const tracker = this.fsm.get(f.fixtureId);

      // Kickoff -> activate.
      if (tracker.phase === "Scheduled" && now >= f.kickoffTs) {
        log.info({ fixtureId: f.fixtureId.toString() }, "scheduler: kickoff -> activate");
        await activateMarket(this.ctx, f.fixtureId);
        this.fsm.markLive(f.fixtureId);
      }

      // Expected end (fallback for a missed SSE frame) -> freeze.
      if (tracker.phase === "Live" && now >= f.expectedEndTs) {
        log.info({ fixtureId: f.fixtureId.toString() }, "scheduler: end-time -> freeze (fallback)");
        await freezeMarket(this.ctx, f.fixtureId);
        this.fsm.markEnded(f.fixtureId);
      }

      // Frozen and end-time passed -> attempt resolve (retries on RootNotAvailable).
      if (tracker.phase === "Ended" && now >= f.expectedEndTs) {
        await this.tryResolve(f.fixtureId);
      }
    }
  }

  /**
   * Trigger the resolve pipeline for a fixture (safe to call repeatedly).
   * `seq` (the Seq of the finalising score event) is REQUIRED by
   * stat-validation; when the end came from the end-time fallback (no SSE
   * frame seen) it is recovered from the historical replay.
   */
  async tryResolve(fixtureId: bigint, seq?: number): Promise<void> {
    const tracker = this.fsm.get(fixtureId);
    if (tracker.phase === "Resolved") return;
    this.fsm.incrementResolveAttempts(fixtureId);
    try {
      const endSeq = seq ?? tracker.endedSeq ?? (await this.recoverEndSeq(fixtureId));
      if (endSeq === undefined) {
        log.warn(
          { fixtureId: fixtureId.toString() },
          "resolve deferred: no finalising Seq yet (match not finalised in historical)",
        );
        return; // next tick / SSE frame retries
      }
      this.fsm.markEnded(fixtureId, endSeq);
      const sig = await resolveMarket(
        this.ctx,
        fixtureId,
        { statQuery: defaultStatQuery(fixtureId, endSeq) },
        this.proofFetcher,
      );
      if (sig !== null) this.fsm.markResolved(fixtureId);
    } catch (err) {
      log.error({ fixtureId: fixtureId.toString(), err }, "resolve failed");
      this.fsm.markFailed(fixtureId);
    }
  }

  /** End-time-fallback path: recover the finalising Seq from the replay. */
  private async recoverEndSeq(fixtureId: bigint): Promise<number | undefined> {
    const end = await this.history.findMatchEnd(fixtureId);
    if (!end) return undefined;
    log.info(
      { fixtureId: fixtureId.toString(), seq: end.seq, action: end.action },
      "recovered finalising Seq from historical replay",
    );
    return end.seq;
  }
}

/**
 * Default "home win" stat query: stat_a = P1 goals, stat_b = P2 goals,
 * op = Subtract; the on-chain predicate (threshold 0, GreaterThan) decides the
 * outcome. `seq` = the finalising score event's Seq (REQUIRED by the API).
 * Per-market stat keys should come from MarketConfig once available.
 */
function defaultStatQuery(fixtureId: bigint, seq: number): StatValidationQuery {
  return {
    fixtureId,
    seq,
    statKey: statKey(Period.FULL, StatBase.P1_GOALS),
    statKey2: statKey(Period.FULL, StatBase.P2_GOALS),
    op: "Subtract",
  };
}

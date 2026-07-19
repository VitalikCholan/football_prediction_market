import { Injectable, Logger } from '@nestjs/common';
import { findMarketPda } from '@fpm/shared';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../db/prisma.service';
import { FixturesService } from './fixtures.service';
import type {
  IndexedEvent,
  LifecycleIndexedEvent,
  MarketCreatedIndexedEvent,
  OutcomeIndex,
  RedeemIndexedEvent,
  SetIndexedEvent,
  TradeIndexedEvent,
} from '../chain/indexed-events.types';

/** Map the indexer's outcome index onto the DB `outcome` string. */
function outcomeLabel(o: OutcomeIndex): string | null {
  if (o === 0) return 'Team1';
  if (o === 1) return 'Draw';
  if (o === 2) return 'Team2';
  if (o === 'void') return 'Void';
  return null;
}

/**
 * Shared, idempotent event -> DB sink used by both the startup backfill and
 * the live tail. Trades and redemptions are keyed by (signature, eventIndex);
 * a replay of an already-indexed tx is a no-op (including its derived
 * PricePoint/VolumePoint rows, which are only written when the Trade row is
 * first inserted).
 */
/** Min gap between live score/odds refetches for one fixture (ms). */
const SCORE_ODDS_THROTTLE_MS = 30_000;

@Injectable()
export class EventPersister {
  private readonly logger = new Logger(EventPersister.name);
  /** fixtureId (string) -> market PDA (base58). */
  private readonly pdaCache = new Map<string, string>();
  /** fixtureId (string) -> last score/odds fetch epoch ms (throttle for live). */
  private readonly lastScoreOddsFetch = new Map<string, number>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly fixtures: FixturesService,
  ) {}

  /**
   * Populate homeTeam/awayTeam from TxLINE fixtures — only when they are still
   * null (one-shot per market; the FixturesService caches per fixture so the
   * 15s poll never refetches). Resilient: getTeams never throws; on a miss the
   * columns stay null and the web falls back to "Fixture <id>".
   */
  async enrichTeams(id: string, fixtureId: bigint): Promise<void> {
    const row = await this.prisma.market.findUnique({
      where: { id },
      select: { homeTeam: true, competition: true },
    });
    if (row?.homeTeam && row?.competition) return; // already fully enriched
    const data: Prisma.MarketUpdateInput = {};
    if (!row?.homeTeam) {
      const teams = await this.fixtures.getTeams(fixtureId);
      if (teams) {
        data.homeTeam = teams.home;
        data.awayTeam = teams.away;
      }
    }
    if (!row?.competition) {
      const comp = await this.fixtures.getCompetition(fixtureId);
      if (comp) {
        data.competition = comp.competition;
        data.competitionId = comp.competitionId;
      }
    }
    if (Object.keys(data).length === 0) return;
    await this.prisma.market.update({ where: { id }, data });
  }

  /**
   * Enrich every market row that still lacks team names OR competition (boot
   * backfill). One-shot: rows are only touched while a field is null.
   */
  async enrichMissingTeams(): Promise<void> {
    const rows = await this.prisma.market.findMany({
      where: { OR: [{ homeTeam: null }, { competition: null }] },
      select: {
        id: true,
        fixtureId: true,
        homeTeam: true,
        competition: true,
      },
    });
    for (const r of rows) {
      const data: Prisma.MarketUpdateInput = {};
      if (!r.homeTeam) {
        const teams = await this.fixtures.getTeams(r.fixtureId);
        if (teams) {
          data.homeTeam = teams.home;
          data.awayTeam = teams.away;
        }
      }
      if (!r.competition) {
        const comp = await this.fixtures.getCompetition(r.fixtureId);
        if (comp) {
          data.competition = comp.competition;
          data.competitionId = comp.competitionId;
        }
      }
      if (Object.keys(data).length === 0) continue;
      await this.prisma.market.update({ where: { id: r.id }, data });
    }
  }

  /**
   * Enrich live score + reference odds on the Market rows. Unlike team names
   * (one-shot, static), score/odds CHANGE for live markets — so:
   *
   *   - `Trading` markets: refetch every poll cycle, but throttled per fixture
   *     (>= SCORE_ODDS_THROTTLE_MS between fetches) so we never hammer TxLINE.
   *   - `Locked` / `Resolved`: capture the FINAL score/odds once — skip once we
   *     already have a home_score (final rows don't change). Odds usually
   *     disappear after full-time, so a null odds result never clobbers a value
   *     already captured.
   *
   * Fully resilient: getScore/getOdds never throw; a dead TxLINE call leaves the
   * columns untouched and never breaks the poll cycle. This is invoked from the
   * authoritative account refresh (once per poll, after on-chain state is set).
   */
  async enrichScoreAndOdds(): Promise<void> {
    if (!this.fixtures) return;
    const rows = await this.prisma.market.findMany({
      select: { id: true, fixtureId: true, state: true, homeScore: true },
    });
    const now = Date.now();
    for (const r of rows) {
      const key = r.fixtureId.toString();
      const isLive = r.state === 'Trading';
      const isFinal = r.state === 'Locked' || r.state === 'Resolved';

      if (isLive) {
        const last = this.lastScoreOddsFetch.get(key) ?? 0;
        if (now - last < SCORE_ODDS_THROTTLE_MS) continue; // throttle
      } else if (isFinal) {
        // One-shot final capture: if we already have a final score, done.
        if (r.homeScore != null) continue;
      } else {
        continue; // Open / Closed: no live match feed worth polling
      }
      this.lastScoreOddsFetch.set(key, now);

      const [score, odds] = await Promise.all([
        this.fixtures.getScore(r.fixtureId),
        this.fixtures.getOdds(r.fixtureId),
      ]);
      const data: Prisma.MarketUpdateInput = {};
      if (score) {
        data.homeScore = score.homeScore;
        data.awayScore = score.awayScore;
        data.statusId = score.statusId;
        data.matchClock = score.clock;
        data.gameState = score.gameState;
      }
      if (odds) {
        data.oddsHomeBps = odds.homeBps;
        data.oddsDrawBps = odds.drawBps;
        data.oddsAwayBps = odds.awayBps;
        data.oddsTs = odds.ts;
      }
      if (Object.keys(data).length === 0) continue; // nothing returned
      await this.prisma.market.update({ where: { id: r.id }, data });
    }
  }

  async persist(events: IndexedEvent[]): Promise<void> {
    for (const ev of events) {
      switch (ev.kind) {
        case 'created':
          await this.persistCreated(ev);
          break;
        case 'trade':
          await this.persistTrade(ev);
          break;
        case 'redeem':
          await this.persistRedeem(ev);
          break;
        case 'setMint':
        case 'setRedeem':
          await this.persistSet(ev);
          break;
        default:
          await this.persistLifecycle(ev);
      }
    }
  }

  /** Derive (and cache) the market PDA for a fixture id (@fpm/shared). */
  async marketPda(fixtureId: bigint): Promise<string> {
    const key = fixtureId.toString();
    const hit = this.pdaCache.get(key);
    if (hit) return hit;
    const [pda] = await findMarketPda(fixtureId);
    this.pdaCache.set(key, pda.toString());
    return pda.toString();
  }

  /**
   * init_market -> Market row bootstrap (LMSR q/b + opening prices). The
   * authoritative q/b/supply/state comes from the account refresh
   * (`refreshMarkets`); this seeds the row so trades/lifecycle can attach.
   */
  private async persistCreated(ev: MarketCreatedIndexedEvent): Promise<void> {
    const id = await this.marketPda(ev.fixtureId);
    await this.prisma.market.upsert({
      where: { id },
      create: {
        id,
        fixtureId: ev.fixtureId,
        configId: ev.config,
        state: 'Open',
        team1PriceBps: ev.pricesBps[0],
        drawPriceBps: ev.pricesBps[1],
        team2PriceBps: ev.pricesBps[2],
        b: ev.b.toString(),
        updatedSlot: ev.slot,
      },
      update: {}, // authoritative state comes from the account refresh
    });
    // Best-effort team-name enrichment (never throws; skips if already set).
    await this.enrichTeams(id, ev.fixtureId);
    // Opening price point so charts start at market creation.
    const exists = await this.prisma.pricePoint.findFirst({
      where: { marketId: id, slot: ev.slot },
      select: { id: true },
    });
    if (!exists) {
      await this.prisma.pricePoint.create({
        data: {
          marketId: id,
          ts: ev.ts,
          slot: ev.slot,
          team1PriceBps: ev.pricesBps[0],
          drawPriceBps: ev.pricesBps[1],
          team2PriceBps: ev.pricesBps[2],
        },
      });
    }
  }

  /**
   * A Buy/Sell -> Trade + PricePoint + VolumePoint. The Trade event carries the
   * traded outcome's post-trade softmax price directly; the authoritative
   * q/supply/all-three prices arrive via the account refresh. We store the
   * outcome index and chart the traded price. Idempotent on (signature,
   * eventIndex).
   */
  private async persistTrade(ev: TradeIndexedEvent): Promise<void> {
    const id = await this.marketPda(ev.fixtureId);
    const already = await this.prisma.trade.findUnique({
      where: {
        signature_eventIndex: {
          signature: ev.signature,
          eventIndex: ev.eventIndex,
        },
      },
      select: { id: true },
    });
    if (already) return; // full replay no-op

    const market = await this.prisma.market.findUnique({ where: { id } });
    if (!market) {
      this.logger.warn(
        `trade on unknown market ${id} (fixture ${ev.fixtureId}) — did the MarketCreated event get indexed?`,
      );
      return;
    }

    // The Trade event carries only the traded outcome's post-trade price. Chart
    // the three per-outcome prices with the traded one updated and the two
    // untraded held at their last snapshot (the account refresh overwrites all
    // three authoritatively on the next poll).
    const team1PriceBps = ev.outcome === 0 ? ev.priceBps : market.team1PriceBps;
    const drawPriceBps = ev.outcome === 1 ? ev.priceBps : market.drawPriceBps;
    const team2PriceBps = ev.outcome === 2 ? ev.priceBps : market.team2PriceBps;

    await this.prisma.$transaction([
      this.prisma.trade.create({
        data: {
          marketId: id,
          signature: ev.signature,
          eventIndex: ev.eventIndex,
          trader: ev.trader,
          outcome: ev.outcome, // 0 = Team1, 1 = Draw, 2 = Team2
          action: ev.isBuy ? 'buy' : 'sell',
          usdtIn: ev.isBuy ? ev.usdt.toString() : '0',
          usdtOut: ev.isBuy ? '0' : ev.usdt.toString(),
          tokensAmount: ev.tokens.toString(),
          priceBps: ev.priceBps,
          feeBps: ev.feeBps,
          ts: ev.ts,
          slot: ev.slot,
        },
      }),
      this.prisma.pricePoint.create({
        data: {
          marketId: id,
          ts: ev.ts,
          slot: ev.slot,
          team1PriceBps,
          drawPriceBps,
          team2PriceBps,
          feeBps: ev.feeBps,
        },
      }),
      this.prisma.volumePoint.create({
        data: {
          marketId: id,
          ts: ev.ts,
          slot: ev.slot,
          volume: ev.usdt.toString(),
        },
      }),
      this.prisma.market.update({
        where: { id },
        data: {
          team1PriceBps,
          drawPriceBps,
          team2PriceBps,
          totalVolume: { increment: new Prisma.Decimal(ev.usdt.toString()) },
          updatedSlot: ev.slot,
        },
      }),
    ]);
  }

  private async persistLifecycle(ev: LifecycleIndexedEvent): Promise<void> {
    const id = await this.marketPda(ev.fixtureId);
    const state =
      ev.kind === 'activate'
        ? 'Trading'
        : ev.kind === 'freeze'
          ? 'Locked'
          : ev.kind === 'resolve'
            ? 'Resolved'
            : 'Closed';
    try {
      await this.prisma.market.update({
        where: { id },
        data: {
          state,
          ...(ev.kind === 'resolve'
            ? { outcome: outcomeLabel(ev.outcome ?? null) }
            : {}),
          updatedSlot: ev.slot,
        },
      });
    } catch {
      this.logger.warn(
        `${ev.kind} on unknown market ${id} (fixture ${ev.fixtureId}) — skipped`,
      );
    }
  }

  private async persistRedeem(ev: RedeemIndexedEvent): Promise<void> {
    const id = await this.marketPda(ev.fixtureId);
    // The Redemption.outcome is an Int — store the outcome index (0/1/2), or
    // -1 for a Void refund (no single winning outcome).
    const outcome =
      ev.outcome === 'void' || ev.outcome == null ? -1 : ev.outcome;
    await this.prisma.redemption.upsert({
      where: {
        signature_eventIndex: {
          signature: ev.signature,
          eventIndex: ev.eventIndex,
        },
      },
      create: {
        marketId: id,
        signature: ev.signature,
        eventIndex: ev.eventIndex,
        owner: ev.owner,
        outcome,
        payout: ev.payout.toString(),
        ts: ev.ts,
        slot: ev.slot,
      },
      update: {},
    });
  }

  /**
   * SetMinted / SetRedeemed -> volume bookkeeping only. A complete-set
   * mint/redeem is fee-free and price-neutral (SPEC §3.1 C-add), so it moves
   * collateral but not the softmax prices — record it as a VolumePoint +
   * totalVolume bump so the chart's volume series reflects the flow.
   */
  private async persistSet(ev: SetIndexedEvent): Promise<void> {
    const id = await this.marketPda(ev.fixtureId);
    const market = await this.prisma.market.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!market) return; // set on unknown market — created event not yet indexed
    const exists = await this.prisma.volumePoint.findFirst({
      where: { marketId: id, slot: ev.slot, volume: ev.amount.toString() },
      select: { id: true },
    });
    if (exists) return; // idempotent-ish guard for replay
    await this.prisma.$transaction([
      this.prisma.volumePoint.create({
        data: {
          marketId: id,
          ts: ev.ts,
          slot: ev.slot,
          volume: ev.amount.toString(),
        },
      }),
      this.prisma.market.update({
        where: { id },
        data: {
          totalVolume: { increment: new Prisma.Decimal(ev.amount.toString()) },
          updatedSlot: ev.slot,
        },
      }),
    ]);
  }
}

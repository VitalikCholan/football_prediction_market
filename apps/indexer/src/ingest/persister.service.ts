import { Injectable, Logger } from '@nestjs/common';
import { findMarketPda } from '@fpm/shared';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../db/prisma.service';
import { deriveReservesFromPrice } from '../chain/reserve-math';
import { FixturesService } from './fixtures.service';
import type {
  IndexedEvent,
  LifecycleIndexedEvent,
  MarketCreatedIndexedEvent,
  RedeemIndexedEvent,
  TradeIndexedEvent,
} from '../chain/indexed-events.types';

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
      select: { homeTeam: true },
    });
    if (row?.homeTeam) return; // already enriched
    const teams = await this.fixtures.getTeams(fixtureId);
    if (!teams) return;
    await this.prisma.market.update({
      where: { id },
      data: { homeTeam: teams.home, awayTeam: teams.away },
    });
  }

  /** Enrich every market row that still lacks team names (boot backfill). */
  async enrichMissingTeams(): Promise<void> {
    const rows = await this.prisma.market.findMany({
      where: { homeTeam: null },
      select: { id: true, fixtureId: true },
    });
    for (const r of rows) {
      const teams = await this.fixtures.getTeams(r.fixtureId);
      if (!teams) continue;
      await this.prisma.market.update({
        where: { id: r.id },
        data: { homeTeam: teams.home, awayTeam: teams.away },
      });
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
        case 'buy':
        case 'sell':
          await this.persistTrade(ev);
          break;
        case 'redeem':
          await this.persistRedeem(ev);
          break;
        default:
          await this.persistLifecycle(ev);
      }
    }
  }

  /** Derive (and cache) the market PDA for a fixture id (seeds from @fpm/shared). */
  async marketPda(fixtureId: bigint): Promise<string> {
    const key = fixtureId.toString();
    const hit = this.pdaCache.get(key);
    if (hit) return hit;
    const [pda] = await findMarketPda(fixtureId);
    this.pdaCache.set(key, pda.toString());
    return pda.toString();
  }

  private async persistCreated(ev: MarketCreatedIndexedEvent): Promise<void> {
    const id = await this.marketPda(ev.fixtureId);
    await this.prisma.market.upsert({
      where: { id },
      create: {
        id,
        fixtureId: ev.fixtureId,
        configId: ev.config,
        state: 'Open',
        yesReserve: ev.yesReserve.toString(),
        noReserve: ev.noReserve.toString(),
        yesPriceBps: ev.yesPriceBps,
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
          yesPriceBps: ev.yesPriceBps,
          yesReserve: ev.yesReserve.toString(),
          noReserve: ev.noReserve.toString(),
        },
      });
    }
  }

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

    // The Trade event carries the post-trade price but not the reserves.
    // Trades preserve the constant product k = yes*no (fees are taken from the
    // collateral leg), so reserves are recoverable from k + price:
    //   p = no/(yes+no)  =>  no = sqrt(k*p/(1-p)), yes = k/no
    const k =
      BigInt(market.yesReserve.toFixed(0)) *
      BigInt(market.noReserve.toFixed(0));
    const { yesReserve, noReserve } = deriveReservesFromPrice(
      k,
      ev.yesPriceBps,
      {
        yesReserve: BigInt(market.yesReserve.toFixed(0)),
        noReserve: BigInt(market.noReserve.toFixed(0)),
      },
    );

    const usdc = ev.kind === 'buy' ? ev.usdcIn : ev.usdcOut;
    await this.prisma.$transaction([
      this.prisma.trade.create({
        data: {
          marketId: id,
          signature: ev.signature,
          eventIndex: ev.eventIndex,
          trader: ev.trader,
          side: ev.side,
          action: ev.kind,
          usdcIn: ev.usdcIn.toString(),
          usdcOut: ev.usdcOut.toString(),
          tokensAmount: ev.tokensAmount.toString(),
          priceBps: ev.yesPriceBps,
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
          yesPriceBps: ev.yesPriceBps,
          yesReserve: yesReserve.toString(),
          noReserve: noReserve.toString(),
          feeBps: ev.feeBps,
        },
      }),
      this.prisma.volumePoint.create({
        data: {
          marketId: id,
          ts: ev.ts,
          slot: ev.slot,
          volume: usdc.toString(),
        },
      }),
      this.prisma.market.update({
        where: { id },
        data: {
          yesReserve: yesReserve.toString(),
          noReserve: noReserve.toString(),
          yesPriceBps: ev.yesPriceBps,
          totalVolume: {
            increment: new Prisma.Decimal(usdc.toString()),
          },
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
          ...(ev.kind === 'resolve' && ev.outcome != null
            ? { outcome: ev.outcome }
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
        outcome: ev.outcome,
        payout: ev.payout.toString(),
        ts: ev.ts,
        slot: ev.slot,
      },
      update: {},
    });
  }
}

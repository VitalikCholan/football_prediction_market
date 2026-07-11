import { Injectable, Logger } from '@nestjs/common';
import { findMarket1x2Pda, findMarketPda } from '@fpm/shared';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../db/prisma.service';
import { deriveReservesFromPrice } from '../chain/reserve-math';
import { FixturesService } from './fixtures.service';
import type {
  IndexedEvent,
  LifecycleIndexedEvent,
  Lifecycle1x2IndexedEvent,
  MarketCreatedIndexedEvent,
  Market1x2CreatedIndexedEvent,
  Outcome1x2Index,
  Redeem1x2IndexedEvent,
  RedeemIndexedEvent,
  Set1x2IndexedEvent,
  Trade1x2IndexedEvent,
  TradeIndexedEvent,
} from '../chain/indexed-events.types';

/** Map the indexer's 1X2 outcome index onto the DB `outcome_1x2` string. */
function outcome1x2Label(o: Outcome1x2Index): string | null {
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
        case 'buy':
        case 'sell':
          await this.persistTrade(ev);
          break;
        case 'redeem':
          await this.persistRedeem(ev);
          break;
        case 'activate':
        case 'freeze':
        case 'resolve':
        case 'close':
          await this.persistLifecycle(ev);
          break;
        // ---- 1X2 (phase C) --------------------------------------------------
        case 'created1x2':
          await this.persistCreated1x2(ev);
          break;
        case 'trade1x2':
          await this.persistTrade1x2(ev);
          break;
        case 'redeem1x2':
          await this.persistRedeem1x2(ev);
          break;
        case 'setMint1x2':
        case 'setRedeem1x2':
          await this.persistSet1x2(ev);
          break;
        default:
          await this.persistLifecycle1x2(ev);
      }
    }
  }

  /** Derive (and cache) the binary market PDA for a fixture id (@fpm/shared). */
  async marketPda(fixtureId: bigint): Promise<string> {
    const key = fixtureId.toString();
    const hit = this.pdaCache.get(key);
    if (hit) return hit;
    const [pda] = await findMarketPda(fixtureId);
    this.pdaCache.set(key, pda.toString());
    return pda.toString();
  }

  /** Derive (and cache) the Market1x2 PDA for a fixture id (@fpm/shared). */
  async market1x2Pda(fixtureId: bigint): Promise<string> {
    const key = `1x2:${fixtureId}`;
    const hit = this.pdaCache.get(key);
    if (hit) return hit;
    const [pda] = await findMarket1x2Pda(fixtureId);
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

    const usdt = ev.kind === 'buy' ? ev.usdtIn : ev.usdtOut;
    await this.prisma.$transaction([
      this.prisma.trade.create({
        data: {
          marketId: id,
          signature: ev.signature,
          eventIndex: ev.eventIndex,
          trader: ev.trader,
          side: ev.side,
          action: ev.kind,
          usdtIn: ev.usdtIn.toString(),
          usdtOut: ev.usdtOut.toString(),
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
          volume: usdt.toString(),
        },
      }),
      this.prisma.market.update({
        where: { id },
        data: {
          yesReserve: yesReserve.toString(),
          noReserve: noReserve.toString(),
          yesPriceBps: ev.yesPriceBps,
          totalVolume: {
            increment: new Prisma.Decimal(usdt.toString()),
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

  // ---- 1X2 (phase C) --------------------------------------------------------

  /**
   * init_market_1x2 -> Market1x2 row bootstrap. Mirrors `persistCreated` but
   * writes the shared row with `marketKind = 1` and the LMSR columns. The
   * authoritative q/b/supply/state comes from the account refresh
   * (`refreshMarkets1x2`); this seeds the row so trades/lifecycle can attach.
   */
  private async persistCreated1x2(
    ev: Market1x2CreatedIndexedEvent,
  ): Promise<void> {
    const id = await this.market1x2Pda(ev.fixtureId);
    await this.prisma.market.upsert({
      where: { id },
      create: {
        id,
        fixtureId: ev.fixtureId,
        configId: ev.config,
        marketKind: 1,
        state: 'Open',
        oneXTeam1PriceBps: ev.pricesBps[0],
        oneXDrawPriceBps: ev.pricesBps[1],
        oneXTeam2PriceBps: ev.pricesBps[2],
        oneXB: ev.b.toString(),
        yesPriceBps: ev.pricesBps[0], // legacy col: opening team1 price
        updatedSlot: ev.slot,
      },
      update: {}, // authoritative state comes from the account refresh
    });
    await this.enrichTeams(id, ev.fixtureId);
    // Opening price point (charts track the Team1 softmax price for 1X2 rows).
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
          yesPriceBps: ev.pricesBps[0],
          yesReserve: '0',
          noReserve: '0',
        },
      });
    }
  }

  /**
   * A 1X2 Buy/Sell -> Trade + PricePoint + VolumePoint. Unlike the binary path
   * there are no reserves to reconstruct: the Trade1x2 event carries the traded
   * outcome's post-trade softmax price directly, and the authoritative q/supply
   * arrive via the account refresh. We store the outcome index in `side` and
   * chart the traded price. Idempotent on (signature, eventIndex).
   */
  private async persistTrade1x2(ev: Trade1x2IndexedEvent): Promise<void> {
    const id = await this.market1x2Pda(ev.fixtureId);
    const already = await this.prisma.trade.findUnique({
      where: {
        signature_eventIndex: {
          signature: ev.signature,
          eventIndex: ev.eventIndex,
        },
      },
      select: { id: true },
    });
    if (already) return;

    const market = await this.prisma.market.findUnique({ where: { id } });
    if (!market) {
      this.logger.warn(
        `1X2 trade on unknown market ${id} (fixture ${ev.fixtureId}) — Market1x2Created not indexed?`,
      );
      return;
    }

    await this.prisma.$transaction([
      this.prisma.trade.create({
        data: {
          marketId: id,
          signature: ev.signature,
          eventIndex: ev.eventIndex,
          trader: ev.trader,
          side: ev.outcome, // 0 = Team1, 1 = Draw, 2 = Team2
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
          yesPriceBps: ev.priceBps,
          yesReserve: '0',
          noReserve: '0',
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
          yesPriceBps: ev.priceBps,
          totalVolume: { increment: new Prisma.Decimal(ev.usdt.toString()) },
          updatedSlot: ev.slot,
        },
      }),
    ]);
  }

  private async persistLifecycle1x2(
    ev: Lifecycle1x2IndexedEvent,
  ): Promise<void> {
    const id = await this.market1x2Pda(ev.fixtureId);
    const state =
      ev.kind === 'activate1x2'
        ? 'Trading'
        : ev.kind === 'freeze1x2'
          ? 'Locked'
          : ev.kind === 'resolve1x2'
            ? 'Resolved'
            : 'Closed';
    try {
      await this.prisma.market.update({
        where: { id },
        data: {
          state,
          ...(ev.kind === 'resolve1x2'
            ? { outcome1x2: outcome1x2Label(ev.outcome ?? null) }
            : {}),
          updatedSlot: ev.slot,
        },
      });
    } catch {
      this.logger.warn(
        `${ev.kind} on unknown 1X2 market ${id} (fixture ${ev.fixtureId}) — skipped`,
      );
    }
  }

  private async persistRedeem1x2(ev: Redeem1x2IndexedEvent): Promise<void> {
    const id = await this.market1x2Pda(ev.fixtureId);
    // The shared Redemption.outcome is an Int — store the 1X2 outcome index
    // (0/1/2), or -1 for a Void refund (no single winning outcome).
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
   * SetMinted1x2 / SetRedeemed1x2 -> volume bookkeeping only. A complete-set
   * mint/redeem is fee-free and price-neutral (SPEC §3.1 C-add), so it moves
   * collateral but not the softmax prices — record it as a VolumePoint +
   * totalVolume bump so the chart's volume series reflects the flow.
   */
  private async persistSet1x2(ev: Set1x2IndexedEvent): Promise<void> {
    const id = await this.market1x2Pda(ev.fixtureId);
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

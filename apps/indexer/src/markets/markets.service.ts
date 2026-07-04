import { Injectable, NotFoundException } from '@nestjs/common';
import {
  type HistoryPointDto,
  type HistoryQuery,
  type HistoryResponseDto,
  type MarketDto,
  type MarketListDto,
  type MarketListQuery,
  type Side,
} from '@fpm/shared';
import type { Market, PricePoint } from '@prisma/client';
import { PrismaService } from '../db/prisma.service';

/** Resolution -> bucket size in seconds (raw = no bucketing). */
const RESOLUTION_SECONDS: Record<string, number> = {
  '1m': 60,
  '5m': 300,
  '1h': 3600,
  raw: 0,
};

@Injectable()
export class MarketsService {
  constructor(private readonly prisma: PrismaService) {}

  /** GET /markets — filtered, paginated list of market snapshots. */
  async list(query: MarketListQuery): Promise<MarketListDto> {
    const where = query.state ? { state: query.state } : {};
    const [rows, total] = await Promise.all([
      this.prisma.market.findMany({
        where,
        orderBy: { updatedAt: 'desc' },
        skip: query.offset,
        take: query.limit,
      }),
      this.prisma.market.count({ where }),
    ]);
    return { markets: rows.map((r) => this.toMarketDto(r)), total };
  }

  /** GET /markets/:id — single market, by PDA or (fallback) fixture id. */
  async findOne(id: string): Promise<MarketDto> {
    const market = await this.resolveMarket(id);
    if (!market) throw new NotFoundException(`market ${id} not found`);
    return this.toMarketDto(market);
  }

  /** GET /markets/:id/history — price/volume series for lightweight-charts. */
  async history(id: string, query: HistoryQuery): Promise<HistoryResponseDto> {
    const market = await this.resolveMarket(id);
    if (!market) throw new NotFoundException(`market ${id} not found`);

    const from = query.from ? new Date(query.from * 1000) : undefined;
    const to = query.to ? new Date(query.to * 1000) : undefined;

    const points = await this.prisma.pricePoint.findMany({
      where: {
        marketId: market.id,
        ts: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) },
      },
      orderBy: { ts: 'asc' },
    });

    const bucketSeconds = RESOLUTION_SECONDS[query.resolution] ?? 0;
    return {
      marketId: market.id,
      resolution: query.resolution,
      points: this.bucketPoints(points, bucketSeconds),
    };
  }

  // ---- helpers -------------------------------------------------------------

  /** Accept either the market PDA (id) or the numeric fixture id. */
  private async resolveMarket(id: string): Promise<Market | null> {
    const byId = await this.prisma.market.findUnique({ where: { id } });
    if (byId) return byId;
    if (/^\d+$/.test(id)) {
      return this.prisma.market.findUnique({
        where: { fixtureId: BigInt(id) },
      });
    }
    return null;
  }

  /**
   * Downsample raw price points into fixed-width time buckets, keeping the last
   * price per bucket and summing the collateral reserves delta as volume. For
   * `raw` (bucketSeconds = 0) each point is emitted as-is.
   */
  private bucketPoints(
    points: PricePoint[],
    bucketSeconds: number,
  ): HistoryPointDto[] {
    if (bucketSeconds <= 0) {
      return points.map((p) => ({
        time: Math.floor(p.ts.getTime() / 1000),
        yesPriceBps: p.yesPriceBps,
        volume: p.yesReserve.plus(p.noReserve).toFixed(0),
      }));
    }

    const buckets = new Map<number, HistoryPointDto>();
    for (const p of points) {
      const unix = Math.floor(p.ts.getTime() / 1000);
      const bucket = Math.floor(unix / bucketSeconds) * bucketSeconds;
      buckets.set(bucket, {
        time: bucket,
        yesPriceBps: p.yesPriceBps,
        volume: p.yesReserve.plus(p.noReserve).toFixed(0),
      });
    }
    return [...buckets.values()].sort((a, b) => a.time - b.time);
  }

  private toMarketDto(m: Market): MarketDto {
    const outcome: Side | null =
      m.outcome === null ? null : m.outcome === 1 ? 'YES' : 'NO';
    return {
      id: m.id,
      fixtureId: m.fixtureId.toString(),
      configId: m.configId,
      state: m.state as MarketDto['state'],
      yesPriceBps: m.yesPriceBps,
      yesReserve: m.yesReserve.toFixed(0),
      noReserve: m.noReserve.toFixed(0),
      yesSupply: m.yesSupply.toFixed(0),
      noSupply: m.noSupply.toFixed(0),
      baseFeeBps: m.baseFeeBps,
      currentFeeBps: m.currentFeeBps,
      totalVolume: m.totalVolume.toFixed(0),
      homeTeam: m.homeTeam,
      awayTeam: m.awayTeam,
      kickoffTs: m.kickoffTs ? Math.floor(m.kickoffTs.getTime() / 1000) : null,
      freezeTs: m.freezeTs ? Math.floor(m.freezeTs.getTime() / 1000) : null,
      outcome,
      updatedSlot: Number(m.updatedSlot),
      updatedAt: Math.floor(m.updatedAt.getTime() / 1000),
    };
  }
}

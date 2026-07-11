import { Injectable, NotFoundException } from '@nestjs/common';
import {
  AnyMarketDto as AnyMarketSchema,
  AnyMarketListDto as AnyMarketListSchema,
  type AnyMarketDto,
  type AnyMarketListDto,
  type HistoryQuery,
  type HistoryResponseDto,
  type MarketListQuery,
} from '@fpm/shared';
import type { Market } from '@prisma/client';
import { PrismaService } from '../db/prisma.service';
import { RESOLUTION_SECONDS } from './markets.constants';
import { bucketPoints, toAnyMarketDto } from './markets.helpers';

@Injectable()
export class MarketsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * GET /markets — filtered, paginated list of market snapshots. Returns the
   * mixed `AnyMarketListDto` envelope (binary + 1X2). Binary entries are
   * byte-compatible with the legacy `MarketListDto` (they omit `marketKind`), so
   * existing binary-only web consumers keep parsing them unchanged.
   */
  async list(query: MarketListQuery): Promise<AnyMarketListDto> {
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
    // Validate the mixed envelope against the shared zod union before returning
    // (the REST contract; catches any mapper drift for binary or 1X2 rows).
    return AnyMarketListSchema.parse({
      markets: rows.map((r) => toAnyMarketDto(r)),
      total,
    });
  }

  /**
   * GET /markets/:id — single market, by PDA or (fallback) fixture id. Returns
   * `MarketDto` for binary rows and `Market1x2Dto` for 1X2 rows (keyed on the
   * stored `marketKind`).
   */
  async findOne(id: string): Promise<AnyMarketDto> {
    const market = await this.resolveMarket(id);
    if (!market) throw new NotFoundException(`market ${id} not found`);
    return AnyMarketSchema.parse(toAnyMarketDto(market));
  }

  /** GET /markets/:id/history — price/volume series for lightweight-charts. */
  async history(id: string, query: HistoryQuery): Promise<HistoryResponseDto> {
    const market = await this.resolveMarket(id);
    if (!market) throw new NotFoundException(`market ${id} not found`);

    const from = query.from ? new Date(query.from * 1000) : undefined;
    const to = query.to ? new Date(query.to * 1000) : undefined;

    const tsFilter = {
      ts: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) },
    };
    const [points, volumes] = await Promise.all([
      this.prisma.pricePoint.findMany({
        where: { marketId: market.id, ...tsFilter },
        orderBy: { ts: 'asc' },
      }),
      this.prisma.volumePoint.findMany({
        where: { marketId: market.id, ...tsFilter },
        orderBy: { ts: 'asc' },
      }),
    ]);

    const bucketSeconds = RESOLUTION_SECONDS[query.resolution] ?? 0;
    return {
      marketId: market.id,
      resolution: query.resolution,
      points: bucketPoints(points, volumes, bucketSeconds),
    };
  }

  // ---- data access ---------------------------------------------------------

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
}

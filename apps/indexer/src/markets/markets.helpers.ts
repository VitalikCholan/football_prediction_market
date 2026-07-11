import type {
  AnyMarketDto,
  HistoryPointDto,
  Market1x2Dto,
  MarketDto,
  Outcome1x2,
  Side,
} from '@fpm/shared';
import type { Market, PricePoint, VolumePoint } from '@prisma/client';

/**
 * Downsample raw price points into fixed-width time buckets, keeping the
 * last price per bucket; `volume` is the collateral traded in that bucket
 * (sum of VolumePoint rows, which the indexer writes one-per-trade). For
 * `raw` (bucketSeconds = 0) each price point is emitted as-is with the
 * volume traded at that slot.
 */
export function bucketPoints(
  points: PricePoint[],
  volumes: VolumePoint[],
  bucketSeconds: number,
): HistoryPointDto[] {
  if (bucketSeconds <= 0) {
    const volBySlot = new Map<string, bigint>();
    for (const v of volumes) {
      const key = v.slot.toString();
      volBySlot.set(
        key,
        (volBySlot.get(key) ?? 0n) + BigInt(v.volume.toFixed(0)),
      );
    }
    return points.map((p) => ({
      time: Math.floor(p.ts.getTime() / 1000),
      yesPriceBps: p.yesPriceBps,
      volume: (volBySlot.get(p.slot.toString()) ?? 0n).toString(),
    }));
  }

  const bucketOf = (ts: Date) =>
    Math.floor(Math.floor(ts.getTime() / 1000) / bucketSeconds) * bucketSeconds;

  const volByBucket = new Map<number, bigint>();
  for (const v of volumes) {
    const bucket = bucketOf(v.ts);
    volByBucket.set(
      bucket,
      (volByBucket.get(bucket) ?? 0n) + BigInt(v.volume.toFixed(0)),
    );
  }

  const buckets = new Map<number, HistoryPointDto>();
  for (const p of points) {
    const bucket = bucketOf(p.ts);
    buckets.set(bucket, {
      time: bucket,
      yesPriceBps: p.yesPriceBps,
      volume: (volByBucket.get(bucket) ?? 0n).toString(),
    });
  }
  return [...buckets.values()].sort((a, b) => a.time - b.time);
}

/**
 * Prisma Market row -> the right shared DTO by `marketKind`. Binary rows map to
 * `MarketDto` (byte-identical to v0 — `marketKind` is omitted so existing
 * binary-only consumers are unaffected); 1X2 rows map to `Market1x2Dto`.
 */
export function toAnyMarketDto(m: Market): AnyMarketDto {
  return m.marketKind === 1 ? toMarket1x2Dto(m) : toMarketDto(m);
}

/** The reference-odds sub-object, shared by both DTO shapes. */
function marketOddsOf(m: Market): MarketDto['marketOdds'] {
  return m.oddsHomeBps != null && m.oddsDrawBps != null && m.oddsAwayBps != null
    ? {
        homeBps: m.oddsHomeBps,
        drawBps: m.oddsDrawBps,
        awayBps: m.oddsAwayBps,
        ts: m.oddsTs != null ? Number(m.oddsTs) : null,
      }
    : null;
}

/** Prisma Market row -> shared MarketDto (the REST contract shape). */
export function toMarketDto(m: Market): MarketDto {
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
    competition: m.competition,
    competitionId: m.competitionId,
    kickoffTs: m.kickoffTs ? Math.floor(m.kickoffTs.getTime() / 1000) : null,
    freezeTs: m.freezeTs ? Math.floor(m.freezeTs.getTime() / 1000) : null,
    homeScore: m.homeScore,
    awayScore: m.awayScore,
    statusId: m.statusId,
    matchClock: m.matchClock,
    gameState: m.gameState,
    marketOdds: marketOddsOf(m),
    outcome,
    updatedSlot: Number(m.updatedSlot),
    updatedAt: Math.floor(m.updatedAt.getTime() / 1000),
  };
}

/**
 * Prisma Market row (marketKind = 1) -> shared Market1x2Dto. Prices are the
 * softmax the indexer computed from q/b in the account refresh; `*Supply` is the
 * USER token supply per outcome (excludes seed offsets). `outcome1x2` is the
 * resolved outcome string, null while unresolved.
 */
export function toMarket1x2Dto(m: Market): Market1x2Dto {
  const outcome1x2 = (m.outcome1x2 as Outcome1x2 | null) ?? null;
  return {
    marketKind: 'OneXTwo',
    id: m.id,
    fixtureId: m.fixtureId.toString(),
    configId: m.configId,
    state: m.state as Market1x2Dto['state'],
    team1PriceBps: m.oneXTeam1PriceBps ?? 0,
    drawPriceBps: m.oneXDrawPriceBps ?? 0,
    team2PriceBps: m.oneXTeam2PriceBps ?? 0,
    team1Supply: m.oneXTeam1Supply.toFixed(0),
    drawSupply: m.oneXDrawSupply.toFixed(0),
    team2Supply: m.oneXTeam2Supply.toFixed(0),
    b: m.oneXB.toFixed(0),
    baseFeeBps: m.baseFeeBps,
    currentFeeBps: m.currentFeeBps,
    totalVolume: m.totalVolume.toFixed(0),
    homeTeam: m.homeTeam,
    awayTeam: m.awayTeam,
    competition: m.competition,
    competitionId: m.competitionId,
    kickoffTs: m.kickoffTs ? Math.floor(m.kickoffTs.getTime() / 1000) : null,
    freezeTs: m.freezeTs ? Math.floor(m.freezeTs.getTime() / 1000) : null,
    homeScore: m.homeScore,
    awayScore: m.awayScore,
    statusId: m.statusId,
    matchClock: m.matchClock,
    gameState: m.gameState,
    marketOdds: marketOddsOf(m),
    outcome1x2,
    updatedSlot: Number(m.updatedSlot),
    updatedAt: Math.floor(m.updatedAt.getTime() / 1000),
  };
}

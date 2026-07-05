import { Injectable, Logger } from '@nestjs/common';
import { findMarketPda } from '@fpm/shared';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../db/prisma.service';
import { deriveReservesFromPrice } from './reserve-math';
import type {
  IndexedEvent,
  LifecycleIndexedEvent,
  MarketCreatedIndexedEvent,
  RedeemIndexedEvent,
  TradeIndexedEvent,
} from './indexer.types';

/**
 * Shared, idempotent event -> DB sink used by both the startup backfill and
 * the live tail. Trades and redemptions are keyed by (signature, eventIndex);
 * a replay of an already-indexed tx is a no-op (including its derived
 * PricePoint/VolumePoint rows, which are only written when the Trade row is
 * first inserted).
 */
@Injectable()
export class EventPersister {
  private readonly logger = new Logger(EventPersister.name);
  /** fixtureId (string) -> market PDA (base58). */
  private readonly pdaCache = new Map<string, string>();

  constructor(private readonly prisma: PrismaService) {}

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

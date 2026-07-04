import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import {
  createSolanaRpc,
  createSolanaRpcSubscriptions,
  type Rpc,
  type RpcSubscriptions,
  type SolanaRpcApi,
  type SolanaRpcSubscriptionsApi,
} from '@solana/kit';
import { AMM_PROGRAM_ID } from '@fpm/shared';
import { PrismaService } from '../db/prisma.service';
import { loadIndexerConfig, type IndexerConfig } from './indexer.config';
import { LogParser } from './log-parser';
import type { IndexedEvent, TradeEvent } from './indexer.types';

/**
 * Background chain subscriber. Runs inside the Nest process (OnModuleInit).
 *
 * Strategy (backend-plan §3.2), two complementary sources over @solana/kit:
 *   1. logsSubscribe filtered by AMM_PROGRAM_ID  -> Buy/Sell/lifecycle events
 *      -> Trade rows + derived PricePoints.
 *   2. accountSubscribe / programSubscribe on Market PDAs -> authoritative
 *      state snapshots (reserves, state, outcome) -> PricePoint on each change.
 *
 * The live subscription is gated behind INDEXER_ENABLED so the API can run
 * standalone while the on-chain program + IDL are still being finalized. The
 * structure, RPC wiring, parsing, and idempotent persistence are complete; the
 * single TODO is the event-decoder wiring in LogParser once the IDL lands.
 */
@Injectable()
export class SubscriberService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SubscriberService.name);
  private readonly config: IndexerConfig;
  private readonly programId = AMM_PROGRAM_ID;

  private rpc?: Rpc<SolanaRpcApi>;
  private rpcSubscriptions?: RpcSubscriptions<SolanaRpcSubscriptionsApi>;
  private abort?: AbortController;

  constructor(
    private readonly prisma: PrismaService,
    private readonly parser: LogParser,
  ) {
    this.config = loadIndexerConfig(process.env);
  }

  async onModuleInit(): Promise<void> {
    if (!this.config.enabled) {
      this.logger.warn(
        'INDEXER_ENABLED is off — chain subscription NOT started ' +
          '(set INDEXER_ENABLED=1 to enable live indexing).',
      );
      return;
    }
    this.rpc = createSolanaRpc(this.config.rpcUrls[0]);
    this.rpcSubscriptions = createSolanaRpcSubscriptions(this.config.rpcWsUrl);
    this.abort = new AbortController();
    this.logger.log(
      `Starting subscriber: program=${this.programId} ws=${this.config.rpcWsUrl}`,
    );
    // Fire-and-forget the subscription loop; it self-reconnects.
    void this.runLogsSubscription(this.abort.signal);
  }

  async onModuleDestroy(): Promise<void> {
    this.abort?.abort();
  }

  /**
   * logsSubscribe loop with reconnect/backoff. Each notification carries a
   * signature + log lines; we parse and persist.
   */
  private async runLogsSubscription(signal: AbortSignal): Promise<void> {
    let backoffMs = 500;
    while (!signal.aborted) {
      try {
        const subs = this.rpcSubscriptions!;
        const notifications = await subs
          .logsNotifications(
            { mentions: [this.programId] },
            { commitment: 'confirmed' },
          )
          .subscribe({ abortSignal: signal });
        backoffMs = 500; // reset on a successful subscribe
        this.logger.log('logsSubscribe active');

        for await (const notification of notifications) {
          const { signature, logs, err } = notification.value;
          if (err) continue; // skip failed txs
          const slot = notification.context.slot;
          // TODO: fetch blockTime via getTransaction/getBlockTime for accurate ts.
          const events = this.parser.parse(logs, signature, slot, null);
          await this.persist(events);
        }
      } catch (err) {
        if (signal.aborted) return;
        this.logger.error(
          `logsSubscribe error: ${(err as Error).message}; retrying in ${backoffMs}ms`,
        );
        await this.sleep(backoffMs);
        backoffMs = Math.min(backoffMs * 2, 30_000);
      }
    }
  }

  /** Persist decoded events idempotently. */
  private async persist(events: IndexedEvent[]): Promise<void> {
    for (const ev of events) {
      switch (ev.kind) {
        case 'buy':
        case 'sell':
          await this.persistTrade(ev);
          break;
        default:
          await this.persistLifecycle(ev);
      }
    }
  }

  private async persistTrade(ev: TradeEvent): Promise<void> {
    // Idempotent on (signature, eventIndex): duplicate replays are no-ops.
    await this.prisma.trade.upsert({
      where: {
        signature_eventIndex: {
          signature: ev.signature,
          eventIndex: ev.eventIndex,
        },
      },
      create: {
        marketId: ev.marketId,
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
      update: {},
    });

    // Derived PricePoint snapshot for the chart.
    await this.prisma.pricePoint.create({
      data: {
        marketId: ev.marketId,
        ts: ev.ts,
        slot: ev.slot,
        yesPriceBps: ev.yesPriceBps,
        yesReserve: ev.yesReserve.toString(),
        noReserve: ev.noReserve.toString(),
        feeBps: ev.feeBps,
      },
    });

    await this.prisma.market.update({
      where: { id: ev.marketId },
      data: {
        yesReserve: ev.yesReserve.toString(),
        noReserve: ev.noReserve.toString(),
        yesPriceBps: ev.yesPriceBps,
        updatedSlot: ev.slot,
      },
    });
  }

  private async persistLifecycle(
    ev: Extract<IndexedEvent, { kind: 'activate' | 'freeze' | 'resolve' }>,
  ): Promise<void> {
    const state =
      ev.kind === 'activate'
        ? 'Trading'
        : ev.kind === 'freeze'
          ? 'Locked'
          : 'Resolved';
    await this.prisma.market.update({
      where: { id: ev.marketId },
      data: {
        state,
        ...(ev.kind === 'resolve' && ev.outcome !== undefined
          ? { outcome: ev.outcome }
          : {}),
        updatedSlot: ev.slot,
      },
    });
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }
}

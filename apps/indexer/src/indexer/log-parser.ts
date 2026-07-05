import { Injectable, Logger } from '@nestjs/common';
import { AMM_PROGRAM_ID, BPS_DENOM } from '@fpm/shared';
import { decodeAmmEventsFromLogs, EventOutcome, type AmmEvent } from './events';
import type { IndexedEvent } from './indexer.types';

/**
 * Decodes Anchor program logs into normalized domain events.
 *
 * The heavy lifting (invoke-frame attribution + discriminator matching + borsh
 * decode) lives in the pure functions of `events.ts`; this class maps the raw
 * decoded events onto the persister's `IndexedEvent` envelope (signature, slot,
 * block time, event index).
 */
@Injectable()
export class LogParser {
  private readonly logger = new Logger(LogParser.name);
  private readonly programId = AMM_PROGRAM_ID.toString();

  /**
   * Parse the log lines of a single transaction into domain events.
   *
   * @param logs        transaction log messages (from getTransaction)
   * @param signature   tx signature
   * @param slot        slot the tx landed in
   * @param blockTime   block time (unix seconds) or null
   */
  parse(
    logs: readonly string[],
    signature: string,
    slot: bigint,
    blockTime: number | null,
  ): IndexedEvent[] {
    const ts = new Date((blockTime ?? Math.floor(Date.now() / 1000)) * 1000);
    const raw = decodeAmmEventsFromLogs(logs, this.programId);
    const events: IndexedEvent[] = [];

    raw.forEach((ev, eventIndex) => {
      const mapped = this.toIndexedEvent(ev, {
        signature,
        eventIndex,
        slot,
        ts,
      });
      if (mapped) events.push(mapped);
    });
    return events;
  }

  private toIndexedEvent(
    ev: AmmEvent,
    base: { signature: string; eventIndex: number; slot: bigint; ts: Date },
  ): IndexedEvent | null {
    switch (ev.name) {
      case 'MarketCreated':
        return {
          kind: 'created',
          ...base,
          fixtureId: ev.fixtureId,
          config: ev.config,
          yesReserve: ev.yesReserve,
          noReserve: ev.noReserve,
          yesPriceBps: ev.priceBps,
        };
      case 'Trade':
        return {
          kind: ev.isBuy ? 'buy' : 'sell',
          ...base,
          fixtureId: ev.fixtureId,
          trader: ev.owner,
          side: ev.sideYes ? 1 : 0,
          usdcIn: ev.isBuy ? ev.usdc : 0n,
          usdcOut: ev.isBuy ? 0n : ev.usdc,
          tokensAmount: ev.tokens,
          feeBps: ev.feeBps,
          yesPriceBps: ev.priceBps,
        };
      case 'MarketActivated':
        return { kind: 'activate', ...base, fixtureId: ev.fixtureId };
      case 'MarketFrozen':
        return { kind: 'freeze', ...base, fixtureId: ev.fixtureId };
      case 'MarketResolved':
        return {
          kind: 'resolve',
          ...base,
          fixtureId: ev.fixtureId,
          outcome:
            ev.outcome === EventOutcome.Yes
              ? 1
              : ev.outcome === EventOutcome.No
                ? 0
                : null, // Void / Unset
        };
      case 'MarketClosed':
        return { kind: 'close', ...base, fixtureId: ev.fixtureId };
      case 'Redeemed':
        return {
          kind: 'redeem',
          ...base,
          fixtureId: ev.fixtureId,
          owner: ev.owner,
          outcome: ev.outcome === EventOutcome.Yes ? 1 : 0,
          payout: ev.payout,
        };
      default:
        this.logger.warn(`unhandled amm event on ${base.signature}`);
        return null;
    }
  }

  /**
   * On-chain price math (anchor-programs-plan §4.3):
   *   price(YES) = no_reserve / (yes_reserve + no_reserve)
   * Returned in basis points (0..10000). `last_price_bps` from the decoded
   * account is the cross-check.
   */
  static deriveYesPriceBps(yesReserve: bigint, noReserve: bigint): number {
    const total = yesReserve + noReserve;
    if (total === 0n) return BPS_DENOM / 2; // 50/50 before any liquidity
    return Number((noReserve * BigInt(BPS_DENOM)) / total);
  }
}

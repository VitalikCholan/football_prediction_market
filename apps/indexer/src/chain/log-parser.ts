/**
 * Pure mapping from decoded Anchor events (`events.decoder.ts`) onto the
 * persister's `IndexedEvent` envelope — no Nest, no RPC, no DB. The Nest
 * glue (per-transaction parse + logging) lives in `ingest/log-parser.ts`.
 */
import { BPS_DENOM } from '@fpm/shared';
import { EventOutcome, type AmmEvent } from './events.decoder';
import type { IndexedEvent } from './indexed-events.types';

/** Per-transaction envelope shared by every event decoded from one tx. */
export interface IndexedEventEnvelope {
  signature: string;
  eventIndex: number; // position within the tx (amm events only)
  slot: bigint;
  ts: Date; // block time
}

/**
 * Map one decoded amm event onto the persister's normalized shape.
 * Returns `null` for event types the indexer does not handle.
 */
export function toIndexedEvent(
  ev: AmmEvent,
  base: IndexedEventEnvelope,
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
      return null;
  }
}

/**
 * On-chain price math (anchor-programs-plan §4.3):
 *   price(YES) = no_reserve / (yes_reserve + no_reserve)
 * Returned in basis points (0..10000). `last_price_bps` from the decoded
 * account is the cross-check.
 */
export function deriveYesPriceBps(
  yesReserve: bigint,
  noReserve: bigint,
): number {
  const total = yesReserve + noReserve;
  if (total === 0n) return BPS_DENOM / 2; // 50/50 before any liquidity
  return Number((noReserve * BigInt(BPS_DENOM)) / total);
}

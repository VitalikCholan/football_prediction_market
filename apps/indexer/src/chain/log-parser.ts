/**
 * Pure mapping from decoded Anchor events (`events.decoder.ts`) onto the
 * persister's `IndexedEvent` envelope — no Nest, no RPC, no DB. The Nest
 * glue (per-transaction parse + logging) lives in `ingest/log-parser.ts`.
 */
import { BPS_DENOM } from '@fpm/shared';
import { Event1x2Outcome, EventOutcome, type AmmEvent } from './events.decoder';
import type { IndexedEvent, Outcome1x2Index } from './indexed-events.types';

/** Map the on-chain `Outcome1x2` u8 tag onto the indexer's outcome index. */
function toOutcome1x2Index(tag: Event1x2Outcome): Outcome1x2Index {
  switch (tag) {
    case Event1x2Outcome.Team1:
      return 0;
    case Event1x2Outcome.Draw:
      return 1;
    case Event1x2Outcome.Team2:
      return 2;
    case Event1x2Outcome.Void:
      return 'void';
    default:
      return null; // Unset (unresolved)
  }
}

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
    // ---- 1X2 (phase C) ------------------------------------------------------
    case 'Market1x2Created':
      return {
        kind: 'created1x2',
        ...base,
        fixtureId: ev.fixtureId,
        config: ev.config,
        b: ev.b,
        q: ev.q,
        pricesBps: ev.pricesBps,
      };
    case 'Trade1x2':
      return {
        kind: 'trade1x2',
        ...base,
        fixtureId: ev.fixtureId,
        trader: ev.owner,
        outcome: ev.outcome === 1 ? 1 : ev.outcome === 2 ? 2 : 0,
        isBuy: ev.isBuy,
        usdc: ev.usdc,
        tokens: ev.tokens,
        feeBps: ev.feeBps,
        priceBps: ev.priceBps,
      };
    case 'Market1x2Activated':
      return { kind: 'activate1x2', ...base, fixtureId: ev.fixtureId };
    case 'Market1x2Frozen':
      return { kind: 'freeze1x2', ...base, fixtureId: ev.fixtureId };
    case 'Market1x2Resolved':
      return {
        kind: 'resolve1x2',
        ...base,
        fixtureId: ev.fixtureId,
        outcome: toOutcome1x2Index(ev.outcome),
      };
    case 'Market1x2Closed':
      return { kind: 'close1x2', ...base, fixtureId: ev.fixtureId };
    case 'Redeemed1x2':
      return {
        kind: 'redeem1x2',
        ...base,
        fixtureId: ev.fixtureId,
        owner: ev.owner,
        outcome: toOutcome1x2Index(ev.outcome),
        payout: ev.payout,
      };
    case 'SetMinted1x2':
      return {
        kind: 'setMint1x2',
        ...base,
        fixtureId: ev.fixtureId,
        owner: ev.owner,
        amount: ev.amount,
      };
    case 'SetRedeemed1x2':
      return {
        kind: 'setRedeem1x2',
        ...base,
        fixtureId: ev.fixtureId,
        owner: ev.owner,
        amount: ev.amount,
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

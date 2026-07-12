/**
 * Pure mapping from decoded Anchor events (`events.decoder.ts`) onto the
 * persister's `IndexedEvent` envelope — no Nest, no RPC, no DB. The Nest
 * glue (per-transaction parse + logging) lives in `ingest/log-parser.ts`.
 */
import { EventOutcome, type AmmEvent } from './events.decoder';
import type { IndexedEvent, OutcomeIndex } from './indexed-events.types';

/** Map the on-chain `Outcome` u8 tag onto the indexer's outcome index. */
function toOutcomeIndex(tag: EventOutcome): OutcomeIndex {
  switch (tag) {
    case EventOutcome.Team1:
      return 0;
    case EventOutcome.Draw:
      return 1;
    case EventOutcome.Team2:
      return 2;
    case EventOutcome.Void:
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
        b: ev.b,
        q: ev.q,
        pricesBps: ev.pricesBps,
      };
    case 'Trade':
      return {
        kind: 'trade',
        ...base,
        fixtureId: ev.fixtureId,
        trader: ev.owner,
        outcome: ev.outcome === 1 ? 1 : ev.outcome === 2 ? 2 : 0,
        isBuy: ev.isBuy,
        usdt: ev.usdt,
        tokens: ev.tokens,
        feeBps: ev.feeBps,
        priceBps: ev.priceBps,
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
        outcome: toOutcomeIndex(ev.outcome),
      };
    case 'MarketClosed':
      return { kind: 'close', ...base, fixtureId: ev.fixtureId };
    case 'Redeemed':
      return {
        kind: 'redeem',
        ...base,
        fixtureId: ev.fixtureId,
        owner: ev.owner,
        outcome: toOutcomeIndex(ev.outcome),
        payout: ev.payout,
      };
    case 'SetMinted':
      return {
        kind: 'setMint',
        ...base,
        fixtureId: ev.fixtureId,
        owner: ev.owner,
        amount: ev.amount,
      };
    case 'SetRedeemed':
      return {
        kind: 'setRedeem',
        ...base,
        fixtureId: ev.fixtureId,
        owner: ev.owner,
        amount: ev.amount,
      };
    default:
      return null;
  }
}

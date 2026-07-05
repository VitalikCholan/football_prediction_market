/**
 * Domain events the log-parser produces from decoded Anchor program logs —
 * the normalized shape the persister writes as Market / Trade / PricePoint /
 * VolumePoint / Redemption rows. Field names mirror the on-chain `emit!`
 * events (target/idl/amm.json).
 *
 * Events carry the TxLINE `fixtureId` (that is what the program emits); the
 * persister derives the market PDA from it via `findMarketPda` (@fpm/shared).
 */

export type IndexedEventKind =
  | 'created'
  | 'buy'
  | 'sell'
  | 'activate'
  | 'freeze'
  | 'resolve'
  | 'redeem'
  | 'close';

/** Common envelope for every decoded event. */
export interface IndexedEventBase {
  kind: IndexedEventKind;
  signature: string;
  eventIndex: number; // position within the tx (amm events only)
  slot: bigint;
  ts: Date; // block time
  fixtureId: bigint; // i64 TxLINE fixture id (market PDA seed, D-7)
}

/** init_market -> Market row bootstrap. */
export interface MarketCreatedIndexedEvent extends IndexedEventBase {
  kind: 'created';
  config: string; // MarketConfig PDA (base58)
  yesReserve: bigint;
  noReserve: bigint;
  yesPriceBps: number;
}

/** A Buy or Sell event -> one Trade row + PricePoint + VolumePoint. */
export interface TradeIndexedEvent extends IndexedEventBase {
  kind: 'buy' | 'sell';
  trader: string;
  side: 0 | 1; // 0 = NO, 1 = YES
  usdcIn: bigint;
  usdcOut: bigint;
  tokensAmount: bigint;
  feeBps: number;
  yesPriceBps: number; // price after trade
}

/** activate/freeze/resolve/close -> Market state update. */
export interface LifecycleIndexedEvent extends IndexedEventBase {
  kind: 'activate' | 'freeze' | 'resolve' | 'close';
  outcome?: 0 | 1 | null; // resolve only (0 = NO, 1 = YES, null = Void)
}

/** Redeemed -> Redemption row. */
export interface RedeemIndexedEvent extends IndexedEventBase {
  kind: 'redeem';
  owner: string;
  outcome: 0 | 1; // winning side redeemed
  payout: bigint;
}

export type IndexedEvent =
  | MarketCreatedIndexedEvent
  | TradeIndexedEvent
  | LifecycleIndexedEvent
  | RedeemIndexedEvent;

/**
 * Domain events the log-parser produces from decoded Anchor program logs.
 * These are the normalized shape the subscriber persists as Trade / PricePoint
 * rows. Field names mirror the on-chain `emit!` events (anchor-programs-plan §9)
 * — adjust once the program team finalizes the event structs.
 */

export type IndexedEventKind =
  | 'buy'
  | 'sell'
  | 'activate'
  | 'freeze'
  | 'resolve';

/** Common envelope for every decoded event. */
export interface IndexedEventBase {
  kind: IndexedEventKind;
  signature: string;
  eventIndex: number; // position within the tx
  slot: bigint;
  ts: Date; // block time
  marketId: string; // market PDA (base58)
}

/** A Buy or Sell event -> one Trade row + a derived PricePoint. */
export interface TradeEvent extends IndexedEventBase {
  kind: 'buy' | 'sell';
  trader: string;
  side: 0 | 1; // 0 = NO, 1 = YES
  usdcIn: bigint;
  usdcOut: bigint;
  tokensAmount: bigint;
  feeBps: number;
  yesReserve: bigint;
  noReserve: bigint;
  yesPriceBps: number; // price after trade
}

/** A lifecycle event (activate/freeze/resolve) -> Market state update. */
export interface LifecycleEvent extends IndexedEventBase {
  kind: 'activate' | 'freeze' | 'resolve';
  outcome?: 0 | 1; // set on resolve (0 = NO, 1 = YES)
}

export type IndexedEvent = TradeEvent | LifecycleEvent;

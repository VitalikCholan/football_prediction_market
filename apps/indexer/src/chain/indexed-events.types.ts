/**
 * Domain events the log-parser produces from decoded Anchor program logs —
 * the normalized shape the persister writes as Market / Trade / PricePoint /
 * VolumePoint / Redemption rows. Field names mirror the on-chain `emit!`
 * events (target/idl/amm.json). One market type: 3-way (1X2) LMSR.
 *
 * Events carry the TxLINE `fixtureId` (that is what the program emits); the
 * persister derives the market PDA from it via `findMarketPda` (@fpm/shared).
 */

export type IndexedEventKind =
  | 'created'
  | 'trade'
  | 'activate'
  | 'freeze'
  | 'resolve'
  | 'redeem'
  | 'close'
  | 'setMint'
  | 'setRedeem';

/** On-chain resolved outcome index for a market (null = unresolved). */
export type OutcomeIndex = 0 | 1 | 2 | 'void' | null;

/** Common envelope for every decoded event. */
export interface IndexedEventBase {
  kind: IndexedEventKind;
  signature: string;
  eventIndex: number; // position within the tx (amm events only)
  slot: bigint;
  ts: Date; // block time
  fixtureId: bigint; // i64 TxLINE fixture id (market PDA seed, D-7)
}

/** init_market -> Market row bootstrap (LMSR q/b + opening prices). */
export interface MarketCreatedIndexedEvent extends IndexedEventBase {
  kind: 'created';
  config: string; // MarketConfig PDA (base58)
  b: bigint;
  q: [bigint, bigint, bigint]; // net tokens per outcome (includes seed offset)
  pricesBps: [number, number, number]; // opening softmax prices
}

/** A Buy or Sell -> one Trade row + PricePoint + VolumePoint. */
export interface TradeIndexedEvent extends IndexedEventBase {
  kind: 'trade';
  trader: string;
  outcome: 0 | 1 | 2; // 0 = Team1, 1 = Draw, 2 = Team2
  isBuy: boolean;
  usdt: bigint;
  tokens: bigint;
  feeBps: number;
  priceBps: number; // post-trade price of the traded outcome
}

/** activate/freeze/resolve/close -> Market state update. */
export interface LifecycleIndexedEvent extends IndexedEventBase {
  kind: 'activate' | 'freeze' | 'resolve' | 'close';
  outcome?: OutcomeIndex; // resolve only
}

/** Redeemed -> Redemption row (winning outcome). */
export interface RedeemIndexedEvent extends IndexedEventBase {
  kind: 'redeem';
  owner: string;
  outcome: OutcomeIndex; // resolved outcome being redeemed
  payout: bigint;
}

/** SetMinted / SetRedeemed -> volume-only bookkeeping (price-neutral). */
export interface SetIndexedEvent extends IndexedEventBase {
  kind: 'setMint' | 'setRedeem';
  owner: string;
  amount: bigint; // USDT in (mint) / out (redeem)
}

export type IndexedEvent =
  | MarketCreatedIndexedEvent
  | TradeIndexedEvent
  | LifecycleIndexedEvent
  | RedeemIndexedEvent
  | SetIndexedEvent;

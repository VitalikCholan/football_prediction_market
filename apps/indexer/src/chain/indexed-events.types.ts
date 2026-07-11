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
  | 'close'
  // ---- 1X2 (phase C) — parallel kinds so the persister routes them to the
  //      1X2 columns without disturbing the binary path. --------------------
  | 'created1x2'
  | 'trade1x2'
  | 'activate1x2'
  | 'freeze1x2'
  | 'resolve1x2'
  | 'redeem1x2'
  | 'close1x2'
  | 'setMint1x2'
  | 'setRedeem1x2';

/** On-chain resolved outcome index for a 1X2 market (null = unresolved/void). */
export type Outcome1x2Index = 0 | 1 | 2 | 'void' | null;

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
  usdtIn: bigint;
  usdtOut: bigint;
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

// ---------------------------------------------------------------------------
// 1X2 indexed events (phase C). The `fixtureId` seeds the Market1x2 PDA via
// `findMarket1x2Pda`; the persister writes the 1X2 columns of the shared row.
// ---------------------------------------------------------------------------

/** init_market_1x2 -> Market1x2 row bootstrap (LMSR q/b + opening prices). */
export interface Market1x2CreatedIndexedEvent extends IndexedEventBase {
  kind: 'created1x2';
  config: string; // MarketConfig PDA (base58)
  b: bigint;
  q: [bigint, bigint, bigint]; // net tokens per outcome (includes seed offset)
  pricesBps: [number, number, number]; // opening softmax prices
}

/** A 1X2 Buy or Sell -> one Trade row + PricePoint + VolumePoint. */
export interface Trade1x2IndexedEvent extends IndexedEventBase {
  kind: 'trade1x2';
  trader: string;
  outcome: 0 | 1 | 2; // 0 = Team1, 1 = Draw, 2 = Team2
  isBuy: boolean;
  usdt: bigint;
  tokens: bigint;
  feeBps: number;
  priceBps: number; // post-trade price of the traded outcome
}

/** activate/freeze/resolve/close of a 1X2 market -> Market1x2 state update. */
export interface Lifecycle1x2IndexedEvent extends IndexedEventBase {
  kind: 'activate1x2' | 'freeze1x2' | 'resolve1x2' | 'close1x2';
  outcome?: Outcome1x2Index; // resolve1x2 only
}

/** Redeemed1x2 -> Redemption row (winning outcome). */
export interface Redeem1x2IndexedEvent extends IndexedEventBase {
  kind: 'redeem1x2';
  owner: string;
  outcome: Outcome1x2Index; // resolved outcome being redeemed
  payout: bigint;
}

/** SetMinted1x2 / SetRedeemed1x2 -> volume-only bookkeeping (price-neutral). */
export interface Set1x2IndexedEvent extends IndexedEventBase {
  kind: 'setMint1x2' | 'setRedeem1x2';
  owner: string;
  amount: bigint; // USDT in (mint) / out (redeem)
}

export type IndexedEvent =
  | MarketCreatedIndexedEvent
  | TradeIndexedEvent
  | LifecycleIndexedEvent
  | RedeemIndexedEvent
  | Market1x2CreatedIndexedEvent
  | Trade1x2IndexedEvent
  | Lifecycle1x2IndexedEvent
  | Redeem1x2IndexedEvent
  | Set1x2IndexedEvent;

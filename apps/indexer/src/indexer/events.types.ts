/**
 * Decoded amm event shapes — field names mirror the IDL structs
 * (`target/idl/amm.json` `events` + `types`). Types only, no runtime deps.
 */

/** IDL `Outcome` enum: borsh u8 tag. */
export enum EventOutcome {
  Unset = 0,
  Yes = 1,
  No = 2,
  Void = 3,
}

export interface MarketCreatedEvent {
  name: 'MarketCreated';
  fixtureId: bigint;
  config: string;
  yesReserve: bigint;
  noReserve: bigint;
  priceBps: number;
}

export interface MarketActivatedEvent {
  name: 'MarketActivated';
  fixtureId: bigint;
  ts: bigint;
}

export interface MarketFrozenEvent {
  name: 'MarketFrozen';
  fixtureId: bigint;
  ts: bigint;
}

export interface MarketResolvedEvent {
  name: 'MarketResolved';
  fixtureId: bigint;
  outcome: EventOutcome;
}

export interface MarketClosedEvent {
  name: 'MarketClosed';
  fixtureId: bigint;
  swept: bigint;
}

export interface RedeemedEvent {
  name: 'Redeemed';
  fixtureId: bigint;
  owner: string;
  outcome: EventOutcome;
  payout: bigint;
}

export interface TradeEventData {
  name: 'Trade';
  fixtureId: bigint;
  owner: string;
  /** true = YES, false = NO. */
  sideYes: boolean;
  /** true = buy, false = sell. */
  isBuy: boolean;
  usdc: bigint;
  tokens: bigint;
  priceBps: number;
  feeBps: number;
}

export type AmmEvent =
  | MarketCreatedEvent
  | MarketActivatedEvent
  | MarketFrozenEvent
  | MarketResolvedEvent
  | MarketClosedEvent
  | RedeemedEvent
  | TradeEventData;

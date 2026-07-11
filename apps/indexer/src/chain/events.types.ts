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

// ---------------------------------------------------------------------------
// 1X2 events (phase C — parallel set; distinguished from binary by name).
// Field layouts mirror the `#[event]` structs in programs/amm/src/state.rs.
// ---------------------------------------------------------------------------

/** IDL `Outcome1x2` enum: borsh u8 tag. Unset = unresolved sentinel. */
export enum Event1x2Outcome {
  Unset = 0,
  Team1 = 1,
  Draw = 2,
  Team2 = 3,
  Void = 4,
}

export interface Market1x2CreatedEvent {
  name: 'Market1x2Created';
  fixtureId: bigint;
  config: string;
  b: bigint;
  q: [bigint, bigint, bigint];
  /** Opening softmax prices [Team1, Draw, Team2] in bps. */
  pricesBps: [number, number, number];
}

export interface Market1x2ActivatedEvent {
  name: 'Market1x2Activated';
  fixtureId: bigint;
  ts: bigint;
}

export interface Market1x2FrozenEvent {
  name: 'Market1x2Frozen';
  fixtureId: bigint;
  ts: bigint;
}

export interface Market1x2ResolvedEvent {
  name: 'Market1x2Resolved';
  fixtureId: bigint;
  outcome: Event1x2Outcome;
}

export interface Redeemed1x2Event {
  name: 'Redeemed1x2';
  fixtureId: bigint;
  owner: string;
  outcome: Event1x2Outcome;
  payout: bigint;
}

export interface Market1x2ClosedEvent {
  name: 'Market1x2Closed';
  fixtureId: bigint;
  swept: bigint;
}

export interface Trade1x2EventData {
  name: 'Trade1x2';
  fixtureId: bigint;
  owner: string;
  /** Traded outcome index: 0 = Team1, 1 = Draw, 2 = Team2. */
  outcome: number;
  /** true = buy, false = sell. */
  isBuy: boolean;
  usdc: bigint;
  tokens: bigint;
  /** Post-trade softmax price (bps) of the traded outcome. */
  priceBps: number;
  feeBps: number;
}

export interface SetMinted1x2Event {
  name: 'SetMinted1x2';
  fixtureId: bigint;
  owner: string;
  /** Base-unit tokens of each outcome minted = USDT deposited. */
  amount: bigint;
}

export interface SetRedeemed1x2Event {
  name: 'SetRedeemed1x2';
  fixtureId: bigint;
  owner: string;
  /** Base-unit tokens of each outcome burned = USDT paid out. */
  amount: bigint;
}

export type AmmEvent =
  | MarketCreatedEvent
  | MarketActivatedEvent
  | MarketFrozenEvent
  | MarketResolvedEvent
  | MarketClosedEvent
  | RedeemedEvent
  | TradeEventData
  | Market1x2CreatedEvent
  | Market1x2ActivatedEvent
  | Market1x2FrozenEvent
  | Market1x2ResolvedEvent
  | Redeemed1x2Event
  | Market1x2ClosedEvent
  | Trade1x2EventData
  | SetMinted1x2Event
  | SetRedeemed1x2Event;

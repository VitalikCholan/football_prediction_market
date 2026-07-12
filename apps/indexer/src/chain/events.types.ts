/**
 * Decoded amm event shapes — field names mirror the IDL structs
 * (`target/idl/amm.json` `events` + `types`). Types only, no runtime deps.
 *
 * The program has ONE market type: a 3-way (1X2) LMSR market. Every event below
 * carries the canonical 3-way shape (`outcome ∈ {Team1, Draw, Team2}`, `q[3]`,
 * `prices_bps[3]`). The former binary YES/NO events are gone.
 */

/** IDL `Outcome` enum: borsh u8 tag. `Unset` is the unresolved sentinel. */
export enum EventOutcome {
  Unset = 0,
  Team1 = 1,
  Draw = 2,
  Team2 = 3,
  Void = 4,
}

export interface MarketCreatedEvent {
  name: 'MarketCreated';
  fixtureId: bigint;
  config: string;
  /** LMSR liquidity parameter b (u64 base units). */
  b: bigint;
  /** Net tokens per outcome [Team1, Draw, Team2] (includes seed offsets). */
  q: [bigint, bigint, bigint];
  /** Opening softmax prices [Team1, Draw, Team2] in bps. */
  pricesBps: [number, number, number];
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
  /** Traded outcome index: 0 = Team1, 1 = Draw, 2 = Team2. */
  outcome: number;
  /** true = buy, false = sell. */
  isBuy: boolean;
  usdt: bigint;
  tokens: bigint;
  /** Post-trade softmax price (bps) of the traded outcome. */
  priceBps: number;
  feeBps: number;
}

export interface SetMintedEvent {
  name: 'SetMinted';
  fixtureId: bigint;
  owner: string;
  /** Base-unit tokens of each outcome minted = USDT deposited. */
  amount: bigint;
}

export interface SetRedeemedEvent {
  name: 'SetRedeemed';
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
  | SetMintedEvent
  | SetRedeemedEvent;

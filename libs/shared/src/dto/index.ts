/**
 * REST contract DTOs (single source of truth for indexer + web).
 *
 * See backend-plan.md §4 for the full contract. Large integers (u64/u128 token
 * amounts) serialize as strings — JS `number` cannot hold them safely. Imported
 * by NestJS via `nestjs-zod` (createZodDto + global ZodValidationPipe) and by the
 * web app for typed fetches.
 */
import { z } from "zod";

export const MarketState = z.enum([
  "Open",
  "Trading",
  "Locked",
  "Resolved",
  "Closed",
]);
export type MarketState = z.infer<typeof MarketState>;

/** The outcome a trade was placed on (mirrors the on-chain `Trade` event's
 *  `outcome: u8` — 0=Team1, 1=Draw, 2=Team2). Never Void/Unset (no trades). */
export const TradeOutcome = z.enum(["Team1", "Draw", "Team2"]);
export type TradeOutcome = z.infer<typeof TradeOutcome>;

/**
 * Resolved outcome of a market (mirrors on-chain `Outcome`, minus the
 * unresolved `Unset` sentinel which surfaces as a null `outcome`). `Void`
 * triggers a pro-rata refund (D-4).
 */
export const Outcome = z.enum(["Team1", "Draw", "Team2", "Void"]);
export type Outcome = z.infer<typeof Outcome>;

/** Trade action recorded by the indexer from Buy/Sell program events. */
export const TradeAction = z.enum(["buy", "sell"]);
export type TradeAction = z.infer<typeof TradeAction>;

/**
 * A single 3-way (1X2) LMSR market as returned by GET /markets/:id and (as a
 * list element) by GET /markets. Denormalized snapshot mirroring the on-chain
 * `Market` PDA. Prices are the LMSR softmax of `q/b` and sum to ~10_000 bps by
 * construction. u64 fields (`supply`, `b`) serialize as strings.
 */
export const MarketDto = z.object({
  id: z.string(), // Market PDA (base58)
  fixtureId: z.string(), // i64 fixture id, as string
  configId: z.string(), // MarketConfig PDA (base58)
  state: MarketState,
  // Softmax prices per outcome (bps 0..10_000); the three sum to ~10_000.
  team1PriceBps: z.number().int().min(0).max(10_000),
  drawPriceBps: z.number().int().min(0).max(10_000),
  team2PriceBps: z.number().int().min(0).max(10_000),
  // Outstanding USER token supply per outcome (u64 base units, as strings).
  team1Supply: z.string(),
  drawSupply: z.string(),
  team2Supply: z.string(),
  // LMSR liquidity parameter b (u64 base units, as string).
  b: z.string(),
  baseFeeBps: z.number().int().nullable(),
  currentFeeBps: z.number().int().nullable(),
  totalVolume: z.string(),
  homeTeam: z.string().nullable(),
  awayTeam: z.string().nullable(),
  competition: z.string().nullable(),
  competitionId: z.number().int().nullable(),
  kickoffTs: z.number().int().nullable(),
  freezeTs: z.number().int().nullable(),
  // Live/final match score + status from the TxLINE scores snapshot.
  homeScore: z.number().int().nullable(),
  awayScore: z.number().int().nullable(),
  statusId: z.number().int().nullable(), // TxLINE StatusId (100 = finalised)
  matchClock: z.string().nullable(), // human clock e.g. "77:26"
  gameState: z.string().nullable(),
  // Reference 1X2 odds (implied probabilities, bps) from the demargined feed.
  marketOdds: z
    .object({
      homeBps: z.number().int(),
      drawBps: z.number().int(),
      awayBps: z.number().int(),
      ts: z.number().int().nullable(), // odds snapshot ts (ms epoch)
    })
    .nullable(),
  outcome: Outcome.nullable(), // null while unresolved (on-chain Unset)
  updatedSlot: z.number().int(),
  updatedAt: z.number().int(), // unix seconds
});
export type MarketDto = z.infer<typeof MarketDto>;

/** Query params for GET /markets. */
export const MarketListQuery = z.object({
  state: MarketState.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export type MarketListQuery = z.infer<typeof MarketListQuery>;

/** GET /markets envelope. */
export const MarketListDto = z.object({
  markets: z.array(MarketDto),
  total: z.number().int(),
});
export type MarketListDto = z.infer<typeof MarketListDto>;

/**
 * Per-user position snapshot (mirrors on-chain `Position`). Token balances are
 * u64 base units serialized as strings.
 */
export const PositionDto = z.object({
  market: z.string(), // Market PDA (base58)
  owner: z.string(), // owner wallet (base58)
  team1Tokens: z.string(),
  drawTokens: z.string(),
  team2Tokens: z.string(),
  collateral: z.string(), // net USDT basis deposited (u64, as string)
  redeemed: z.boolean(),
});
export type PositionDto = z.infer<typeof PositionDto>;

/** A single point in a market price/volume series (lightweight-charts shape). */
export const HistoryPointDto = z.object({
  time: z.number().int(), // unix seconds (UTCTimestamp)
  // LMSR softmax prices per outcome (bps, 0..=10_000), sum ~10_000.
  team1PriceBps: z.number().int().min(0).max(10_000),
  drawPriceBps: z.number().int().min(0).max(10_000),
  team2PriceBps: z.number().int().min(0).max(10_000),
  volume: z.string(),
});
export type HistoryPointDto = z.infer<typeof HistoryPointDto>;

/** Query params for GET /markets/:id/history. */
export const HistoryQuery = z.object({
  from: z.coerce.number().int().optional(), // unix seconds
  to: z.coerce.number().int().optional(),
  resolution: z.enum(["1m", "5m", "1h", "raw"]).default("5m"),
});
export type HistoryQuery = z.infer<typeof HistoryQuery>;

/** GET /markets/:id/history response. */
export const HistoryResponseDto = z.object({
  marketId: z.string(),
  resolution: z.string(),
  points: z.array(HistoryPointDto),
});
export type HistoryResponseDto = z.infer<typeof HistoryResponseDto>;

/** A single trade as returned to the web app (from the `trades` table). */
export const TradeDto = z.object({
  signature: z.string(),
  trader: z.string(),
  outcome: TradeOutcome,
  action: TradeAction,
  usdtAmount: z.string(),
  tokensAmount: z.string(),
  feeBps: z.number().int(),
  // Post-trade softmax price (bps) of the traded outcome (mirrors `Trade.price_bps`).
  priceBps: z.number().int().min(0).max(10_000),
  time: z.number().int(), // unix seconds
});
export type TradeDto = z.infer<typeof TradeDto>;

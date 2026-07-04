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

export const Side = z.enum(["YES", "NO"]);
export type Side = z.infer<typeof Side>;

/** Trade action recorded by the indexer from Buy/Sell program events. */
export const TradeAction = z.enum(["buy", "sell"]);
export type TradeAction = z.infer<typeof TradeAction>;

/**
 * A single market as returned by GET /markets/:id and (as a list element) by
 * GET /markets. Denormalized snapshot mirroring the on-chain Market PDA.
 */
export const MarketDto = z.object({
  id: z.string(), // market PDA (base58)
  fixtureId: z.string(), // i64 fixture id, as string
  configId: z.string(), // MarketConfig PDA (base58)
  state: MarketState,
  yesPriceBps: z.number().int().min(0).max(10_000),
  yesReserve: z.string(), // u64 base units as string
  noReserve: z.string(),
  yesSupply: z.string(), // outstanding YES token supply
  noSupply: z.string(),
  baseFeeBps: z.number().int().nullable(),
  currentFeeBps: z.number().int().nullable(),
  totalVolume: z.string(),
  homeTeam: z.string().nullable(),
  awayTeam: z.string().nullable(),
  kickoffTs: z.number().int().nullable(),
  freezeTs: z.number().int().nullable(),
  outcome: Side.nullable(),
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

/** A single point in a market price/volume series (lightweight-charts shape). */
export const HistoryPointDto = z.object({
  time: z.number().int(), // unix seconds (UTCTimestamp)
  yesPriceBps: z.number().int().min(0).max(10_000),
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
  side: Side,
  action: TradeAction,
  usdcAmount: z.string(),
  tokensAmount: z.string(),
  feeBps: z.number().int(),
  yesPriceBps: z.number().int().min(0).max(10_000),
  time: z.number().int(), // unix seconds
});
export type TradeDto = z.infer<typeof TradeDto>;

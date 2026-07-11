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

/**
 * Market kind discriminant. "Binary" = v0 YES/NO CPMM (mirrors on-chain
 * `market_kind = 0`); "OneXTwo" = 3-way 1X2 LMSR (`market_kind = 1`). The list
 * endpoint keys its union on this field; `MarketDto` defaults it to "Binary" so
 * pre-existing binary payloads (which omit it) still parse unchanged.
 */
export const MarketKind = z.enum(["Binary", "OneXTwo"]);
export type MarketKind = z.infer<typeof MarketKind>;

/**
 * Resolved outcome of a 1X2 market (mirrors on-chain `Outcome1x2`, minus the
 * unresolved `Unset` sentinel which surfaces as a null `outcome1x2`). `Void`
 * triggers a pro-rata refund (D-4).
 */
export const Outcome1x2 = z.enum(["Team1", "Draw", "Team2", "Void"]);
export type Outcome1x2 = z.infer<typeof Outcome1x2>;

/** Trade action recorded by the indexer from Buy/Sell program events. */
export const TradeAction = z.enum(["buy", "sell"]);
export type TradeAction = z.infer<typeof TradeAction>;

/**
 * A single market as returned by GET /markets/:id and (as a list element) by
 * GET /markets. Denormalized snapshot mirroring the on-chain Market PDA.
 */
export const MarketDto = z.object({
  // Discriminant for the GET /markets union. Optional + Binary-only so existing
  // binary payloads that omit the field still validate AND existing producers
  // (indexer) that build a MarketDto without it still typecheck (back-compat).
  marketKind: z.literal("Binary").optional(),
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
  // Competition enrichment from the TxLINE fixtures snapshot (e.g. "World Cup").
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
  outcome: Side.nullable(),
  updatedSlot: z.number().int(),
  updatedAt: z.number().int(), // unix seconds
});
export type MarketDto = z.infer<typeof MarketDto>;

/**
 * A single 3-way (1X2) LMSR market. Denormalized snapshot mirroring the
 * on-chain `Market1x2` PDA. Prices are the LMSR softmax of `q/b` and sum to
 * ~10_000 bps by construction. u64 fields (`supply`, `b`) serialize as strings.
 */
export const Market1x2Dto = z.object({
  marketKind: z.literal("OneXTwo"), // discriminant for the GET /markets union
  id: z.string(), // Market1x2 PDA (base58)
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
  outcome1x2: Outcome1x2.nullable(), // null while unresolved (on-chain Unset)
  updatedSlot: z.number().int(),
  updatedAt: z.number().int(), // unix seconds
});
export type Market1x2Dto = z.infer<typeof Market1x2Dto>;

/**
 * Union of every market shape returned by the list/detail endpoints. Keyed on
 * `marketKind`, but a plain (non-discriminated) union so a binary payload that
 * OMITS `marketKind` still parses as `MarketDto` (back-compat) — a
 * discriminatedUnion would reject the missing discriminant. Branch order:
 * binary first (its required `yes*` fields exclude 1X2 payloads), then 1X2
 * (its `marketKind: "OneXTwo"` literal + `team*` fields exclude binary).
 */
export const AnyMarketDto = z.union([MarketDto, Market1x2Dto]);
export type AnyMarketDto = z.infer<typeof AnyMarketDto>;

/** Query params for GET /markets. */
export const MarketListQuery = z.object({
  state: MarketState.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export type MarketListQuery = z.infer<typeof MarketListQuery>;

/**
 * GET /markets envelope (binary markets — unchanged v0 shape, back-compat).
 * Existing binary-only consumers keep this narrow type.
 */
export const MarketListDto = z.object({
  markets: z.array(MarketDto),
  total: z.number().int(),
});
export type MarketListDto = z.infer<typeof MarketListDto>;

/**
 * GET /markets envelope for a MIXED grid of binary + 1X2 markets. Opt-in union
 * shape — consumers that want to render both kinds validate against this; the
 * legacy `MarketListDto` stays binary-only so existing web/indexer code is
 * untouched. The indexer can serve this once it emits 1X2 rows (C2 wave 2+).
 */
export const AnyMarketListDto = z.object({
  markets: z.array(AnyMarketDto),
  total: z.number().int(),
});
export type AnyMarketListDto = z.infer<typeof AnyMarketListDto>;

/**
 * Per-user 1X2 position snapshot (mirrors on-chain `Position1x2`). Token
 * balances are u64 base units serialized as strings.
 */
export const Position1x2Dto = z.object({
  market: z.string(), // Market1x2 PDA (base58)
  owner: z.string(), // owner wallet (base58)
  team1Tokens: z.string(),
  drawTokens: z.string(),
  team2Tokens: z.string(),
  collateral: z.string(), // net USDT basis deposited (u64, as string)
  redeemed: z.boolean(),
});
export type Position1x2Dto = z.infer<typeof Position1x2Dto>;

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

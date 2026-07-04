/**
 * Demo fixtures — concrete sample data from the wireframe, shaped EXACTLY to
 * the shared zod DTOs (`@fpm/shared`) so the whole app renders standalone for
 * the demo without the indexer running. `lib/data.ts` swaps to live fetch via
 * NEXT_PUBLIC_USE_LIVE_DATA.
 *
 * u64/u128 fields are strings of base units. USDC has 6 decimals, so
 * "842000000000" = $842,000. yesPriceBps is 0–10000 (46¢ = 4600 bps).
 */
import type {
  MarketDto,
  MarketListDto,
  HistoryResponseDto,
  HistoryPointDto,
  TradeDto,
} from "@fpm/shared";

const HOUR = 3600;
const now = 1_720_000_000; // fixed demo epoch (deterministic screen recordings)

const usdcBase = (dollars: number): string =>
  Math.round(dollars * 1_000_000).toString();

/** Build a plausible YES-price history walk ending near `endBps`. */
function makeHistory(
  marketId: string,
  endBps: number,
  points = 72,
  spanSeconds = 3 * HOUR,
): HistoryResponseDto {
  const step = Math.floor(spanSeconds / points);
  const out: HistoryPointDto[] = [];
  let bps = endBps - 800; // start lower, drift up to end
  let seed = endBps; // deterministic pseudo-random
  for (let i = 0; i < points; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    const noise = ((seed % 200) - 100) * 1.3;
    const drift = (800 * i) / points;
    bps = Math.max(600, Math.min(9400, endBps - 800 + drift + noise));
    out.push({
      time: now - spanSeconds + i * step,
      yesPriceBps: Math.round(bps),
      volume: usdcBase(2000 + (seed % 9000)),
    });
  }
  out[out.length - 1] = { ...out[out.length - 1], yesPriceBps: endBps };
  return { marketId, resolution: "5m", points: out };
}

// ---------------------------------------------------------------------------
// Markets (mirroring wireframe sample data)
// ---------------------------------------------------------------------------

export const MARKETS: MarketDto[] = [
  {
    id: "BRAvARG",
    fixtureId: "100234",
    configId: "CfgWorldCup",
    state: "Trading",
    yesPriceBps: 4600, // Brazil 46¢
    yesReserve: usdcBase(540_000),
    noReserve: usdcBase(634_000),
    yesSupply: usdcBase(540_000),
    noSupply: usdcBase(634_000),
    baseFeeBps: 30,
    currentFeeBps: 62, // elevated (recent goal → volatility)
    totalVolume: usdcBase(842_000),
    homeTeam: "Brazil",
    awayTeam: "Argentina",
    kickoffTs: now - 55 * 60,
    freezeTs: now + 35 * 60,
    outcome: null,
    updatedSlot: 284_113_990,
    updatedAt: now,
  },
  {
    id: "FRAvESP",
    fixtureId: "100235",
    configId: "CfgWorldCup",
    state: "Trading",
    yesPriceBps: 5300, // France 53¢
    yesReserve: usdcBase(410_000),
    noReserve: usdcBase(364_000),
    yesSupply: usdcBase(410_000),
    noSupply: usdcBase(364_000),
    baseFeeBps: 30,
    currentFeeBps: 34,
    totalVolume: usdcBase(511_000),
    homeTeam: "France",
    awayTeam: "Spain",
    kickoffTs: now + 2 * HOUR,
    freezeTs: now + 4 * HOUR,
    outcome: null,
    updatedSlot: 284_113_940,
    updatedAt: now,
  },
  {
    id: "ENGvGER",
    fixtureId: "100236",
    configId: "CfgWorldCup",
    state: "Open",
    yesPriceBps: 4900,
    yesReserve: usdcBase(220_000),
    noReserve: usdcBase(229_000),
    yesSupply: usdcBase(220_000),
    noSupply: usdcBase(229_000),
    baseFeeBps: 30,
    currentFeeBps: 30,
    totalVolume: usdcBase(188_000),
    homeTeam: "England",
    awayTeam: "Germany",
    kickoffTs: now + 26 * HOUR,
    freezeTs: now + 28 * HOUR,
    outcome: null,
    updatedSlot: 284_113_900,
    updatedAt: now,
  },
  {
    id: "PORvNED",
    fixtureId: "100237",
    configId: "CfgWorldCup",
    state: "Trading",
    yesPriceBps: 4100,
    yesReserve: usdcBase(300_000),
    noReserve: usdcBase(360_000),
    yesSupply: usdcBase(300_000),
    noSupply: usdcBase(360_000),
    baseFeeBps: 30,
    currentFeeBps: 41,
    totalVolume: usdcBase(402_000),
    homeTeam: "Portugal",
    awayTeam: "Netherlands",
    kickoffTs: now - 20 * 60,
    freezeTs: now + 70 * 60,
    outcome: null,
    updatedSlot: 284_113_880,
    updatedAt: now,
  },
  {
    id: "CROvBEL",
    fixtureId: "100238",
    configId: "CfgWorldCup",
    state: "Resolved",
    yesPriceBps: 10000, // Croatia won → YES resolved to $1.00
    yesReserve: usdcBase(180_000),
    noReserve: usdcBase(200_000),
    yesSupply: usdcBase(180_000),
    noSupply: usdcBase(200_000),
    baseFeeBps: 30,
    currentFeeBps: null,
    totalVolume: usdcBase(377_000),
    homeTeam: "Croatia",
    awayTeam: "Belgium",
    kickoffTs: now - 6 * HOUR,
    freezeTs: now - 4 * HOUR,
    outcome: "YES",
    updatedSlot: 284_100_000,
    updatedAt: now - 4 * HOUR,
  },
  {
    id: "URUvKOR",
    fixtureId: "100239",
    configId: "CfgWorldCup",
    state: "Open",
    yesPriceBps: 6200,
    yesReserve: usdcBase(140_000),
    noReserve: usdcBase(86_000),
    yesSupply: usdcBase(140_000),
    noSupply: usdcBase(86_000),
    baseFeeBps: 30,
    currentFeeBps: 30,
    totalVolume: usdcBase(96_000),
    homeTeam: "Uruguay",
    awayTeam: "South Korea",
    kickoffTs: now + 48 * HOUR,
    freezeTs: now + 50 * HOUR,
    outcome: null,
    updatedSlot: 284_113_700,
    updatedAt: now,
  },
];

export const MARKET_LIST: MarketListDto = {
  markets: MARKETS,
  total: MARKETS.length,
};

const HISTORY: Record<string, HistoryResponseDto> = Object.fromEntries(
  MARKETS.map((m) => [m.id, makeHistory(m.id, m.yesPriceBps)]),
);

export function getFixtureMarket(id: string): MarketDto | undefined {
  return MARKETS.find((m) => m.id === id);
}

export function getFixtureHistory(id: string): HistoryResponseDto {
  return HISTORY[id] ?? { marketId: id, resolution: "5m", points: [] };
}

// ---------------------------------------------------------------------------
// Order book (per-market ladder for 1c sidebar). Not a shared DTO — UI only.
// ---------------------------------------------------------------------------

export interface OrderBookLevel {
  priceCents: number;
  shares: number;
}
export interface OrderBook {
  asks: OrderBookLevel[]; // sell YES
  bids: OrderBookLevel[]; // buy YES
  lastCents: number;
}

export function getOrderBook(m: MarketDto): OrderBook {
  const mid = Math.round(m.yesPriceBps / 100);
  const bids: OrderBookLevel[] = [];
  const asks: OrderBookLevel[] = [];
  for (let i = 1; i <= 5; i++) {
    bids.push({ priceCents: mid - i, shares: 400 + i * 220 + (i % 2) * 130 });
    asks.push({ priceCents: mid + i, shares: 360 + i * 180 + (i % 3) * 90 });
  }
  return { asks: asks.reverse(), bids, lastCents: mid };
}

// ---------------------------------------------------------------------------
// Outright market (World Cup Winner) — UI-only aggregate card (1b).
// ---------------------------------------------------------------------------

export interface OutrightEntry {
  team: string;
  cents: number;
}
export const OUTRIGHT: { title: string; entries: OutrightEntry[]; more: number } =
  {
    title: "World Cup Winner",
    entries: [
      { team: "Brazil", cents: 22 },
      { team: "France", cents: 18 },
      { team: "Argentina", cents: 15 },
      { team: "Spain", cents: 11 },
      { team: "England", cents: 9 },
    ],
    more: 13,
  };

// ---------------------------------------------------------------------------
// Portfolio (1e) — UI-only rows.
// ---------------------------------------------------------------------------

export interface PositionRowData {
  marketId: string;
  market: string;
  sub: string;
  live: boolean;
  outcome: string;
  side: "YES" | "NO";
  shares: number;
  avgCents: number;
  nowCents: number;
}

export const PORTFOLIO = {
  value: 3_412.8,
  cash: 1_240.0,
  inPositions: 2_172.8,
  allTimePnl: 512.4,
  positions: [
    {
      marketId: "BRAvARG",
      market: "Brazil vs Argentina",
      sub: "Live · 1–1",
      live: true,
      outcome: "Brazil",
      side: "YES" as const,
      shares: 640,
      avgCents: 41,
      nowCents: 46,
    },
    {
      marketId: "FRAvESP",
      market: "France vs Spain",
      sub: "Starts in 2h",
      live: false,
      outcome: "France",
      side: "YES" as const,
      shares: 300,
      avgCents: 55,
      nowCents: 53,
    },
    {
      marketId: "PORvNED",
      market: "Portugal vs Netherlands",
      sub: "Live · 0–1",
      live: true,
      outcome: "Netherlands",
      side: "NO" as const,
      shares: 220,
      avgCents: 52,
      nowCents: 59,
    },
    {
      marketId: "CROvBEL",
      market: "Croatia vs Belgium",
      sub: "Resolved · Croatia won",
      live: false,
      outcome: "Croatia",
      side: "YES" as const,
      shares: 400,
      avgCents: 63,
      nowCents: 100,
    },
  ] satisfies PositionRowData[],
};

// ---------------------------------------------------------------------------
// Leaderboard + activity (1f).
// ---------------------------------------------------------------------------

export interface LeaderRow {
  rank: number;
  name: string;
  volume: number;
  profit: number;
  you?: boolean;
}
export const LEADERBOARD: LeaderRow[] = [
  { rank: 1, name: "0xSamba", volume: 1_240_000, profit: 84_200 },
  { rank: 2, name: "pitchside.sol", volume: 980_400, profit: 61_050 },
  { rank: 3, name: "GolazoGwei", volume: 742_100, profit: 52_800 },
  { rank: 4, name: "tiki_taka", volume: 610_900, profit: 38_400 },
  { rank: 5, name: "ExpectedGoals", volume: 540_300, profit: 31_200 },
  { rank: 6, name: "midfield_maestro", volume: 402_000, profit: 24_900 },
  { rank: 7, name: "setpiece.sol", volume: 388_700, profit: 19_600 },
  { rank: 18, name: "You", volume: 96_400, profit: 4_120, you: true },
];

export interface ActivityItem {
  id: number;
  user: string;
  action: "bought" | "sold";
  outcome: string;
  cents: number;
  amount: number;
  ts: number;
}
export const ACTIVITY: ActivityItem[] = [
  { id: 1, user: "0xSamba", action: "bought", outcome: "Brazil", cents: 46, amount: 500, ts: now - 4 },
  { id: 2, user: "tiki_taka", action: "sold", outcome: "Spain", cents: 47, amount: 220, ts: now - 12 },
  { id: 3, user: "GolazoGwei", action: "bought", outcome: "France", cents: 53, amount: 1_000, ts: now - 26 },
  { id: 4, user: "pitchside.sol", action: "bought", outcome: "Netherlands", cents: 59, amount: 340, ts: now - 41 },
  { id: 5, user: "ExpectedGoals", action: "sold", outcome: "Argentina", cents: 24, amount: 180, ts: now - 58 },
  { id: 6, user: "setpiece.sol", action: "bought", outcome: "Brazil", cents: 45, amount: 90, ts: now - 73 },
  { id: 7, user: "midfield_maestro", action: "bought", outcome: "Croatia", cents: 63, amount: 610, ts: now - 96 },
];

// Recent trades for a market detail (maps to TradeDto).
export function getFixtureTrades(m: MarketDto): TradeDto[] {
  const base = m.yesPriceBps;
  return Array.from({ length: 6 }, (_, i) => ({
    signature: `sig${m.id}${i}`,
    trader: ["0xSamba", "tiki_taka", "GolazoGwei", "setpiece.sol"][i % 4],
    side: (i % 3 === 0 ? "NO" : "YES") as TradeDto["side"],
    action: (i % 2 === 0 ? "buy" : "sell") as TradeDto["action"],
    usdcAmount: usdcBase([500, 220, 90, 1000, 340, 180][i]),
    tokensAmount: usdcBase([1080, 470, 190, 2100, 720, 380][i]),
    feeBps: m.currentFeeBps ?? 30,
    yesPriceBps: Math.max(600, Math.min(9400, base + (i - 3) * 40)),
    time: now - i * 18,
  }));
}

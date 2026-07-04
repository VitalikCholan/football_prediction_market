/**
 * Data layer — one seam between the demo fixtures and the live indexer REST.
 *
 * Flip NEXT_PUBLIC_USE_LIVE_DATA=true (and set NEXT_PUBLIC_INDEXER_URL) to fetch
 * the real indexer; otherwise the app renders entirely from fixtures so it works
 * standalone for the demo. Every live response is parsed with the shared zod
 * DTOs (`@fpm/shared`) — the single source of truth for the REST contract — so
 * a shape mismatch fails loud instead of corrupting the UI.
 */
import {
  MarketDto,
  MarketListDto,
  HistoryResponseDto,
  type MarketListQuery,
} from "@fpm/shared";
import {
  MARKET_LIST,
  getFixtureMarket,
  getFixtureHistory,
} from "@/lib/fixtures";

const USE_LIVE = process.env.NEXT_PUBLIC_USE_LIVE_DATA === "true";
const BASE = process.env.NEXT_PUBLIC_INDEXER_URL ?? "";

async function getJson<T>(
  path: string,
  schema: { parse: (v: unknown) => T },
): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { next: { revalidate: 5 } });
  if (!res.ok) throw new Error(`Indexer ${res.status} for ${path}`);
  return schema.parse(await res.json());
}

/** GET /markets — list of markets. */
export async function fetchMarkets(
  query?: Partial<MarketListQuery>,
): Promise<MarketListDto> {
  if (!USE_LIVE) {
    let markets = MARKET_LIST.markets;
    if (query?.state) markets = markets.filter((m) => m.state === query.state);
    return MarketListDto.parse({ markets, total: markets.length });
  }
  const params = new URLSearchParams();
  if (query?.state) params.set("state", query.state);
  if (query?.limit) params.set("limit", String(query.limit));
  if (query?.offset) params.set("offset", String(query.offset));
  const qs = params.toString();
  return getJson(`/markets${qs ? `?${qs}` : ""}`, MarketListDto);
}

/** GET /markets/:id — single market. Returns null when not found. */
export async function fetchMarket(id: string): Promise<MarketDto | null> {
  if (!USE_LIVE) {
    const m = getFixtureMarket(id);
    return m ? MarketDto.parse(m) : null;
  }
  const res = await fetch(`${BASE}/markets/${id}`, { next: { revalidate: 5 } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Indexer ${res.status} for /markets/${id}`);
  return MarketDto.parse(await res.json());
}

/** GET /markets/:id/history — price/volume series for the hero chart. */
export async function fetchHistory(id: string): Promise<HistoryResponseDto> {
  if (!USE_LIVE) return HistoryResponseDto.parse(getFixtureHistory(id));
  return getJson(`/markets/${id}/history`, HistoryResponseDto);
}

export const dataMode = USE_LIVE ? "live" : "demo";

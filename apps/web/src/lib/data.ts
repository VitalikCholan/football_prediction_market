/**
 * Data layer — the single seam to the live indexer REST. There is no demo
 * mode: the app is always backed by the real indexer (`NEXT_PUBLIC_INDEXER_URL`)
 * plus direct on-chain reads. Every response is parsed with the shared zod DTOs
 * (`@fpm/shared`) — the source of truth for the REST contract — so a shape
 * mismatch fails loud instead of corrupting the UI.
 *
 * Graceful degradation: with no fixture fallback, an unreachable indexer must
 * NOT crash SSR. List/detail fetches catch network errors and return an empty
 * result (the UI renders an "indexer offline" empty state) rather than throwing
 * a 500.
 */
import {
  HistoryResponseDto,
  MarketDto,
  MarketListDto,
  type MarketListQuery,
} from "@fpm/shared";

const BASE = process.env.NEXT_PUBLIC_INDEXER_URL ?? "";

/** Server components use the 5s revalidate cache; client polls bypass it. */
export interface FetchOpts {
  fresh?: boolean;
}

function fetchInit(opts?: FetchOpts): RequestInit {
  return opts?.fresh
    ? { cache: "no-store" }
    : { next: { revalidate: 5 } };
}

async function getJson<T>(
  path: string,
  schema: { parse: (v: unknown) => T },
  opts?: FetchOpts,
): Promise<T> {
  const res = await fetch(`${BASE}${path}`, fetchInit(opts));
  if (!res.ok) throw new Error(`Indexer ${res.status} for ${path}`);
  return schema.parse(await res.json());
}

/** Result of a market-list fetch, with an offline flag for graceful degradation. */
export interface MarketsResult extends MarketListDto {
  /** True when the indexer could not be reached (empty list is a real state). */
  offline: boolean;
}

/**
 * GET /markets — list of markets. Never throws: on a network/parse failure it
 * returns an empty list flagged `offline` so SSR renders an empty state.
 */
export async function fetchMarkets(
  query?: Partial<MarketListQuery>,
  opts?: FetchOpts,
): Promise<MarketsResult> {
  const params = new URLSearchParams();
  if (query?.state) params.set("state", query.state);
  if (query?.limit) params.set("limit", String(query.limit));
  if (query?.offset) params.set("offset", String(query.offset));
  const qs = params.toString();
  try {
    const list = await getJson(
      `/markets${qs ? `?${qs}` : ""}`,
      MarketListDto,
      opts,
    );
    // Hide no-feed markets from listings: a fixture whose TxLINE feed never
    // yields team names (homeTeam null) renders as "Fixture <id> · ? – ?" and
    // carries no match context, so it's noise in the grid. The market still
    // exists on-chain and is reachable by direct URL (fetchMarket) — this is a
    // presentation filter, not a data one.
    const markets = list.markets.filter((m) => m.homeTeam);
    const hidden = list.markets.length - markets.length;
    return { ...list, markets, total: list.total - hidden, offline: false };
  } catch {
    return { markets: [], total: 0, offline: true };
  }
}

/**
 * GET /markets/:id — single market. Returns null when not found OR when the
 * indexer is unreachable (the page maps null → notFound, never a 500).
 */
export async function fetchMarket(
  id: string,
  opts?: FetchOpts,
): Promise<MarketDto | null> {
  try {
    const res = await fetch(`${BASE}/markets/${id}`, fetchInit(opts));
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Indexer ${res.status} for /markets/${id}`);
    return MarketDto.parse(await res.json());
  } catch {
    return null;
  }
}

/**
 * GET /markets/:id/history — price/volume series for the hero chart. Returns an
 * empty series on failure so the chart degrades to a flat/empty state.
 */
export async function fetchHistory(
  id: string,
  opts?: FetchOpts,
): Promise<HistoryResponseDto> {
  try {
    return await getJson(`/markets/${id}/history`, HistoryResponseDto, opts);
  } catch {
    return { marketId: id, resolution: "1h", points: [] };
  }
}

import { request } from "undici";
import type { KeeperConfig } from "../config.ts";
import { log } from "../log.ts";
import type { TxlineAuth } from "./auth.ts";

/**
 * TxLINE StablePrice odds -> implied P(home win).
 *
 * Ported from scripts/seed-markets.ts `fetchOddsImplied`, reusing the keeper's
 * TxlineAuth. Reads `GET /api/odds/snapshot/{fixtureId}` and takes the freshest
 * full-time match-winner (1X2) home-side `Pct` (already a vig-free implied
 * probability, e.g. "52.632"). The devnet WC odds feed is frequently empty, so
 * a null return (no quote) tells the caller to fall back to 50/50.
 *
 * Never throws — odds are a nice-to-have, never a reason to block seeding.
 */
export async function fetchImpliedHomeProb(
  config: KeeperConfig,
  auth: TxlineAuth,
  fixtureId: bigint,
  clamp?: { minProb: number; maxProb: number },
): Promise<number | null> {
  try {
    const headers = await auth.headers();
    const url = `${config.txlineBaseUrl}/api/odds/snapshot/${fixtureId.toString()}`;
    const res = await request(url, { method: "GET", headers });
    if (res.statusCode >= 300) {
      await res.body.dump();
      return null;
    }
    const arr = (await res.body.json()) as unknown;
    if (!Array.isArray(arr) || arr.length === 0) return null;

    const isHomeName = (n: string) => /^(home|1|p1|participant\s*1)$/i.test(n.trim());
    let best: { ts: number; pct: number } | null = null;
    for (const row of arr) {
      const o = row as Record<string, unknown>;
      const names = (o.PriceNames ?? o.priceNames) as unknown;
      const pcts = (o.Pct ?? o.pct) as unknown;
      if (!Array.isArray(names) || !Array.isArray(pcts)) continue;
      const idx = names.findIndex((n) => typeof n === "string" && isHomeName(n));
      if (idx < 0) continue;
      const raw = pcts[idx];
      const pct =
        typeof raw === "number"
          ? raw
          : typeof raw === "string" && raw.toUpperCase() !== "NA"
            ? Number.parseFloat(raw)
            : NaN;
      if (!Number.isFinite(pct) || pct <= 0 || pct >= 100) continue;
      const ts = Number(o.Ts ?? o.ts ?? 0);
      if (!best || ts > best.ts) best = { ts, pct };
    }
    if (!best) return null;
    const p = best.pct / 100;
    if (!clamp) return p;
    return Math.min(clamp.maxProb, Math.max(clamp.minProb, p));
  } catch (err) {
    log.debug({ fixtureId: fixtureId.toString(), err }, "auto-seed: odds fetch failed — 50/50 fallback");
    return null;
  }
}

/**
 * TxLINE StablePrice odds -> demargined implied probabilities for the three
 * 1X2 outcomes `[P(Team1/home), P(Draw), P(Team2/away)]`.
 *
 * Mirrors scripts/seed-markets.ts `fetch1x2Implied`, reusing the keeper's
 * TxlineAuth. Uses the `Pct` field (already vig-free). Returns null when no
 * full-time 1X2 quote is available (the devnet WC feed is frequently empty —
 * the caller then falls back to symmetric seeding). Never throws.
 */
export async function fetchImplied1x2(
  config: KeeperConfig,
  auth: TxlineAuth,
  fixtureId: bigint,
): Promise<[number, number, number] | null> {
  try {
    const headers = await auth.headers();
    const url = `${config.txlineBaseUrl}/api/odds/snapshot/${fixtureId.toString()}`;
    const res = await request(url, { method: "GET", headers });
    if (res.statusCode >= 300) {
      await res.body.dump();
      return null;
    }
    const arr = (await res.body.json()) as unknown;
    if (!Array.isArray(arr) || arr.length === 0) return null;

    const isHome = (n: string) => /^(home|1|p1|participant\s*1)$/i.test(n.trim());
    const isDraw = (n: string) => /^(draw|x|tie)$/i.test(n.trim());
    const isAway = (n: string) => /^(away|2|p2|participant\s*2)$/i.test(n.trim());

    let best: { ts: number; probs: [number, number, number] } | null = null;
    for (const row of arr) {
      const o = row as Record<string, unknown>;
      const names = (o.PriceNames ?? o.priceNames) as unknown;
      const pcts = (o.Pct ?? o.pct) as unknown;
      if (!Array.isArray(names) || !Array.isArray(pcts)) continue;

      const pick = (test: (n: string) => boolean): number | null => {
        const idx = names.findIndex((n) => typeof n === "string" && test(n));
        if (idx < 0) return null;
        const raw = pcts[idx];
        const pct =
          typeof raw === "number"
            ? raw
            : typeof raw === "string" && raw.toUpperCase() !== "NA"
              ? Number.parseFloat(raw)
              : NaN;
        return Number.isFinite(pct) && pct > 0 && pct < 100 ? pct / 100 : null;
      };
      const h = pick(isHome);
      const d = pick(isDraw);
      const a = pick(isAway);
      if (h == null || d == null || a == null) continue; // need a full 3-way quote
      const ts = Number(o.Ts ?? o.ts ?? 0);
      if (!best || ts > best.ts) best = { ts, probs: [h, d, a] };
    }
    return best ? best.probs : null;
  } catch (err) {
    log.debug({ fixtureId: fixtureId.toString(), err }, "auto-seed: 1X2 odds fetch failed — symmetric seed");
    return null;
  }
}

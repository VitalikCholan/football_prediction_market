import { Injectable, Logger } from '@nestjs/common';
import { createGunzip } from 'node:zlib';
import { buffer } from 'node:stream/consumers';
import { request } from 'undici';
import { loadIndexerConfig, type IndexerConfig } from './ingest.config';

/**
 * TxLINE fixture -> team-name enrichment for market cards.
 *
 * On-chain the Market carries only `fixture_id`; the web renders
 * `homeTeam ?? "Fixture <id>"`. This service resolves fixture_id -> participant
 * names via the TxLINE fixtures API so the DB columns get populated once.
 *
 * Resilience contract: `getTeams` NEVER throws. Any auth/network/miss returns
 * null (logged at warn) so a flaky feed never blocks the indexer. Results
 * (including negative lookups) are memoized in-process so the 15s poll doesn't
 * hammer the API — enrichment is one-shot per fixture per process.
 *
 * Two sources, both authed (mirrors the keeper's working pattern — see
 * apps/keeper/src/txline/{auth,fixtures,history}.ts, verified live 2026-07-04;
 * every data request needs `Authorization: Bearer <guest-jwt>` +
 * `X-Api-Token: <env token>`):
 *
 *   1. GET /api/fixtures/snapshot — a small moving window of upcoming/live
 *      fixtures with direct PascalCase name fields (Participant1/Participant2).
 *      Hits only if the fixture is currently featured.
 *   2. GET /api/scores/historical/{id} — SSE-framed replay of a finished match.
 *      A frame with Action "lineups" carries Lineups[0]/Lineups[1].preferredName
 *      = the two team names (Lineups[0] = Participant1; Participant1IsHome tells
 *      us which is home). This is how the two devnet fixtures resolve, since the
 *      snapshot window has already rolled past them.
 *
 * The public /api/schedule requires auth too (401 without a token), so there is
 * no usable no-auth fallback; without a token, enrichment is skipped (null).
 */

export interface FixtureTeams {
  home: string;
  away: string;
  competition?: string;
}

/** Live/final score pulled from the TxLINE scores snapshot. */
export interface FixtureScore {
  homeScore: number;
  awayScore: number;
  statusId: number | null; // TxLINE StatusId (100 = finalised)
  clock: string | null; // human clock e.g. "77:26"
  gameState: string | null;
}

/** Reference 1X2 odds (implied probabilities) from the demargined feed, in bps. */
export interface FixtureOdds {
  homeBps: number;
  drawBps: number;
  awayBps: number;
  ts: bigint | null; // snapshot ts (ms epoch)
}

interface GuestTokenResponse {
  token?: string;
  access_token?: string;
  jwt?: string;
  expires_in?: number;
  expiresIn?: number;
}

@Injectable()
export class FixturesService {
  private readonly logger = new Logger(FixturesService.name);
  private readonly config: IndexerConfig;

  /** fixtureId (string) -> resolved teams, or null for a known miss. */
  private readonly cache = new Map<string, FixtureTeams | null>();

  private jwt?: string;
  private jwtExpiresAt = 0; // epoch ms

  constructor() {
    this.config = loadIndexerConfig(process.env);
  }

  /**
   * Resolve team names for a fixture. Returns null on any miss or error — never
   * throws. Cached (positive and negative) for the process lifetime.
   */
  async getTeams(fixtureId: bigint): Promise<FixtureTeams | null> {
    const key = fixtureId.toString();
    if (this.cache.has(key)) return this.cache.get(key) ?? null;

    let teams: FixtureTeams | null = null;
    try {
      teams = await this.lookup(fixtureId);
    } catch (err) {
      this.logger.warn(
        `fixture ${key} enrichment failed: ${(err as Error).message}`,
      );
      teams = null;
    }
    this.cache.set(key, teams);
    if (teams) {
      this.logger.log(`enriched fixture ${key}: ${teams.home} vs ${teams.away}`);
    } else {
      this.logger.warn(`no team names found for fixture ${key}`);
    }
    return teams;
  }

  // ---- live score -----------------------------------------------------------

  /**
   * Latest score for a fixture from GET /api/scores/snapshot/{id}. Unlike team
   * names this is NOT cached — the caller controls refresh cadence (live markets
   * poll it; finished markets capture once). NEVER throws: any auth/network/miss
   * / empty-feed returns null.
   *
   * The snapshot is an array of per-action rows (ascending Ts). We take the most
   * authoritative row: prefer the last StatusId==100 (finalised) row, else the
   * last row overall. Goals come from the `Stats` map (key = period*1000+base;
   * base 1 = home goals, base 2 = away goals; period-0 keys "1"/"2" are the
   * running totals), with the `Score.*.Total.Goals` object as a fallback.
   */
  async getScore(fixtureId: bigint): Promise<FixtureScore | null> {
    if (!this.config.txlineApiToken) return null;
    try {
      const headers = await this.authHeaders();
      const url = `${this.config.txlineBaseUrl}/api/scores/snapshot/${fixtureId}`;
      const json = await this.getJson(url, headers);
      const rows = Array.isArray(json) ? (json as Record<string, unknown>[]) : [];
      if (rows.length === 0) return null;
      const finalised = rows.filter((r) => Number(r.StatusId) === 100);
      const row = (finalised.length > 0 ? finalised : rows)[
        (finalised.length > 0 ? finalised : rows).length - 1
      ];
      const goals = this.goalsFrom(row);
      if (!goals) return null;
      const statusId = Number.isFinite(Number(row.StatusId))
        ? Number(row.StatusId)
        : null;
      return {
        homeScore: goals.home,
        awayScore: goals.away,
        statusId,
        clock: this.clockOf(row.Clock),
        gameState: this.str(row.GameState) ?? null,
      };
    } catch (err) {
      this.logger.warn(
        `score fetch for fixture ${fixtureId} failed: ${(err as Error).message}`,
      );
      return null;
    }
  }

  /** Extract home/away goals from a snapshot row (Stats map first, Score fallback). */
  private goalsFrom(
    row: Record<string, unknown>,
  ): { home: number; away: number } | null {
    const stats = row.Stats as Record<string, unknown> | undefined;
    if (stats && typeof stats === 'object') {
      const home = this.num(stats['1']);
      const away = this.num(stats['2']);
      if (home != null || away != null) {
        return { home: home ?? 0, away: away ?? 0 };
      }
    }
    const score = row.Score as Record<string, unknown> | undefined;
    if (score && typeof score === 'object') {
      const home = this.totalGoals(score.Participant1);
      const away = this.totalGoals(score.Participant2);
      if (home != null || away != null) {
        return { home: home ?? 0, away: away ?? 0 };
      }
    }
    return null;
  }

  private totalGoals(participant: unknown): number | null {
    const total = (participant as Record<string, unknown> | undefined)?.Total as
      | Record<string, unknown>
      | undefined;
    return this.num(total?.Goals);
  }

  private clockOf(clock: unknown): string | null {
    const c = clock as Record<string, unknown> | undefined;
    const secs = this.num(c?.Seconds);
    if (secs == null) return null;
    const mm = Math.floor(secs / 60);
    const ss = secs % 60;
    return `${mm}:${ss.toString().padStart(2, '0')}`;
  }

  // ---- reference odds -------------------------------------------------------

  /**
   * Reference 1X2 odds from GET /api/odds/snapshot/{id}. StablePrice is
   * demargined, so the prices read as implied probabilities; we convert them to
   * basis points for home/draw/away. Picks the freshest full-time match-winner
   * (1X2) row. NEVER throws / cached-free like getScore; returns null on any
   * miss or empty feed (verified empty for the devnet demo fixtures).
   */
  async getOdds(fixtureId: bigint): Promise<FixtureOdds | null> {
    if (!this.config.txlineApiToken) return null;
    try {
      const headers = await this.authHeaders();
      const url = `${this.config.txlineBaseUrl}/api/odds/snapshot/${fixtureId}`;
      const json = await this.getJson(url, headers);
      const rows = Array.isArray(json) ? (json as Record<string, unknown>[]) : [];
      if (rows.length === 0) return null;

      // Prefer the freshest (max Ts) 1X2 row that yields three aligned prices.
      let best: FixtureOdds | null = null;
      let bestTs = -1n;
      for (const row of rows) {
        const parsed = this.parseOddsRow(row);
        if (!parsed) continue;
        const ts = parsed.ts ?? 0n;
        if (ts >= bestTs) {
          bestTs = ts;
          best = parsed;
        }
      }
      return best;
    } catch (err) {
      this.logger.warn(
        `odds fetch for fixture ${fixtureId} failed: ${(err as Error).message}`,
      );
      return null;
    }
  }

  /** Map one odds row's aligned PriceNames/Prices arrays to home/draw/away bps. */
  private parseOddsRow(row: Record<string, unknown>): FixtureOdds | null {
    const names = row.PriceNames;
    const prices = row.Prices;
    if (!Array.isArray(names) || !Array.isArray(prices)) return null;
    if (names.length !== prices.length) return null;

    let home: number | null = null;
    let draw: number | null = null;
    let away: number | null = null;
    for (let i = 0; i < names.length; i += 1) {
      const label = String(names[i]).trim().toLowerCase();
      const price = this.num(prices[i]);
      if (price == null) continue;
      // Demargined StablePrice reads as a probability in [0,1]; some feeds
      // express it as a percentage. Normalise both to basis points.
      const bps = Math.round((price <= 1 ? price : price / 100) * 10_000);
      if (label === 'home' || label === '1') home = bps;
      else if (label === 'draw' || label === 'x') draw = bps;
      else if (label === 'away' || label === '2') away = bps;
    }
    // Require a full 1X2 triple so we never publish a partial (soccer only).
    if (home == null || draw == null || away == null) return null;
    return { homeBps: home, drawBps: draw, awayBps: away, ts: this.tsOf(row.Ts) };
  }

  private tsOf(v: unknown): bigint | null {
    const n = this.num(v);
    if (n == null) return null;
    try {
      return BigInt(Math.trunc(n));
    } catch {
      return null;
    }
  }

  private num(v: unknown): number | null {
    if (v == null) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  // ---- lookup ---------------------------------------------------------------

  private async lookup(fixtureId: bigint): Promise<FixtureTeams | null> {
    if (!this.config.txlineApiToken) {
      this.logger.warn('TXLINE_API_TOKEN not set — skipping enrichment');
      return null;
    }
    // 1. Snapshot (direct names) for currently-featured fixtures.
    const fromSnapshot = await this.fromSnapshot(fixtureId);
    if (fromSnapshot) return fromSnapshot;
    // 2. Historical replay (lineups frame) for finished fixtures.
    return this.fromHistorical(fixtureId);
  }

  private async fromSnapshot(fixtureId: bigint): Promise<FixtureTeams | null> {
    const headers = await this.authHeaders();
    const url = `${this.config.txlineBaseUrl}/api/fixtures/snapshot`;
    const json = await this.getJson(url, headers);
    const rows = Array.isArray(json) ? json : [];
    const want = fixtureId.toString();
    for (const row of rows) {
      const o = row as Record<string, unknown>;
      if (String(o.FixtureId ?? o.fixtureId ?? '') !== want) continue;
      const home = this.str(o.Participant1);
      const away = this.str(o.Participant2);
      if (!home || !away) return null;
      const competition = this.str(o.Competition);
      return { home, away, ...(competition ? { competition } : {}) };
    }
    return null;
  }

  /**
   * Parse the SSE-framed historical replay for the `lineups` frame and pull the
   * two team names. Home/away follows Participant1IsHome (Lineups[0] is always
   * Participant1). Returns null if the fixture has no feed data (empty body) or
   * no lineups frame.
   */
  private async fromHistorical(
    fixtureId: bigint,
  ): Promise<FixtureTeams | null> {
    const headers = await this.authHeaders();
    const url = `${this.config.txlineBaseUrl}/api/scores/historical/${fixtureId}`;
    const text = await this.getText(url, headers);
    if (!text || text.trim() === '' || text.trim() === 'null') return null;

    for (const line of text.split(/\r?\n/)) {
      if (!line.startsWith('data:')) continue;
      const data = line.slice('data:'.length).trim();
      if (!data || data === 'null') continue;
      let frame: Record<string, unknown>;
      try {
        frame = JSON.parse(data) as Record<string, unknown>;
      } catch {
        continue;
      }
      const lineups = frame.Lineups;
      if (!Array.isArray(lineups) || lineups.length < 2) continue;
      const p1 = this.str(
        (lineups[0] as Record<string, unknown>)?.preferredName,
      );
      const p2 = this.str(
        (lineups[1] as Record<string, unknown>)?.preferredName,
      );
      if (!p1 || !p2) continue;
      // Lineups[0] = Participant1. Home is Participant1 unless flagged otherwise.
      const p1IsHome = frame.Participant1IsHome !== false;
      return {
        home: p1IsHome ? p1 : p2,
        away: p1IsHome ? p2 : p1,
      };
    }
    return null;
  }

  private str(v: unknown): string | undefined {
    if (v == null) return undefined;
    const s = String(v).trim();
    return s.length > 0 ? s : undefined;
  }

  // ---- transport ------------------------------------------------------------

  /** GET a text body, defensively gunzipping (undici does not auto-decode). */
  private async getText(
    url: string,
    headers: Record<string, string>,
  ): Promise<string> {
    const res = await request(url, { method: 'GET', headers });
    if (res.statusCode >= 300) {
      await res.body.text().catch(() => undefined);
      throw new Error(`GET ${url} -> ${res.statusCode}`);
    }
    const encoding = String(res.headers['content-encoding'] ?? '');
    if (encoding.includes('gzip')) {
      const gunzip = createGunzip();
      res.body.on('error', (err: Error) => gunzip.destroy(err));
      const buf = await buffer(res.body.pipe(gunzip));
      return buf.toString('utf8');
    }
    return res.body.text();
  }

  /** GET + JSON-parse a body (via getText, so gzip-safe). */
  private async getJson(
    url: string,
    headers: Record<string, string>,
  ): Promise<unknown> {
    const text = await this.getText(url, headers);
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new Error(`GET ${url} -> non-JSON body`);
    }
  }

  private async authHeaders(): Promise<Record<string, string>> {
    if (!this.config.txlineApiToken) {
      throw new Error('TXLINE_API_TOKEN not set');
    }
    const jwt = await this.getGuestJwt();
    return {
      Authorization: `Bearer ${jwt}`,
      'X-Api-Token': this.config.txlineApiToken,
      accept: 'application/json',
    };
  }

  private async getGuestJwt(): Promise<string> {
    const now = Date.now();
    if (this.jwt && now < this.jwtExpiresAt - 30_000) return this.jwt;
    const url = `${this.config.txlineBaseUrl}/auth/guest/start`;
    const res = await request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    });
    if (res.statusCode >= 300) {
      await res.body.text().catch(() => undefined);
      throw new Error(`guest auth -> ${res.statusCode}`);
    }
    const json = (await res.body.json()) as GuestTokenResponse;
    const token = json.token ?? json.access_token ?? json.jwt;
    if (!token) throw new Error('guest auth response had no token');
    const ttl = (json.expires_in ?? json.expiresIn ?? 3600) * 1000;
    this.jwt = token;
    this.jwtExpiresAt = now + ttl;
    return token;
  }
}

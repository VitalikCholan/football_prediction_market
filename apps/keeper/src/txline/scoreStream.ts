import { EventEmitter } from "node:events";
import { createGunzip } from "node:zlib";
import { request } from "undici";
import type { KeeperConfig } from "../config.ts";
import { log } from "../log.ts";
import type { TxlineAuth } from "./auth.ts";
import { SseFrameParser, type SseFrame } from "./sse.ts";
import { isMatchEnd, type ScoreEvent } from "./types.ts";

/**
 * TxLINE SSE score-stream client (GET /api/scores/stream).
 *
 * Auth: guest JWT + X-Api-Token (both required).
 *
 * REAL wire shape (VERIFIED live 2026-07-04 — docs/OpenAPI were wrong):
 *   - fields are PascalCase: FixtureId, Seq, Ts, Action, StatusId, GameState,
 *     Stats (map "key"->value, key = period*1000+base), Clock, Score;
 *   - NO phase_id/gamePhase exists. Match end = StatusId === 100 OR
 *     Action === "game_finalised" (see types.ts isMatchEnd);
 *   - heartbeats arrive as `event: heartbeat` + `data: {"Ts":...}`;
 *   - GameState stays "scheduled" even in play — never trust it.
 *
 * Devnet is Service Level 1 = 60s DELAYED data (by design for the demo).
 */

export type MatchEvent = ScoreStreamEvent | HeartbeatEvent;

/** A normalized score event; `ended: true` when the match-end rule fires. */
export interface ScoreStreamEvent extends ScoreEvent {
  type: "score";
  ended: boolean;
}
/** Alias kept for consumers wiring `stream.on("ended", ...)`. */
export type EndedEvent = ScoreStreamEvent;

export interface HeartbeatEvent {
  type: "heartbeat";
  raw: unknown;
}

export interface ScoreStreamEvents {
  event: (e: MatchEvent) => void;
  ended: (e: EndedEvent) => void;
  error: (err: unknown) => void;
}

export class ScoreStream extends EventEmitter {
  private readonly config: KeeperConfig;
  private readonly auth: TxlineAuth;
  private abort?: AbortController;
  private closed = false;

  constructor(config: KeeperConfig, auth: TxlineAuth) {
    super();
    this.config = config;
    this.auth = auth;
  }

  /** Start the long-lived SSE connection with reconnect + backoff. */
  async start(): Promise<void> {
    this.closed = false;
    let backoffMs = 1000;
    while (!this.closed) {
      this.abort = new AbortController();
      try {
        await this.connectOnce(this.abort.signal);
        backoffMs = 1000; // reset after a clean run
      } catch (err) {
        if (this.closed) return;
        const jitter = Math.random() * 500;
        this.emit("error", err);
        log.warn(
          { err, backoffMs },
          "score-stream disconnected — reconnecting",
        );
        await this.sleep(backoffMs + jitter);
        backoffMs = Math.min(backoffMs * 2, 30_000);
      }
    }
  }

  stop(): void {
    this.closed = true;
    this.abort?.abort();
  }

  private async connectOnce(signal: AbortSignal): Promise<void> {
    const headers = await this.auth.headers();
    const url = `${this.config.txlineBaseUrl}/api/scores/stream`;
    const res = await request(url, {
      method: "GET",
      signal,
      headers: {
        ...headers,
        Accept: "text/event-stream",
        "Cache-Control": "no-cache",
        // NOTE: no Accept-Encoding — undici request() does not auto-decompress,
        // and a gunzip pipe swallows disconnect errors (stalls the reconnect
        // loop). Identity SSE text is tiny on devnet (60s-delayed feed).
      },
    });
    if (res.statusCode >= 300) {
      const body = await res.body.text();
      throw new Error(`score-stream failed (${res.statusCode}): ${body}`);
    }
    log.info("score-stream connected");

    // Defensive: if a proxy compresses anyway, gunzip with error propagation
    // (plain .pipe() would swallow disconnect errors and stall the loop).
    const encoding = String(res.headers["content-encoding"] ?? "");
    let body: AsyncIterable<string | Buffer> = res.body;
    if (encoding.includes("gzip")) {
      const gunzip = createGunzip();
      res.body.on("error", (err: Error) => gunzip.destroy(err));
      body = res.body.pipe(gunzip);
    }

    const parser = new SseFrameParser();
    for await (const chunk of body) {
      const text =
        typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      for (const frame of parser.push(text)) this.handleFrame(frame);
    }
    for (const frame of parser.flush()) this.handleFrame(frame);
  }

  /** Handle one parsed SSE frame. */
  private handleFrame(frame: SseFrame): void {
    const payload = frame.data;
    if (frame.event === "heartbeat") {
      this.emit("event", { type: "heartbeat", raw: payload } as HeartbeatEvent);
      return;
    }
    if (!payload || payload === "[DONE]" || payload === "null") return;

    let json: unknown;
    try {
      json = JSON.parse(payload);
    } catch {
      log.debug({ payload }, "non-JSON SSE frame ignored");
      return;
    }
    const event = normalizeMatchEvent(json);
    if (!event) return;
    this.emit("event", event);
    if (event.type === "score" && event.ended) this.emit("ended", event);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }
}

/**
 * Normalize one JSON payload into a MatchEvent. PascalCase (the REAL shape,
 * verified live) is primary; the old snake/camel aliases are kept as a thin
 * fallback tolerance. Shared by the live stream and the historical replay.
 */
export function normalizeMatchEvent(json: unknown): MatchEvent | null {
  if (typeof json !== "object" || json === null) return null;
  const o = json as Record<string, unknown>;

  const fixtureRaw =
    o.FixtureId ?? o.fixture_id ?? o.fixtureId ?? o.match_id ?? o.matchId;
  if (fixtureRaw === undefined || fixtureRaw === null) {
    // Heartbeat payloads are {"Ts":...} with no fixture (or explicit markers).
    if (o.heartbeat || o.ping || o.Ts !== undefined || o.ts !== undefined) {
      return { type: "heartbeat", raw: json };
    }
    return null;
  }

  const event = normalizeScoreEvent(o, json);
  return { type: "score", ...event, ended: isMatchEnd(event) };
}

/** Normalize the (already fixture-bearing) payload into a ScoreEvent. */
function normalizeScoreEvent(
  o: Record<string, unknown>,
  raw: unknown,
): ScoreEvent {
  const fixtureRaw =
    o.FixtureId ?? o.fixture_id ?? o.fixtureId ?? o.match_id ?? o.matchId;
  return {
    fixtureId: BigInt(fixtureRaw as string | number),
    seq: Number(o.Seq ?? o.seq ?? 0),
    ts: BigInt((o.Ts ?? o.ts ?? o.timestamp ?? 0) as string | number), // ms
    statusId: Number(o.StatusId ?? o.status_id ?? o.statusId ?? 0),
    action: String(o.Action ?? o.action ?? ""),
    gameState: (o.GameState ?? o.game_state ?? o.gameState) as
      | string
      | undefined,
    stats: normalizeStats(o.Stats ?? o.stats ?? o.score_stats ?? o.scoreStats),
    raw,
  };
}

/**
 * Stats on the wire are a MAP { "<key>": value } (key = period*1000+base).
 * Tolerate the old docs' array-of-{key,value,period} shape as a fallback.
 */
function normalizeStats(rawStats: unknown): Record<string, number> {
  if (rawStats === null || rawStats === undefined) return {};
  if (Array.isArray(rawStats)) {
    const out: Record<string, number> = {};
    for (const s of rawStats) {
      const so = s as Record<string, unknown>;
      if (so.key === undefined) continue;
      out[String(Number(so.key))] = Number(so.value ?? 0);
    }
    return out;
  }
  if (typeof rawStats === "object") {
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(rawStats as Record<string, unknown>)) {
      out[k] = Number(v);
    }
    return out;
  }
  return {};
}

/* -------------------------------------------------------------------------
 * Score-stat key encoding (CONFIRMED live): key = period*1000 + base.
 *   base: 1 = P1 total goals, 2 = P2 total goals, 3-6 = yellow/red cards,
 *         7-8 = corners.
 *   period multipliers: FT 0 (bare base keys), H1 +1000, H2 +2000, ET1 +3000,
 *         ET2 +4000, Pens +5000. Stat-validation labels final stats with
 *         `period: 100` (see types.ts readStat).
 * ----------------------------------------------------------------------- */
export const StatBase = {
  P1_GOALS: 1,
  P2_GOALS: 2,
  YELLOW_CARDS_A: 3,
  YELLOW_CARDS_B: 4,
  RED_CARDS_A: 5,
  RED_CARDS_B: 6,
  CORNERS_A: 7,
  CORNERS_B: 8,
} as const;

export const Period = {
  FULL: 0,
  H1: 1,
  H2: 2,
  ET1: 3,
  ET2: 4,
  PENS: 5,
} as const;

/** Encode a (period, base) pair into a TxLINE stat key. */
export function statKey(
  period: (typeof Period)[keyof typeof Period],
  base: (typeof StatBase)[keyof typeof StatBase],
): number {
  return period * 1000 + base;
}

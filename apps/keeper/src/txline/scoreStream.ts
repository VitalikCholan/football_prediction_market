import { EventEmitter } from "node:events";
import { request } from "undici";
import type { KeeperConfig } from "../config.ts";
import { log } from "../log.ts";
import type { TxlineAuth } from "./auth.ts";

/**
 * TxLINE SSE score-stream client (GET /api/scores/stream).
 *
 * Auth: guest JWT + X-Api-Token (both required). Events are generic/unnamed —
 * each `data:` payload is JSON; we normalize into a discriminated MatchEvent.
 * Exact inner field names are generic in the docs, so parsing is defensive.
 *
 * Match-end detection (CONFIRMED): Game Phase ID ∈ {5 "F", 10 "FET", 13 "FPE"}.
 * Devnet is Service Level 1 = 60s DELAYED data (by design for the demo).
 */

/** Game phase ids that mean the match has ended. */
export const ENDED_PHASE_IDS = new Set([5, 10, 13]);

export type MatchEvent =
  | ScoreEvent
  | StatusChangeEvent
  | EndedEvent
  | HeartbeatEvent;

export interface ScoreEvent {
  type: "score";
  fixtureId: bigint;
  phaseId: number;
  stats: ScoreStat[];
  raw: unknown;
}
export interface StatusChangeEvent {
  type: "status";
  fixtureId: bigint;
  phaseId: number;
  raw: unknown;
}
export interface EndedEvent {
  type: "ended";
  fixtureId: bigint;
  phaseId: number;
  raw: unknown;
}
export interface HeartbeatEvent {
  type: "heartbeat";
  raw: unknown;
}

export interface ScoreStat {
  key: number; // period*1000 + base (see statKey helpers)
  value: number;
  period: number;
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
        "Accept-Encoding": "gzip",
      },
    });
    if (res.statusCode >= 300) {
      const body = await res.body.text();
      throw new Error(`score-stream failed (${res.statusCode}): ${body}`);
    }
    log.info("score-stream connected");

    let buffer = "";
    for await (const chunk of res.body) {
      const text =
        typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      buffer += text;
      // SSE frames are separated by a blank line.
      let idx: number;
      while ((idx = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        this.handleFrame(frame);
      }
    }
  }

  /** Parse one SSE frame (may contain multiple `data:` lines). */
  private handleFrame(frame: string): void {
    const dataLines = frame
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trim());
    if (dataLines.length === 0) return;
    const payload = dataLines.join("\n");
    if (!payload || payload === "[DONE]") return;

    let json: unknown;
    try {
      json = JSON.parse(payload);
    } catch {
      log.debug({ payload }, "non-JSON SSE frame ignored");
      return;
    }
    const event = this.normalize(json);
    if (!event) return;
    this.emit("event", event);
    if (event.type === "ended") this.emit("ended", event);
  }

  /**
   * Normalize a generic JSON payload into a MatchEvent. Field names are guessed
   * defensively across the shapes seen in the docs; adjust once the live schema
   * is confirmed (open item, backend-plan §8 O3 residual).
   */
  private normalize(json: unknown): MatchEvent | null {
    if (typeof json !== "object" || json === null) return null;
    const o = json as Record<string, unknown>;

    if (o.heartbeat || o.type === "heartbeat" || o.ping) {
      return { type: "heartbeat", raw: json };
    }

    const fixtureRaw =
      o.fixture_id ?? o.fixtureId ?? o.fixture ?? o.match_id ?? o.matchId;
    if (fixtureRaw === undefined) return null;
    const fixtureId = BigInt(fixtureRaw as string | number);

    const phaseId = Number(
      o.phase_id ?? o.phaseId ?? o.game_phase ?? o.gamePhase ?? 0,
    );

    if (ENDED_PHASE_IDS.has(phaseId)) {
      return { type: "ended", fixtureId, phaseId, raw: json };
    }

    const rawStats = (o.stats ?? o.score_stats ?? o.scoreStats) as
      | unknown[]
      | undefined;
    if (Array.isArray(rawStats)) {
      const stats: ScoreStat[] = rawStats.map((s) => {
        const so = s as Record<string, unknown>;
        return {
          key: Number(so.key ?? 0),
          value: Number(so.value ?? 0),
          period: Number(so.period ?? 0),
        };
      });
      return { type: "score", fixtureId, phaseId, stats, raw: json };
    }

    return { type: "status", fixtureId, phaseId, raw: json };
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }
}

/* -------------------------------------------------------------------------
 * Score-stat key encoding (CONFIRMED): key = period*1000 + base.
 *   base: 1 = P1 total goals, 2 = P2 total goals, 3-6 = yellow/red cards,
 *         7-8 = corners.
 *   period multipliers: FT 0, H1 +1000, H2 +2000, ET1 +3000, ET2 +4000,
 *         Pens +5000.
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

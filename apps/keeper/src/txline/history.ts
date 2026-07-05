import { request } from "undici";
import type { KeeperConfig } from "../config.ts";
import { log } from "../log.ts";
import type { TxlineAuth } from "./auth.ts";
import { normalizeMatchEvent, type ScoreStreamEvent } from "./scoreStream.ts";
import { parseSseText } from "./sse.ts";
import { isMatchEnd } from "./types.ts";

/**
 * Historical scores for replay / fee calibration (backend-plan §6).
 *   GET /api/scores/historical/{fixtureId}
 *
 * VERIFIED live 2026-07-04: the response is SSE-FRAMED TEXT (`data:` / `id:`
 * lines, same framing as the live stream — NOT a JSON array), so it goes
 * through the same SSE parser + normalizer as the stream. Fixtures with no
 * data (or still in play) return a literal `null` / empty body — handled as [].
 *
 * Serves fixtures within the past two weeks and six hours. Used to replay a
 * finished match for the demo, to calibrate the dynamic-fee parameters against
 * the 60s-delay adverse-selection window, and to recover the final `Seq`
 * (required by /api/scores/stat-validation) if the live SSE frame was missed.
 */
export class HistoryClient {
  private readonly config: KeeperConfig;
  private readonly auth: TxlineAuth;

  constructor(config: KeeperConfig, auth: TxlineAuth) {
    this.config = config;
    this.auth = auth;
  }

  /** Fetch + parse the full replay; [] when TxLINE has no data yet. */
  async fetch(fixtureId: bigint): Promise<ScoreStreamEvent[]> {
    const headers = await this.auth.headers();
    const url = `${this.config.txlineBaseUrl}/api/scores/historical/${fixtureId}`;
    const res = await request(url, { method: "GET", headers });
    if (res.statusCode >= 300) {
      const body = await res.body.text();
      throw new Error(`historical fetch failed (${res.statusCode}): ${body}`);
    }
    const text = await res.body.text();
    if (!text || text.trim() === "" || text.trim() === "null") {
      log.debug(
        { fixtureId: fixtureId.toString() },
        "historical: no data (null/empty body)",
      );
      return [];
    }

    const events: ScoreStreamEvent[] = [];
    for (const frame of parseSseText(text)) {
      if (!frame.data || frame.data === "null") continue;
      let json: unknown;
      try {
        json = JSON.parse(frame.data);
      } catch {
        continue;
      }
      const event = normalizeMatchEvent(json);
      if (event?.type === "score") events.push(event);
    }
    return events;
  }

  /**
   * The event that finalised the match (StatusId 100 / "game_finalised"),
   * or undefined if the fixture hasn't ended (or has no data). Its `seq` is
   * what stat-validation needs.
   */
  async findMatchEnd(fixtureId: bigint): Promise<ScoreStreamEvent | undefined> {
    const events = await this.fetch(fixtureId);
    return events.find((e) => isMatchEnd(e));
  }
}

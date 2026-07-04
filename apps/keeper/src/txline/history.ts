import { request } from "undici";
import type { KeeperConfig } from "../config.ts";
import type { TxlineAuth } from "./auth.ts";

/**
 * Historical scores for replay / fee calibration (backend-plan §6).
 *   GET /api/scores/historical/{fixtureId}
 * Serves fixtures within the past two weeks and six hours. Used to replay a
 * finished match for the demo and to calibrate the dynamic-fee parameters
 * against the 60s-delay adverse-selection window.
 */
export class HistoryClient {
  private readonly config: KeeperConfig;
  private readonly auth: TxlineAuth;

  constructor(config: KeeperConfig, auth: TxlineAuth) {
    this.config = config;
    this.auth = auth;
  }

  async fetch(fixtureId: bigint): Promise<unknown> {
    const headers = await this.auth.headers();
    const url = `${this.config.txlineBaseUrl}/api/scores/historical/${fixtureId}`;
    const res = await request(url, { method: "GET", headers });
    if (res.statusCode >= 300) {
      const body = await res.body.text();
      throw new Error(`historical fetch failed (${res.statusCode}): ${body}`);
    }
    return res.body.json();
  }
}

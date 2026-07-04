import { request } from "undici";
import type { KeeperConfig } from "../config.ts";
import { log } from "../log.ts";

/**
 * TxLINE auth. Two headers are required on every data request:
 *   - Authorization: Bearer <guest-jwt>   (from POST /auth/guest/start)
 *   - X-Api-Token: <apiToken>             (from /api/token/activate, via env)
 *
 * The guest JWT is short-lived and fetched at runtime; we cache it and refresh
 * ahead of expiry.
 */
export type TxlineAuthHeaders = Record<string, string> & {
  Authorization: string;
  "X-Api-Token": string;
};

interface GuestTokenResponse {
  // Field names are normalized defensively — docs are generic.
  token?: string;
  access_token?: string;
  jwt?: string;
  expires_in?: number; // seconds
  expiresIn?: number;
}

export class TxlineAuth {
  private readonly config: KeeperConfig;
  private jwt?: string;
  private jwtExpiresAt = 0; // epoch ms

  constructor(config: KeeperConfig) {
    this.config = config;
  }

  /** Return both required auth headers, refreshing the guest JWT if needed. */
  async headers(): Promise<TxlineAuthHeaders> {
    if (!this.config.txlineApiToken) {
      throw new Error("TXLINE_API_TOKEN not set (X-Api-Token required).");
    }
    const jwt = await this.getGuestJwt();
    return {
      Authorization: `Bearer ${jwt}`,
      "X-Api-Token": this.config.txlineApiToken,
    };
  }

  /** Fetch (or return cached) guest JWT via POST /auth/guest/start. */
  private async getGuestJwt(): Promise<string> {
    const now = Date.now();
    if (this.jwt && now < this.jwtExpiresAt - 30_000) {
      return this.jwt;
    }
    const url = `${this.config.txlineBaseUrl}/auth/guest/start`;
    const res = await request(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
    });
    if (res.statusCode >= 300) {
      const body = await res.body.text();
      throw new Error(`guest auth failed (${res.statusCode}): ${body}`);
    }
    const json = (await res.body.json()) as GuestTokenResponse;
    const token = json.token ?? json.access_token ?? json.jwt;
    if (!token) {
      throw new Error("guest auth response had no token field");
    }
    const ttl = (json.expires_in ?? json.expiresIn ?? 3600) * 1000;
    this.jwt = token;
    this.jwtExpiresAt = now + ttl;
    log.info({ ttlSeconds: ttl / 1000 }, "obtained TxLINE guest JWT");
    return token;
  }
}

//! On-chain fixture source — derives the scheduler's Fixture[] from the live
//! program state instead of a static FIXTURES env (fixes PLAN §12 BUG-1 root:
//! a deployed keeper with an empty env drove nothing).
//!
//! Every `Market` PDA already stores `fixture_id`, `kickoff_ts`, `freeze_ts` and
//! `state`. We getProgramAccounts (same discriminator + 278-byte filter as
//! smoke.ts, so pre-refactor ghost accounts are excluded server-side), decode,
//! and map each still-live market to a Fixture. Markets already Resolved/Closed
//! are dropped so the scheduler stops re-ticking them ("already resolved,
//! skipping" noise). Team names aren't on-chain — left blank (the scheduler
//! keys on fixtureId/kickoffTs/expectedEndTs; names are cosmetic in logs).
//!
//! Implements the SAME `FixtureSource` interface the scheduler + markPoster
//! already consume — swap it in at the index.ts wiring, nothing else changes.
//! Results are cached briefly (CACHE_TTL_MS) so a fast scheduler tick doesn't
//! getProgramAccounts every few seconds.

import {
  getBase58Decoder,
  getBase64Encoder,
  type Base58EncodedBytes,
} from "@solana/kit";
import { MARKET_DISCRIMINATOR, getMarketDecoder, MarketState } from "@fpm/idl";
import { AMM_PROGRAM_ID } from "@fpm/shared";

import type { SolanaClients } from "../solana/rpc.ts";
import type { Fixture, FixtureSource } from "../txline/fixtures.ts";
import { log } from "../log.ts";

/** Canonical `Market` size: 8 disc + 270 InitSpace (excludes 254-byte ghosts). */
const MARKET_DATA_SIZE = 278n;

/** Re-list at most this often; a scheduler tick is usually 5s. */
const CACHE_TTL_MS = 30_000;

/** States worth driving. Resolved(4)/Closed(5)/Uninitialized(0) are skipped. */
const LIVE_STATES = new Set<MarketState>([
  MarketState.Open,
  MarketState.Trading,
  MarketState.Locked,
]);

export class OnchainFixtureSource implements FixtureSource {
  private readonly rpc: SolanaClients["rpc"];
  private cache: Fixture[] = [];
  private cachedAt = 0;

  constructor(clients: SolanaClients) {
    this.rpc = clients.rpc;
  }

  async list(): Promise<Fixture[]> {
    const now = Date.now();
    if (now - this.cachedAt < CACHE_TTL_MS) return this.cache;

    try {
      this.cache = await this.fetch();
      this.cachedAt = now;
    } catch (err) {
      // Never let a listing failure kill the scheduler tick — serve the last
      // good snapshot (empty on first failure).
      log.warn({ err }, "onchain fixture source: list failed, serving cache");
    }
    return this.cache;
  }

  private async fetch(): Promise<Fixture[]> {
    const base64 = getBase64Encoder();
    const decoder = getMarketDecoder();
    const discriminator = getBase58Decoder().decode(
      MARKET_DISCRIMINATOR,
    ) as Base58EncodedBytes;

    const accounts = await this.rpc
      .getProgramAccounts(AMM_PROGRAM_ID, {
        encoding: "base64",
        filters: [
          { memcmp: { offset: 0n, bytes: discriminator, encoding: "base58" } },
          { dataSize: MARKET_DATA_SIZE },
        ],
      })
      .send();

    const fixtures: Fixture[] = [];
    for (const a of accounts) {
      let m: ReturnType<typeof decoder.decode>;
      try {
        m = decoder.decode(base64.encode(a.account.data[0]));
      } catch {
        continue; // skip anything that still fails to decode
      }
      if (!LIVE_STATES.has(m.state)) continue;
      fixtures.push({
        fixtureId: m.fixtureId,
        homeTeam: "",
        awayTeam: "",
        kickoffTs: Number(m.kickoffTs),
        expectedEndTs: Number(m.freezeTs),
      });
    }

    log.info(
      { count: fixtures.length },
      "onchain fixture source: live markets refreshed",
    );
    return fixtures;
  }
}

import { request } from "undici";
import type { KeeperConfig } from "../config.ts";
import type { TxlineAuth } from "./auth.ts";

/**
 * Fixture schedule — drives the lifecycle FSM (kickoff -> activate,
 * final whistle -> freeze). Kickoff/end times cross-check the SSE stream so a
 * missed frame still triggers activate/freeze/resolve.
 *
 * Source: TxLINE fixtures endpoint (or a static seed for the demo). Kept minimal
 * here; the scheduler consumes `Fixture[]`.
 */
export interface Fixture {
  fixtureId: bigint;
  homeTeam: string;
  awayTeam: string;
  kickoffTs: number; // unix seconds
  /** Best-effort expected end (kickoff + ~2h); a fallback for freeze/resolve. */
  expectedEndTs: number;
}

export interface FixtureSource {
  list(): Promise<Fixture[]>;
}

/** Static in-memory fixture source for local/demo runs. */
export class StaticFixtureSource implements FixtureSource {
  private readonly fixtures: Fixture[];
  constructor(fixtures: Fixture[] = []) {
    this.fixtures = fixtures;
  }
  async list(): Promise<Fixture[]> {
    return this.fixtures;
  }
}

/**
 * One row of GET /api/fixtures/snapshot (VERIFIED live 2026-07-04 — fields are
 * PascalCase: FixtureId, Participant1/2, StartTime (ms), Ts, Competition, ...).
 */
export interface SnapshotFixture {
  fixtureId: bigint;
  participant1: string;
  participant2: string;
  competition?: string;
  /** Kickoff in MILLISECONDS. */
  startTime: number;
  raw: unknown;
}

/** Fetch the live fixture snapshot (upcoming + recent fixtures). */
export async function fetchFixtureSnapshot(
  config: KeeperConfig,
  auth: TxlineAuth,
): Promise<SnapshotFixture[]> {
  const headers = await auth.headers();
  const url = `${config.txlineBaseUrl}/api/fixtures/snapshot`;
  const res = await request(url, { method: "GET", headers });
  if (res.statusCode >= 300) {
    const body = await res.body.text();
    throw new Error(`fixtures snapshot failed (${res.statusCode}): ${body}`);
  }
  const json = (await res.body.json()) as unknown;
  if (!Array.isArray(json)) return [];
  return json.map((f) => {
    const o = f as Record<string, unknown>;
    return {
      fixtureId: BigInt((o.FixtureId ?? o.fixture_id ?? 0) as string | number),
      participant1: String(o.Participant1 ?? ""),
      participant2: String(o.Participant2 ?? ""),
      competition: o.Competition as string | undefined,
      startTime: Number(o.StartTime ?? 0),
      raw: f,
    };
  });
}

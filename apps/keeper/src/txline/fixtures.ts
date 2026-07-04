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

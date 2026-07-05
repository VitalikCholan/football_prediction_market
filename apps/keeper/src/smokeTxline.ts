/**
 * TxLINE API smoke (`--smoke-txline` / SMOKE_TXLINE=1): proves the keeper's
 * parsers against the LIVE TxLINE API (real shapes verified 2026-07-04).
 * Read-only — nothing touches Solana.
 *
 *   (a) open the live SSE score stream for ~SMOKE_SSE_SECONDS (default 30),
 *       parse with the real-shape normalizer, print normalized events;
 *   (b) discover a finished fixture via /api/fixtures/snapshot, fetch its
 *       historical replay (SSE-framed text), print the final event + the
 *       detected match-end (StatusId 100 / "game_finalised");
 *   (c) fetch a real stat-validation proof (statKey=1&statKey2=2 + the Seq
 *       from (b)) and print the mapped ResolveProofArgs SUMMARY.
 *
 * Requires TXLINE_API_TOKEN (+ TXLINE_BASE_URL) in the env / .env.
 */
import { loadConfig } from "./config.ts";
import { log } from "./log.ts";
import { TxlineAuth } from "./txline/auth.ts";
import { fetchFixtureSnapshot } from "./txline/fixtures.ts";
import { HistoryClient } from "./txline/history.ts";
import { ProofFetcher } from "./txline/proof.ts";
import {
  ScoreStream,
  StatBase,
  type MatchEvent,
  type ScoreStreamEvent,
} from "./txline/scoreStream.ts";
import { isMatchEnd, readStat, type ResolveProofArgs } from "./txline/types.ts";

export async function runSmokeTxline(): Promise<void> {
  const config = loadConfig();
  if (!config.txlineApiToken) {
    throw new Error("smoke-txline needs TXLINE_API_TOKEN (see .env.example)");
  }
  log.info({ baseUrl: config.txlineBaseUrl }, "smoke-txline: starting");
  const auth = new TxlineAuth(config);

  await smokeLiveStream(config, auth);
  const end = await smokeHistorical(config, auth);
  if (end) {
    await smokeStatValidation(config, auth, end);
  } else {
    log.warn("smoke-txline: no finished fixture found — skipping stat-validation leg");
  }
  log.info("smoke-txline: done");
}

/** (a) Live SSE stream, bounded by time. */
async function smokeLiveStream(
  config: ReturnType<typeof loadConfig>,
  auth: TxlineAuth,
): Promise<void> {
  const seconds = Number(process.env.SMOKE_SSE_SECONDS ?? 30);
  const maxPrinted = 15;
  log.info({ seconds }, "smoke-txline (a): opening live SSE score stream");

  const stream = new ScoreStream(config, auth);
  let scoreEvents = 0;
  let heartbeats = 0;
  let endedSeen = 0;

  stream.on("event", (e: MatchEvent) => {
    if (e.type === "heartbeat") {
      heartbeats += 1;
      if (heartbeats <= 3) log.info("smoke-txline (a): heartbeat");
      return;
    }
    scoreEvents += 1;
    if (e.ended) endedSeen += 1;
    if (scoreEvents <= maxPrinted) {
      log.info(
        {
          fixtureId: e.fixtureId.toString(),
          seq: e.seq,
          statusId: e.statusId,
          action: e.action,
          score: formatScore(e),
          ended: e.ended,
        },
        "smoke-txline (a): score event",
      );
    }
  });
  stream.on("error", (err) => log.warn({ err }, "smoke-txline (a): stream error"));

  const run = stream.start();
  await new Promise((r) => setTimeout(r, seconds * 1000));
  stream.stop();
  await run;

  log.info(
    { scoreEvents, heartbeats, endedSeen },
    "smoke-txline (a): live SSE parsed OK",
  );
}

/** (b) Historical replay of a finished fixture; returns its match-end event. */
async function smokeHistorical(
  config: ReturnType<typeof loadConfig>,
  auth: TxlineAuth,
): Promise<ScoreStreamEvent | undefined> {
  const history = new HistoryClient(config, auth);
  const snapshot = await fetchFixtureSnapshot(config, auth);
  log.info({ fixtures: snapshot.length }, "smoke-txline (b): fixtures snapshot fetched");

  const now = Date.now();
  const past = snapshot
    .filter((f) => f.startTime < now)
    .sort((a, b) => b.startTime - a.startTime);

  for (const f of past) {
    const events = await history.fetch(f.fixtureId);
    if (events.length === 0) {
      log.info(
        { fixtureId: f.fixtureId.toString(), match: `${f.participant1} v ${f.participant2}` },
        "smoke-txline (b): historical empty/null — handled gracefully, trying next",
      );
      continue;
    }
    const end = events.find((e) => isMatchEnd(e));
    const last = events[events.length - 1];
    log.info(
      {
        fixtureId: f.fixtureId.toString(),
        match: `${f.participant1} v ${f.participant2}`,
        events: events.length,
        lastEvent: { seq: last.seq, statusId: last.statusId, action: last.action },
        matchEnd: end
          ? {
              seq: end.seq,
              statusId: end.statusId,
              action: end.action,
              score: formatScore(end),
              ts: end.ts.toString(),
            }
          : null,
      },
      "smoke-txline (b): historical replay parsed",
    );
    if (end) return end;
  }
  return undefined;
}

/** (c) Real stat-validation proof mapped into ResolveProofArgs. */
async function smokeStatValidation(
  config: ReturnType<typeof loadConfig>,
  auth: TxlineAuth,
  end: ScoreStreamEvent,
): Promise<void> {
  const proofFetcher = new ProofFetcher(config, auth);
  const proof = await proofFetcher.fetch({
    fixtureId: end.fixtureId,
    seq: end.seq, // REQUIRED — the Seq of the finalising event
    statKey: StatBase.P1_GOALS,
    statKey2: StatBase.P2_GOALS,
    op: "Subtract",
  });
  log.info(summarizeProof(proof), "smoke-txline (c): ResolveProofArgs mapped");
}

/** Compact, non-null-proving summary (no giant hash dumps). */
function summarizeProof(p: ResolveProofArgs) {
  const hex = (b: Uint8Array) => Buffer.from(b).toString("hex").slice(0, 8);
  const nonZero = (b: Uint8Array) => b.length === 32 && b.some((x) => x !== 0);
  return {
    ts: p.ts.toString(),
    epochDay: p.epochDay,
    fixtureId: p.fixtureSummary.fixtureId.toString(),
    updateStats: {
      updateCount: p.fixtureSummary.updateStats.updateCount,
      minTimestamp: p.fixtureSummary.updateStats.minTimestamp.toString(),
      maxTimestamp: p.fixtureSummary.updateStats.maxTimestamp.toString(),
    },
    eventsSubTreeRoot: { prefix: hex(p.fixtureSummary.eventsSubTreeRoot), nonZero: nonZero(p.fixtureSummary.eventsSubTreeRoot) },
    fixtureProofLen: p.fixtureProof.length, // <- wire `subTreeProof`
    mainTreeProofLen: p.mainTreeProof.length,
    statA: {
      ...p.statA.statToProve,
      proofLen: p.statA.statProof.length,
      eventStatRoot: { prefix: hex(p.statA.eventStatRoot), nonZero: nonZero(p.statA.eventStatRoot) },
    },
    statB: p.statB
      ? {
          ...p.statB.statToProve,
          proofLen: p.statB.statProof.length,
          sharedRoot: Buffer.compare(p.statB.eventStatRoot, p.statA.eventStatRoot) === 0,
        }
      : null,
    op: p.op ?? null,
  };
}

function formatScore(e: ScoreStreamEvent): string {
  const home = readStat(e.stats, StatBase.P1_GOALS) ?? "?";
  const away = readStat(e.stats, StatBase.P2_GOALS) ?? "?";
  return `${home}-${away}`;
}

/**
 * @fpm/keeper — off-chain lifecycle + resolution keeper.
 *
 * Bootstraps: config -> signer -> RPC clients -> TxSender -> TxLINE auth +
 * score stream -> lifecycle scheduler. The SSE `ended` event and the scheduler's
 * end-time fallback both drive resolve; all actions are idempotent against the
 * on-chain Market.state.
 *
 * Run: node --experimental-strip-types src/index.ts  (buildless).
 */
import { loadConfig } from "./config.ts";
import { log } from "./log.ts";
import { createClients } from "./solana/rpc.ts";
import { loadKeeperSigner } from "./solana/signer.ts";
import { KitTxSender } from "./solana/txSender.ts";
import { TxlineAuth } from "./txline/auth.ts";
import { ScoreStream, type EndedEvent } from "./txline/scoreStream.ts";
import { ProofFetcher } from "./txline/proof.ts";
import { StaticFixtureSource } from "./txline/fixtures.ts";
import { LifecycleStateMachine } from "./lifecycle/stateMachine.ts";
import { Scheduler } from "./lifecycle/scheduler.ts";
import type { ActionContext } from "./actions/context.ts";

async function main(): Promise<void> {
  const config = loadConfig();
  log.info(
    { cluster: config.cluster, dryRun: config.dryRun, rpc: config.rpcUrls[0] },
    "keeper starting",
  );

  // --- Solana wiring ---
  const clients = createClients(config);
  const signer = await loadKeeperSigner(config).catch((err: unknown) => {
    log.warn({ err }, "no keeper signer loaded — running read-only/structure mode");
    return undefined;
  });
  if (!signer) {
    log.warn("keeper has no signer; skipping action pipeline (set KEEPER_KEYPAIR).");
    return;
  }
  const txSender = new KitTxSender(clients, signer, config);
  const ctx: ActionContext = { config, clients, signer, txSender };

  // --- TxLINE wiring ---
  const auth = new TxlineAuth(config);
  const proofFetcher = new ProofFetcher(config, auth);
  const fixtures = new StaticFixtureSource([]); // seed for demo / replace with live source
  const fsm = new LifecycleStateMachine();

  // --- Lifecycle scheduler (activate/freeze/resolve at boundaries) ---
  const scheduler = new Scheduler(ctx, fixtures, fsm, proofFetcher);
  scheduler.start();
  log.info({ tickMs: config.schedulerTickMs }, "lifecycle scheduler started");

  // --- SSE score stream: match-end -> resolve ---
  if (config.enableScoreStream) {
    const stream = new ScoreStream(config, auth);
    stream.on("ended", (e: EndedEvent) => {
      log.info(
        { fixtureId: e.fixtureId.toString(), phaseId: e.phaseId },
        "SSE match-end detected -> resolve",
      );
      fsm.markEnded(e.fixtureId);
      void scheduler.tryResolve(e.fixtureId);
    });
    stream.on("error", (err) => log.warn({ err }, "score-stream error"));
    void stream.start();
    log.info("score stream started");

    process.on("SIGINT", () => {
      stream.stop();
      scheduler.stop();
      process.exit(0);
    });
  } else {
    log.warn("ENABLE_SCORE_STREAM off — SSE not started (scheduler still runs).");
  }
}

main().catch((err: unknown) => {
  log.error({ err }, "keeper fatal");
  process.exitCode = 1;
});

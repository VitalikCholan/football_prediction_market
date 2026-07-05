/**
 * @fpm/keeper — off-chain lifecycle + resolution keeper.
 *
 * Bootstraps: config -> signer -> RPC clients -> TxSender -> TxLINE auth +
 * score stream -> lifecycle scheduler. The SSE `ended` event and the scheduler's
 * end-time fallback both drive resolve; all actions are idempotent against the
 * on-chain Market.state.
 *
 * Run: node --experimental-transform-types --import ./hooks/register.mjs src/index.ts
 * (buildless; transform-types + resolve hook because the generated @fpm/idl
 * client uses TS enums and extensionless imports). `--smoke` / SMOKE=1 runs
 * the devnet smoke check instead (simulate-only, never sends).
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
import { HistoryClient } from "./txline/history.ts";
import { LifecycleStateMachine } from "./lifecycle/stateMachine.ts";
import { Scheduler } from "./lifecycle/scheduler.ts";
import { runSmoke } from "./smoke.ts";
import { runSmokeTxline } from "./smokeTxline.ts";
import type { ActionContext } from "./actions/context.ts";

async function main(): Promise<void> {
  // TxLINE API smoke: live SSE + historical + stat-validation parser proof.
  if (process.argv.includes("--smoke-txline") || process.env.SMOKE_TXLINE === "1") {
    await runSmokeTxline();
    return;
  }
  // Devnet smoke mode: prove wiring against the live program, simulate-only.
  if (process.argv.includes("--smoke") || process.env.SMOKE === "1") {
    await runSmoke();
    return;
  }

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
  const history = new HistoryClient(config, auth);
  const fixtures = new StaticFixtureSource([]); // seed for demo / replace with live source
  const fsm = new LifecycleStateMachine();

  // --- Lifecycle scheduler (activate/freeze/resolve at boundaries) ---
  const scheduler = new Scheduler(ctx, fixtures, fsm, proofFetcher, history);
  scheduler.start();
  log.info({ tickMs: config.schedulerTickMs }, "lifecycle scheduler started");

  // --- SSE score stream: match-end -> resolve ---
  if (config.enableScoreStream) {
    const stream = new ScoreStream(config, auth);
    stream.on("ended", (e: EndedEvent) => {
      log.info(
        {
          fixtureId: e.fixtureId.toString(),
          seq: e.seq,
          statusId: e.statusId,
          action: e.action,
        },
        "SSE match-end detected (StatusId 100 / game_finalised) -> resolve",
      );
      fsm.markEnded(e.fixtureId, e.seq);
      void scheduler.tryResolve(e.fixtureId, e.seq);
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

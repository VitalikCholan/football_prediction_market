/**
 * Auto-seed dry-run smoke (`--smoke-seed` / SMOKE_SEED=1).
 *
 * Runs exactly ONE MarketSeeder pass with AUTO_SEED_DRY_RUN forced on, so it
 * lists the fixtures it WOULD init_market (ids, teams, reserves, prob source)
 * and sends NOTHING. Verifies the whole auto-seed path — TxLINE snapshot fetch,
 * future filter, on-chain Market-PDA dedup, odds->reserves, authority precheck —
 * against the LIVE program + LIVE TxLINE API without spending any SOL.
 *
 *   node ... src/index.ts --smoke-seed
 *
 * Needs TXLINE_API_TOKEN (+ optionally RPC_URLS / KEEPER_KEYPAIR[_PATH]); the
 * Solana CLI default keypair is used if none is configured (same as --smoke).
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config.ts";
import { log } from "./log.ts";
import { createClients } from "./solana/rpc.ts";
import { loadKeeperSigner } from "./solana/signer.ts";
import { KitTxSender } from "./solana/txSender.ts";
import { TxlineAuth } from "./txline/auth.ts";
import { MarketSeeder } from "./lifecycle/seeder.ts";

const DEFAULT_SMOKE_RPCS = "https://api.devnet.solana.com";

export async function runSmokeSeed(): Promise<void> {
  // Force dry-run + safe defaults; NOTHING is ever sent in smoke-seed.
  process.env.AUTO_SEED_DRY_RUN = "1";
  process.env.DRY_RUN = "1"; // belt-and-suspenders: TxSender would skip send too
  if (!process.env.RPC_URLS) process.env.RPC_URLS = DEFAULT_SMOKE_RPCS;
  if (!process.env.KEEPER_KEYPAIR && !process.env.KEEPER_KEYPAIR_PATH) {
    process.env.KEEPER_KEYPAIR_PATH = join(homedir(), ".config", "solana", "id.json");
  }

  const config = loadConfig();
  if (!config.txlineApiToken) {
    log.warn(
      "smoke-seed needs TXLINE_API_TOKEN (see .env.example) — cannot fetch fixtures; skipping.",
    );
    return; // graceful: no token is a skip, not a failure
  }

  const clients = createClients(config);
  const signer = await loadKeeperSigner(config);
  const txSender = new KitTxSender(clients, signer, config);
  const auth = new TxlineAuth(config);
  log.info(
    { rpc: config.rpcUrls[0], cluster: config.cluster, keeper: signer.address, baseUrl: config.txlineBaseUrl },
    "smoke-seed: DRY-RUN forced — will list candidates and send nothing",
  );

  const seeder = new MarketSeeder(config, clients, signer, txSender, auth);
  const summary = await seeder.runOnce();
  log.info(
    { wouldSeed: summary.seeded, skippedExisting: summary.skippedExisting, future: summary.future, cappedOut: summary.cappedOut, failed: summary.failed },
    "smoke-seed: done (nothing sent)",
  );
}

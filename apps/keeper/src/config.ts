import { z } from "zod";
import type { Cluster } from "@fpm/shared";

/**
 * Keeper environment config, parsed + validated with zod at startup.
 *
 * Safety: default cluster = devnet; refuse to start against mainnet unless
 * ALLOW_MAINNET=1 (guards against fat-finger).
 */
const schema = z.object({
  // Comma-separated RPC http(s) endpoints; primary first, fallbacks after.
  RPC_URLS: z.string().default("https://api.devnet.solana.com"),
  RPC_WS_URL: z.string().optional(),
  CLUSTER: z.enum(["devnet", "mainnet"]).default("devnet"),
  ALLOW_MAINNET: z
    .string()
    .optional()
    .transform((v) => v === "1" || v === "true"),

  // Keeper signer: base58 secret key, JSON array, or a file path (one of).
  KEEPER_KEYPAIR: z.string().optional(),
  KEEPER_KEYPAIR_PATH: z.string().optional(),

  // TxLINE API. Devnet origin is the default (mainnet: https://txline.txodds.com).
  TXLINE_BASE_URL: z.string().default("https://txline-dev.txodds.com"),
  // X-Api-Token from /api/token/activate (guest JWT is fetched at runtime).
  TXLINE_API_TOKEN: z.string().optional(),

  // Priority-fee strategy.
  PRIORITY_FEE_MODE: z.enum(["dynamic", "fixed"]).default("dynamic"),
  PRIORITY_FEE_FIXED_MICROLAMPORTS: z.coerce.number().int().default(1000),
  PRIORITY_FEE_FLOOR_MICROLAMPORTS: z.coerce.number().int().default(100),
  PRIORITY_FEE_CEILING_MICROLAMPORTS: z.coerce.number().int().default(1_000_000),

  // Optional durable retry queue.
  REDIS_URL: z.string().optional(),

  // Poll interval for the lifecycle scheduler (ms).
  SCHEDULER_TICK_MS: z.coerce.number().int().default(5000),

  // Feature flags: run without touching the network (structure/typecheck only).
  DRY_RUN: z
    .string()
    .optional()
    .transform((v) => v === "1" || v === "true"),
  ENABLE_SCORE_STREAM: z
    .string()
    .optional()
    .transform((v) => v === "1" || v === "true"),

  // Auto-seed: periodically poll the TxLINE fixtures snapshot and init_market
  // for strictly-future fixtures that have no Market PDA yet. OFF by default
  // (opt-in — sending init_market spends SOL for account rent + a USDT seed).
  ENABLE_AUTO_SEED: z
    .string()
    .optional()
    .transform((v) => v === "1" || v === "true"),
  // How often the auto-seed loop runs (ms). Default hourly — the TxLINE
  // fixtures feed refreshes roughly hourly, so more often just wastes RPC.
  AUTO_SEED_INTERVAL_MS: z.coerce.number().int().default(3_600_000),
  // Hard per-run cap on how many new markets to seed (SOL-drain guard).
  MAX_SEED_PER_RUN: z.coerce.number().int().default(5),
  // Dry-run the seeder: list what it WOULD create and send NOTHING.
  AUTO_SEED_DRY_RUN: z
    .string()
    .optional()
    .transform((v) => v === "1" || v === "true"),

  // Mark poster (v1 leverage): post_mark for Trading markets that have a
  // LeveragePool, at each config's funding_epoch_secs cadence. OFF by default
  // (additive — leverage-less deployments are unaffected).
  ENABLE_MARK_POSTER: z
    .string()
    .optional()
    .transform((v) => v === "1" || v === "true"),
});

export interface KeeperConfig {
  rpcUrls: string[];
  rpcWsUrl: string;
  cluster: Cluster;
  keeperKeypair?: string;
  keeperKeypairPath?: string;
  txlineBaseUrl: string;
  txlineApiToken?: string;
  priorityFee: {
    mode: "dynamic" | "fixed";
    fixedMicroLamports: number;
    floorMicroLamports: number;
    ceilingMicroLamports: number;
  };
  redisUrl?: string;
  schedulerTickMs: number;
  dryRun: boolean;
  enableScoreStream: boolean;
  enableAutoSeed: boolean;
  autoSeedIntervalMs: number;
  maxSeedPerRun: number;
  autoSeedDryRun: boolean;
  enableMarkPoster: boolean;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): KeeperConfig {
  const p = schema.parse(env);

  if (p.CLUSTER === "mainnet" && !p.ALLOW_MAINNET) {
    throw new Error(
      "Refusing to start against mainnet without ALLOW_MAINNET=1 (safety guard).",
    );
  }

  const rpcUrls = p.RPC_URLS.split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const primary = rpcUrls[0] ?? "https://api.devnet.solana.com";

  return {
    rpcUrls,
    rpcWsUrl: p.RPC_WS_URL ?? primary.replace(/^http/, "ws"),
    cluster: p.CLUSTER,
    keeperKeypair: p.KEEPER_KEYPAIR,
    keeperKeypairPath: p.KEEPER_KEYPAIR_PATH,
    txlineBaseUrl: p.TXLINE_BASE_URL,
    txlineApiToken: p.TXLINE_API_TOKEN,
    priorityFee: {
      mode: p.PRIORITY_FEE_MODE,
      fixedMicroLamports: p.PRIORITY_FEE_FIXED_MICROLAMPORTS,
      floorMicroLamports: p.PRIORITY_FEE_FLOOR_MICROLAMPORTS,
      ceilingMicroLamports: p.PRIORITY_FEE_CEILING_MICROLAMPORTS,
    },
    redisUrl: p.REDIS_URL,
    schedulerTickMs: p.SCHEDULER_TICK_MS,
    dryRun: Boolean(p.DRY_RUN),
    enableScoreStream: Boolean(p.ENABLE_SCORE_STREAM),
    enableAutoSeed: Boolean(p.ENABLE_AUTO_SEED),
    autoSeedIntervalMs: p.AUTO_SEED_INTERVAL_MS,
    maxSeedPerRun: p.MAX_SEED_PER_RUN,
    autoSeedDryRun: Boolean(p.AUTO_SEED_DRY_RUN),
    enableMarkPoster: Boolean(p.ENABLE_MARK_POSTER),
  };
}

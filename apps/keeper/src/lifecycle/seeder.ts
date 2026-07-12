/**
 * MarketSeeder — scheduled auto-seed loop.
 *
 * Periodically polls the TxLINE `fixtures/snapshot`, and for every fixture whose
 * StartTime is strictly in the future AND which does not already have a Market
 * PDA on-chain, sends `init_market` via the keeper's own signer + TxSender +
 * TxLINE auth. Matches self-appear on-chain while the keeper runs so the web app
 * always has upcoming markets to show.
 *
 * This is the scheduled port of the one-shot `scripts/seed-markets.ts`; the
 * domain logic (future-fixture filter, 1X2 odds->seed_q with symmetric [0,0,0]
 * fallback, Market-PDA dedup, init_market build) is preserved.
 *
 * Contract (mirrors Scheduler): start() schedules a never-throw tick loop at
 * `autoSeedIntervalMs`; stop() clears the timer. Every run is:
 *   - idempotent  — a fixture whose Market PDA already exists is skipped by a
 *                   pre-read (we NEVER rely on tx failure for dedup);
 *   - bounded     — at most `maxSeedPerRun` init_market txs per run;
 *   - never-throw — one bad fixture / HTTP / RPC / tx error logs and continues;
 *                   a whole failed run logs and the next tick retries.
 *   - safe        — simulate-before-send is inherited from KitTxSender.
 *
 * Authority: init_market's `authority` must equal GlobalConfig.authority (the
 * program enforces `global.authority == authority.key()`). Each run pre-checks
 * this against the keeper signer and refuses to send (logs a blocker) if they
 * differ, so a mis-provisioned keeper can never spew failing txs.
 */
import {
  getAddressEncoder,
  getProgramDerivedAddress,
  type Address,
  type KeyPairSigner,
} from "@solana/kit";
import {
  MarketState,
  fetchMaybeGlobalConfig,
  fetchMaybeMarket,
  getInitMarketInstructionAsync,
} from "@fpm/idl";
import {
  TXLINE,
  findConfigPda,
  findMarketConfigPda,
  findMarketPda,
  findVaultPda,
} from "@fpm/shared";
import type { KeeperConfig } from "../config.ts";
import { log } from "../log.ts";
import { marketStateName } from "../actions/context.ts";
import type { SolanaClients } from "../solana/rpc.ts";
import type { TxSender } from "../solana/txSender.ts";
import type { TxlineAuth } from "../txline/auth.ts";
import { fetchFixtureSnapshot } from "../txline/fixtures.ts";
import { fetchImplied1x2 } from "../txline/odds.ts";

/* ----------------------------------------------------------- seed constants */
// MarketConfig#2 — 1X2 predicate (stat1 - stat2); resolve DERIVES the per-hint
// comparator (Team1>Draw=Team2<). Matches scripts/seed-markets.ts.
const CONFIG_ID = 2;
const ONE_USDT = 1_000_000n; // 6 decimals
// LMSR liquidity depth `b` (raw USDT units). Symmetric subsidy = ceil(b·ln3).
const SEED_B = 100n * ONE_USDT; // 100 USDT depth (mirrors LiteSVM tests)
// Real collateral seeded into the vault. Must cover C(seed_q,b) - min(seed_q);
// for symmetric [0,0,0]: ceil(b·ln3) ≈ 109.86 USDT — 200 USDT gives headroom.
const SEED_LIQUIDITY = 200n * ONE_USDT;
// Clamp implied probs so no outcome degenerates to a ~0/100¢ seed offset.
const MIN_PROB = 0.02;
// Require StartTime > now + 2 min at tx time (init_market checks kickoff > now).
const KICKOFF_BUFFER_SECS = 120;
// Freeze 2h after kickoff (matches the script's schedule).
const FREEZE_AFTER_KICKOFF_SECS = 2 * 3_600;

const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" as Address;
const ATA_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL" as Address;

const addressEncoder = getAddressEncoder();

/**
 * Map three implied probabilities to LMSR seed offsets `seed_q = [q1, qx, q2]`.
 *
 * Softmax is shift-invariant, so opening price_i = softmax(q_i / b). Setting
 * `q_i = b · ln(p_i)` reproduces the probabilities exactly; we then shift so
 * `min(seed_q) = 0` (seed offsets are pool-owned; the shift preserves prices).
 * Probs are normalized + clamped to [MIN_PROB, ·] so no offset degenerates.
 */
function seedQFromProbs(
  probs: [number, number, number],
  b: bigint,
): [bigint, bigint, bigint] {
  const clamped = probs.map((p) => Math.max(MIN_PROB, p));
  const sum = clamped.reduce((a, c) => a + c, 0);
  const norm = clamped.map((p) => p / sum);
  const bNum = Number(b);
  const rawQ = norm.map((p) => bNum * Math.log(p)); // <= 0
  const minRaw = Math.min(...rawQ);
  const shifted = rawQ.map((q) => Math.round(q - minRaw)); // >= 0, min = 0
  return [BigInt(shifted[0]), BigInt(shifted[1]), BigInt(shifted[2])];
}

/** Derive the classic-SPL associated token account for owner+mint. */
async function findAtaPda(owner: Address, mint: Address): Promise<Address> {
  const [pda] = await getProgramDerivedAddress({
    programAddress: ATA_PROGRAM,
    seeds: [
      addressEncoder.encode(owner),
      addressEncoder.encode(TOKEN_PROGRAM),
      addressEncoder.encode(mint),
    ],
  });
  return pda;
}

/** A future fixture that has no Market PDA — a candidate to seed. */
interface SeedCandidate {
  fixtureId: bigint;
  teams: string;
  kickoffTs: bigint;
  freezeTs: bigint;
  marketPda: Address;
  vaultPda: Address;
}

/** Per-run tally (logged as a one-line summary). */
export interface RunSummary {
  seeded: number;
  skippedExisting: number;
  future: number;
  noFuture: boolean;
  cappedOut: number;
  failed: number;
}

export class MarketSeeder {
  private readonly config: KeeperConfig;
  private readonly clients: SolanaClients;
  private readonly signer: KeyPairSigner;
  private readonly txSender: TxSender;
  private readonly auth: TxlineAuth;
  private readonly usdtMint: Address;
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    config: KeeperConfig,
    clients: SolanaClients,
    signer: KeyPairSigner,
    txSender: TxSender,
    auth: TxlineAuth,
  ) {
    this.config = config;
    this.clients = clients;
    this.signer = signer;
    this.txSender = txSender;
    this.auth = auth;
    this.usdtMint = TXLINE[config.cluster].usdtMint;
  }

  /** Schedule the never-throw run loop at `autoSeedIntervalMs` (runs once now). */
  start(): void {
    const run = () =>
      void this.runOnce().catch((err) =>
        log.error({ err }, "auto-seed run failed (whole run) — will retry next interval"),
      );
    run();
    this.timer = setInterval(run, this.config.autoSeedIntervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /**
   * One seed run. NEVER throws — every failure mode (auth precheck, HTTP,
   * per-fixture RPC read, per-tx send) logs and is contained. Returns the
   * summary so the dry-run smoke can assert on it.
   */
  async runOnce(): Promise<RunSummary> {
    const summary: RunSummary = {
      seeded: 0,
      skippedExisting: 0,
      future: 0,
      noFuture: false,
      cappedOut: 0,
      failed: 0,
    };
    if (this.running) {
      log.warn("auto-seed: previous run still in flight — skipping this tick");
      return summary;
    }
    this.running = true;
    const dry = this.config.autoSeedDryRun;
    try {
      // ---- authority precheck (do not spew failing txs on a bad signer) ----
      const [configPda] = await findConfigPda();
      const gc = await fetchMaybeGlobalConfig(this.clients.rpc, configPda);
      if (!gc.exists) {
        log.warn({ configPda }, "auto-seed: GlobalConfig not initialized — skipping run");
        return summary;
      }
      if (gc.data.authority !== this.signer.address) {
        log.error(
          {
            globalAuthority: gc.data.authority,
            keeperSigner: this.signer.address,
          },
          "auto-seed BLOCKED: keeper signer != GlobalConfig.authority; init_market " +
            "would fail (program enforces global.authority == authority). Seed with the " +
            "market-authority wallet, or reconfigure the keeper signer. No tx sent.",
        );
        return summary;
      }

      const adminUsdtAta = await findAtaPda(this.signer.address, this.usdtMint);
      const [marketConfigPda] = await findMarketConfigPda(CONFIG_ID);

      // ---- 1. fetch live snapshot (never-throw: HTTP error ends the run) ----
      const snapshot = await fetchFixtureSnapshot(this.config, this.auth);

      // ---- 2. filter to strictly-future fixtures (no synthetic kickoff) ----
      const nowMs = Date.now();
      const minStartMs = nowMs + KICKOFF_BUFFER_SECS * 1_000;
      const future = snapshot
        .filter(
          (f) =>
            f.fixtureId > 0n &&
            Number.isFinite(f.startTime) &&
            f.startTime > minStartMs,
        )
        .sort((a, b) => a.startTime - b.startTime);
      summary.future = future.length;
      if (future.length === 0) {
        summary.noFuture = true;
        log.info("auto-seed: no strictly-future fixtures in snapshot — nothing to seed");
        return summary;
      }

      // ---- 3. dedup against on-chain Market PDAs (pre-read; never tx-fail) ----
      const candidates: SeedCandidate[] = [];
      for (const f of future) {
        try {
          const [marketPda] = await findMarketPda(f.fixtureId);
          const [vaultPda] = await findVaultPda(marketPda);
          const existing = await fetchMaybeMarket(this.clients.rpc, marketPda);
          if (existing.exists) {
            summary.skippedExisting++;
            log.debug(
              {
                fixtureId: f.fixtureId.toString(),
                state: marketStateName(existing.data.state as MarketState),
              },
              "auto-seed: market already on-chain — skip",
            );
            continue;
          }
          candidates.push({
            fixtureId: f.fixtureId,
            teams: `${f.participant1} vs ${f.participant2}`,
            kickoffTs: BigInt(Math.floor(f.startTime / 1_000)),
            freezeTs:
              BigInt(Math.floor(f.startTime / 1_000)) +
              BigInt(FREEZE_AFTER_KICKOFF_SECS),
            marketPda,
            vaultPda,
          });
        } catch (err) {
          // One bad fixture must not kill the run.
          summary.failed++;
          log.warn(
            { fixtureId: f.fixtureId.toString(), err },
            "auto-seed: dedup check failed for fixture — skipping it",
          );
        }
      }

      // ---- 4. cap (SOL-drain guard; no silent truncation) ----
      let toSeed = candidates;
      if (candidates.length > this.config.maxSeedPerRun) {
        summary.cappedOut = candidates.length - this.config.maxSeedPerRun;
        toSeed = candidates.slice(0, this.config.maxSeedPerRun);
        log.warn(
          { new: candidates.length, cap: this.config.maxSeedPerRun, deferred: summary.cappedOut },
          "auto-seed: more new fixtures than per-run cap — seeding cap, deferring rest to next run",
        );
      }

      if (toSeed.length === 0) {
        log.info(
          { future: summary.future, existing: summary.skippedExisting },
          "auto-seed: all future fixtures already have on-chain markets — nothing new",
        );
        return summary;
      }

      // ---- 5. seed each candidate (one init_market per fixture) ----
      for (const c of toSeed) {
        try {
          const probs = await fetchImplied1x2(this.config, this.auth, c.fixtureId);
          const seedQ = probs
            ? seedQFromProbs(probs, SEED_B)
            : ([0n, 0n, 0n] as [bigint, bigint, bigint]);
          const probSource = probs
            ? `StablePrice [H ${(probs[0] * 100).toFixed(1)}%, X ${(probs[1] * 100).toFixed(1)}%, A ${(probs[2] * 100).toFixed(1)}%] -> seed_q ${seedQ.map(String).join(",")}`
            : "symmetric seed_q [0,0,0] (no 1X2 odds on feed) -> 1/3 each";

          if (dry) {
            log.info(
              {
                fixtureId: c.fixtureId.toString(),
                teams: c.teams,
                kickoffTs: c.kickoffTs.toString(),
                freezeTs: c.freezeTs.toString(),
                b: SEED_B.toString(),
                seedQ: seedQ.map(String),
                seedLiquidity: SEED_LIQUIDITY.toString(),
                market: c.marketPda,
                probSource,
              },
              "auto-seed DRY-RUN: WOULD init_market (nothing sent)",
            );
            summary.seeded++;
            continue;
          }

          const ix = await getInitMarketInstructionAsync({
            authority: this.signer,
            marketConfig: marketConfigPda,
            market: c.marketPda,
            vault: c.vaultPda,
            usdtMint: this.usdtMint,
            authorityUsdt: adminUsdtAta,
            tokenProgram: TOKEN_PROGRAM,
            fixtureId: c.fixtureId,
            kickoffTs: c.kickoffTs,
            freezeTs: c.freezeTs,
            b: SEED_B,
            seedQ,
            seedLiquidity: SEED_LIQUIDITY,
          });
          const sig = await this.txSender.sendAndConfirm({
            instructions: [ix],
            writableAccounts: [c.marketPda, c.vaultPda, adminUsdtAta],
          });
          summary.seeded++;
          log.info(
            {
              fixtureId: c.fixtureId.toString(),
              teams: c.teams,
              market: c.marketPda,
              kickoffTs: c.kickoffTs.toString(),
              probSource,
              signature: sig,
            },
            "auto-seed: init_market sent",
          );
        } catch (err) {
          // Per-fixture failure (odds/build/simulate/send) never kills the run;
          // idempotency means the next run retries this fixture cleanly.
          summary.failed++;
          log.warn(
            { fixtureId: c.fixtureId.toString(), teams: c.teams, err },
            "auto-seed: init_market failed for fixture — continuing",
          );
        }
      }
    } catch (err) {
      // Snapshot fetch / precheck transport failure: contained, retried next run.
      log.warn({ err }, "auto-seed: run aborted early (transport/HTTP) — retry next interval");
    } finally {
      this.running = false;
    }

    log.info(
      {
        seeded: summary.seeded,
        skippedExisting: summary.skippedExisting,
        cappedOut: summary.cappedOut,
        failed: summary.failed,
        future: summary.future,
        dryRun: dry,
      },
      dry
        ? "auto-seed DRY-RUN summary (nothing sent)"
        : "auto-seed run summary",
    );
    return summary;
  }
}

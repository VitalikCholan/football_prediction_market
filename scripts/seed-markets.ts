/**
 * Seed on-chain devnet markets from REAL upcoming TxLINE World Cup fixtures.
 *
 * The web app renders one card per on-chain Market; only a couple exist so far.
 * This script pulls the live TxLINE fixtures snapshot, keeps ONLY fixtures whose
 * StartTime is strictly in the future, and calls `init_market` for each one that
 * doesn't already have a Market PDA. The indexer's tail poll ingests + enriches
 * (team names / score / odds) the new markets automatically within ~15s.
 *
 * HARD RULE: no synthetic kickoff times, no mock fixtures. If the snapshot has
 * zero future fixtures we create NOTHING and say so.
 *
 * Idempotent: re-runnable. Each fixture whose Market PDA already exists is
 * skipped. Simulate-before-send is inherited from `sendTx` preflight.
 *
 * Run (repo root):  pnpm --filter @fpm/devnet-scripts seed-markets
 *
 * Env:
 *   HELIUS_RPC_URL     — optional; else public devnet (+ public fallback).
 *   SOLANA_KEYPAIR     — optional; else ~/.config/solana/id.json (admin/keeper).
 *   TXLINE_BASE_URL    — optional; else read from apps/keeper/.env.
 *   TXLINE_API_TOKEN   — read from apps/keeper/.env (gitignored) if unset.
 *   SEED_CAP           — optional; max markets to seed this run (default 8).
 */
import { readFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import {
  AccountRole,
  address,
  appendTransactionMessageInstructions,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  createTransactionMessage,
  getAddressEncoder,
  getBase64EncodedWireTransaction,
  getBase64Encoder,
  getProgramDerivedAddress,
  getSignatureFromTransaction,
  getUtf8Encoder,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Address,
  type Instruction,
  type KeyPairSigner,
  type Rpc,
  type SolanaRpcApi,
} from "@solana/kit";
import {
  MarketState,
  fetchMaybeMarket,
  getInitMarketInstructionAsync,
} from "@fpm/idl";
import {
  AMM_PROGRAM_ID,
  TXLINE,
  findMarketConfigPda,
  findMarketPda,
  findVaultPda,
} from "@fpm/shared";

/* ----------------------------------------------------------------- config */
const RPC_URLS = process.env.HELIUS_RPC_URL
  ? [process.env.HELIUS_RPC_URL, "https://api.devnet.solana.com"]
  : ["https://api.devnet.solana.com"];
const KEYPAIR_PATH =
  process.env.SOLANA_KEYPAIR ?? join(homedir(), ".config", "solana", "id.json");

const TXLINE_PROGRAM = TXLINE.devnet.txlineProgram;
const USDT_MINT = TXLINE.devnet.usdtMint; // 6 decimals, classic SPL Token
const TOKEN_PROGRAM = address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ATA_PROGRAM = address("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const SYSTEM_PROGRAM = address("11111111111111111111111111111111");
const CLOCK_SYSVAR = address("SysvarC1ock11111111111111111111111111111111");

const CONFIG_ID = 1; // MarketConfig#1 — home-win predicate (stat1 - stat2) > 0
// Virtual-reserve total (yes+no). Split per real StablePrice odds when available,
// else 50/50. price_yes = no/(yes+no), and YES = home-win, so no = T·P(home).
const SEED_TOTAL = 200_000_000n; // 200 USDT virtual
const SEED_LIQUIDITY = 10_000_000n; // 10 USDT real collateral per market
// Clamp implied prob so neither virtual reserve degenerates near 0/100¢.
const MIN_PROB = 0.05;
const MAX_PROB = 0.95;
const KICKOFF_BUFFER_SECS = 120n; // require StartTime > now + 2 min at tx time
const FREEZE_AFTER_KICKOFF_SECS = 2n * 3_600n; // freeze 2h after kickoff
const SEED_CAP = Number(process.env.SEED_CAP ?? 8);

// TxLINE request_devnet_faucet (100 USDT/call) — same recovered wiring as
// scripts/devnet-init.ts (discriminator from programs/amm/idls/txline.json,
// seeds recovered empirically from live devnet faucet txs).
const FAUCET_DISCRIMINATOR = new Uint8Array([49, 178, 104, 8, 23, 120, 186, 21]);
const FAUCET_TRACKER_SEED = "faucet_tracker";
const USDT_TREASURY_SEED = "usdt_treasury";

const EXPLORER = (kind: "address" | "tx", id: string) =>
  `https://explorer.solana.com/${kind}/${id}?cluster=devnet`;

/* --------------------------------------------------- TxLINE env (from .env) */
/**
 * Read TXLINE_BASE_URL / TXLINE_API_TOKEN from process.env, falling back to the
 * gitignored apps/keeper/.env. The token is never logged.
 */
function loadTxlineEnv(): { baseUrl: string; token: string | undefined } {
  let baseUrl = process.env.TXLINE_BASE_URL;
  let token = process.env.TXLINE_API_TOKEN;
  if (!baseUrl || !token) {
    const here = dirname(fileURLToPath(import.meta.url));
    const candidates = [
      join(here, "..", "apps", "keeper", ".env"),
      join(here, "..", "apps", "indexer", ".env"),
    ];
    for (const p of candidates) {
      if (!existsSync(p)) continue;
      const raw = readFileSync(p, "utf8");
      for (const line of raw.split(/\r?\n/)) {
        if (line.trim().startsWith("#")) continue;
        const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
        if (!m) continue;
        const val = m[2].replace(/^["']|["']$/g, "").trim();
        if (m[1] === "TXLINE_BASE_URL" && !baseUrl) baseUrl = val;
        if (m[1] === "TXLINE_API_TOKEN" && !token) token = val;
      }
      if (baseUrl && token) break;
    }
  }
  return { baseUrl: baseUrl ?? "https://txline-dev.txodds.com", token };
}

/* ------------------------------------------------------------- rpc + retry */
const rpcs: Rpc<SolanaRpcApi>[] = RPC_URLS.map((u) => createSolanaRpc(u));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function withRpc<T>(
  label: string,
  fn: (rpc: Rpc<SolanaRpcApi>) => Promise<T>,
  attempts = 6,
): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn(rpcs[i % rpcs.length]);
    } catch (e) {
      lastErr = e;
      const wait = 1_000 * (i + 1);
      console.warn(
        `    rpc retry ${i + 1}/${attempts} for ${label} in ${wait}ms — ${
          e instanceof Error ? e.message.slice(0, 160) : e
        }`,
      );
      await sleep(wait);
    }
  }
  throw new Error(
    `${label} failed after ${attempts} attempts: ${
      lastErr instanceof Error ? lastErr.message : lastErr
    }`,
  );
}

/** Read the on-chain Clock sysvar's unix_timestamp (i64 LE at offset 32). */
async function chainNow(): Promise<bigint> {
  return withRpc("chainNow", async (rpc) => {
    const info = await rpc
      .getAccountInfo(CLOCK_SYSVAR, { encoding: "base64" })
      .send();
    if (!info.value) throw new Error("clock sysvar missing");
    const bytes = getBase64Encoder().encode(info.value.data[0]);
    return new DataView(
      bytes.buffer as ArrayBuffer,
      bytes.byteOffset,
      bytes.byteLength,
    ).getBigInt64(32, true);
  });
}

const jsonify = (v: unknown) =>
  JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x));

/** Sign + send + confirm with blockhash-rebuild retry across both RPCs. */
async function sendTx(
  signer: KeyPairSigner,
  ixs: Instruction[],
  label: string,
): Promise<string> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const { value: latestBlockhash } = await withRpc(
      `${label}: getLatestBlockhash`,
      (rpc) => rpc.getLatestBlockhash({ commitment: "confirmed" }).send(),
    );
    const message = pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayerSigner(signer, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, m),
      (m) => appendTransactionMessageInstructions(ixs, m),
    );
    const signed = await signTransactionMessageWithSigners(message);
    const wire = getBase64EncodedWireTransaction(signed);
    const signature = getSignatureFromTransaction(signed);
    try {
      await withRpc(`${label}: sendTransaction`, (rpc) =>
        rpc
          .sendTransaction(wire, {
            encoding: "base64",
            preflightCommitment: "confirmed",
          })
          .send(),
      );
    } catch (e) {
      // Preflight simulation errors are deterministic — do not retry those.
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("custom program error") || msg.includes("Custom")) throw e;
      if (attempt === 3) throw e;
      console.warn(`    ${label}: send attempt ${attempt} failed, rebuilding tx`);
      continue;
    }
    for (let i = 0; i < 75; i++) {
      const { value } = await withRpc(`${label}: getSignatureStatuses`, (rpc) =>
        rpc.getSignatureStatuses([signature]).send(),
      );
      const st = value[0];
      if (
        st &&
        (st.confirmationStatus === "confirmed" ||
          st.confirmationStatus === "finalized")
      ) {
        if (st.err) throw new Error(`tx ${signature} failed: ${jsonify(st.err)}`);
        console.log(`    tx ${label}: ${EXPLORER("tx", signature)}`);
        return signature;
      }
      await sleep(1_000);
    }
    console.warn(`    ${label}: tx ${signature} expired unconfirmed, retrying`);
  }
  throw new Error(`${label}: could not land tx in 3 attempts`);
}

/* ------------------------------------------------------------ faucet + ata */
const utf8 = getUtf8Encoder();
const addressEncoder = getAddressEncoder();

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

async function buildFaucetIx(
  user: Address,
  userUsdtAta: Address,
): Promise<Instruction> {
  const [faucetTracker] = await getProgramDerivedAddress({
    programAddress: TXLINE_PROGRAM,
    seeds: [utf8.encode(FAUCET_TRACKER_SEED), addressEncoder.encode(user)],
  });
  const [usdtTreasury] = await getProgramDerivedAddress({
    programAddress: TXLINE_PROGRAM,
    seeds: [utf8.encode(USDT_TREASURY_SEED)],
  });
  return {
    programAddress: TXLINE_PROGRAM,
    accounts: [
      { address: user, role: AccountRole.WRITABLE_SIGNER },
      { address: faucetTracker, role: AccountRole.WRITABLE },
      { address: USDT_MINT, role: AccountRole.WRITABLE },
      { address: userUsdtAta, role: AccountRole.WRITABLE },
      { address: usdtTreasury, role: AccountRole.READONLY },
      { address: TOKEN_PROGRAM, role: AccountRole.READONLY },
      { address: ATA_PROGRAM, role: AccountRole.READONLY },
      { address: SYSTEM_PROGRAM, role: AccountRole.READONLY },
    ],
    data: FAUCET_DISCRIMINATOR,
  };
}

async function usdtBalance(tokenAccount: Address): Promise<bigint> {
  return withRpc("getTokenAccountBalance", async (rpc) => {
    const info = await rpc
      .getAccountInfo(tokenAccount, { encoding: "jsonParsed" })
      .send();
    if (!info.value) return 0n;
    const data = info.value.data as unknown as {
      parsed: { info: { tokenAmount: { amount: string } } };
    };
    return BigInt(data.parsed.info.tokenAmount.amount);
  });
}

/* --------------------------------------------------------- TxLINE fixtures */
interface SnapshotFixture {
  fixtureId: bigint;
  home: string;
  away: string;
  competition?: string;
  startTimeMs: number; // TxLINE StartTime is epoch MILLISECONDS
  p1IsHome: boolean;
}

/** Guest JWT + X-Api-Token (mirrors keeper/indexer never-throw pattern). */
async function txlineHeaders(
  baseUrl: string,
  token: string,
): Promise<Record<string, string>> {
  const res = await fetch(`${baseUrl}/auth/guest/start`, {
    method: "POST",
    headers: { "content-type": "application/json" },
  });
  if (!res.ok) throw new Error(`guest auth -> ${res.status}`);
  const json = (await res.json()) as {
    token?: string;
    access_token?: string;
    jwt?: string;
  };
  const jwt = json.token ?? json.access_token ?? json.jwt;
  if (!jwt) throw new Error("guest auth response had no token");
  return {
    Authorization: `Bearer ${jwt}`,
    "X-Api-Token": token,
    accept: "application/json",
  };
}

/**
 * GET /api/fixtures/snapshot with retry/backoff on the flaky devnet API.
 * Node 24 global fetch auto-decodes gzip. PascalCase fields per the keeper's
 * verified shape: FixtureId, Participant1/2, StartTime (ms), Participant1IsHome.
 */
async function fetchSnapshot(
  baseUrl: string,
  token: string,
): Promise<SnapshotFixture[]> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const headers = await txlineHeaders(baseUrl, token);
      const res = await fetch(`${baseUrl}/api/fixtures/snapshot`, { headers });
      if (!res.ok) throw new Error(`snapshot -> ${res.status}`);
      const text = await res.text();
      let arr: unknown;
      try {
        arr = JSON.parse(text);
      } catch {
        throw new Error("snapshot -> non-JSON body");
      }
      if (!Array.isArray(arr)) return [];
      return arr.map((f) => {
        const o = f as Record<string, unknown>;
        return {
          fixtureId: BigInt(
            (o.FixtureId ?? o.fixture_id ?? 0) as string | number,
          ),
          home: String(o.Participant1 ?? "").trim(),
          away: String(o.Participant2 ?? "").trim(),
          competition:
            typeof o.Competition === "string" ? o.Competition : undefined,
          startTimeMs: Number(o.StartTime ?? 0),
          p1IsHome: o.Participant1IsHome !== false,
        };
      });
    } catch (e) {
      lastErr = e;
      const wait = 1_500 * attempt;
      console.warn(
        `    snapshot retry ${attempt}/5 in ${wait}ms — ${
          e instanceof Error ? e.message.slice(0, 160) : e
        }`,
      );
      await sleep(wait);
    }
  }
  throw new Error(
    `fixtures snapshot failed after 5 attempts: ${
      lastErr instanceof Error ? lastErr.message : lastErr
    }`,
  );
}

/* --------------------------------------------------------- TxLINE odds */
/**
 * Split SEED_TOTAL into {seedYes, seedNo} so the opening YES price equals the
 * implied P(home win). YES = home-win predicate, and price_yes = no/(yes+no),
 * so `no = T·p`, `yes = T·(1−p)`. `p` clamped to [MIN_PROB, MAX_PROB].
 */
function reservesForProb(pHome: number): { seedYes: bigint; seedNo: bigint } {
  const p = Math.min(MAX_PROB, Math.max(MIN_PROB, pHome));
  const seedNo = BigInt(Math.round(Number(SEED_TOTAL) * p));
  const seedYes = SEED_TOTAL - seedNo;
  return { seedYes, seedNo };
}

/**
 * Fetch the demargined implied P(home win) for a fixture from TxLINE
 * StablePrice odds (`GET /api/odds/snapshot/{fixtureId}`). Uses the `Pct` field
 * (already vig-free implied probability, e.g. "52.632"). Returns the Home-side
 * probability in [0,1], or null when no full-time 1X2 quote is available (the
 * devnet WC odds feed is frequently empty — caller falls back to 50/50).
 * Never throws.
 */
async function fetchOddsImplied(
  baseUrl: string,
  token: string,
  fixtureId: bigint,
): Promise<number | null> {
  try {
    const headers = await txlineHeaders(baseUrl, token);
    const res = await fetch(
      `${baseUrl}/api/odds/snapshot/${fixtureId.toString()}`,
      { headers },
    );
    if (!res.ok) return null;
    const arr = (await res.json()) as unknown;
    if (!Array.isArray(arr) || arr.length === 0) return null;

    // Prefer the freshest full-time match-winner (1X2) quote.
    const isHomeName = (n: string) => /^(home|1|p1|participant\s*1)$/i.test(n.trim());
    let best: { ts: number; pct: number } | null = null;
    for (const row of arr) {
      const o = row as Record<string, unknown>;
      const names = (o.PriceNames ?? o.priceNames) as unknown;
      const pcts = (o.Pct ?? o.pct) as unknown;
      if (!Array.isArray(names) || !Array.isArray(pcts)) continue;
      const idx = names.findIndex(
        (n) => typeof n === "string" && isHomeName(n),
      );
      if (idx < 0) continue;
      const raw = pcts[idx];
      const pct =
        typeof raw === "number"
          ? raw
          : typeof raw === "string" && raw.toUpperCase() !== "NA"
            ? Number.parseFloat(raw)
            : NaN;
      if (!Number.isFinite(pct) || pct <= 0 || pct >= 100) continue;
      const ts = Number(o.Ts ?? o.ts ?? 0);
      if (!best || ts > best.ts) best = { ts, pct };
    }
    return best ? best.pct / 100 : null;
  } catch {
    return null; // resilient — odds are a nice-to-have, never block seeding
  }
}

/* ------------------------------------------------------------------ main */
async function main() {
  const keypairBytes = new Uint8Array(
    JSON.parse(await readFile(KEYPAIR_PATH, "utf8")),
  );
  const admin = await createKeyPairSignerFromBytes(keypairBytes);
  const adminUsdtAta = await findAtaPda(admin.address, USDT_MINT);
  const [marketConfigPda] = await findMarketConfigPda(CONFIG_ID);

  console.log(`admin/keeper wallet: ${admin.address}`);
  console.log(`amm program:         ${AMM_PROGRAM_ID}`);
  console.log(`market config #${CONFIG_ID}: ${marketConfigPda}`);

  const { baseUrl, token } = loadTxlineEnv();
  console.log(`txline base:         ${baseUrl}`);
  console.log(`txline token:        ${token ? "present" : "MISSING"}`);
  if (!token) {
    throw new Error(
      "TXLINE_API_TOKEN not found (env or apps/keeper/.env) — cannot fetch real fixtures",
    );
  }

  // ---- 1. fetch REAL fixtures from the live TxLINE snapshot ----
  console.log("\n==> fetching live TxLINE fixtures snapshot");
  const snapshot = await fetchSnapshot(baseUrl, token);
  console.log(`    snapshot returned ${snapshot.length} fixture(s)`);

  // ---- 2. filter to REAL FUTURE only (no synthetic kickoff) ----
  const now = await chainNow(); // on-chain clock (init_market checks kickoff > now)
  const nowMs = Number(now) * 1_000;
  const minStartMs = nowMs + Number(KICKOFF_BUFFER_SECS) * 1_000;

  const future: SnapshotFixture[] = [];
  const pastOrBad: { fx: SnapshotFixture; why: string }[] = [];
  for (const fx of snapshot) {
    if (fx.fixtureId <= 0n) {
      pastOrBad.push({ fx, why: "missing/zero FixtureId" });
      continue;
    }
    if (!Number.isFinite(fx.startTimeMs) || fx.startTimeMs <= 0) {
      pastOrBad.push({ fx, why: "missing StartTime" });
      continue;
    }
    if (fx.startTimeMs <= minStartMs) {
      const mins = Math.round((fx.startTimeMs - nowMs) / 60_000);
      pastOrBad.push({ fx, why: `StartTime not future enough (${mins} min)` });
      continue;
    }
    future.push(fx);
  }
  future.sort((a, b) => a.startTimeMs - b.startTimeMs);

  console.log(`    real future fixtures: ${future.length}`);
  for (const fx of future) {
    const mins = Math.round((fx.startTimeMs - nowMs) / 60_000);
    console.log(
      `      ${fx.fixtureId}  ${fx.home} vs ${fx.away}  (+${mins} min, ${fx.competition ?? "?"})`,
    );
  }
  for (const { fx, why } of pastOrBad) {
    console.log(`      SKIP ${fx.fixtureId} ${fx.home} vs ${fx.away} — ${why}`);
  }

  const report: {
    seeded: {
      fixtureId: string;
      teams: string;
      kickoff: string;
      sig: string;
    }[];
    skippedExisting: { fixtureId: string; teams: string; state: string }[];
    skippedPast: { fixtureId: string; teams: string; why: string }[];
    cappedOut: { fixtureId: string; teams: string }[];
  } = {
    seeded: [],
    skippedExisting: [],
    skippedPast: pastOrBad.map(({ fx, why }) => ({
      fixtureId: fx.fixtureId.toString(),
      teams: `${fx.home} vs ${fx.away}`,
      why,
    })),
    cappedOut: [],
  };

  if (future.length === 0) {
    console.log(
      "\nNo real upcoming fixtures in TxLINE devnet feed — nothing seeded " +
        "(no synthetic per instruction).",
    );
    printReport(report);
    return;
  }

  // ---- 3. partition: which fixtures already have a Market PDA on-chain ----
  const toSeed: { fx: SnapshotFixture; marketPda: Address; vaultPda: Address }[] =
    [];
  for (const fx of future) {
    const [marketPda] = await findMarketPda(fx.fixtureId);
    const [vaultPda] = await findVaultPda(marketPda);
    const existing = await withRpc("fetchMaybeMarket", (rpc) =>
      fetchMaybeMarket(rpc, marketPda),
    );
    if (existing.exists) {
      report.skippedExisting.push({
        fixtureId: fx.fixtureId.toString(),
        teams: `${fx.home} vs ${fx.away}`,
        state: MarketState[existing.data.state],
      });
      console.log(
        `    already on-chain: ${fx.fixtureId} (${MarketState[existing.data.state]}) — skip`,
      );
      continue;
    }
    toSeed.push({ fx, marketPda, vaultPda });
  }

  // ---- 4. cap (no silent truncation) ----
  let capped = toSeed;
  if (toSeed.length > SEED_CAP) {
    capped = toSeed.slice(0, SEED_CAP);
    for (const { fx } of toSeed.slice(SEED_CAP)) {
      report.cappedOut.push({
        fixtureId: fx.fixtureId.toString(),
        teams: `${fx.home} vs ${fx.away}`,
      });
    }
    console.warn(
      `    CAP: ${toSeed.length} new fixtures > cap ${SEED_CAP}; seeding first ${SEED_CAP}, ` +
        `deferring ${toSeed.length - SEED_CAP} (see report)`,
    );
  }

  if (capped.length === 0) {
    console.log("\nAll real future fixtures already have on-chain markets — nothing new to seed.");
    printReport(report);
    return;
  }

  // ---- 5. funding: ensure admin USDT covers N × seed (+ small headroom) ----
  const needed = BigInt(capped.length) * SEED_LIQUIDITY + 1_000_000n;
  console.log(`\n==> funding: need ${needed} raw USDT for ${capped.length} market(s)`);

  // SOL for gas (Helius airdrop only works on some endpoints; best-effort).
  const solBal = await withRpc("getBalance", (rpc) =>
    rpc.getBalance(admin.address).send(),
  );
  console.log(`    admin SOL: ${Number(solBal.value) / 1e9}`);
  if (solBal.value < 20_000_000n) {
    try {
      await withRpc("requestAirdrop", (rpc) =>
        rpc.requestAirdrop(admin.address, 500_000_000n as never).send(),
      );
      console.log("    requested 0.5 SOL airdrop (may be rate-limited)");
      await sleep(4_000);
    } catch (e) {
      console.warn(
        `    airdrop failed (fund manually if gas runs out): ${
          e instanceof Error ? e.message.slice(0, 120) : e
        }`,
      );
    }
  }

  let bal = await usdtBalance(adminUsdtAta);
  console.log(`    admin USDT: ${bal} raw (${Number(bal) / 1e6})`);
  // Faucet gives 100 USDT/call; loop a few times if we're short (cooldown-tolerant).
  for (let i = 0; i < 5 && bal < needed; i++) {
    try {
      await sendTx(admin, [await buildFaucetIx(admin.address, adminUsdtAta)], "request_devnet_faucet");
    } catch (e) {
      console.warn(
        `    faucet attempt ${i + 1} failed (cooldown?): ${
          e instanceof Error ? e.message.slice(0, 160) : e
        }`,
      );
      break;
    }
    bal = await usdtBalance(adminUsdtAta);
    console.log(`    admin USDT after faucet: ${bal} raw (${Number(bal) / 1e6})`);
  }

  // If still short, seed only as many as we can afford (no synthetic shrink of
  // real fixtures — just fewer markets, honestly reported).
  const affordable = Number((bal - 1_000_000n) / SEED_LIQUIDITY);
  if (affordable < capped.length) {
    if (affordable <= 0) {
      throw new Error(
        `insufficient USDT: have ${bal} raw, need >= ${SEED_LIQUIDITY + 1_000_000n} for even one market`,
      );
    }
    for (const { fx } of capped.slice(affordable)) {
      report.cappedOut.push({
        fixtureId: fx.fixtureId.toString(),
        teams: `${fx.home} vs ${fx.away}`,
      });
    }
    console.warn(
      `    FUNDING CAP: can afford ${affordable}/${capped.length} markets with ${bal} raw USDT`,
    );
    capped = capped.slice(0, affordable);
  }

  // ---- 6. seed each new market (one init_market per fixture) ----
  console.log(`\n==> seeding ${capped.length} market(s)`);
  for (const { fx, marketPda, vaultPda } of capped) {
    const label = `init_market ${fx.fixtureId} (${fx.home} vs ${fx.away})`;
    console.log(`\n  ${label}`);
    // Re-derive kickoff/freeze from the REAL StartTime (seconds). Re-check the
    // future guard against a fresh clock in case funding took a while.
    const clock = await chainNow();
    const kickoffTs = BigInt(Math.floor(fx.startTimeMs / 1_000));
    const freezeTs = kickoffTs + FREEZE_AFTER_KICKOFF_SECS;
    if (kickoffTs <= clock) {
      console.warn(
        `    SKIP — real StartTime ${kickoffTs} is no longer > clock ${clock}`,
      );
      report.skippedPast.push({
        fixtureId: fx.fixtureId.toString(),
        teams: `${fx.home} vs ${fx.away}`,
        why: "StartTime passed before tx",
      });
      continue;
    }
    // Open at the real StablePrice implied odds when the feed has them,
    // else fall back to 50/50. price_yes = P(home win) either way.
    const pHome = await fetchOddsImplied(baseUrl, token, fx.fixtureId);
    const { seedYes, seedNo } =
      pHome != null ? reservesForProb(pHome) : { seedYes: SEED_TOTAL / 2n, seedNo: SEED_TOTAL / 2n };
    console.log(
      pHome != null
        ? `    odds: P(home)=${(pHome * 100).toFixed(1)}% -> open ${Math.round((Number(seedNo) / Number(SEED_TOTAL)) * 100)}¢ (StablePrice)`
        : `    odds: none on feed -> open 50¢ (50/50 fallback)`,
    );
    try {
      const ix = await getInitMarketInstructionAsync({
        authority: admin,
        marketConfig: marketConfigPda,
        market: marketPda,
        vault: vaultPda,
        usdcMint: USDT_MINT,
        authorityUsdc: adminUsdtAta,
        tokenProgram: TOKEN_PROGRAM,
        fixtureId: fx.fixtureId,
        kickoffTs,
        freezeTs,
        seedYes,
        seedNo,
        seedLiquidity: SEED_LIQUIDITY,
      });
      const sig = await sendTx(admin, [ix], label);
      report.seeded.push({
        fixtureId: fx.fixtureId.toString(),
        teams: `${fx.home} vs ${fx.away}`,
        kickoff: new Date(fx.startTimeMs).toISOString(),
        sig,
      });
      console.log(`    OK — market ${marketPda}, kickoff ${kickoffTs}, freeze ${freezeTs}`);
    } catch (e) {
      console.error(
        `    FAIL ${fx.fixtureId} — ${e instanceof Error ? e.message : e}`,
      );
      // continue to next fixture; partial success is acceptable + idempotent
    }
  }

  printReport(report);
}

function printReport(report: {
  seeded: { fixtureId: string; teams: string; kickoff: string; sig: string }[];
  skippedExisting: { fixtureId: string; teams: string; state: string }[];
  skippedPast: { fixtureId: string; teams: string; why: string }[];
  cappedOut: { fixtureId: string; teams: string }[];
}) {
  console.log("\n===== seed-markets summary =====");
  console.log(`seeded (${report.seeded.length}):`);
  for (const s of report.seeded)
    console.log(`  ${s.fixtureId}  ${s.teams}  kickoff ${s.kickoff}  ${EXPLORER("tx", s.sig)}`);
  console.log(`skipped — already on-chain (${report.skippedExisting.length}):`);
  for (const s of report.skippedExisting)
    console.log(`  ${s.fixtureId}  ${s.teams}  (${s.state})`);
  console.log(`skipped — past/invalid (${report.skippedPast.length}):`);
  for (const s of report.skippedPast)
    console.log(`  ${s.fixtureId}  ${s.teams}  — ${s.why}`);
  if (report.cappedOut.length > 0) {
    console.log(`deferred by cap/funding (${report.cappedOut.length}):`);
    for (const s of report.cappedOut)
      console.log(`  ${s.fixtureId}  ${s.teams}`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("\naborted:", e instanceof Error ? e.message : e);
    process.exit(1);
  });

/**
 * Seed on-chain devnet 3-way (1X2) markets from REAL upcoming TxLINE World Cup
 * fixtures (SPEC §3.1 phase C2).
 *
 * Mirrors scripts/seed-markets.ts but for the LMSR `Market1x2`:
 *   1. ensure a `create_market_config_1x2` (config_id 2, market_kind = 1X2,
 *      resolution_period = 100) exists;
 *   2. pull the live TxLINE fixtures snapshot, keep ONLY strictly-future
 *      fixtures with no `Market1x2` PDA yet;
 *   3. `init_market_1x2` for each — seeding LMSR liquidity `b` + per-outcome
 *      seed offsets `seed_q = [q1, qx, q2]` from the TxLINE 1X2 StablePrice odds
 *      when available, else SYMMETRIC `[0,0,0]` (1/3 each per SPEC init).
 *
 * HARD RULE (inherited): no synthetic kickoff times, no mock fixtures. If the
 * snapshot has zero future fixtures we create NOTHING and say so.
 *
 * Idempotent: re-runnable. Simulate-before-send is inherited from `sendTx`
 * preflight.
 *
 * Run (repo root):  pnpm --filter @fpm/devnet-scripts seed-markets-1x2
 *
 * Env (same as seed-markets.ts):
 *   HELIUS_RPC_URL, SOLANA_KEYPAIR, TXLINE_BASE_URL, TXLINE_API_TOKEN, SEED_CAP.
 */
import { readFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
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
  fetchMaybeMarket1x2,
  fetchMaybeMarketConfig,
  getCreateMarketConfig1x2InstructionAsync,
  getInitMarket1x2InstructionAsync,
} from "@fpm/idl";
import {
  AMM_PROGRAM_ID,
  MARKET_KIND_1X2,
  TXLINE,
  findMarket1x2Pda,
  findMarketConfigPda,
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

// MarketConfig#2 — 1X2 predicate. Base predicate (stat1 - stat2) with threshold
// 0; resolve_1x2 DERIVES the comparator per hint (Team1>Draw=Team2<), so the
// stored `resolution_comparison` is ignored. resolution_period = 100 (TxLINE
// full-time final stats carry period 100).
const CONFIG_ID_1X2 = 2;
const RESOLUTION_PERIOD = 100;

const ONE_USDT = 1_000_000n; // 6 decimals
// LMSR liquidity depth `b` (raw USDT units). Symmetric subsidy = ceil(b·ln3).
const SEED_B = 100n * ONE_USDT; // 100 USDT depth (mirrors LiteSVM tests)
// Real collateral seeded into the vault. Must be >= C(seed_q,b) - min(seed_q).
// For symmetric [0,0,0]: ceil(b·ln3) ≈ 109.86 USDT. We seed 200 USDT (headroom).
const SEED_LIQUIDITY = 200n * ONE_USDT;
// Clamp implied probs so no outcome degenerates to a ~0/100¢ seed offset.
const MIN_PROB = 0.02;
const KICKOFF_BUFFER_SECS = 120n;
const FREEZE_AFTER_KICKOFF_SECS = 2n * 3_600n;
const SEED_CAP = Number(process.env.SEED_CAP ?? 8);

// TxLINE request_devnet_faucet (100 USDT/call) — same wiring as seed-markets.ts.
const FAUCET_DISCRIMINATOR = new Uint8Array([49, 178, 104, 8, 23, 120, 186, 21]);
const FAUCET_TRACKER_SEED = "faucet_tracker";
const USDT_TREASURY_SEED = "usdt_treasury";

// 1X2 fee params — identical to the binary config #1 (devnet-init.ts).
const FEE_PARAMS = {
  baseFeeBps: 30,
  maxFeeBps: 500,
  vfcNum: 5_000,
  filterPeriod: 30,
  decayPeriod: 600,
  reductionBps: 5_000,
  maxVAcc: 1_000_000n,
  resolutionGraceSecs: 300n,
  resolutionThreshold: 0,
  resolutionComparison: 0, // ignored by resolve_1x2 (derived per hint)
  statKeyA: 1, // P1 (home) goals
  statKeyB: 2, // P2 (away) goals
  statOp: 2, // Subtract
} as const;

const EXPLORER = (kind: "address" | "tx", id: string) =>
  `https://explorer.solana.com/${kind}/${id}?cluster=devnet`;

/* --------------------------------------------------- TxLINE env (from .env) */
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
  startTimeMs: number;
}

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
          fixtureId: BigInt((o.FixtureId ?? o.fixture_id ?? 0) as string | number),
          home: String(o.Participant1 ?? "").trim(),
          away: String(o.Participant2 ?? "").trim(),
          competition:
            typeof o.Competition === "string" ? o.Competition : undefined,
          startTimeMs: Number(o.StartTime ?? 0),
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

/* --------------------------------------------------------- TxLINE 1X2 odds */
/**
 * Fetch demargined implied probabilities for the three 1X2 outcomes
 * [P(Team1/home), P(Draw), P(Team2/away)] from the TxLINE StablePrice odds
 * snapshot. Uses the `Pct` field (already vig-free). Returns null when no
 * full-time 1X2 quote is available (the devnet WC feed is frequently empty —
 * caller falls back to symmetric seeding). Never throws.
 */
async function fetch1x2Implied(
  baseUrl: string,
  token: string,
  fixtureId: bigint,
): Promise<[number, number, number] | null> {
  try {
    const headers = await txlineHeaders(baseUrl, token);
    const res = await fetch(
      `${baseUrl}/api/odds/snapshot/${fixtureId.toString()}`,
      { headers },
    );
    if (!res.ok) return null;
    const arr = (await res.json()) as unknown;
    if (!Array.isArray(arr) || arr.length === 0) return null;

    const isHome = (n: string) => /^(home|1|p1|participant\s*1)$/i.test(n.trim());
    const isDraw = (n: string) => /^(draw|x|tie)$/i.test(n.trim());
    const isAway = (n: string) => /^(away|2|p2|participant\s*2)$/i.test(n.trim());

    let best: { ts: number; probs: [number, number, number] } | null = null;
    for (const row of arr) {
      const o = row as Record<string, unknown>;
      const names = (o.PriceNames ?? o.priceNames) as unknown;
      const pcts = (o.Pct ?? o.pct) as unknown;
      if (!Array.isArray(names) || !Array.isArray(pcts)) continue;

      const pick = (test: (n: string) => boolean): number | null => {
        const idx = names.findIndex((n) => typeof n === "string" && test(n));
        if (idx < 0) return null;
        const raw = pcts[idx];
        const pct =
          typeof raw === "number"
            ? raw
            : typeof raw === "string" && raw.toUpperCase() !== "NA"
              ? Number.parseFloat(raw)
              : NaN;
        return Number.isFinite(pct) && pct > 0 && pct < 100 ? pct / 100 : null;
      };
      const h = pick(isHome);
      const d = pick(isDraw);
      const a = pick(isAway);
      // Need a full 3-way quote to open a 1X2 book.
      if (h == null || d == null || a == null) continue;
      const ts = Number(o.Ts ?? o.ts ?? 0);
      if (!best || ts > best.ts) best = { ts, probs: [h, d, a] };
    }
    return best ? best.probs : null;
  } catch {
    return null;
  }
}

/**
 * Map three implied probabilities to LMSR seed offsets `seed_q = [q1, qx, q2]`.
 *
 * Softmax is shift-invariant, so opening price_i = softmax(q_i / b). Setting
 * `q_i = b · ln(p_i)` reproduces the probabilities exactly; we then shift so
 * `min(seed_q) = 0` (seed offsets are pool-owned; the shift preserves prices).
 * With min = 0 the solvency-at-init bound is simply `seed_liquidity >= C(q,b)`.
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

/* ------------------------------------------------------------------ main */
async function main() {
  const keypairBytes = new Uint8Array(
    JSON.parse(await readFile(KEYPAIR_PATH, "utf8")),
  );
  const admin = await createKeyPairSignerFromBytes(keypairBytes);
  const adminUsdtAta = await findAtaPda(admin.address, USDT_MINT);
  const [marketConfigPda] = await findMarketConfigPda(CONFIG_ID_1X2);

  console.log(`admin/keeper wallet: ${admin.address}`);
  console.log(`amm program:         ${AMM_PROGRAM_ID}`);
  console.log(`1X2 market config #${CONFIG_ID_1X2}: ${marketConfigPda}`);

  const { baseUrl, token } = loadTxlineEnv();
  console.log(`txline base:         ${baseUrl}`);
  console.log(`txline token:        ${token ? "present" : "MISSING"}`);
  if (!token) {
    throw new Error(
      "TXLINE_API_TOKEN not found (env or apps/keeper/.env) — cannot fetch real fixtures",
    );
  }

  // ---- 0. ensure the 1X2 MarketConfig exists (idempotent) ----
  console.log(`\n==> ensuring 1X2 market config #${CONFIG_ID_1X2}`);
  const existingCfg = await withRpc("fetchMaybeMarketConfig", (rpc) =>
    fetchMaybeMarketConfig(rpc, marketConfigPda),
  );
  if (existingCfg.exists) {
    const kindOk = existingCfg.data.marketKind === MARKET_KIND_1X2;
    console.log(
      `    SKIP — config #${CONFIG_ID_1X2} exists (market_kind=${existingCfg.data.marketKind}` +
        `${kindOk ? "" : " — NOT 1X2! inspect manually"}, resolution_period=${existingCfg.data.resolutionPeriod})`,
    );
    if (!kindOk) {
      throw new Error(
        `config #${CONFIG_ID_1X2} exists but is not a 1X2 config — refusing to seed 1X2 markets against it`,
      );
    }
  } else {
    const ix = await getCreateMarketConfig1x2InstructionAsync({
      authority: admin,
      marketConfig: marketConfigPda,
      configId: CONFIG_ID_1X2,
      params: FEE_PARAMS,
      resolutionPeriod: RESOLUTION_PERIOD,
    });
    await sendTx(admin, [ix], `create_market_config_1x2 (#${CONFIG_ID_1X2})`);
    console.log(
      `    created 1X2 config #${CONFIG_ID_1X2}: predicate (stat1 - stat2), period ${RESOLUTION_PERIOD}`,
    );
  }

  // ---- 1. fetch REAL fixtures ----
  console.log("\n==> fetching live TxLINE fixtures snapshot");
  const snapshot = await fetchSnapshot(baseUrl, token);
  console.log(`    snapshot returned ${snapshot.length} fixture(s)`);

  // ---- 2. filter to REAL FUTURE only ----
  const now = await chainNow();
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
    seeded: { fixtureId: string; teams: string; kickoff: string; sig: string }[];
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

  // ---- 3. partition: which fixtures already have a Market1x2 PDA ----
  const toSeed: { fx: SnapshotFixture; marketPda: Address; vaultPda: Address }[] =
    [];
  for (const fx of future) {
    const [marketPda] = await findMarket1x2Pda(fx.fixtureId);
    const [vaultPda] = await findVaultPda(marketPda);
    const existing = await withRpc("fetchMaybeMarket1x2", (rpc) =>
      fetchMaybeMarket1x2(rpc, marketPda),
    );
    if (existing.exists) {
      report.skippedExisting.push({
        fixtureId: fx.fixtureId.toString(),
        teams: `${fx.home} vs ${fx.away}`,
        state: MarketState[existing.data.state],
      });
      console.log(
        `    already on-chain (1X2): ${fx.fixtureId} (${MarketState[existing.data.state]}) — skip`,
      );
      continue;
    }
    toSeed.push({ fx, marketPda, vaultPda });
  }

  // ---- 4. cap ----
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
      `    CAP: ${toSeed.length} new fixtures > cap ${SEED_CAP}; seeding first ${SEED_CAP}`,
    );
  }

  if (capped.length === 0) {
    console.log("\nAll real future fixtures already have on-chain 1X2 markets — nothing new to seed.");
    printReport(report);
    return;
  }

  // ---- 5. funding ----
  const needed = BigInt(capped.length) * SEED_LIQUIDITY + 1_000_000n;
  console.log(`\n==> funding: need ${needed} raw USDT for ${capped.length} market(s)`);

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

  // ---- 6. seed each new 1X2 market ----
  console.log(`\n==> seeding ${capped.length} 1X2 market(s)`);
  for (const { fx, marketPda, vaultPda } of capped) {
    const label = `init_market_1x2 ${fx.fixtureId} (${fx.home} vs ${fx.away})`;
    console.log(`\n  ${label}`);
    const clock = await chainNow();
    const kickoffTs = BigInt(Math.floor(fx.startTimeMs / 1_000));
    const freezeTs = kickoffTs + FREEZE_AFTER_KICKOFF_SECS;
    if (kickoffTs <= clock) {
      console.warn(`    SKIP — real StartTime ${kickoffTs} is no longer > clock ${clock}`);
      report.skippedPast.push({
        fixtureId: fx.fixtureId.toString(),
        teams: `${fx.home} vs ${fx.away}`,
        why: "StartTime passed before tx",
      });
      continue;
    }

    // Open at real 1X2 StablePrice odds when the feed has them, else symmetric.
    const probs = await fetch1x2Implied(baseUrl, token, fx.fixtureId);
    const seedQ = probs
      ? seedQFromProbs(probs, SEED_B)
      : ([0n, 0n, 0n] as [bigint, bigint, bigint]);
    console.log(
      probs
        ? `    odds: [H ${(probs[0] * 100).toFixed(1)}%, X ${(probs[1] * 100).toFixed(1)}%, A ${(probs[2] * 100).toFixed(1)}%] -> seed_q ${seedQ.map(String).join(",")}`
        : `    odds: none on feed -> symmetric seed_q [0,0,0] (1/3 each)`,
    );

    try {
      const ix = await getInitMarket1x2InstructionAsync({
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
        b: SEED_B,
        seedQ,
        seedLiquidity: SEED_LIQUIDITY,
      });
      const sig = await sendTx(admin, [ix], label);
      report.seeded.push({
        fixtureId: fx.fixtureId.toString(),
        teams: `${fx.home} vs ${fx.away}`,
        kickoff: new Date(fx.startTimeMs).toISOString(),
        sig,
      });
      console.log(`    OK — market1x2 ${marketPda}, kickoff ${kickoffTs}, freeze ${freezeTs}`);
    } catch (e) {
      console.error(`    FAIL ${fx.fixtureId} — ${e instanceof Error ? e.message : e}`);
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
  console.log("\n===== seed-markets-1x2 summary =====");
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

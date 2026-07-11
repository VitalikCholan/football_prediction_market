/**
 * Surfpool integration test (anchor-programs-plan.md §10.2, §12 item 18).
 *
 * Drives the FULL market lifecycle through a real JSON-RPC endpoint against a
 * surfpool fork of DEVNET, so the `resolve` CPI hits the REAL TxLINE oracle
 * binary (lazily cloned from devnet) — not the LiteSVM mock:
 *
 *   deploy → initialize_config → create_market_config → init_market →
 *   open_position → (buy-before-activate guard) → timeTravel → activate →
 *   buy → timeTravel → freeze → resolve probes vs REAL txoracle →
 *   force-Resolved via surfnet_setAccount → redeem → timeTravel → close.
 *
 * The resolve probes prove our discriminator + Borsh arg layout are accepted
 * by the production TxLINE binary (a layout mismatch would fail Anchor
 * deserialization with a different signature). A proof-VALID resolve is NOT
 * covered here — that needs real Merkle proofs from the TxLINE keeper API.
 *
 * KEY FINDING (2026-07-04, probes 5b/5c): TxLINE `ts` is in MILLISECONDS —
 * the real binary derives the daily roots PDA as ts/86_400_000 and stores one
 * root per 5-minute batch slot. This originally exposed a seconds-vs-ms bug in
 * `resolve.rs` (epoch_day = ts/86_400); FIXED same day: `resolve.rs` now uses
 * MILLIS_PER_DAY, so probe 5b drives the REAL binary's full Merkle
 * verification path THROUGH our resolve instruction (expect 6004/6007).
 *
 * Self-managing: spawns `surfpool start --network devnet --ci --no-deploy`
 * itself and kills it on exit. Set SURFPOOL_RPC_URL to reuse an already
 * running instance (it will NOT be killed). Requirements: `surfpool` at
 * SURFPOOL_BIN (default ~/.local/bin/surfpool), `solana` CLI on PATH, a
 * funded-by-airdrop default keypair at ~/.config/solana/id.json, network
 * access (accounts are lazily fetched from devnet).
 *
 * Run: pnpm test:surfpool   (root) — exits non-zero on the first failure.
 */
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { openSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  AccountRole,
  address,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  fixEncoderSize,
  getArrayEncoder,
  getBase64Encoder,
  getBooleanEncoder,
  getBytesEncoder,
  getI32Encoder,
  getI64Encoder,
  getOptionEncoder,
  getProgramDerivedAddress,
  getStructEncoder,
  getU16Encoder,
  getU8Encoder,
  getU32Encoder,
  pipe,
  createTransactionMessage,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  appendTransactionMessageInstructions,
  signTransactionMessageWithSigners,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  type Address,
  type Instruction,
  type KeyPairSigner,
  type Rpc,
  type SolanaRpcApi,
} from "@solana/kit";
import {
  AMM_ERROR__INVALID_MARKET_STATE,
  AMM_ERROR__INVALID_MERKLE_ROOTS_ACCOUNT,
  BinaryExpression,
  MarketState,
  Outcome,
  Side,
  fetchMarket,
  fetchMaybeGlobalConfig,
  fetchMaybeMarket,
  fetchPosition,
  getMarketDecoder,
  getMarketEncoder,
  getActivateMarketInstructionAsync,
  getBuyInstructionAsync,
  getCloseMarketInstructionAsync,
  getCreateMarketConfigInstructionAsync,
  getFreezeMarketInstructionAsync,
  getInitMarketInstructionAsync,
  getInitializeConfigInstructionAsync,
  getOpenPositionInstructionAsync,
  getRedeemInstructionAsync,
  getResolveInstructionAsync,
} from "@fpm/idl";
import {
  AMM_PROGRAM_ID,
  DAILY_SCORES_ROOTS_SEED,
  TXLINE,
  findConfigPda,
  findMarketConfigPda,
  findMarketPda,
  findPositionPda,
  findVaultPda,
} from "@fpm/shared";

const execFileAsync = promisify(execFile);

/* ----------------------------------------------------------------- config */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SURFPOOL_BIN =
  process.env.SURFPOOL_BIN ?? join(homedir(), ".local", "bin", "surfpool");
const PORT = Number(process.env.SURFPOOL_PORT ?? 8899);
const EXTERNAL_RPC = process.env.SURFPOOL_RPC_URL; // set → reuse, don't spawn/kill
const RPC_URL = EXTERNAL_RPC ?? `http://127.0.0.1:${PORT}`;
const KEYPAIR_PATH =
  process.env.SURFPOOL_KEYPAIR ?? join(homedir(), ".config", "solana", "id.json");
const AMM_SO = join(REPO_ROOT, "target", "deploy", "amm.so");
const AMM_KEYPAIR = join(REPO_ROOT, "target", "deploy", "amm-keypair.json");

const TXLINE_PROGRAM = TXLINE.devnet.txlineProgram;
const USDT_MINT = TXLINE.devnet.usdtMint;
const TOKEN_PROGRAM = address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const CLOCK_SYSVAR = address("SysvarC1ock11111111111111111111111111111111");

const SECONDS_PER_DAY = 86_400n;
const MILLIS_PER_DAY = 86_400_000n; // TxLINE ts is MILLISECONDS (see header)
const CONFIG_ID = 1;
const BASE_FIXTURE_ID = 17_588_316n;
const SEED_YES = 1_000_000_000n; // 1000 USDT virtual reserve
const SEED_NO = 1_000_000_000n;
const SEED_LIQUIDITY = 1_000_000_000n; // 1000 USDT real collateral
const BUY_USDT_IN = 50_000_000n; // 50 USDT
const GRACE_SECS = 3_600n;

/* ------------------------------------------------------------- utilities */
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** JSON.stringify that survives the bigints Kit's RPC layer produces. */
const jsonify = (v: unknown) =>
  JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? Number(x) : x));

async function rawRpc<T = unknown>(
  method: string,
  params: unknown[],
): Promise<T> {
  const res = await fetch(RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const json = (await res.json()) as {
    result?: T;
    error?: { code: number; message: string; data?: unknown };
  };
  if (json.error) {
    throw new Error(
      `${method}: ${json.error.message} ${JSON.stringify(json.error.data ?? "")}`,
    );
  }
  return json.result as T;
}

/** Read the on-chain Clock sysvar's unix_timestamp (i64 LE at offset 32). */
async function chainNow(rpc: Rpc<SolanaRpcApi>): Promise<bigint> {
  const info = await rpc
    .getAccountInfo(CLOCK_SYSVAR, { encoding: "base64" })
    .send();
  assert(info.value, "clock sysvar missing");
  const bytes = getBase64Encoder().encode(info.value.data[0]);
  return new DataView(
    bytes.buffer as ArrayBuffer,
    bytes.byteOffset,
    bytes.byteLength,
  ).getBigInt64(32, true);
}

/** surfnet_timeTravel takes ABSOLUTE MILLISECONDS; verify via the sysvar. */
async function timeTravel(rpc: Rpc<SolanaRpcApi>, targetTs: bigint) {
  await rawRpc("surfnet_timeTravel", [
    { absoluteTimestamp: Number(targetTs) * 1000 },
  ]);
  for (let i = 0; i < 50; i++) {
    if ((await chainNow(rpc)) >= targetTs) return;
    await sleep(200);
  }
  throw new Error(`timeTravel to ${targetTs} did not reflect in Clock sysvar`);
}

async function sendTx(
  rpc: Rpc<SolanaRpcApi>,
  signer: KeyPairSigner,
  ixs: Instruction[],
): Promise<string> {
  const { value: latestBlockhash } = await rpc
    .getLatestBlockhash({ commitment: "confirmed" })
    .send();
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(signer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, m),
    (m) => appendTransactionMessageInstructions(ixs, m),
  );
  const signed = await signTransactionMessageWithSigners(message);
  const wire = getBase64EncodedWireTransaction(signed);
  const signature = getSignatureFromTransaction(signed);
  await rpc
    .sendTransaction(wire, {
      encoding: "base64",
      preflightCommitment: "confirmed",
    })
    .send();
  for (let i = 0; i < 75; i++) {
    const { value } = await rpc.getSignatureStatuses([signature]).send();
    const st = value[0];
    if (
      st &&
      (st.confirmationStatus === "confirmed" ||
        st.confirmationStatus === "finalized")
    ) {
      if (st.err) throw new Error(`tx ${signature} failed: ${jsonify(st.err)}`);
      return signature;
    }
    await sleep(200);
  }
  throw new Error(`tx ${signature} not confirmed in time`);
}

interface SimResult {
  err: unknown;
  logs: readonly string[];
  customError: number | null;
}

/** Simulate (full SVM execution on the fork) and capture err + logs. */
async function simulateTx(
  rpc: Rpc<SolanaRpcApi>,
  signer: KeyPairSigner,
  ixs: Instruction[],
): Promise<SimResult> {
  const { value: latestBlockhash } = await rpc
    .getLatestBlockhash({ commitment: "confirmed" })
    .send();
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(signer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, m),
    (m) => appendTransactionMessageInstructions(ixs, m),
  );
  const signed = await signTransactionMessageWithSigners(message);
  const wire = getBase64EncodedWireTransaction(signed);
  const { value } = await rpc
    .simulateTransaction(wire, { encoding: "base64", commitment: "confirmed" })
    .send();
  const err = value.err as
    | null
    | string
    | { InstructionError?: [number, { Custom?: number | bigint } | string] };
  let customError: number | null = null;
  if (err && typeof err === "object" && Array.isArray(err.InstructionError)) {
    const detail = err.InstructionError[1];
    if (
      detail &&
      typeof detail === "object" &&
      (typeof detail.Custom === "number" || typeof detail.Custom === "bigint")
    ) {
      customError = Number(detail.Custom);
    }
  }
  return { err, logs: value.logs ?? [], customError };
}

async function usdtBalance(
  rpc: Rpc<SolanaRpcApi>,
  tokenAccount: Address,
): Promise<bigint> {
  const { value } = await rpc.getTokenAccountBalance(tokenAccount).send();
  return BigInt(value.amount);
}

/* ------------------------------------------------------------ txline direct */
/**
 * Hand-built `validate_stat` instruction against the REAL TxLINE program
 * (Borsh layout + Anchor discriminator from `programs/amm/idls/txline.json`).
 * Used by probe 5c to reach TxLINE's proof-verification path with a
 * MILLISECOND `ts` — which our AMM's (seconds-based) epoch-day guard cannot
 * currently forward.
 */
function buildDirectValidateStatIx(
  rootsPda: Address,
  tsMs: bigint,
  fixtureId: bigint,
): Instruction {
  const bytes32 = fixEncoderSize(getBytesEncoder(), 32);
  const proofNode = getStructEncoder([
    ["hash", bytes32],
    ["isRightSibling", getBooleanEncoder()],
  ]);
  const scoreStat = getStructEncoder([
    ["key", getU32Encoder()],
    ["value", getI32Encoder()],
    ["period", getI32Encoder()],
  ]);
  const statTerm = getStructEncoder([
    ["statToProve", scoreStat],
    ["eventStatRoot", bytes32],
    ["statProof", getArrayEncoder(proofNode)],
  ]);
  const data = getStructEncoder([
    ["discriminator", fixEncoderSize(getBytesEncoder(), 8)],
    ["ts", getI64Encoder()],
    [
      "fixtureSummary",
      getStructEncoder([
        ["fixtureId", getI64Encoder()],
        [
          "updateStats",
          getStructEncoder([
            ["updateCount", getI32Encoder()],
            ["minTimestamp", getI64Encoder()],
            ["maxTimestamp", getI64Encoder()],
          ]),
        ],
        ["eventsSubTreeRoot", bytes32],
      ]),
    ],
    ["fixtureProof", getArrayEncoder(proofNode)],
    ["mainTreeProof", getArrayEncoder(proofNode)],
    [
      "predicate",
      getStructEncoder([
        ["threshold", getI32Encoder()],
        ["comparison", getU8Encoder()],
      ]),
    ],
    ["statA", statTerm],
    ["statB", getOptionEncoder(statTerm)],
    ["op", getOptionEncoder(getU8Encoder())],
  ]).encode({
    // sha256("global:validate_stat")[0..8] — from the published devnet IDL
    discriminator: new Uint8Array([107, 197, 232, 90, 191, 136, 105, 185]),
    ts: tsMs,
    fixtureSummary: {
      fixtureId,
      updateStats: { updateCount: 1, minTimestamp: tsMs, maxTimestamp: tsMs },
      eventsSubTreeRoot: new Uint8Array(32),
    },
    fixtureProof: [],
    mainTreeProof: [],
    predicate: { threshold: 0, comparison: 0 }, // GreaterThan
    statA: {
      statToProve: { key: 1, value: 2, period: 0 },
      eventStatRoot: new Uint8Array(32),
      statProof: [],
    },
    statB: {
      statToProve: { key: 2, value: 0, period: 0 },
      eventStatRoot: new Uint8Array(32),
      statProof: [],
    },
    op: 1, // Subtract
  });
  return {
    programAddress: TXLINE_PROGRAM,
    accounts: [{ address: rootsPda, role: AccountRole.READONLY }],
    data,
  };
}

/* ------------------------------------------------------- surfpool control */
let surfpool: ChildProcess | null = null;

async function isHealthy(): Promise<boolean> {
  try {
    return (await rawRpc<string>("getHealth", [])) === "ok";
  } catch {
    return false;
  }
}

async function startSurfpool(): Promise<string> {
  if (EXTERNAL_RPC) {
    assert(await isHealthy(), `no healthy surfpool at ${EXTERNAL_RPC}`);
    return `reusing external instance at ${EXTERNAL_RPC}`;
  }
  if (await isHealthy()) {
    return `reusing already-running instance on port ${PORT} (will NOT be killed)`;
  }
  const logPath = join(tmpdir(), `surfpool-fpm-${Date.now()}.log`);
  const logFd = openSync(logPath, "a");
  surfpool = spawn(
    SURFPOOL_BIN,
    [
      "start",
      "--network",
      "devnet",
      "--ci",
      "--no-deploy",
      "--no-studio",
      "-p",
      String(PORT),
    ],
    {
      env: { ...process.env, NO_DNA: "1" },
      stdio: ["ignore", logFd, logFd],
    },
  );
  surfpool.on("exit", (code) => {
    surfpool = null;
    if (code !== 0 && code !== null) {
      console.error(`surfpool exited with code ${code}; log: ${logPath}`);
    }
  });
  for (let i = 0; i < 90; i++) {
    if (await isHealthy()) return `spawned pid ${surfpool?.pid} (log: ${logPath})`;
    await sleep(1000);
  }
  throw new Error(`surfpool did not become healthy in 90s; log: ${logPath}`);
}

function stopSurfpool() {
  if (surfpool && surfpool.pid) {
    surfpool.kill("SIGINT");
    setTimeout(() => surfpool?.kill("SIGKILL"), 3000).unref();
  }
}
process.on("SIGINT", () => {
  stopSurfpool();
  process.exit(130);
});
process.on("exit", stopSurfpool);

/* ------------------------------------------------------------ step runner */
const results: { name: string; ok: boolean; note: string }[] = [];
async function step(name: string, fn: () => Promise<string | void>) {
  try {
    const note = (await fn()) ?? "";
    results.push({ name, ok: true, note });
    console.log(`PASS  ${name}${note ? ` — ${note}` : ""}`);
  } catch (e) {
    const note = e instanceof Error ? e.message : String(e);
    results.push({ name, ok: false, note });
    console.error(`FAIL  ${name} — ${note}`);
    throw e;
  }
}

function printSummary() {
  console.log("\n===== surfpool integration summary =====");
  for (const r of results) {
    console.log(`  ${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.note ? ` — ${r.note}` : ""}`);
  }
  const failed = results.filter((r) => !r.ok).length;
  console.log(`  ${results.length - failed}/${results.length} steps passed`);
}

/* ------------------------------------------------------------------ main */
async function main() {
  const rpc = createSolanaRpc(RPC_URL);

  // ---- surfnet up ----
  await step("surfnet: start + healthy", async () => startSurfpool());

  // ---- signer (admin = keeper = default CLI keypair, airdropped at boot) ----
  const keypairBytes = new Uint8Array(
    JSON.parse(await readFile(KEYPAIR_PATH, "utf8")),
  );
  const admin = await createKeyPairSignerFromBytes(keypairBytes);

  // ---- 1. preflight: deploy amm.so, verify executable ----
  await step("preflight: deploy amm.so", async () => {
    await execFileAsync(
      "solana",
      [
        "program",
        "deploy",
        AMM_SO,
        "--program-id",
        AMM_KEYPAIR,
        "--url",
        RPC_URL,
        "--keypair",
        KEYPAIR_PATH,
        "--commitment",
        "confirmed",
      ],
      { cwd: REPO_ROOT, timeout: 120_000 },
    );
    const { value } = await rpc
      .getAccountInfo(AMM_PROGRAM_ID, { encoding: "base64" })
      .send();
    assert(value?.executable, "program account not executable after deploy");
    return `program live, payer ${admin.address}`;
  });

  const [configPda] = await findConfigPda();
  const [marketConfigPda] = await findMarketConfigPda(CONFIG_ID);

  // ---- 2. initialize_config ----
  await step("initialize_config", async () => {
    const existing = await fetchMaybeGlobalConfig(rpc, configPda);
    if (existing.exists) {
      assert(
        existing.data.authority === admin.address &&
          existing.data.keeper === admin.address &&
          existing.data.txlineProgram === TXLINE_PROGRAM &&
          existing.data.usdtMint === USDT_MINT,
        "GlobalConfig exists with foreign values — restart surfpool fresh",
      );
      return "already initialized (reused instance) — values match";
    }
    const ix = await getInitializeConfigInstructionAsync({
      authority: admin,
      keeper: admin.address,
      txlineProgram: TXLINE_PROGRAM,
      usdtMint: USDT_MINT,
      tokenProgram: TOKEN_PROGRAM,
    });
    await sendTx(rpc, admin, [ix]);
    return `config ${configPda}: keeper=admin, txline=${TXLINE_PROGRAM}`;
  });

  // ---- 3. create_market_config (home-win predicate, D-8) ----
  await step("create_market_config", async () => {
    const info = await rpc.getAccountInfo(marketConfigPda).send();
    if (info.value) return `config_id ${CONFIG_ID} already exists (reused instance)`;
    const ix = await getCreateMarketConfigInstructionAsync({
      authority: admin,
      marketConfig: marketConfigPda,
      configId: CONFIG_ID,
      // params became a nested struct once FeeParamsArgs stopped being
      // single-use (create_market_config_1x2 reuses it) — same wire bytes.
      params: {
        baseFeeBps: 30,
        maxFeeBps: 500,
        vfcNum: 5_000,
        filterPeriod: 30,
        decayPeriod: 600,
        reductionBps: 5_000,
        maxVAcc: 1_000_000n,
        resolutionGraceSecs: GRACE_SECS,
        // home win: (goals P1 [key 1] - goals P2 [key 2]) > 0, GT=0, Subtract=2
        resolutionThreshold: 0,
        resolutionComparison: 0,
        statKeyA: 1,
        statKeyB: 2,
        statOp: 2,
      },
    });
    await sendTx(rpc, admin, [ix]);
    return `config_id ${CONFIG_ID}: predicate (stat1 - stat2) > 0`;
  });

  // ---- 4a. fund admin USDT ATA via cheatcode (REAL devnet mint, lazily cloned) ----
  let adminUsdt!: Address;
  await step("surfnet_setTokenAccount: fund USDT ATA", async () => {
    await rawRpc("surfnet_setTokenAccount", [
      admin.address,
      USDT_MINT,
      { amount: 100_000_000_000 }, // 100k USDT (6 dp)
    ]);
    const { value } = await rpc
      .getTokenAccountsByOwner(
        admin.address,
        { mint: USDT_MINT },
        { encoding: "jsonParsed" },
      )
      .send();
    assert(value.length > 0, "no USDT token account after cheatcode");
    adminUsdt = value[0].pubkey;
    const amount = value[0].account.data.parsed.info.tokenAmount.amount;
    return `ATA ${adminUsdt} = ${amount} (raw)`;
  });

  // ---- 4b. init_market ----
  let fixtureId = BASE_FIXTURE_ID;
  {
    // rerun-safety on a reused instance: bump fixture id until PDA is free
    for (let i = 0; i < 20; i++) {
      const [pda] = await findMarketPda(fixtureId);
      const existing = await fetchMaybeMarket(rpc, pda);
      if (!existing.exists) break;
      fixtureId += 1n;
    }
  }
  const [marketPda] = await findMarketPda(fixtureId);
  const [vaultPda] = await findVaultPda(marketPda);
  const [positionPda] = await findPositionPda(marketPda, admin.address);

  const t0 = await chainNow(rpc);
  const kickoffTs = t0 + 600n;
  const freezeTs = t0 + 1_200n;

  await step("init_market", async () => {
    const ix = await getInitMarketInstructionAsync({
      authority: admin,
      marketConfig: marketConfigPda,
      market: marketPda,
      vault: vaultPda,
      usdtMint: USDT_MINT,
      authorityUsdt: adminUsdt,
      tokenProgram: TOKEN_PROGRAM,
      fixtureId,
      kickoffTs,
      freezeTs,
      seedYes: SEED_YES,
      seedNo: SEED_NO,
      seedLiquidity: SEED_LIQUIDITY,
    });
    await sendTx(rpc, admin, [ix]);
    const market = await fetchMarket(rpc, marketPda);
    assert(market.data.state === MarketState.Open, "market not Open");
    assert(market.data.lastPriceBps === 5_000, "seed price != 5000 bps");
    const vaultBal = await usdtBalance(rpc, vaultPda);
    assert(vaultBal === SEED_LIQUIDITY, `vault ${vaultBal} != seed ${SEED_LIQUIDITY}`);
    return `fixture ${fixtureId}, market ${marketPda}, price 5000 bps, vault ${vaultBal}`;
  });

  // ---- 4c. open_position ----
  await step("open_position", async () => {
    const ix = await getOpenPositionInstructionAsync({
      owner: admin,
      market: marketPda,
      position: positionPda,
    });
    await sendTx(rpc, admin, [ix]);
    const pos = await fetchPosition(rpc, positionPda);
    assert(pos.data.yesTokens === 0n && pos.data.noTokens === 0n, "position not empty");
    return `position ${positionPda}`;
  });

  const buyIx = async () =>
    getBuyInstructionAsync({
      trader: admin,
      market: marketPda,
      marketConfig: marketConfigPda,
      position: positionPda,
      traderUsdt: adminUsdt,
      vault: vaultPda,
      usdtMint: USDT_MINT,
      tokenProgram: TOKEN_PROGRAM,
      side: Side.Yes,
      usdtIn: BUY_USDT_IN,
      minOut: 1n,
    });

  // ---- 4d. lifecycle guard: buy before activate must fail ----
  await step("guard: buy before activate rejected", async () => {
    const sim = await simulateTx(rpc, admin, [await buyIx()]);
    assert(
      sim.customError === AMM_ERROR__INVALID_MARKET_STATE,
      `expected InvalidMarketState (${AMM_ERROR__INVALID_MARKET_STATE}), got ${jsonify(sim.err)}`,
    );
    return `rejected with custom error ${sim.customError} (InvalidMarketState)`;
  });

  // ---- 4e. timeTravel past kickoff → activate ----
  await step("surfnet_timeTravel past kickoff + activate_market", async () => {
    await timeTravel(rpc, kickoffTs + 5n);
    const ix = await getActivateMarketInstructionAsync({
      keeper: admin,
      market: marketPda,
    });
    await sendTx(rpc, admin, [ix]);
    const market = await fetchMarket(rpc, marketPda);
    assert(market.data.state === MarketState.Trading, "market not Trading");
    return `clock ≥ ${kickoffTs + 5n}, state Trading`;
  });

  // ---- 4f. buy: position credited, price moved, vault increased ----
  await step("buy (YES): position credited + price moved", async () => {
    const before = await fetchMarket(rpc, marketPda);
    const vaultBefore = await usdtBalance(rpc, vaultPda);
    await sendTx(rpc, admin, [await buyIx()]);
    const after = await fetchMarket(rpc, marketPda);
    const pos = await fetchPosition(rpc, positionPda);
    const vaultAfter = await usdtBalance(rpc, vaultPda);
    assert(pos.data.yesTokens > 0n, "yes_tokens not credited");
    assert(
      after.data.lastPriceBps > before.data.lastPriceBps,
      `YES price did not rise: ${before.data.lastPriceBps} -> ${after.data.lastPriceBps}`,
    );
    assert(
      vaultAfter === vaultBefore + BUY_USDT_IN,
      `vault delta ${vaultAfter - vaultBefore} != usdt_in ${BUY_USDT_IN}`,
    );
    return `yes_tokens=${pos.data.yesTokens}, price ${before.data.lastPriceBps}→${after.data.lastPriceBps} bps, vault +${BUY_USDT_IN}`;
  });

  // ---- 4g. timeTravel past freeze → freeze ----
  await step("surfnet_timeTravel past freeze + freeze_market", async () => {
    await timeTravel(rpc, freezeTs + 5n);
    const ix = await getFreezeMarketInstructionAsync({
      keeper: admin,
      market: marketPda,
    });
    await sendTx(rpc, admin, [ix]);
    const market = await fetchMarket(rpc, marketPda);
    assert(market.data.state === MarketState.Locked, "market not Locked");
    return "state Locked";
  });

  // ---- 5. resolve probes against the REAL forked TxLINE binary ----
  const u16 = getU16Encoder();
  const rootsPdaForDay = async (day: number): Promise<Address> => {
    const [pda] = await getProgramDerivedAddress({
      programAddress: TXLINE_PROGRAM,
      seeds: [DAILY_SCORES_ROOTS_SEED, u16.encode(day)],
    });
    return pda;
  };
  const rootsExists = async (pda: Address): Promise<boolean> => {
    const { value } = await rpc.getAccountInfo(pda, { encoding: "base64" }).send();
    return value !== null && value.owner === TXLINE_PROGRAM;
  };
  const resolveIx = async (ts: bigint, rootsPda: Address) =>
    getResolveInstructionAsync({
      keeper: admin,
      market: marketPda,
      marketConfig: marketConfigPda,
      txlineProgram: TXLINE_PROGRAM,
      dailyScoresMerkleRoots: rootsPda,
      outcomeHint: Side.Yes,
      ts,
      // fixtureSummary became a nested struct once ScoresBatchSummary stopped
      // being single-use (resolve_1x2 reuses it) — same wire bytes.
      fixtureSummary: {
        fixtureId,
        updateStats: { updateCount: 1, minTimestamp: ts, maxTimestamp: ts },
        eventsSubTreeRoot: new Uint8Array(32),
      },
      fixtureProof: [],
      mainTreeProof: [],
      statA: {
        statToProve: { key: 1, value: 2, period: 0 },
        eventStatRoot: new Uint8Array(32),
        statProof: [],
      },
      statB: {
        statToProve: { key: 2, value: 0, period: 0 },
        eventStatRoot: new Uint8Array(32),
        statProof: [],
      },
      op: BinaryExpression.Subtract,
    });

  const nowDay = Number((await chainNow(rpc)) / SECONDS_PER_DAY);

  // 5a. epoch_day with NO devnet roots PDA → our pre-CPI guard fires
  //     (owner check: a missing account is system-owned, so the AMM rejects it
  //     with InvalidMerkleRootsAccount BEFORE TxLINE could return 6007).
  //     `ts` is MILLISECONDS (matches resolve.rs MILLIS_PER_DAY derivation).
  await step("resolve 5a: missing daily_scores_roots PDA", async () => {
    let day = nowDay + 2;
    while (await rootsExists(await rootsPdaForDay(day))) day += 1;
    const ts = BigInt(day) * MILLIS_PER_DAY + 43_200_000n;
    const sim = await simulateTx(rpc, admin, [
      await resolveIx(ts, await rootsPdaForDay(day)),
    ]);
    assert(
      sim.customError === AMM_ERROR__INVALID_MERKLE_ROOTS_ACCOUNT,
      `expected InvalidMerkleRootsAccount (${AMM_ERROR__INVALID_MERKLE_ROOTS_ACCOUNT}), got ${jsonify(sim.err)}\n${sim.logs.join("\n")}`,
    );
    return `epoch_day ${day} (roots PDA absent) → AMM custom error ${sim.customError} InvalidMerkleRootsAccount (pre-CPI guard; TxLINE 6007 shielded)`;
  });

  // 5b. EXISTING devnet roots PDA (lazily cloned) + garbage proofs, driven
  //     THROUGH OUR `resolve` instruction with a ms-scale `ts`. Since the
  //     s↔ms fix, our epoch-day derivation matches the real binary's seeds
  //     constraint, so the CPI reaches TxLINE's FULL verification path:
  //       - 5-min slot with a posted root → 6004 InvalidMainTreeProof
  //         (garbage proofs rejected by real Merkle verification), or
  //       - empty slot → 6007 RootNotAvailable.
  //     Either way: discriminator + Borsh layout + PDA derivation all
  //     accepted by the production program, through our own instruction.
  let existingRootsDay: number | null = null;
  let existingRootsPda: Address | null = null;
  for (let day = nowDay; day > nowDay - 21; day--) {
    const pda = await rootsPdaForDay(day);
    if (await rootsExists(pda)) {
      existingRootsDay = day;
      existingRootsPda = pda;
      break;
    }
  }
  await step("resolve 5b: full REAL-TxLINE verification via our resolve", async () => {
    if (!existingRootsPda || existingRootsDay === null) {
      return "SKIPPED — no daily_scores_roots PDA found on devnet within 21 days";
    }
    let sim: SimResult | null = null;
    let tsMs = 0n;
    let empty6007 = 0;
    for (let slot = 0; slot < 48; slot++) {
      tsMs = BigInt(existingRootsDay) * MILLIS_PER_DAY + BigInt(slot) * 300_000n;
      sim = await simulateTx(rpc, admin, [await resolveIx(tsMs, existingRootsPda)]);
      assert(sim.err !== null, "garbage proofs unexpectedly ACCEPTED");
      assert(
        sim.logs.some((l) => l.includes(`Program ${TXLINE_PROGRAM} invoke`)) &&
          sim.logs.some((l) => l.includes("Instruction: ValidateStat")),
        `CPI into TxLINE ValidateStat not visible in logs:\n${sim.logs.join("\n")}`,
      );
      if (sim.customError === 6007) {
        empty6007 += 1;
        continue; // no root posted in this 5-min slot — try the next
      }
      break;
    }
    assert(sim, "no simulation ran");
    assert(
      sim.customError === 6004 || sim.customError === 6007,
      `expected TxLINE 6004 InvalidMainTreeProof (posted root + garbage proof) or 6007 RootNotAvailable, got ${jsonify(sim.err)}\n${sim.logs.join("\n")}`,
    );
    console.log("    txline log tail:");
    for (const l of sim.logs.filter((x) => x.includes("Error") || x.includes(TXLINE_PROGRAM)).slice(-4))
      console.log(`      ${l}`);
    const verdict =
      sim.customError === 6004
        ? `6004 InvalidMainTreeProof — FULL Merkle verification executed against the posted root`
        : `6007 RootNotAvailable on all ${empty6007} probed slots (no posted root that day)`;
    return `ms ts ${tsMs} through OUR resolve → real binary ${verdict}; discriminator+layout+PDA all accepted`;
  });

  // 5c. Direct validate_stat against the REAL binary with ts in MILLISECONDS
  //     — bypasses our AMM (control probe: isolates the raw TxLINE interface
  //     from our instruction's guards). The roots account stores one
  //     32-byte root per 5-minute batch slot; scan slots until one is posted:
  //       - empty slot → 6007 RootNotAvailable (validate_stat.rs:59)
  //       - posted slot + garbage proofs → 6004 InvalidMainTreeProof
  //         (validate_stat.rs:73) — the FULL Merkle verification executed.
  await step("resolve 5c: direct validate_stat, ms ts, garbage proofs", async () => {
    if (!existingRootsPda || existingRootsDay === null) {
      return "SKIPPED — no daily_scores_roots PDA found on devnet within 21 days";
    }
    let last: SimResult | null = null;
    let lastTsMs = 0n;
    let hit6007 = 0;
    for (let slot = 0; slot < 48; slot++) {
      lastTsMs = BigInt(existingRootsDay) * 86_400_000n + BigInt(slot) * 300_000n;
      const ix = buildDirectValidateStatIx(existingRootsPda, lastTsMs, fixtureId);
      last = await simulateTx(rpc, admin, [ix]);
      assert(last.err !== null, "garbage proofs unexpectedly ACCEPTED");
      assert(
        last.logs.some((l) => l.includes("Instruction: ValidateStat")),
        `ValidateStat not reached:\n${last.logs.join("\n")}`,
      );
      if (last.customError === 6007) {
        hit6007 += 1;
        continue; // no root posted in this 5-min slot — try the next one
      }
      break;
    }
    assert(last, "no simulation ran");
    assert(
      last.customError !== null && last.customError >= 6000 && last.customError < 7000,
      `expected a TxLINE 6xxx verification error, got ${jsonify(last.err)}\n${last.logs.join("\n")}`,
    );
    const errLine = last.logs.find((l) => l.includes("Error Number")) ?? "";
    console.log("    txline verification error:");
    for (const l of last.logs.filter((x) => x.includes("Error") || x.includes("Program log")).slice(-4))
      console.log(`      ${l}`);
    return `epoch_day ${existingRootsDay}, ms ts ${lastTsMs}${hit6007 ? ` (after ${hit6007}× 6007 RootNotAvailable on empty slots)` : ""} → real binary returned ${last.customError}${errLine ? ` (${errLine.replace("Program log: ", "")})` : ""}`;
  });

  // ---- 6a. force Resolved(Yes) via surfnet_setAccount (state patch) ----
  await step("surfnet_setAccount: force state=Resolved outcome=Yes", async () => {
    const info = await rpc.getAccountInfo(marketPda, { encoding: "base64" }).send();
    assert(info.value, "market account missing");
    const bytes = getBase64Encoder().encode(info.value.data[0]);
    const decoded = getMarketDecoder().decode(bytes);
    const patched = getMarketEncoder().encode({
      ...decoded,
      state: MarketState.Resolved,
      outcome: Outcome.Yes,
    });
    await rawRpc("surfnet_setAccount", [
      marketPda,
      {
        lamports: Number(info.value.lamports),
        owner: info.value.owner,
        executable: false,
        data: Buffer.from(patched).toString("hex"), // surfnet_setAccount takes HEX
      },
    ]);
    const market = await fetchMarket(rpc, marketPda);
    assert(market.data.state === MarketState.Resolved, "state not Resolved");
    assert(market.data.outcome === Outcome.Yes, "outcome not Yes");
    return "market patched to Resolved / Yes (verified via decode)";
  });

  // ---- 6b. redeem: winner gets 1 USDT per YES token ----
  await step("redeem: winner payout 1 USDT per YES token", async () => {
    const posBefore = await fetchPosition(rpc, positionPda);
    const expected = posBefore.data.yesTokens;
    const balBefore = await usdtBalance(rpc, adminUsdt);
    const ix = await getRedeemInstructionAsync({
      owner: admin,
      market: marketPda,
      position: positionPda,
      vault: vaultPda,
      ownerUsdt: adminUsdt,
      usdtMint: USDT_MINT,
      tokenProgram: TOKEN_PROGRAM,
    });
    await sendTx(rpc, admin, [ix]);
    const balAfter = await usdtBalance(rpc, adminUsdt);
    const pos = await fetchPosition(rpc, positionPda);
    assert(expected > 0n, "nothing to redeem");
    assert(
      balAfter - balBefore === expected,
      `payout ${balAfter - balBefore} != yes_tokens ${expected}`,
    );
    assert(pos.data.redeemed, "position not flagged redeemed");
    return `payout ${expected} (raw USDT) — balance delta matches, position flagged`;
  });

  // ---- 6c. timeTravel past grace → close_market ----
  await step("surfnet_timeTravel past grace + close_market", async () => {
    await timeTravel(rpc, freezeTs + GRACE_SECS + 10n);
    const ix = await getCloseMarketInstructionAsync({
      authority: admin,
      market: marketPda,
      marketConfig: marketConfigPda,
      vault: vaultPda,
      authorityUsdt: adminUsdt,
      usdtMint: USDT_MINT,
      tokenProgram: TOKEN_PROGRAM,
    });
    await sendTx(rpc, admin, [ix]);
    const market = await rpc.getAccountInfo(marketPda, { encoding: "base64" }).send();
    const vault = await rpc.getAccountInfo(vaultPda, { encoding: "base64" }).send();
    assert(market.value === null, "market account not closed");
    assert(vault.value === null, "vault token account not closed");
    return "vault swept+closed, market account reclaimed";
  });
}

main()
  .then(() => {
    printSummary();
    stopSurfpool();
    process.exit(0);
  })
  .catch((e) => {
    console.error("\naborted:", e instanceof Error ? e.message : e);
    printSummary();
    stopSurfpool();
    process.exit(1);
  });

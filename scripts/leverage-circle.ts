/**
 * LEVERAGE-CIRCLE devnet demo (plans/leverage-v1.md verification).
 *
 * Drives the full v1 leverage lifecycle against the LIVE devnet program:
 *   1. create_market_config #2 with leverage ENABLED (max_leverage 5, tfn 2)
 *   2. init_market on a synthetic fixture (kickoff in the past, freeze +2h)
 *   3. activate_market (admin == keeper on devnet)
 *   4. init_leverage_pool + open_lp_account + deposit_lp (45 USDT)
 *   5. post_mark [45¢, 30¢, 25¢]  (first post — initializes, no accrual)
 *   6. open_leverage: 8 USDT collateral, 3x on Team1 (notional 24, U≈53.3)
 *   7. wait ~65s → post_mark [51¢, 27¢, 22¢]  (accrues segment @45¢ marks)
 *   8. wait ~65s → post_mark again              (accrues segment @51¢ marks)
 *   9. close_leverage → payout = max(0, C + pnl − F); prints the ledger
 *
 * Idempotent per step (safe to re-run; a settled position just re-opens on
 * the next run only if the LevPosition was closed).
 *
 * Run (repo root):  pnpm --filter @fpm/devnet-scripts leverage-circle
 * Env: HELIUS_RPC_URL (recommended), FIXTURE_ID (default 990000001),
 *      KEYPAIR_PATH (default ~/.config/solana/id.json)
 */
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  address,
  appendTransactionMessageInstructions,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  createTransactionMessage,
  getAddressEncoder,
  getBase64Encoder,
  getProgramDerivedAddress,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
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
  MarketState,
  fetchMaybeMarket,
  fetchMaybeMarketConfig,
  fetchMaybeLeveragePool,
  fetchMaybeLevPosition,
  fetchMaybeLpAccount,
  getActivateMarketInstructionAsync,
  getCloseLeverageInstructionAsync,
  getCreateMarketConfigInstructionAsync,
  getDepositLpInstructionAsync,
  getInitLeveragePoolInstructionAsync,
  getInitMarketInstructionAsync,
  getOpenLeverageInstructionAsync,
  getOpenLpAccountInstructionAsync,
  getPostMarkInstructionAsync,
} from "@fpm/idl";
import {
  AMM_PROGRAM_ID,
  TXLINE,
  findLevPoolPda,
  findLevPositionPda,
  findLevVaultPda,
  findLpAccountPda,
  findMarketConfigPda,
  findMarketPda,
} from "@fpm/shared";

/* ----------------------------------------------------------------- config */
const RPC_URLS = process.env.HELIUS_RPC_URL
  ? [process.env.HELIUS_RPC_URL, "https://api.devnet.solana.com"]
  : ["https://api.devnet.solana.com"];
const KEYPAIR_PATH =
  process.env.KEYPAIR_PATH ?? join(homedir(), ".config/solana/id.json");

const USDT_MINT = TXLINE.devnet.usdtMint;
const TOKEN_PROGRAM = address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ATA_PROGRAM = address("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const CLOCK_SYSVAR = address("SysvarC1ock11111111111111111111111111111111");

const CONFIG_ID = Number(process.env.LEV_CONFIG_ID ?? 3); // leverage-enabled config (config #1 stays spot-only; #2 is a stale zero-leverage leftover)
const FIXTURE_ID = BigInt(process.env.FIXTURE_ID ?? 990_000_001);

const ONE = 1_000_000n; // USDT 6dp
const SEED_B = 15n * ONE; // subsidy ceil(b·ln3) ≈ 16.5 USDT
const SEED_LIQUIDITY = 18n * ONE;
const LP_DEPOSIT = 45n * ONE;
const COLLATERAL = BigInt(process.env.COLLATERAL_USDT ?? 8) * ONE;
const LEVERAGE = 3;
const OUTCOME = 0; // Team1
const MARKS_T0: [number, number, number] = [4_500, 3_000, 2_500];
const MARKS_T1: [number, number, number] = [5_100, 2_700, 2_200];
const SEGMENT_WAIT_SECS = 65; // > funding_epoch_secs (60) so post_mark accrues

const INDEX_SCALE = 1_000_000_000_000n;
const BPS = 10_000n;

const EXPLORER = (kind: "address" | "tx", id: string) =>
  `https://explorer.solana.com/${kind}/${id}?cluster=devnet`;

/* ------------------------------------------------------------- rpc + send */
const rpcs: Rpc<SolanaRpcApi>[] = RPC_URLS.map((u) => createSolanaRpc(u));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const jsonify = (v: unknown) =>
  JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x));

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
  throw new Error(`${label} failed after ${attempts} attempts: ${lastErr}`);
}

async function chainNow(): Promise<bigint> {
  return withRpc("chainNow", async (rpc) => {
    const info = await rpc.getAccountInfo(CLOCK_SYSVAR, { encoding: "base64" }).send();
    if (!info.value) throw new Error("clock sysvar missing");
    const bytes = getBase64Encoder().encode(info.value.data[0]);
    return new DataView(
      bytes.buffer as ArrayBuffer,
      bytes.byteOffset,
      bytes.byteLength,
    ).getBigInt64(32, true);
  });
}

async function sendTx(
  signer: KeyPairSigner,
  ixs: Instruction[],
  label: string,
): Promise<string> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const { value: latestBlockhash } = await withRpc(`${label}: blockhash`, (rpc) =>
      rpc.getLatestBlockhash().send(),
    );
    const tx = await signTransactionMessageWithSigners(
      pipe(
        createTransactionMessage({ version: 0 }),
        (m) => setTransactionMessageFeePayerSigner(signer, m),
        (m) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, m),
        (m) => appendTransactionMessageInstructions(ixs, m),
      ),
    );
    const wire = getBase64EncodedWireTransaction(tx);
    // simulate-before-send
    const sim = await withRpc(`${label}: simulate`, (rpc) =>
      rpc.simulateTransaction(wire, { encoding: "base64" }).send(),
    );
    if (sim.value.err) {
      throw new Error(
        `${label}: SIM ERR ${jsonify(sim.value.err)}\n${(sim.value.logs ?? [])
          .slice(-6)
          .join("\n")}`,
      );
    }
    const signature = getSignatureFromTransaction(tx);
    await withRpc(`${label}: send`, (rpc) =>
      rpc.sendTransaction(wire, { encoding: "base64", skipPreflight: true }).send(),
    );
    for (let i = 0; i < 30; i++) {
      const { value } = await withRpc(`${label}: status`, (rpc) =>
        rpc.getSignatureStatuses([signature]).send(),
      );
      const st = value[0];
      if (st && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized")) {
        if (st.err) throw new Error(`tx ${signature} failed: ${jsonify(st.err)}`);
        console.log(`    tx ${label}: ${EXPLORER("tx", signature)}`);
        return signature;
      }
      await sleep(1_000);
    }
    console.warn(`    ${label}: tx expired unconfirmed, retrying`);
  }
  throw new Error(`${label}: could not land tx in 3 attempts`);
}

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

async function step(name: string, fn: () => Promise<string>) {
  try {
    const note = await fn();
    console.log(`OK    ${name} — ${note}`);
  } catch (e) {
    console.error(`FAIL  ${name} — ${e instanceof Error ? e.message : e}`);
    throw e;
  }
}

const usd = (v: bigint) => `$${(Number(v) / 1e6).toFixed(4)}`;

/* ------------------------------------------------------------------ main */
async function main() {
  const keypairBytes = new Uint8Array(JSON.parse(await readFile(KEYPAIR_PATH, "utf8")));
  const admin = await createKeyPairSignerFromBytes(keypairBytes);
  console.log(`admin/keeper/trader wallet: ${admin.address}`);
  console.log(`amm program: ${AMM_PROGRAM_ID}\n`);

  const [marketConfigPda] = await findMarketConfigPda(CONFIG_ID);
  const [marketPda] = await findMarketPda(FIXTURE_ID);
  const [poolPda] = await findLevPoolPda(marketPda);
  const [levVaultPda] = await findLevVaultPda(marketPda);
  const [levPositionPda] = await findLevPositionPda(marketPda, admin.address);
  const [lpAccountPda] = await findLpAccountPda(marketPda, admin.address);
  const adminUsdt = await findAtaPda(admin.address, USDT_MINT);
  console.log(`market: ${marketPda}\npool:   ${poolPda}\n`);

  // ---- 1. leverage-enabled MarketConfig #2 ----
  await step(`create_market_config #${CONFIG_ID} (leverage ON)`, async () => {
    const existing = await withRpc("fetchMaybeMarketConfig", (rpc) =>
      fetchMaybeMarketConfig(rpc, marketConfigPda),
    );
    if (existing.exists) {
      if (existing.data.maxLeverage === 0) {
        throw new Error(
          `config #${CONFIG_ID} exists with leverage DISABLED — pick another LEV_CONFIG_ID`,
        );
      }
      return `SKIP — exists (maxLeverage=${existing.data.maxLeverage})`;
    }
    const ix = await getCreateMarketConfigInstructionAsync({
      authority: admin,
      marketConfig: marketConfigPda,
      configId: CONFIG_ID,
      baseFeeBps: 30,
      maxFeeBps: 500,
      vfcNum: 5_000,
      filterPeriod: 30,
      decayPeriod: 600,
      reductionBps: 5_000,
      maxVAcc: 1_000_000n,
      resolutionGraceSecs: 300n,
      resolutionThreshold: 0,
      resolutionComparison: 0,
      statKeyA: 1,
      statKeyB: 2,
      statOp: 2,
      // leverage params (plans/leverage-v1.md; tfn scale note: small integer)
      maxOpenInterest: 500n * ONE,
      timeFeeNum: 2,
      fundingEpochSecs: 60,
      maxMarkAgeSecs: 300,
      leverageCutoffSecs: 600,
      maxLeverage: 5,
      minCoverageBps: 12_000,
      resolutionPeriod: 100,
    });
    await sendTx(admin, [ix], "create_market_config");
    return `created ${marketConfigPda}`;
  });

  // ---- 2. market on a synthetic fixture (already past kickoff) ----
  let kickoffTs = 0n;
  let freezeTs = 0n;
  await step("init_market (synthetic fixture)", async () => {
    const existing = await withRpc("fetchMaybeMarket", (rpc) =>
      fetchMaybeMarket(rpc, marketPda),
    );
    if (existing.exists) {
      kickoffTs = existing.data.kickoffTs;
      freezeTs = existing.data.freezeTs;
      return `SKIP — exists (state ${MarketState[existing.data.state]})`;
    }
    // init_market requires kickoff strictly in the future; activate then
    // requires now >= kickoff — so kickoff lands ~45s out and step 3 waits.
    const now = await chainNow();
    kickoffTs = now + 45n;
    freezeTs = now + 7_200n;
    const ix = await getInitMarketInstructionAsync({
      authority: admin,
      marketConfig: marketConfigPda,
      usdtMint: USDT_MINT,
      authorityUsdt: adminUsdt,
      fixtureId: FIXTURE_ID,
      kickoffTs,
      freezeTs,
      b: SEED_B,
      seedQ: [0n, 0n, 0n],
      seedLiquidity: SEED_LIQUIDITY,
    });
    await sendTx(admin, [ix], "init_market");
    return `market ${marketPda}, freeze in 2h, seed ${usd(SEED_LIQUIDITY)}`;
  });

  // ---- 3. activate (admin == devnet keeper) ----
  await step("activate_market", async () => {
    const m = await withRpc("fetchMaybeMarket", (rpc) => fetchMaybeMarket(rpc, marketPda));
    if (m.exists && m.data.state === MarketState.Trading) return "SKIP — already Trading";
    if (m.exists) kickoffTs = m.data.kickoffTs;
    for (;;) {
      const now = await chainNow();
      if (now >= kickoffTs) break;
      console.log(`    waiting for kickoff (${kickoffTs - now}s)`);
      await sleep(5_000);
    }
    const ix = await getActivateMarketInstructionAsync({ keeper: admin, market: marketPda });
    await sendTx(admin, [ix], "activate_market");
    return "Open -> Trading";
  });

  // ---- 4. leverage pool + LP deposit ----
  await step("init_leverage_pool", async () => {
    const p = await withRpc("fetchMaybeLeveragePool", (rpc) =>
      fetchMaybeLeveragePool(rpc, poolPda),
    );
    if (p.exists) return "SKIP — pool exists";
    const ix = await getInitLeveragePoolInstructionAsync({
      authority: admin,
      market: marketPda,
      marketConfig: marketConfigPda,
      usdtMint: USDT_MINT,
    });
    await sendTx(admin, [ix], "init_leverage_pool");
    return `pool ${poolPda}`;
  });

  await step(`open_lp_account + deposit_lp ${usd(LP_DEPOSIT)}`, async () => {
    const lp = await withRpc("fetchMaybeLpAccount", (rpc) =>
      fetchMaybeLpAccount(rpc, lpAccountPda),
    );
    const ixs: Instruction[] = [];
    if (!lp.exists) {
      ixs.push(await getOpenLpAccountInstructionAsync({ owner: admin, market: marketPda }));
    } else if (lp.data.shares > 0n) {
      return `SKIP — LP already has ${lp.data.shares} shares`;
    }
    ixs.push(
      await getDepositLpInstructionAsync({
        owner: admin,
        market: marketPda,
        levVault: levVaultPda,
        ownerUsdt: adminUsdt,
        usdtMint: USDT_MINT,
        amount: LP_DEPOSIT,
      }),
    );
    await sendTx(admin, ixs, "deposit_lp");
    return `deposited ${usd(LP_DEPOSIT)}`;
  });

  // ---- 5. first marks ----
  await step(`post_mark t0 ${jsonify(MARKS_T0)}`, async () => {
    const p = await withRpc("pool", (rpc) => fetchMaybeLeveragePool(rpc, poolPda));
    if (p.exists && p.data.markTs > 0n) return `SKIP — marks already posted (${p.data.markBps})`;
    const ix = await getPostMarkInstructionAsync({
      keeper: admin,
      market: marketPda,
      marketConfig: marketConfigPda,
      marks: MARKS_T0,
    });
    await sendTx(admin, [ix], "post_mark t0");
    return "marks initialized (no accrual on first post)";
  });

  // ---- 6. open 3x on Team1 ----
  await step(`open_leverage ${usd(COLLATERAL)} x${LEVERAGE} on Team1`, async () => {
    const pos = await withRpc("fetchMaybeLevPosition", (rpc) =>
      fetchMaybeLevPosition(rpc, levPositionPda),
    );
    if (pos.exists) {
      return `SKIP — position open (units ${pos.data.units}, entry ${pos.data.entryMarkBps} bps)`;
    }
    const ix = await getOpenLeverageInstructionAsync({
      trader: admin,
      market: marketPda,
      marketConfig: marketConfigPda,
      levVault: levVaultPda,
      traderUsdt: adminUsdt,
      usdtMint: USDT_MINT,
      outcome: OUTCOME,
      collateral: COLLATERAL,
      leverage: LEVERAGE,
    });
    await sendTx(admin, [ix], "open_leverage");
    const after = await withRpc("fetchMaybeLevPosition", (rpc) =>
      fetchMaybeLevPosition(rpc, levPositionPda),
    );
    if (!after.exists) throw new Error("position not created");
    return `notional ${usd(after.data.notional)}, units ${after.data.units}, entry ${after.data.entryMarkBps} bps`;
  });

  // ---- 7-8. two funding segments with a mark move ----
  for (const [i, marks] of [MARKS_T1, MARKS_T1].entries()) {
    await step(`wait ${SEGMENT_WAIT_SECS}s -> post_mark t${i + 1} ${jsonify(marks)}`, async () => {
      const before = await withRpc("pool", (rpc) => fetchMaybeLeveragePool(rpc, poolPda));
      if (!before.exists) throw new Error("pool missing");
      const now = await chainNow();
      const sinceLast = now - before.data.markTs;
      const toWait = BigInt(SEGMENT_WAIT_SECS) - sinceLast;
      if (toWait > 0n) await sleep(Number(toWait) * 1_000);
      const ix = await getPostMarkInstructionAsync({
        keeper: admin,
        market: marketPda,
        marketConfig: marketConfigPda,
        marks,
      });
      await sendTx(admin, [ix], `post_mark t${i + 1}`);
      const after = await withRpc("pool", (rpc) => fetchMaybeLeveragePool(rpc, poolPda));
      if (!after.exists) throw new Error("pool missing");
      const dIdx = after.data.cumFundingIndex[OUTCOME] - before.data.cumFundingIndex[OUTCOME];
      return `idx[Team1] += ${dIdx} (cum ${after.data.cumFundingIndex[OUTCOME]})`;
    });
  }

  // ---- 9. close: payout = max(0, C + pnl - F) ----
  await step("close_leverage (settle)", async () => {
    const pos = await withRpc("fetchMaybeLevPosition", (rpc) =>
      fetchMaybeLevPosition(rpc, levPositionPda),
    );
    if (!pos.exists) return "SKIP — no open position (already settled)";
    const pool = await withRpc("pool", (rpc) => fetchMaybeLeveragePool(rpc, poolPda));
    if (!pool.exists) throw new Error("pool missing");

    const { units, entryMarkBps, notional, collateral, fundingIndexSnap } = pos.data;
    const mark = BigInt(pool.data.markBps[OUTCOME]);
    const pnl = (units * (mark - BigInt(entryMarkBps))) / BPS;
    const funding =
      (notional * (pool.data.cumFundingIndex[OUTCOME] - fundingIndexSnap)) / INDEX_SCALE;
    const expected = collateral + pnl - funding;
    console.log(
      `    expectation: C ${usd(collateral)} + pnl ${usd(pnl)} - F ${usd(funding)} = ${usd(expected < 0n ? 0n : expected)}`,
    );

    const balBefore = await withRpc("bal", (rpc) =>
      rpc.getTokenAccountBalance(adminUsdt).send(),
    );
    const ix = await getCloseLeverageInstructionAsync({
      owner: admin,
      market: marketPda,
      marketConfig: marketConfigPda,
      levVault: levVaultPda,
      ownerUsdt: adminUsdt,
      usdtMint: USDT_MINT,
    });
    await sendTx(admin, [ix], "close_leverage");
    const balAfter = await withRpc("bal", (rpc) =>
      rpc.getTokenAccountBalance(adminUsdt).send(),
    );
    const paid = BigInt(balAfter.value.amount) - BigInt(balBefore.value.amount);
    const gone = await withRpc("fetchMaybeLevPosition", (rpc) =>
      fetchMaybeLevPosition(rpc, levPositionPda),
    );
    if (gone.exists) throw new Error("LevPosition still exists after close");
    return `payout ${usd(paid)} (expected ${usd(expected < 0n ? 0n : expected)}); position account closed`;
  });

  console.log(`\nmarket: ${EXPLORER("address", marketPda)}`);
  console.log("leverage circle COMPLETE");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

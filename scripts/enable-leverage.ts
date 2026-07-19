/**
 * ENABLE-LEVERAGE — retro-enable the v1 leverage layer on EVERY live market.
 *
 *   1. update_leverage_params on MarketConfig #1 (all real-fixture markets
 *      reference it; leverage params are read LIVE by the program, so the flip
 *      applies to every market instantly — marginfi configure_bank pattern)
 *   2. faucet top-up if the admin USDT balance can't cover the LP deposits
 *   3. for each live (Open/Trading) market on that config:
 *        init_leverage_pool -> open_lp_account + deposit_lp -> post_mark
 *        (initial marks = current LMSR spot prices)
 *
 * Idempotent: every step SKIPs what already exists; safe to re-run.
 *
 * Run (repo root):  pnpm --filter @fpm/devnet-scripts enable-leverage
 * Env: HELIUS_RPC_URL (recommended), KEYPAIR_PATH, CONFIG_ID (default 1),
 *      LP_PER_POOL_USDT (default 10)
 */
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  AccountRole,
  address,
  appendTransactionMessageInstructions,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  createTransactionMessage,
  getAddressEncoder,
  getBase58Decoder,
  getBase64Encoder,
  getProgramDerivedAddress,
  getUtf8Encoder,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  type Address,
  type Base58EncodedBytes,
  type Instruction,
  type KeyPairSigner,
  type Rpc,
  type SolanaRpcApi,
} from "@solana/kit";
import {
  MARKET_DISCRIMINATOR,
  MarketState,
  fetchMaybeLeveragePool,
  fetchMaybeLpAccount,
  fetchMaybeMarketConfig,
  getMarketDecoder,
  getDepositLpInstructionAsync,
  getInitLeveragePoolInstructionAsync,
  getOpenLpAccountInstructionAsync,
  getPostMarkInstructionAsync,
  getUpdateLeverageParamsInstructionAsync,
} from "@fpm/idl";
import {
  AMM_PROGRAM_ID,
  TXLINE,
  findLevPoolPda,
  findLevVaultPda,
  findLpAccountPda,
  findMarketConfigPda,
} from "@fpm/shared";

/* ----------------------------------------------------------------- config */
const RPC_URLS = process.env.HELIUS_RPC_URL
  ? [process.env.HELIUS_RPC_URL, "https://api.devnet.solana.com"]
  : ["https://api.devnet.solana.com"];
const KEYPAIR_PATH =
  process.env.KEYPAIR_PATH ?? join(homedir(), ".config/solana/id.json");

const USDT_MINT = TXLINE.devnet.usdtMint;
const TXLINE_PROGRAM = TXLINE.devnet.txlineProgram;
const TOKEN_PROGRAM = address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ATA_PROGRAM = address("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const SYSTEM_PROGRAM = address("11111111111111111111111111111111");

const CONFIG_ID = Number(process.env.CONFIG_ID ?? 1);
const ONE = 1_000_000n;
const LP_PER_POOL = BigInt(process.env.LP_PER_POOL_USDT ?? 10) * ONE;

// Leverage params for the shared config (leverage-v1.md calibration notes:
// time_fee_num is a SMALL integer slope; 2 = visible-but-survivable demo theta).
const LEVERAGE_PARAMS = {
  maxOpenInterest: 500n * ONE,
  timeFeeNum: 2,
  fundingEpochSecs: 60,
  maxMarkAgeSecs: 300,
  leverageCutoffSecs: 600,
  maxLeverage: 5,
  minCoverageBps: 12_000,
} as const;

// TxLINE faucet (100 USDT/call, per-wallet cooldown) — same recovered wiring
// as full-circle.ts / devnet-init.ts.
const FAUCET_DISCRIMINATOR = new Uint8Array([49, 178, 104, 8, 23, 120, 186, 21]);
const FAUCET_TRACKER_SEED = "faucet_tracker";
const USDT_TREASURY_SEED = "usdt_treasury";

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

async function buildFaucetIx(user: Address, userUsdtAta: Address): Promise<Instruction> {
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
    const info = await rpc.getAccountInfo(tokenAccount, { encoding: "jsonParsed" }).send();
    if (!info.value) return 0n;
    const data = info.value.data as unknown as {
      parsed: { info: { tokenAmount: { amount: string } } };
    };
    return BigInt(data.parsed.info.tokenAmount.amount);
  });
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

const usd = (v: bigint) => `$${(Number(v) / 1e6).toFixed(2)}`;

/** LMSR spot prices in bps from on-chain q/b (display-grade float softmax). */
function spotMarksBps(q: readonly bigint[], b: bigint): [number, number, number] {
  const bf = Number(b);
  const qf = q.map((x) => Number(x));
  const mx = Math.max(...qf);
  const ex = qf.map((x) => Math.exp((x - mx) / bf));
  const sum = ex.reduce((a, x) => a + x, 0);
  const raw = ex.map((x) => Math.max(1, Math.min(9_998, Math.floor((x / sum) * 10_000))));
  // re-balance the floor remainder into the last outcome, clamped
  const rem = 10_000 - (raw[0] + raw[1] + raw[2]);
  raw[2] = Math.max(1, Math.min(9_998, raw[2] + rem));
  return [raw[0], raw[1], raw[2]];
}

/* ------------------------------------------------------------------ main */
async function main() {
  const keypairBytes = new Uint8Array(JSON.parse(await readFile(KEYPAIR_PATH, "utf8")));
  const admin = await createKeyPairSignerFromBytes(keypairBytes);
  const adminUsdt = await findAtaPda(admin.address, USDT_MINT);
  const [marketConfigPda] = await findMarketConfigPda(CONFIG_ID);
  console.log(`admin: ${admin.address}`);
  console.log(`config #${CONFIG_ID}: ${marketConfigPda}\n`);

  // ---- 1. flip leverage params on the shared config ----
  await step(`update_leverage_params on config #${CONFIG_ID}`, async () => {
    const cfg = await withRpc("fetchMaybeMarketConfig", (rpc) =>
      fetchMaybeMarketConfig(rpc, marketConfigPda),
    );
    if (!cfg.exists) throw new Error(`config #${CONFIG_ID} does not exist`);
    if (cfg.data.maxLeverage > 0) {
      return `SKIP — already enabled (maxLeverage=${cfg.data.maxLeverage})`;
    }
    const ix = await getUpdateLeverageParamsInstructionAsync({
      authority: admin,
      marketConfig: marketConfigPda,
      ...LEVERAGE_PARAMS,
    });
    await sendTx(admin, [ix], "update_leverage_params");
    return `leverage ON (max ${LEVERAGE_PARAMS.maxLeverage}x, tfn ${LEVERAGE_PARAMS.timeFeeNum})`;
  });

  // ---- 2. list live markets on this config ----
  const base64 = getBase64Encoder();
  const decoder = getMarketDecoder();
  const discriminator = getBase58Decoder().decode(
    MARKET_DISCRIMINATOR,
  ) as Base58EncodedBytes;
  const accounts = await withRpc("getProgramAccounts(markets)", (rpc) =>
    rpc
      .getProgramAccounts(AMM_PROGRAM_ID, {
        encoding: "base64",
        filters: [
          { memcmp: { offset: 0n, bytes: discriminator, encoding: "base58" } },
          { dataSize: 278n },
        ],
      })
      .send(),
  );
  const live = accounts.flatMap((a) => {
    try {
      const m = decoder.decode(base64.encode(a.account.data[0]));
      if (m.config !== marketConfigPda) return [];
      if (m.state !== MarketState.Open && m.state !== MarketState.Trading) return [];
      return [{ address: a.pubkey, data: m }];
    } catch {
      return [];
    }
  });
  console.log(`\nlive markets on config #${CONFIG_ID}: ${live.length}`);

  // ---- 3. faucet top-up if short ----
  await step("USDT budget", async () => {
    const need = LP_PER_POOL * BigInt(live.length);
    let bal = await usdtBalance(adminUsdt);
    if (bal < need) {
      try {
        const ix = await buildFaucetIx(admin.address, adminUsdt);
        await sendTx(admin, [ix], "request_devnet_faucet");
        bal = await usdtBalance(adminUsdt);
      } catch (e) {
        console.warn(
          `    faucet failed (${e instanceof Error ? e.message.slice(0, 120) : e}) — continuing with current balance`,
        );
      }
    }
    return `balance ${usd(bal)}, need ${usd(need)} for ${live.length} pool(s) x ${usd(LP_PER_POOL)}`;
  });

  // ---- 4. pool + LP + first marks per market ----
  for (const m of live) {
    const fid = m.data.fixtureId.toString();
    const [poolPda] = await findLevPoolPda(m.address);
    const [levVaultPda] = await findLevVaultPda(m.address);
    const [lpAccountPda] = await findLpAccountPda(m.address, admin.address);

    await step(`market ${fid}: init_leverage_pool`, async () => {
      const p = await withRpc("pool", (rpc) => fetchMaybeLeveragePool(rpc, poolPda));
      if (p.exists) return "SKIP — pool exists";
      const ix = await getInitLeveragePoolInstructionAsync({
        authority: admin,
        market: m.address,
        marketConfig: marketConfigPda,
        usdtMint: USDT_MINT,
      });
      await sendTx(admin, [ix], `init_leverage_pool ${fid}`);
      return `pool ${poolPda}`;
    });

    await step(`market ${fid}: deposit_lp ${usd(LP_PER_POOL)}`, async () => {
      const bal = await usdtBalance(adminUsdt);
      if (bal < LP_PER_POOL) return `SKIP — insufficient USDT (${usd(bal)})`;
      const lp = await withRpc("lp", (rpc) => fetchMaybeLpAccount(rpc, lpAccountPda));
      if (lp.exists && lp.data.shares > 0n) return `SKIP — already ${lp.data.shares} shares`;
      const ixs: Instruction[] = [];
      if (!lp.exists) {
        ixs.push(await getOpenLpAccountInstructionAsync({ owner: admin, market: m.address }));
      }
      ixs.push(
        await getDepositLpInstructionAsync({
          owner: admin,
          market: m.address,
          levVault: levVaultPda,
          ownerUsdt: adminUsdt,
          usdtMint: USDT_MINT,
          amount: LP_PER_POOL,
        }),
      );
      await sendTx(admin, ixs, `deposit_lp ${fid}`);
      return `deposited ${usd(LP_PER_POOL)}`;
    });

    await step(`market ${fid}: post_mark (spot)`, async () => {
      const p = await withRpc("pool", (rpc) => fetchMaybeLeveragePool(rpc, poolPda));
      if (!p.exists) return "SKIP — no pool";
      if (p.data.markTs > 0n) return `SKIP — marks posted (${p.data.markBps})`;
      // Trading markets get real marks now; Open markets get them from the
      // keeper MarkPoster once they activate (post_mark itself is state-free,
      // but a first mark from seed odds is a fine baseline either way).
      const marks = spotMarksBps(m.data.q, m.data.b);
      const ix = await getPostMarkInstructionAsync({
        keeper: admin,
        market: m.address,
        marketConfig: marketConfigPda,
        marks,
      });
      await sendTx(admin, [ix], `post_mark ${fid}`);
      return `marks ${jsonify(marks)}`;
    });
  }

  console.log("\nenable-leverage COMPLETE");
  console.log(
    "next: run the keeper with FIXTURE_SOURCE=onchain ENABLE_MARK_POSTER=1 so marks stay fresh",
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

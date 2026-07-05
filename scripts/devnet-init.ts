/**
 * One-shot, idempotent DEVNET state initialization for the deployed AMM
 * (program H59qQz8DXzUWWc3L528iTCFL36ozwBhJc4tHzuwL2JuY).
 *
 * Steps (each checks on-chain state first and SKIPs if already done):
 *   1. initialize_config      — authority = keeper = local CLI wallet (v0),
 *                               txline devnet program + TxLINE devnet USDT.
 *   2. create_market_config   — config_id 1, same fee params as the surfpool
 *                               suite, home-win predicate (stat1 - stat2) > 0.
 *   3. request_devnet_faucet  — TxLINE's devnet USDT faucet (100 USDT/call).
 *                               faucet_tracker PDA seeds were recovered
 *                               empirically from real devnet faucet txs:
 *                               ["faucet_tracker", user] (verified against 3
 *                               live calls); usdt_treasury = ["usdt_treasury"].
 *   4. init_market            — real World Cup fixture id from the TxLINE
 *                               schedule; kickoff ~2 min out (init_market
 *                               requires kickoff > now, activate requires
 *                               now >= kickoff — no time travel on devnet),
 *                               freeze a few hours out. Seeds 50/50.
 *   5. open_position → wait for kickoff → activate_market → one small buy,
 *                               so the market carries a real devnet trade.
 *   6. Fetch + decode GlobalConfig / MarketConfig / Market / Position and
 *      print explorer links.
 *
 * Run (repo root):  pnpm devnet:init
 *   or:             pnpm --filter @fpm/devnet-scripts devnet:init
 *
 * RPC: Helius devnet primary, public devnet fallback — every RPC call retries
 * with backoff across both endpoints (Helius intermittently drops requests).
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
  Side,
  fetchMaybeGlobalConfig,
  fetchMaybeMarket,
  fetchMaybeMarketConfig,
  fetchMaybePosition,
  getActivateMarketInstructionAsync,
  getBuyInstructionAsync,
  getCreateMarketConfigInstructionAsync,
  getInitMarketInstructionAsync,
  getInitializeConfigInstructionAsync,
  getOpenPositionInstructionAsync,
} from "@fpm/idl";
import {
  AMM_PROGRAM_ID,
  TXLINE,
  findConfigPda,
  findMarketConfigPda,
  findMarketPda,
  findPositionPda,
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

const CONFIG_ID = 1;
/**
 * Real World Cup fixture id from the TxLINE schedule
 * (https://txline.txodds.com/documentation/scores/schedule.md).
 * The published schedule only lists fixtures through Jul 4 01:30 UTC and the
 * live fixtures snapshot API requires an activated API token, so we reuse the
 * canonical demo fixture (17588316 — Haiti vs Scotland, WC group stage).
 */
const FIXTURE_ID = 17_588_316n;
const KICKOFF_DELAY_SECS = 120n; // must be > now at init, <= now at activate
const FREEZE_DELAY_SECS = 6n * 3_600n; // freeze a few hours out
const GRACE_SECS = 3_600n;
const SEED_YES = 100_000_000n; // 100 USDT virtual — 50/50 odds
const SEED_NO = 100_000_000n;
const SEED_LIQUIDITY = 80_000_000n; // 80 USDT real collateral
const BUY_USDC_IN = 5_000_000n; // 5 USDT
const MIN_USDT_FOR_MARKET = SEED_LIQUIDITY + BUY_USDC_IN;

// request_devnet_faucet — discriminator from programs/amm/idls/txline.json.
const FAUCET_DISCRIMINATOR = new Uint8Array([49, 178, 104, 8, 23, 120, 186, 21]);
// Seeds recovered empirically (2026-07-04) from live devnet faucet txs, e.g.
// 2fq64WNgj7a9at3HDbBoLPdse4aJq8BgGfqYnU1a2Z374LBDDEKRCmFGGn4uWhsAAPkEQJDmVZ1tAmBVmsPBL5xi
const FAUCET_TRACKER_SEED = "faucet_tracker";
const USDT_TREASURY_SEED = "usdt_treasury";

const EXPLORER = (kind: "address" | "tx", id: string) =>
  `https://explorer.solana.com/${kind}/${id}?cluster=devnet`;

/* ------------------------------------------------------------- rpc + retry */
const rpcs: Rpc<SolanaRpcApi>[] = RPC_URLS.map((u) => createSolanaRpc(u));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Run an RPC-dependent fn with retry/backoff, alternating endpoints. */
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
    // confirm: poll signature status for up to ~75s (blockhash lifetime)
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

/* ------------------------------------------------------------ faucet ix */
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

/** Hand-built TxLINE `request_devnet_faucet` (no args; account order per IDL). */
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

/* ------------------------------------------------------------ step runner */
const results: { name: string; ok: boolean; note: string }[] = [];
async function step(name: string, fn: () => Promise<string | void>) {
  console.log(`\n==> ${name}`);
  try {
    const note = (await fn()) ?? "";
    results.push({ name, ok: true, note });
    console.log(`OK    ${name}${note ? ` — ${note}` : ""}`);
  } catch (e) {
    const note = e instanceof Error ? e.message : String(e);
    results.push({ name, ok: false, note });
    console.error(`FAIL  ${name} — ${note}`);
    throw e;
  }
}

/* ------------------------------------------------------------------ main */
async function main() {
  const keypairBytes = new Uint8Array(
    JSON.parse(await readFile(KEYPAIR_PATH, "utf8")),
  );
  const admin = await createKeyPairSignerFromBytes(keypairBytes);
  console.log(`admin/keeper wallet: ${admin.address}`);
  console.log(`amm program:         ${AMM_PROGRAM_ID}`);

  const [configPda] = await findConfigPda();
  const [marketConfigPda] = await findMarketConfigPda(CONFIG_ID);
  const [marketPda] = await findMarketPda(FIXTURE_ID);
  const [vaultPda] = await findVaultPda(marketPda);
  const [positionPda] = await findPositionPda(marketPda, admin.address);
  const adminUsdtAta = await findAtaPda(admin.address, USDT_MINT);

  // ---- 0. preflight: program is live ----
  await step("preflight: program executable on devnet", async () => {
    const executable = await withRpc("getAccountInfo(program)", async (rpc) => {
      const { value } = await rpc
        .getAccountInfo(AMM_PROGRAM_ID, { encoding: "base64" })
        .send();
      return value?.executable ?? false;
    });
    if (!executable) throw new Error(`program ${AMM_PROGRAM_ID} not deployed`);
    return EXPLORER("address", AMM_PROGRAM_ID);
  });

  // ---- 1. initialize_config ----
  await step("initialize_config", async () => {
    const existing = await withRpc("fetchMaybeGlobalConfig", (rpc) =>
      fetchMaybeGlobalConfig(rpc, configPda),
    );
    if (existing.exists) {
      const d = existing.data;
      const matches =
        d.authority === admin.address &&
        d.keeper === admin.address &&
        d.txlineProgram === TXLINE_PROGRAM &&
        d.usdcMint === USDT_MINT &&
        d.tokenProgram === TOKEN_PROGRAM;
      return `SKIP — already exists at ${configPda} (values ${matches ? "match" : "DIFFER — inspect manually!"})`;
    }
    const ix = await getInitializeConfigInstructionAsync({
      authority: admin,
      keeper: admin.address,
      txlineProgram: TXLINE_PROGRAM,
      usdcMint: USDT_MINT,
      tokenProgram: TOKEN_PROGRAM,
    });
    await sendTx(admin, [ix], "initialize_config");
    return `created ${configPda}`;
  });

  // ---- 2. create_market_config (home-win predicate) ----
  await step("create_market_config (config_id 1)", async () => {
    const existing = await withRpc("fetchMaybeMarketConfig", (rpc) =>
      fetchMaybeMarketConfig(rpc, marketConfigPda),
    );
    if (existing.exists) return `SKIP — already exists at ${marketConfigPda}`;
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
      resolutionGraceSecs: GRACE_SECS,
      // home win: (goals P1 [key 1] - goals P2 [key 2]) > 0 — GT=0, Subtract=2
      resolutionThreshold: 0,
      resolutionComparison: 0,
      statKeyA: 1,
      statKeyB: 2,
      statOp: 2,
    });
    await sendTx(admin, [ix], "create_market_config");
    return `created ${marketConfigPda}: predicate (stat1 - stat2) > 0`;
  });

  // ---- 3. TxLINE devnet USDT faucet (100 USDT per call) ----
  let usdtHave = 0n;
  await step("request_devnet_faucet (TxLINE USDT)", async () => {
    usdtHave = await usdtBalance(adminUsdtAta);
    if (usdtHave >= MIN_USDT_FOR_MARKET) {
      return `SKIP — ATA ${adminUsdtAta} already holds ${usdtHave} raw (${Number(usdtHave) / 1e6} USDT)`;
    }
    const marketAlready = await withRpc("fetchMaybeMarket", (rpc) =>
      fetchMaybeMarket(rpc, marketPda),
    );
    if (marketAlready.exists) {
      return `SKIP — market already seeded; no USDT needed (ATA holds ${usdtHave} raw)`;
    }
    const ix = await buildFaucetIx(admin.address, adminUsdtAta);
    await sendTx(admin, [ix], "request_devnet_faucet");
    usdtHave = await usdtBalance(adminUsdtAta);
    if (usdtHave === 0n) throw new Error("faucet landed but ATA balance is 0");
    return `ATA ${adminUsdtAta} now holds ${usdtHave} raw (${Number(usdtHave) / 1e6} USDT)`;
  });

  // ---- 4. init_market (real WC fixture, kickoff ~2 min out) ----
  let marketExists = false;
  await step(`init_market (fixture ${FIXTURE_ID})`, async () => {
    const existing = await withRpc("fetchMaybeMarket", (rpc) =>
      fetchMaybeMarket(rpc, marketPda),
    );
    if (existing.exists) {
      marketExists = true;
      return `SKIP — market ${marketPda} already exists (state ${MarketState[existing.data.state]})`;
    }
    if (usdtHave < MIN_USDT_FOR_MARKET) {
      throw new Error(
        `insufficient USDT: have ${usdtHave}, need ${MIN_USDT_FOR_MARKET} (seed + buy)`,
      );
    }
    const now = await chainNow();
    const kickoffTs = now + KICKOFF_DELAY_SECS;
    const freezeTs = now + FREEZE_DELAY_SECS;
    const ix = await getInitMarketInstructionAsync({
      authority: admin,
      marketConfig: marketConfigPda,
      market: marketPda,
      vault: vaultPda,
      usdcMint: USDT_MINT,
      authorityUsdc: adminUsdtAta,
      tokenProgram: TOKEN_PROGRAM,
      fixtureId: FIXTURE_ID,
      kickoffTs,
      freezeTs,
      seedYes: SEED_YES,
      seedNo: SEED_NO,
      seedLiquidity: SEED_LIQUIDITY,
    });
    await sendTx(admin, [ix], "init_market");
    marketExists = true;
    return `market ${marketPda}, vault ${vaultPda}, kickoff ${kickoffTs}, freeze ${freezeTs}, 50/50 @ ${SEED_LIQUIDITY} raw seed`;
  });

  // ---- 5a. open_position ----
  await step("open_position", async () => {
    if (!marketExists) return "SKIP — no market";
    const existing = await withRpc("fetchMaybePosition", (rpc) =>
      fetchMaybePosition(rpc, positionPda),
    );
    if (existing.exists) return `SKIP — position ${positionPda} already exists`;
    const ix = await getOpenPositionInstructionAsync({
      owner: admin,
      market: marketPda,
      position: positionPda,
    });
    await sendTx(admin, [ix], "open_position");
    return `position ${positionPda}`;
  });

  // ---- 5b. wait for kickoff → activate_market ----
  await step("activate_market (waits for kickoff)", async () => {
    if (!marketExists) return "SKIP — no market";
    const market = await withRpc("fetchMaybeMarket", (rpc) =>
      fetchMaybeMarket(rpc, marketPda),
    );
    if (!market.exists) throw new Error("market vanished");
    if (market.data.state !== MarketState.Open) {
      return `SKIP — state is ${MarketState[market.data.state]}, not Open`;
    }
    const kickoff = market.data.kickoffTs;
    // bounded wait: kickoff is at most KICKOFF_DELAY_SECS out
    for (let i = 0; i < 40; i++) {
      const now = await chainNow();
      if (now >= kickoff) break;
      const remain = kickoff - now;
      console.log(`    waiting for kickoff: ${remain}s remaining`);
      await sleep(Math.min(Number(remain) * 1_000 + 2_000, 15_000));
    }
    const ix = await getActivateMarketInstructionAsync({
      keeper: admin,
      market: marketPda,
    });
    await sendTx(admin, [ix], "activate_market");
    return "state Open → Trading";
  });

  // ---- 5c. buy (one real trade) ----
  await step("buy 5 USDT of YES", async () => {
    if (!marketExists) return "SKIP — no market";
    const market = await withRpc("fetchMaybeMarket", (rpc) =>
      fetchMaybeMarket(rpc, marketPda),
    );
    if (!market.exists || market.data.state !== MarketState.Trading) {
      return `SKIP — market not Trading (${market.exists ? MarketState[market.data.state] : "missing"})`;
    }
    const pos = await withRpc("fetchMaybePosition", (rpc) =>
      fetchMaybePosition(rpc, positionPda),
    );
    if (pos.exists && pos.data.yesTokens > 0n) {
      return `SKIP — position already holds ${pos.data.yesTokens} YES tokens`;
    }
    const ix = await getBuyInstructionAsync({
      trader: admin,
      market: marketPda,
      marketConfig: marketConfigPda,
      position: positionPda,
      traderUsdc: adminUsdtAta,
      vault: vaultPda,
      usdcMint: USDT_MINT,
      tokenProgram: TOKEN_PROGRAM,
      side: Side.Yes,
      usdcIn: BUY_USDC_IN,
      minOut: 1n,
    });
    await sendTx(admin, [ix], "buy");
    const after = await withRpc("fetchMaybePosition", (rpc) =>
      fetchMaybePosition(rpc, positionPda),
    );
    const yes = after.exists ? after.data.yesTokens : 0n;
    return `bought ${BUY_USDC_IN} raw USDT of YES → ${yes} YES tokens`;
  });

  // ---- 6. verify + report ----
  await step("verify: decode on-chain state", async () => {
    const cfg = await withRpc("fetchMaybeGlobalConfig", (rpc) =>
      fetchMaybeGlobalConfig(rpc, configPda),
    );
    const mktCfg = await withRpc("fetchMaybeMarketConfig", (rpc) =>
      fetchMaybeMarketConfig(rpc, marketConfigPda),
    );
    const market = await withRpc("fetchMaybeMarket", (rpc) =>
      fetchMaybeMarket(rpc, marketPda),
    );
    const pos = await withRpc("fetchMaybePosition", (rpc) =>
      fetchMaybePosition(rpc, positionPda),
    );
    const vaultBal = await usdtBalance(vaultPda);
    const walletBal = await usdtBalance(adminUsdtAta);

    console.log("\n----- devnet state -----");
    console.log(`GlobalConfig ${configPda}`);
    console.log(`  ${EXPLORER("address", configPda)}`);
    if (cfg.exists) console.log(`  ${jsonify(cfg.data)}`);
    console.log(`MarketConfig ${marketConfigPda}`);
    console.log(`  ${EXPLORER("address", marketConfigPda)}`);
    if (mktCfg.exists) console.log(`  ${jsonify(mktCfg.data)}`);
    console.log(`Market ${marketPda}`);
    console.log(`  ${EXPLORER("address", marketPda)}`);
    if (market.exists) console.log(`  ${jsonify(market.data)}`);
    console.log(`Vault ${vaultPda} — balance ${vaultBal} raw USDT`);
    console.log(`  ${EXPLORER("address", vaultPda)}`);
    console.log(`Position ${positionPda}`);
    console.log(`  ${EXPLORER("address", positionPda)}`);
    if (pos.exists) console.log(`  ${jsonify(pos.data)}`);
    console.log(`Admin USDT ATA ${adminUsdtAta} — balance ${walletBal} raw`);

    if (!cfg.exists) throw new Error("GlobalConfig missing after init");
    if (!mktCfg.exists) throw new Error("MarketConfig missing after init");
    return `config ✓  market-config ✓  market ${market.exists ? `✓ (state ${MarketState[market.data.state]}, price ${market.exists ? market.data.lastPriceBps : "?"} bps)` : "✗"}`;
  });
}

main()
  .then(() => {
    console.log("\n===== devnet-init summary =====");
    for (const r of results)
      console.log(`  ${r.ok ? "OK  " : "FAIL"}  ${r.name}${r.note ? ` — ${r.note}` : ""}`);
    process.exit(0);
  })
  .catch((e) => {
    console.error("\naborted:", e instanceof Error ? e.message : e);
    console.log("\n===== devnet-init summary (partial) =====");
    for (const r of results)
      console.log(`  ${r.ok ? "OK  " : "FAIL"}  ${r.name}${r.note ? ` — ${r.note}` : ""}`);
    process.exit(1);
  });

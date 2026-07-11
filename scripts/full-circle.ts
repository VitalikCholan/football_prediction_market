/**
 * FULL-CIRCLE devnet demo for a REAL finished fixture (default 18179549,
 * Colombia–Ghana, 1–0 home win — TxLINE Merkle proof verified to exist for
 * epoch day 20638).
 *
 * This script owns the MARKET-SIDE of the demo:
 *   1. faucet (if short) → init_market (kickoff ~90s out, freeze ~180s out,
 *      50/50 seed) → open_position
 *   2. prints the `FIXTURES=` line the REAL keeper process needs, then WAITS:
 *        - keeper activates at kickoff  → script buys ~5 USDT of YES
 *        - keeper freezes at freeze_ts  → script waits for resolve
 *        - keeper resolves with a REAL TxLINE proof → script verifies
 *          outcome == Yes and REDEEMS (1 USDT per YES token)
 *   3. collects the artifact list for the indexer: every tx that touched the
 *      market PDA, its instruction name, and whether `Program data:` (Anchor
 *      events) is present in the logs.
 *
 * The keeper itself (apps/keeper, its actual scheduler loop) must be started
 * separately with DRY_RUN=0 and FIXTURES pointing at this market:
 *
 *   cd apps/keeper && DRY_RUN=0 ENABLE_SCORE_STREAM=0 \
 *     KEEPER_KEYPAIR_PATH=$HOME/.config/solana/id.json \
 *     FIXTURES="<fixtureId>:<kickoffTs>:<freezeTs+10>" \
 *     node --env-file=.env --experimental-transform-types \
 *          --import ./hooks/register.mjs src/index.ts
 *
 * Run (repo root):  pnpm --filter @fpm/devnet-scripts full-circle
 * Env: FIXTURE_ID (default 18179549), KICKOFF_DELAY_SECS (90),
 *      TRADING_WINDOW_SECS (90), STATE_FILE (optional JSON drop for automation).
 */
import { readFile, writeFile } from "node:fs/promises";
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
  type Signature,
  type SolanaRpcApi,
} from "@solana/kit";
import {
  MarketState,
  Outcome,
  Side,
  fetchMaybeMarket,
  fetchMaybePosition,
  getBuyInstructionAsync,
  getInitMarketInstructionAsync,
  getOpenPositionInstructionAsync,
  getRedeemInstructionAsync,
} from "@fpm/idl";
import {
  AMM_PROGRAM_ID,
  TXLINE,
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

const CONFIG_ID = 1; // MarketConfig#1 — home-win predicate (stat1 - stat2) > 0
/** Colombia–Ghana, finished 1–0 home win; proof verified to exist. */
const FIXTURE_ID = BigInt(process.env.FIXTURE_ID ?? 18_179_549);
const KICKOFF_DELAY_SECS = BigInt(process.env.KICKOFF_DELAY_SECS ?? 90);
const TRADING_WINDOW_SECS = BigInt(process.env.TRADING_WINDOW_SECS ?? 90);
const SEED_YES = 100_000_000n; // 100 USDT virtual — 50/50 odds
const SEED_NO = 100_000_000n;
const SEED_LIQUIDITY = 50_000_000n; // 50 USDT real collateral
const BUY_USDT_IN = 5_000_000n; // 5 USDT of YES so redeem pays out
const MIN_USDT = SEED_LIQUIDITY + BUY_USDT_IN + 1_000_000n; // +1 USDT headroom
const STATE_FILE = process.env.STATE_FILE;

// TxLINE request_devnet_faucet (100 USDT/call) — same recovered wiring as
// scripts/devnet-init.ts (discriminator from programs/amm/idls/txline.json,
// seeds recovered empirically from live devnet faucet txs).
const FAUCET_DISCRIMINATOR = new Uint8Array([49, 178, 104, 8, 23, 120, 186, 21]);
const FAUCET_TRACKER_SEED = "faucet_tracker";
const USDT_TREASURY_SEED = "usdt_treasury";

const EXPLORER = (kind: "address" | "tx", id: string) =>
  `https://explorer.solana.com/${kind}/${id}?cluster=devnet`;

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

/** On-chain Clock sysvar unix_timestamp (i64 LE at offset 32). */
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
          .sendTransaction(wire, { encoding: "base64", preflightCommitment: "confirmed" })
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
        (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized")
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
  const keypairBytes = new Uint8Array(JSON.parse(await readFile(KEYPAIR_PATH, "utf8")));
  const owner = await createKeyPairSignerFromBytes(keypairBytes);
  console.log(`owner wallet:  ${owner.address}`);
  console.log(`amm program:   ${AMM_PROGRAM_ID}`);
  console.log(`fixture:       ${FIXTURE_ID} (real, finished — home win)`);

  const [marketConfigPda] = await findMarketConfigPda(CONFIG_ID);
  const [marketPda] = await findMarketPda(FIXTURE_ID);
  const [vaultPda] = await findVaultPda(marketPda);
  const [positionPda] = await findPositionPda(marketPda, owner.address);
  const ownerUsdtAta = await findAtaPda(owner.address, USDT_MINT);
  console.log(`market PDA:    ${marketPda}\n`);

  const txSigs: Record<string, string> = {};
  let kickoffTs = 0n;
  let freezeTs = 0n;

  // ---- 1. funding (faucet if short; tolerate cooldown by shrinking seed) ----
  let seedLiquidity = SEED_LIQUIDITY;
  await step("funding: faucet if balance short", async () => {
    const market = await withRpc("fetchMaybeMarket", (rpc) => fetchMaybeMarket(rpc, marketPda));
    if (market.exists) return "SKIP — market already exists, no seed needed";
    let bal = await usdtBalance(ownerUsdtAta);
    if (bal < MIN_USDT) {
      try {
        const ix = await buildFaucetIx(owner.address, ownerUsdtAta);
        txSigs.faucet = await sendTx(owner, [ix], "request_devnet_faucet");
        bal = await usdtBalance(ownerUsdtAta);
      } catch (e) {
        console.warn(
          `    faucet failed (cooldown?): ${e instanceof Error ? e.message.slice(0, 200) : e}`,
        );
      }
    }
    if (bal < MIN_USDT) {
      // FaucetTracker cooldown — shrink the seed to what the wallet can cover.
      const spendable = bal - BUY_USDT_IN - 1_000_000n;
      if (spendable < 5_000_000n) {
        throw new Error(`insufficient USDT even after faucet attempt: ${bal} raw`);
      }
      seedLiquidity = spendable;
    }
    return `balance ${bal} raw (${Number(bal) / 1e6} USDT), seed_liquidity ${seedLiquidity} raw`;
  });

  // ---- 2. init_market (kickoff ~90s out, freeze ~180s out, 50/50) ----
  await step(`init_market (fixture ${FIXTURE_ID})`, async () => {
    const existing = await withRpc("fetchMaybeMarket", (rpc) => fetchMaybeMarket(rpc, marketPda));
    if (existing.exists) {
      kickoffTs = existing.data.kickoffTs;
      freezeTs = existing.data.freezeTs;
      return `SKIP — market exists (state ${MarketState[existing.data.state]}, kickoff ${kickoffTs}, freeze ${freezeTs})`;
    }
    const now = await chainNow();
    kickoffTs = now + KICKOFF_DELAY_SECS;
    freezeTs = kickoffTs + TRADING_WINDOW_SECS;
    const ix = await getInitMarketInstructionAsync({
      authority: owner,
      marketConfig: marketConfigPda,
      market: marketPda,
      vault: vaultPda,
      usdtMint: USDT_MINT,
      authorityUsdt: ownerUsdtAta,
      tokenProgram: TOKEN_PROGRAM,
      fixtureId: FIXTURE_ID,
      kickoffTs,
      freezeTs,
      seedYes: SEED_YES,
      seedNo: SEED_NO,
      seedLiquidity,
    });
    txSigs.init_market = await sendTx(owner, [ix], "init_market");
    return `market ${marketPda}, kickoff ${kickoffTs}, freeze ${freezeTs}, seed ${seedLiquidity} raw`;
  });

  // Hand the boundaries to the keeper process (env line + optional JSON drop).
  const fixturesLine = `${FIXTURE_ID}:${kickoffTs}:${freezeTs + 10n}`;
  console.log(`\n>>> KEEPER_FIXTURES=${fixturesLine}\n`);
  if (STATE_FILE) {
    await writeFile(
      STATE_FILE,
      jsonify({
        fixtureId: FIXTURE_ID,
        market: marketPda,
        vault: vaultPda,
        position: positionPda,
        kickoffTs,
        freezeTs,
        fixturesEnv: fixturesLine,
      }),
    );
  }

  // ---- 3. open_position ----
  await step("open_position", async () => {
    const existing = await withRpc("fetchMaybePosition", (rpc) =>
      fetchMaybePosition(rpc, positionPda),
    );
    if (existing.exists) return `SKIP — position ${positionPda} already exists`;
    const ix = await getOpenPositionInstructionAsync({
      owner,
      market: marketPda,
      position: positionPda,
    });
    txSigs.open_position = await sendTx(owner, [ix], "open_position");
    return `position ${positionPda}`;
  });

  // ---- 4. wait for the KEEPER to activate (Open -> Trading), then buy ----
  await step("wait for keeper activate -> buy 5 USDT of YES", async () => {
    const pos = await withRpc("fetchMaybePosition", (rpc) =>
      fetchMaybePosition(rpc, positionPda),
    );
    if (pos.exists && pos.data.yesTokens > 0n) {
      return `SKIP — position already holds ${pos.data.yesTokens} YES tokens`;
    }
    // Bounded wait: kickoff + 120s of slack for keeper ticks / clock skew.
    const deadline = Number(kickoffTs) + 120;
    for (;;) {
      const market = await withRpc("fetchMaybeMarket", (rpc) =>
        fetchMaybeMarket(rpc, marketPda),
      );
      if (!market.exists) throw new Error("market vanished");
      const state = market.data.state;
      if (state === MarketState.Trading) break;
      if (state !== MarketState.Open) {
        throw new Error(`market advanced past Trading without a buy (${MarketState[state]})`);
      }
      const now = Math.floor(Date.now() / 1000);
      if (now > deadline) {
        throw new Error("keeper did not activate within kickoff+120s — is it running?");
      }
      console.log(
        `    waiting for keeper activate (state Open, kickoff in ${Number(kickoffTs) - now}s)`,
      );
      await sleep(3_000);
    }
    const ix = await getBuyInstructionAsync({
      trader: owner,
      market: marketPda,
      marketConfig: marketConfigPda,
      position: positionPda,
      traderUsdt: ownerUsdtAta,
      vault: vaultPda,
      usdtMint: USDT_MINT,
      tokenProgram: TOKEN_PROGRAM,
      side: Side.Yes,
      usdtIn: BUY_USDT_IN,
      minOut: 1n,
    });
    txSigs.buy = await sendTx(owner, [ix], "buy");
    const after = await withRpc("fetchMaybePosition", (rpc) =>
      fetchMaybePosition(rpc, positionPda),
    );
    const yes = after.exists ? after.data.yesTokens : 0n;
    return `bought ${BUY_USDT_IN} raw USDT of YES → ${yes} YES tokens`;
  });

  // ---- 5. wait for the KEEPER to freeze + RESOLVE (real TxLINE proof) ----
  await step("wait for keeper freeze -> resolve (real Merkle proof)", async () => {
    // Bounded wait: freeze + 6 min (resolve retries on RootNotAvailable).
    const deadline = Number(freezeTs) + 360;
    for (;;) {
      const market = await withRpc("fetchMaybeMarket", (rpc) =>
        fetchMaybeMarket(rpc, marketPda),
      );
      if (!market.exists) throw new Error("market vanished");
      const state = market.data.state;
      if (state === MarketState.Resolved) {
        const outcome = market.data.outcome;
        if (outcome !== Outcome.Yes) {
          throw new Error(
            `resolved with UNEXPECTED outcome ${Outcome[outcome]} (expected Yes: 1-0 home win)`,
          );
        }
        return `market Resolved, outcome Yes — proof-valid resolve landed`;
      }
      const now = Math.floor(Date.now() / 1000);
      if (now > deadline) {
        throw new Error(
          `keeper did not resolve by freeze+360s (state ${MarketState[state]}) — check keeper logs`,
        );
      }
      console.log(
        `    waiting for keeper (state ${MarketState[state]}, freeze in ${Number(freezeTs) - now}s)`,
      );
      await sleep(5_000);
    }
  });

  // ---- 6. redeem: winner payout 1 USDT per YES token ----
  await step("redeem: 1 USDT per YES token", async () => {
    const posBefore = await withRpc("fetchMaybePosition", (rpc) =>
      fetchMaybePosition(rpc, positionPda),
    );
    if (!posBefore.exists) throw new Error("position missing");
    if (posBefore.data.redeemed) return "SKIP — already redeemed";
    const expected = posBefore.data.yesTokens;
    if (expected === 0n) throw new Error("nothing to redeem (0 YES tokens)");
    const balBefore = await usdtBalance(ownerUsdtAta);
    const ix = await getRedeemInstructionAsync({
      owner,
      market: marketPda,
      position: positionPda,
      vault: vaultPda,
      ownerUsdt: ownerUsdtAta,
      usdtMint: USDT_MINT,
      tokenProgram: TOKEN_PROGRAM,
    });
    txSigs.redeem = await sendTx(owner, [ix], "redeem");
    const balAfter = await usdtBalance(ownerUsdtAta);
    const delta = balAfter - balBefore;
    if (delta !== expected) {
      throw new Error(`payout ${delta} != yes_tokens ${expected}`);
    }
    const posAfter = await withRpc("fetchMaybePosition", (rpc) =>
      fetchMaybePosition(rpc, positionPda),
    );
    if (!posAfter.exists || !posAfter.data.redeemed) {
      throw new Error("position not flagged redeemed");
    }
    return `payout ${delta} raw USDT (= ${expected} YES tokens) — balance delta matches`;
  });

  // ---- 7. artifact list for the indexer ----
  await step("artifacts: txs + events on the market PDA", async () => {
    const sigs = await withRpc("getSignaturesForAddress", (rpc) =>
      rpc.getSignaturesForAddress(marketPda, { limit: 25 }).send(),
    );
    console.log(`    ${sigs.length} txs touching market ${marketPda} (newest first):`);
    const lines: string[] = [];
    for (const s of [...sigs].reverse()) {
      const tx = await withRpc("getTransaction", (rpc) =>
        rpc
          .getTransaction(s.signature as Signature, {
            maxSupportedTransactionVersion: 0,
            encoding: "json",
          })
          .send(),
      );
      const logs: readonly string[] = tx?.meta?.logMessages ?? [];
      const ixNames = logs
        .filter((l) => l.startsWith("Program log: Instruction:"))
        .map((l) => l.replace("Program log: Instruction: ", ""))
        .join("+");
      const hasEvent = logs.some((l) => l.startsWith("Program data:"));
      const line = `${ixNames || "?"}${hasEvent ? " [Program data: EVENT]" : ""}  ${s.signature}`;
      lines.push(line);
      console.log(`      ${line}`);
      console.log(`        ${EXPLORER("tx", s.signature)}`);
    }
    return `${sigs.length} txs, events flagged above`;
  });

  // ---- 8. final on-chain state ----
  await step("verify: final Market/Position state", async () => {
    const market = await withRpc("fetchMaybeMarket", (rpc) => fetchMaybeMarket(rpc, marketPda));
    const pos = await withRpc("fetchMaybePosition", (rpc) =>
      fetchMaybePosition(rpc, positionPda),
    );
    if (!market.exists) throw new Error("market missing");
    console.log(`    Market   ${marketPda}\n      ${jsonify(market.data)}`);
    console.log(`      ${EXPLORER("address", marketPda)}`);
    if (pos.exists) console.log(`    Position ${positionPda}\n      ${jsonify(pos.data)}`);
    console.log(`    tx signatures: ${jsonify(txSigs)}`);
    return `state ${MarketState[market.data.state]}, outcome ${Outcome[market.data.outcome]}`;
  });
}

main()
  .then(() => {
    console.log("\n===== full-circle summary =====");
    for (const r of results)
      console.log(`  ${r.ok ? "OK  " : "FAIL"}  ${r.name}${r.note ? ` — ${r.note}` : ""}`);
    process.exit(0);
  })
  .catch((e) => {
    console.error("\naborted:", e instanceof Error ? e.message : e);
    console.log("\n===== full-circle summary (partial) =====");
    for (const r of results)
      console.log(`  ${r.ok ? "OK  " : "FAIL"}  ${r.name}${r.note ? ` — ${r.note}` : ""}`);
    process.exit(1);
  });

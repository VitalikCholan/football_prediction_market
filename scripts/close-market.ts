/**
 * CLOSE-MARKET one-shot for a RESOLVED devnet market (default fixture
 * 18179549, the full-circle demo market). Sends the `close_market`
 * instruction so the UI can show the `Closed` state.
 *
 * The program gates close on:
 *   state == Resolved  AND  now >= freeze_ts + resolution_grace_secs
 * (else custom error GraceNotElapsed). This script SIMULATES FIRST and only
 * sends if the simulation is clean. On GraceNotElapsed it prints freeze_ts,
 * grace, and the earliest close time, then STOPS (no retry-spam).
 *
 * NOTE: close_market SWEEPS residual vault USDT to the admin ATA and DELETES
 * the Market account (Anchor `close = authority`). This is expected/by-design.
 *
 * Run (repo root):  pnpm --filter @fpm/devnet-scripts close:market
 * Env: FIXTURE_ID (default 18179549), HELIUS_RPC_URL, SOLANA_KEYPAIR.
 *
 * Authorized: devnet, our own market, our wallet == GlobalConfig.authority.
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
  getBase64EncodedWireTransaction,
  getProgramDerivedAddress,
  getSignatureFromTransaction,
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
  Outcome,
  fetchMaybeMarket,
  fetchMaybeMarketConfig,
  getCloseMarketInstructionAsync,
} from "@fpm/idl";
import {
  AMM_PROGRAM_ID,
  TXLINE,
  findConfigPda,
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

const USDT_MINT = TXLINE.devnet.usdtMint; // 6 decimals, classic SPL Token
const TOKEN_PROGRAM = address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ATA_PROGRAM = address("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

const CONFIG_ID = 1; // MarketConfig#1 — matches full-circle
/** Colombia–Ghana, finished 1–0 home win; already Resolved on devnet. */
const FIXTURE_ID = BigInt(process.env.FIXTURE_ID ?? 18_179_549);

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

const jsonify = (v: unknown) =>
  JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x));

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

/** Build signed wire tx (for simulateTransaction). */
async function buildWire(signer: KeyPairSigner, ixs: Instruction[]) {
  const { value: latestBlockhash } = await withRpc("simulate: getLatestBlockhash", (rpc) =>
    rpc.getLatestBlockhash({ commitment: "confirmed" }).send(),
  );
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(signer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, m),
    (m) => appendTransactionMessageInstructions(ixs, m),
  );
  const signed = await signTransactionMessageWithSigners(message);
  return getBase64EncodedWireTransaction(signed);
}

/* ------------------------------------------------------------------ main */
async function main() {
  const keypairBytes = new Uint8Array(JSON.parse(await readFile(KEYPAIR_PATH, "utf8")));
  const authority = await createKeyPairSignerFromBytes(keypairBytes);
  console.log(`authority:     ${authority.address}`);
  console.log(`amm program:   ${AMM_PROGRAM_ID}`);
  console.log(`fixture:       ${FIXTURE_ID}`);

  const [configPda] = await findConfigPda();
  const [marketConfigPda] = await findMarketConfigPda(CONFIG_ID);
  const [marketPda] = await findMarketPda(FIXTURE_ID);
  const [vaultPda] = await findVaultPda(marketPda);
  const authorityUsdt = await findAtaPda(authority.address, USDT_MINT);
  console.log(`market PDA:    ${marketPda}`);
  console.log(`vault PDA:     ${vaultPda}`);
  console.log(`authority ATA: ${authorityUsdt}\n`);

  // ---- pre-flight: fetch market + config so we can explain any gate failure ----
  const market = await withRpc("fetchMaybeMarket", (rpc) => fetchMaybeMarket(rpc, marketPda));
  if (!market.exists) {
    console.error(
      `market ${marketPda} does not exist on-chain — nothing to close (already closed?).`,
    );
    process.exit(1);
  }
  const mc = await withRpc("fetchMaybeMarketConfig", (rpc) =>
    fetchMaybeMarketConfig(rpc, marketConfigPda),
  );
  const freezeTs = market.data.freezeTs;
  const grace = mc.exists ? mc.data.resolutionGraceSecs : 0n;
  const earliest = freezeTs + grace;
  const vaultBefore = await usdtBalance(vaultPda);
  console.log(
    `market state ${MarketState[market.data.state]}, outcome ${Outcome[market.data.outcome]}`,
  );
  console.log(
    `freeze_ts ${freezeTs}, resolution_grace_secs ${grace}, earliest close_ts ${earliest} ` +
      `(${new Date(Number(earliest) * 1000).toISOString()})`,
  );
  console.log(`vault balance before: ${vaultBefore} raw (${Number(vaultBefore) / 1e6} USDT)\n`);

  const ix = await getCloseMarketInstructionAsync({
    authority,
    global: configPda,
    market: marketPda,
    marketConfig: marketConfigPda,
    vault: vaultPda,
    authorityUsdt,
    usdtMint: USDT_MINT,
    tokenProgram: TOKEN_PROGRAM,
  });

  // ---- 1. SIMULATE FIRST ----
  console.log("==> simulate close_market");
  const wire = await buildWire(authority, [ix]);
  const sim = await withRpc("simulateTransaction", (rpc) =>
    rpc
      .simulateTransaction(wire, {
        encoding: "base64",
        commitment: "confirmed",
        sigVerify: false,
        replaceRecentBlockhash: true,
      })
      .send(),
  );

  if (sim.value.err) {
    const errStr = jsonify(sim.value.err);
    const logs = sim.value.logs ?? [];
    const graceHit =
      errStr.includes("6024") || // AMM_ERROR__GRACE_NOT_ELAPSED (0x1788)
      logs.some((l) => l.includes("GraceNotElapsed"));
    console.error(`SIMULATION FAILED: ${errStr}`);
    const errLog = logs.find((l) => /Error|failed|GraceNotElapsed|custom program error/i.test(l));
    if (errLog) console.error(`    decisive log: ${errLog}`);
    if (graceHit || earliest > Math.floor(Date.now() / 1000)) {
      const nowS = Math.floor(Date.now() / 1000);
      console.error(
        `GraceNotElapsed — earliest close_ts ${earliest} ` +
          `(${new Date(Number(earliest) * 1000).toISOString()}); ` +
          `now ${nowS}, ${Number(earliest) - nowS}s remaining. ` +
          `freeze_ts=${freezeTs}, resolution_grace_secs=${grace}.`,
      );
    }
    console.error("STOPPING (no send).");
    process.exit(1);
  }

  console.log(`simulation CLEAN (no err). compute units: ${sim.value.unitsConsumed ?? "?"}`);

  // ---- 2. send + confirm ----
  console.log("\n==> send close_market");
  console.log(
    "    NOTE: sweeps residual vault USDT -> admin ATA and DELETES the Market account (by-design).",
  );
  const authBalBefore = await usdtBalance(authorityUsdt);
  const sig = await sendTx(authority, [ix], "close_market");

  const authBalAfter = await usdtBalance(authorityUsdt);
  const swept = authBalAfter - authBalBefore;
  console.log(`\ntx signature: ${sig}`);
  console.log(`  ${EXPLORER("tx", sig)}`);
  console.log(
    `swept ~${swept} raw USDT to admin ATA (vault-before ${vaultBefore} raw); market account deleted.`,
  );

  // ---- 3. poll indexer for Closed state (best-effort, skip if not running) ----
  console.log("\n==> poll indexer :3900 for Closed state");
  const url = `http://localhost:3900/markets/${marketPda}`;
  let sawClosed = false;
  let indexerUp = false;
  for (let i = 0; i < 6; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(5_000) });
      indexerUp = true;
      if (res.ok) {
        const body = (await res.json()) as { state?: string };
        console.log(`    [${i + 1}/6] indexer state = ${body.state ?? "?"}`);
        if (body.state === "Closed") {
          sawClosed = true;
          break;
        }
      } else {
        console.log(`    [${i + 1}/6] indexer HTTP ${res.status}`);
      }
    } catch (e) {
      console.log(
        `    [${i + 1}/6] indexer not reachable: ${e instanceof Error ? e.message : e}`,
      );
    }
    await sleep(5_000);
  }
  if (!indexerUp) {
    console.log("indexer not running on :3900 — skipped Closed-state check.");
  } else if (sawClosed) {
    console.log("indexer flipped market to Closed.");
  } else {
    console.log("indexer did not report Closed within ~30s (may still be catching up).");
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("\naborted:", e instanceof Error ? e.message : e);
    process.exit(1);
  });

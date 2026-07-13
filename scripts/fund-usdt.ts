/**
 * Consolidate TxLINE devnet USDT into the admin wallet by farming the faucet
 * across fresh throwaway wallets.
 *
 * WHY: the TxLINE `request_devnet_faucet` dispenses a fixed 100 USDT per call
 * and enforces a per-wallet cooldown via the `["faucet_tracker", wallet]` PDA.
 * We cannot mint USDT (mint authority is a TxLINE PDA), so the only way to fund
 * many markets in one shot is to claim from several wallets. The cooldown is
 * per-wallet, so a brand-new keypair can always claim immediately.
 *
 * Per throwaway wallet, in order:
 *   1. admin funds it with a little SOL (fees + ATA rent);
 *   2. ONE tx signed by the temp wallet: request_devnet_faucet (+100 USDT,
 *      creates the temp USDT ATA) -> transfer_checked 100 USDT to the admin ATA
 *      -> close the temp USDT ATA (rent refunded to admin);
 *   3. sweep the temp wallet's residual SOL back to admin.
 * Net SOL cost to admin ≈ transaction fees only.
 *
 * Run (repo root):
 *   HELIUS_RPC_URL=... TARGET_USDT=420 pnpm --filter @fpm/devnet-scripts fund-usdt
 *   (or pass the target as argv: ... fund-usdt 420)
 *
 * Env: HELIUS_RPC_URL, SOLANA_KEYPAIR, TARGET_USDT (default 420).
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
  generateKeyPairSigner,
  getAddressEncoder,
  getBase64EncodedWireTransaction,
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
import { TXLINE } from "@fpm/shared";

/* ----------------------------------------------------------------- config */
const RPC_URLS = process.env.HELIUS_RPC_URL
  ? [process.env.HELIUS_RPC_URL, "https://api.devnet.solana.com"]
  : ["https://api.devnet.solana.com"];
const KEYPAIR_PATH =
  process.env.SOLANA_KEYPAIR ?? join(homedir(), ".config", "solana", "id.json");

const TXLINE_PROGRAM = TXLINE.devnet.txlineProgram;
const USDT_MINT = TXLINE.devnet.usdtMint; // 6 decimals, classic SPL Token
const USDT_DECIMALS = 6;
const TOKEN_PROGRAM = address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ATA_PROGRAM = address("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const SYSTEM_PROGRAM = address("11111111111111111111111111111111");
const COMPUTE_BUDGET = address("ComputeBudget111111111111111111111111111111");

const ONE_USDT = 1_000_000n; // 6 decimals
const FAUCET_AMOUNT = 100n * ONE_USDT; // fixed 100 USDT per call
const TARGET_USDT =
  BigInt(process.env.TARGET_USDT ?? process.argv[2] ?? "420") * ONE_USDT;
// SOL handed to each temp wallet: covers the USDT ATA rent (~0.00204, created by
// the faucet CPI and refunded to admin on close) + tx fees. Most comes back via
// close + sweep, so over-funding is ~free (net admin cost ≈ fees).
const FUND_LAMPORTS = 5_000_000n; // 0.005 SOL
const SWEEP_RESERVE = 5_000n; // leave for the sweep tx fee
const CU_LIMIT = 700_000; // faucet CPI (create ATA + mint) uses ~600k CU
const CU_PRICE = 20_000n; // micro-lamports/CU; bounds priority fee to ~14k lamports

const FAUCET_DISCRIMINATOR = new Uint8Array([49, 178, 104, 8, 23, 120, 186, 21]);
const FAUCET_TRACKER_SEED = "faucet_tracker";
const USDT_TREASURY_SEED = "usdt_treasury";

const EXPLORER = (kind: "address" | "tx", id: string) =>
  `https://explorer.solana.com/${kind}/${id}?cluster=devnet`;

/* ------------------------------------------------------------- rpc + retry */
const rpcs: Rpc<SolanaRpcApi>[] = RPC_URLS.map((u) => createSolanaRpc(u));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const utf8 = getUtf8Encoder();
const addressEncoder = getAddressEncoder();

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
    // Simulate first and surface program logs — a failed sim otherwise hides
    // behind a generic "Transaction simulation failed" and 18 useless retries.
    const sim = await withRpc(
      `${label}: simulate`,
      (rpc) =>
        rpc
          .simulateTransaction(wire, {
            encoding: "base64",
            sigVerify: false,
            replaceRecentBlockhash: true,
          })
          .send(),
      2,
    );
    if (sim.value.err) {
      const errStr = JSON.stringify(sim.value.err, (_k, v) =>
        typeof v === "bigint" ? v.toString() : v,
      );
      console.error(`    ${label} SIM ERR: ${errStr}`);
      for (const l of (sim.value.logs ?? []).slice(-12)) console.error(`      ${l}`);
      throw new Error(`${label} sim: ${errStr}`);
    }
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
        if (st.err) throw new Error(`tx ${signature} failed: ${JSON.stringify(st.err)}`);
        console.log(`    tx ${label}: ${EXPLORER("tx", signature)}`);
        return signature;
      }
      await sleep(1_000);
    }
    console.warn(`    ${label}: tx ${signature} expired unconfirmed, retrying`);
  }
  throw new Error(`${label}: could not land tx in 3 attempts`);
}

/* ------------------------------------------------------------ ix builders */
function u64le(v: bigint): Uint8Array {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, v, true);
  return b;
}

function u32le(v: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, v, true);
  return b;
}

/** ComputeBudget SetComputeUnitLimit (ix 2) — bounds the tx's max CU (and thus
 *  the priority fee = limit × price). Without it the default limit inflates the
 *  fee and can starve the fee payer of rent for the ATA it must create. */
function cuLimitIx(units: number): Instruction {
  return {
    programAddress: COMPUTE_BUDGET,
    accounts: [],
    data: new Uint8Array([2, ...u32le(units)]),
  };
}

/** ComputeBudget SetComputeUnitPrice (ix 3) — priority fee for congested devnet. */
function priorityIx(microLamports: bigint): Instruction {
  return {
    programAddress: COMPUTE_BUDGET,
    accounts: [],
    data: new Uint8Array([3, ...u64le(microLamports)]),
  };
}

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

/** SPL Token transfer_checked (ix 12): data = [12, amount u64 LE, decimals u8]. */
function transferCheckedIx(
  source: Address,
  mint: Address,
  destination: Address,
  authority: KeyPairSigner,
  amount: bigint,
  decimals: number,
): Instruction {
  return {
    programAddress: TOKEN_PROGRAM,
    accounts: [
      { address: source, role: AccountRole.WRITABLE },
      { address: mint, role: AccountRole.READONLY },
      { address: destination, role: AccountRole.WRITABLE },
      { address: authority.address, role: AccountRole.READONLY_SIGNER },
    ],
    data: new Uint8Array([12, ...u64le(amount), decimals & 0xff]),
  };
}

/** SPL Token close_account (ix 9): rent refunded to `destination`. */
function closeAccountIx(
  accountToClose: Address,
  destination: Address,
  owner: KeyPairSigner,
): Instruction {
  return {
    programAddress: TOKEN_PROGRAM,
    accounts: [
      { address: accountToClose, role: AccountRole.WRITABLE },
      { address: destination, role: AccountRole.WRITABLE },
      { address: owner.address, role: AccountRole.READONLY_SIGNER },
    ],
    data: new Uint8Array([9]),
  };
}

/** System transfer (ix 2): data = [2 u32 LE, lamports u64 LE]. */
function systemTransferIx(
  from: KeyPairSigner,
  to: Address,
  lamports: bigint,
): Instruction {
  return {
    programAddress: SYSTEM_PROGRAM,
    accounts: [
      { address: from.address, role: AccountRole.WRITABLE_SIGNER },
      { address: to, role: AccountRole.WRITABLE },
    ],
    data: new Uint8Array([2, 0, 0, 0, ...u64le(lamports)]),
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

async function solBalance(owner: Address): Promise<bigint> {
  return withRpc("getBalance", async (rpc) => {
    const { value } = await rpc.getBalance(owner, { commitment: "confirmed" }).send();
    return BigInt(value);
  });
}

/* --------------------------------------------------------------------- run */
async function main() {
  const secret = new Uint8Array(JSON.parse(await readFile(KEYPAIR_PATH, "utf8")));
  const admin = await createKeyPairSignerFromBytes(secret);
  const adminUsdtAta = await findAtaPda(admin.address, USDT_MINT);

  console.log(`admin wallet:      ${admin.address}`);
  console.log(`admin USDT ATA:    ${adminUsdtAta}`);
  console.log(`target:            ${TARGET_USDT / ONE_USDT} USDT`);

  const before = await usdtBalance(adminUsdtAta);
  console.log(`admin USDT now:    ${before / ONE_USDT} USDT`);

  const deficit = TARGET_USDT - before;
  if (deficit <= 0n) {
    console.log(`\nAlready at/above target (${before / ONE_USDT} USDT) — nothing to do.`);
    return;
  }
  const claims = Number((deficit + FAUCET_AMOUNT - 1n) / FAUCET_AMOUNT); // ceil
  console.log(
    `\nneed +${deficit / ONE_USDT} USDT -> farming ${claims} fresh wallet(s) @ 100 USDT each\n`,
  );

  let funded = 0n;
  for (let i = 1; i <= claims; i++) {
    console.log(`==> wallet ${i}/${claims}`);
    try {
      const temp = await generateKeyPairSigner();
      const tempUsdtAta = await findAtaPda(temp.address, USDT_MINT);

      // 1. admin -> temp SOL (fees + ATA rent)
      await sendTx(
        admin,
        [
          cuLimitIx(CU_LIMIT),
          priorityIx(CU_PRICE),
          systemTransferIx(admin, temp.address, FUND_LAMPORTS),
        ],
        `fund temp ${i}`,
      );

      // 2. temp: faucet (+100 USDT, creates ATA) -> transfer to admin -> close ATA
      await sendTx(
        temp,
        [
          cuLimitIx(CU_LIMIT),
          priorityIx(CU_PRICE),
          await buildFaucetIx(temp.address, tempUsdtAta),
          transferCheckedIx(
            tempUsdtAta,
            USDT_MINT,
            adminUsdtAta,
            temp,
            FAUCET_AMOUNT,
            USDT_DECIMALS,
          ),
          closeAccountIx(tempUsdtAta, admin.address, temp),
        ],
        `faucet+transfer+close ${i}`,
      );
      funded += FAUCET_AMOUNT;

      // 3. sweep residual SOL back to admin
      const residual = await solBalance(temp.address);
      if (residual > SWEEP_RESERVE) {
        await sendTx(
          temp,
          [systemTransferIx(temp, admin.address, residual - SWEEP_RESERVE)],
          `sweep SOL ${i}`,
        );
      }
      console.log(`    OK — +100 USDT to admin (temp ${temp.address} drained)`);
    } catch (e) {
      console.error(
        `    FAIL wallet ${i}: ${e instanceof Error ? e.message : e} — continuing`,
      );
    }
  }

  const after = await usdtBalance(adminUsdtAta);
  console.log(
    `\n===== fund-usdt summary =====\n` +
      `claimed:  +${funded / ONE_USDT} USDT across ${claims} wallet(s)\n` +
      `admin USDT: ${before / ONE_USDT} -> ${after / ONE_USDT} USDT`,
  );
  if (after < TARGET_USDT) {
    console.warn(
      `still below target ${TARGET_USDT / ONE_USDT} — some faucet claims failed; re-run to top up.`,
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

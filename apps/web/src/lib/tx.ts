/**
 * Transaction layer — REAL devnet instructions via the `@fpm/idl` Kit client.
 *
 * Flow (DESIGN_SPEC 1d + frontend-plan §4.3, simulate-before-sign mandatory):
 *   prepareTrade/prepareClaim/prepareFaucet
 *     → build ixs (PDAs from @fpm/shared, builders from @fpm/idl)
 *     → compile unsigned tx → `simulateTransaction` (sigVerify:false) with
 *       post-state account capture, so the review box can show the EXACT
 *       simulated output (shares out / USDT out) next to the client quote
 *     → PreparedTx.send(): sign (wallet session OR demo keypair) → send →
 *       poll-confirm (bounded) → { signature }.
 *
 * Signing seams:
 *   - Demo custodial wallet: a real local KeyPairSigner — instructions carry
 *     the signer, `signTransactionMessageWithSigners` signs offline.
 *   - Wallet-Standard wallet: instructions carry a noop signer (address-only
 *     account metas); the compiled tx goes to `session.signTransaction` /
 *     `session.sendTransaction` from framework-kit. The session comes from
 *     `@solana/client` (kit v5 types) while all builders here are kit v2 —
 *     the tx wire shape is identical, so the boundary is one structural cast.
 */
import {
  AccountRole,
  address,
  appendTransactionMessageInstructions,
  compileTransaction,
  createNoopSigner,
  createTransactionMessage,
  getAddressEncoder,
  getBase64Encoder,
  getBase64EncodedWireTransaction,
  getProgramDerivedAddress,
  getUtf8Encoder,
  lamports,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Address,
  type Instruction,
  type KeyPairSigner,
  type Signature,
  type TransactionSigner,
} from "@solana/kit";
import {
  fetchMaybePosition,
  fetchMaybePosition1x2,
  getBuyInstructionAsync,
  getBuy1x2InstructionAsync,
  getOpenPositionInstructionAsync,
  getOpenPosition1x2InstructionAsync,
  getPositionDecoder,
  getPosition1x2Decoder,
  getRedeemInstructionAsync,
  getRedeem1x2InstructionAsync,
  getSellInstructionAsync,
  getSell1x2InstructionAsync,
  Side as IdlSide,
} from "@fpm/idl";
import {
  TXLINE,
  findPosition1x2Pda,
  findPositionPda,
  findVaultPda,
  friendlyTxError as decodeProgramError,
  type Outcome1x2,
  type Side,
} from "@fpm/shared";
import { getRpc } from "@/lib/solana";

/* ------------------------------------------------------------ constants */

const USDT_MINT = TXLINE.devnet.usdtMint;
const TXLINE_PROGRAM = TXLINE.devnet.txlineProgram;
const TOKEN_PROGRAM = address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ATA_PROGRAM = address("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const SYSTEM_PROGRAM = address("11111111111111111111111111111111");
const COMPUTE_BUDGET_PROGRAM = address(
  "ComputeBudget111111111111111111111111111111",
);

/**
 * Compute-unit budget for a 1X2 buy/sell. The LMSR softmax (exp/ln fixed-point
 * math over three outcomes) blows past the 200k default; SPEC §3.1 measures
 * `buy_1x2` at ~660k CU, so request 700k with headroom. Binary trades stay on
 * the default budget (no ComputeBudget ix — keeps binary txs byte-identical).
 */
const CU_LIMIT_1X2 = 700_000;

/**
 * Hand-built `ComputeBudget::SetComputeUnitLimit(units)` instruction — there is
 * no `@solana-program/compute-budget` dep in the web app, and the ix is a
 * 1-byte tag (2) + a u32 LE. Same hand-rolled-ix approach as the faucet ix.
 */
function setComputeUnitLimitIx(units: number): Instruction {
  const data = new Uint8Array(5);
  data[0] = 2; // SetComputeUnitLimit discriminant
  new DataView(data.buffer).setUint32(1, units, true); // u32 LE
  return {
    programAddress: COMPUTE_BUDGET_PROGRAM,
    accounts: [],
    data,
  };
}

/**
 * TxLINE `request_devnet_faucet` (100 USDT / call). Discriminator from
 * `programs/amm/idls/txline.json`; PDA seeds recovered empirically from live
 * devnet faucet txs (see scripts/devnet-init.ts / scripts/full-circle.ts).
 */
const FAUCET_DISCRIMINATOR = new Uint8Array([
  49, 178, 104, 8, 23, 120, 186, 21,
]);
const FAUCET_TRACKER_SEED = "faucet_tracker";
const USDT_TREASURY_SEED = "usdt_treasury";

/** Min SOL the demo wallet needs to pay fees + rent for faucet accounts. */
const MIN_GAS_LAMPORTS = 10_000_000n; // 0.01 SOL
const AIRDROP_LAMPORTS = 1_000_000_000n; // 1 SOL

const utf8 = getUtf8Encoder();
const addressEncoder = getAddressEncoder();
const base64 = getBase64Encoder();

/* ------------------------------------------------------------ authority */

/**
 * Minimal structural view of a framework-kit `WalletSession` (kit v5 types in
 * `@solana/client`) — declared locally so this kit-v2 module doesn't import
 * across the version seam. `signTransaction`/`sendTransaction` take/return the
 * standard wire `Transaction` shape.
 */
export interface WalletTxSession {
  account: { address: string | { toString(): string } };
  signTransaction?(transaction: unknown): Promise<unknown>;
  sendTransaction?(
    transaction: unknown,
    config?: { commitment?: string },
  ): Promise<unknown>;
}

/** Who signs: the demo custodial keypair or the connected wallet session. */
export type TxAuthority =
  | { kind: "keypair"; signer: KeyPairSigner }
  | { kind: "wallet"; session: WalletTxSession };

function authorityAddress(auth: TxAuthority): Address {
  return auth.kind === "keypair"
    ? auth.signer.address
    : address(auth.session.account.address.toString());
}

function authoritySigner(auth: TxAuthority): TransactionSigner {
  return auth.kind === "keypair"
    ? auth.signer
    : createNoopSigner(authorityAddress(auth));
}

/* ------------------------------------------------------------ public API */

export interface TradeTxParams {
  /** Market PDA (base58) — the DTO `id`. */
  marketId: string;
  /** MarketConfig PDA (base58) — the DTO `configId`. */
  configId: string;
  side: Side;
  action: "buy" | "sell";
  /** Base units (u64 as string): USDT in for buy, position tokens in for sell. */
  amountBase: string;
  /** Slippage guard, base units (shares min for buy, USDT min for sell). */
  minOutBase: string;
}

export interface ClaimTxParams {
  /** Market PDA (base58). */
  marketId: string;
}

export interface TxResult {
  signature: string;
  /** True when this came from the demo-fixture stub (no chain involved). */
  simulated: boolean;
}

/** Result of the pre-sign simulation, surfaced in the 1d summary box. */
export interface SimSummary {
  ok: boolean;
  /** Friendly decoded error when !ok. */
  error?: string;
  computeUnits?: number;
  /** Simulated output in base units: shares (buy) / USDT (sell, redeem, faucet). */
  outBase?: bigint;
}

/** A simulated, ready-to-sign transaction. */
export interface PreparedTx {
  sim: SimSummary;
  /** Sign → send → confirm. Throws Error with a friendly message. */
  send(): Promise<TxResult>;
}

/* --------------------------------------------------------------- helpers */

export async function findUsdtAta(owner: Address): Promise<Address> {
  const [ata] = await getProgramDerivedAddress({
    programAddress: ATA_PROGRAM,
    seeds: [
      addressEncoder.encode(owner),
      addressEncoder.encode(TOKEN_PROGRAM),
      addressEncoder.encode(USDT_MINT),
    ],
  });
  return ata;
}

/** USDT balance in base units (6dp); 0n when the ATA doesn't exist. */
export async function getUsdtBalanceBase(owner: string): Promise<bigint> {
  try {
    const ata = await findUsdtAta(address(owner));
    const { value } = await getRpc()
      .getTokenAccountBalance(ata)
      .send();
    return BigInt(value.amount);
  } catch {
    return 0n;
  }
}

export async function getSolBalanceLamports(owner: string): Promise<bigint> {
  const { value } = await getRpc().getBalance(address(owner)).send();
  return BigInt(value);
}

function sideToIdl(side: Side): IdlSide {
  return side === "YES" ? IdlSide.Yes : IdlSide.No;
}

/**
 * Decode `{"InstructionError":[i,{"Custom":6006}]}`-style sim/tx errors to a
 * user-facing sentence. Rent/log specifics stay here; the curated per-code
 * messages live in @fpm/shared (`decodeProgramError`, BUG-5). These are trade
 * txs, so the AMM program is the relevant hint.
 */
function friendlyTxError(err: unknown, logs?: readonly string[]): string {
  const raw = JSON.stringify(err, (_k, v) =>
    typeof v === "bigint" ? v.toString() : v,
  );
  if (raw?.includes("InsufficientFundsForRent") || raw?.includes("AccountNotFound")) {
    return "Not enough SOL to pay fees/rent — fund the wallet with devnet SOL.";
  }
  // A program that emitted a human-readable "Error Message:" log but no coded
  // Custom error — surface that line directly.
  if (!/"Custom"/.test(raw ?? "")) {
    const programLog = logs?.find((l) => l.includes("Error Message:"));
    if (programLog) return programLog.split("Error Message:")[1].trim();
  }
  return decodeProgramError(err, "amm");
}

/** Token-account amount (u64 LE at offset 64) from raw account bytes. */
function tokenAmountFromAccountData(bytes: Uint8Array): bigint {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return view.getBigUint64(64, true);
}

/* ------------------------------------------------- simulate + send core */

type OutProbe =
  | { kind: "position"; address: Address; side: Side; preTokens: bigint }
  | {
      kind: "position1x2";
      address: Address;
      /** Outcome index into the on-chain `tokens[3]` array (Team1|Draw|Team2). */
      outcomeIdx: number;
      preTokens: bigint;
    }
  | { kind: "tokenAccount"; address: Address; preAmount: bigint };

async function buildPrepared(
  auth: TxAuthority,
  ixs: Instruction[],
  probe: OutProbe | null,
  confirmLabel: string,
): Promise<PreparedTx> {
  const rpc = getRpc();
  const signer = authoritySigner(auth);

  const { value: latestBlockhash } = await rpc
    .getLatestBlockhash({ commitment: "confirmed" })
    .send();

  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(signer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, m),
    (m) => appendTransactionMessageInstructions(ixs, m),
  );
  const unsigned = compileTransaction(message);
  const wire = getBase64EncodedWireTransaction(unsigned);

  // ---- simulate (never sign first) ----
  let sim: SimSummary;
  try {
    const { value } = await rpc
      .simulateTransaction(wire, {
        encoding: "base64",
        sigVerify: false,
        accounts: {
          encoding: "base64",
          addresses: probe ? [probe.address] : [],
        },
      })
      .send();
    if (value.err) {
      sim = {
        ok: false,
        error: friendlyTxError(value.err, value.logs ?? undefined),
      };
    } else {
      let outBase: bigint | undefined;
      const acc = value.accounts?.[0];
      if (probe && acc) {
        const bytes = base64.encode(acc.data[0]) as Uint8Array;
        if (probe.kind === "position") {
          const pos = getPositionDecoder().decode(bytes);
          const post = probe.side === "YES" ? pos.yesTokens : pos.noTokens;
          outBase = post - probe.preTokens;
        } else if (probe.kind === "position1x2") {
          const pos = getPosition1x2Decoder().decode(bytes);
          const post = pos.tokens[probe.outcomeIdx] ?? 0n;
          outBase = post - probe.preTokens;
        } else {
          outBase = tokenAmountFromAccountData(bytes) - probe.preAmount;
        }
      }
      sim = {
        ok: true,
        computeUnits: value.unitsConsumed
          ? Number(value.unitsConsumed)
          : undefined,
        outBase,
      };
    }
  } catch (e) {
    sim = { ok: false, error: friendlyTxError(e) };
  }

  return {
    sim,
    async send(): Promise<TxResult> {
      if (!sim.ok) throw new Error(sim.error ?? "Simulation failed");

      let signature: string;
      if (auth.kind === "keypair") {
        const signed = await signTransactionMessageWithSigners(message);
        signature = await rpc
          .sendTransaction(getBase64EncodedWireTransaction(signed), {
            encoding: "base64",
            preflightCommitment: "confirmed",
          })
          .send();
      } else if (auth.session.signTransaction) {
        const signed = (await auth.session.signTransaction(
          unsigned,
        )) as typeof unsigned;
        signature = await rpc
          .sendTransaction(getBase64EncodedWireTransaction(signed), {
            encoding: "base64",
            preflightCommitment: "confirmed",
          })
          .send();
      } else if (auth.session.sendTransaction) {
        signature = String(
          await auth.session.sendTransaction(unsigned, {
            commitment: "confirmed",
          }),
        );
      } else {
        throw new Error("Connected wallet cannot sign transactions");
      }

      await confirmSignature(signature, confirmLabel);
      return { signature, simulated: false };
    },
  };
}

/** Bounded poll until confirmed/finalized; throws on on-chain error. */
async function confirmSignature(sig: string, label: string): Promise<void> {
  const rpc = getRpc();
  for (let i = 0; i < 45; i++) {
    const { value } = await rpc
      .getSignatureStatuses([sig as Signature])
      .send();
    const st = value[0];
    if (
      st &&
      (st.confirmationStatus === "confirmed" ||
        st.confirmationStatus === "finalized")
    ) {
      if (st.err) throw new Error(`${label} failed: ${friendlyTxError(st.err)}`);
      return;
    }
    await new Promise((r) => setTimeout(r, 1_000));
  }
  throw new Error(`${label}: transaction not confirmed in 45s — check explorer`);
}

/* ----------------------------------------------------------- trade + claim */

/** Buy: (openPosition if missing) + buy. Sell: sell. Simulated, not signed. */
export async function prepareTrade(
  auth: TxAuthority,
  params: TradeTxParams,
): Promise<PreparedTx> {
  const rpc = getRpc();
  const owner = authorityAddress(auth);
  const signer = authoritySigner(auth);
  const market = address(params.marketId);
  const marketConfig = address(params.configId);
  const [vault] = await findVaultPda(market);
  const [position] = await findPositionPda(market, owner);
  const traderUsdt = await findUsdtAta(owner);

  const ixs: Instruction[] = [];
  let probe: OutProbe;

  if (params.action === "buy") {
    const existing = await fetchMaybePosition(rpc, position);
    if (!existing.exists) {
      ixs.push(
        await getOpenPositionInstructionAsync({
          owner: signer,
          market,
          position,
        }),
      );
    }
    ixs.push(
      await getBuyInstructionAsync({
        trader: signer,
        market,
        marketConfig,
        position,
        traderUsdt,
        vault,
        usdtMint: USDT_MINT,
        tokenProgram: TOKEN_PROGRAM,
        side: sideToIdl(params.side),
        usdtIn: BigInt(params.amountBase),
        minOut: BigInt(params.minOutBase),
      }),
    );
    probe = {
      kind: "position",
      address: position,
      side: params.side,
      preTokens: existing.exists
        ? params.side === "YES"
          ? existing.data.yesTokens
          : existing.data.noTokens
        : 0n,
    };
  } else {
    ixs.push(
      await getSellInstructionAsync({
        trader: signer,
        market,
        marketConfig,
        position,
        traderUsdt,
        vault,
        usdtMint: USDT_MINT,
        tokenProgram: TOKEN_PROGRAM,
        side: sideToIdl(params.side),
        tokensIn: BigInt(params.amountBase),
        minUsdtOut: BigInt(params.minOutBase),
      }),
    );
    probe = {
      kind: "tokenAccount",
      address: traderUsdt,
      preAmount: await getUsdtBalanceBase(owner),
    };
  }

  return buildPrepared(auth, ixs, probe, params.action);
}

/** Redeem the winning side of a resolved market (1 token = 1 USDT). */
export async function prepareClaim(
  auth: TxAuthority,
  params: ClaimTxParams,
): Promise<PreparedTx> {
  const owner = authorityAddress(auth);
  const signer = authoritySigner(auth);
  const market = address(params.marketId);
  const [vault] = await findVaultPda(market);
  const [position] = await findPositionPda(market, owner);
  const ownerUsdt = await findUsdtAta(owner);

  const ix = await getRedeemInstructionAsync({
    owner: signer,
    market,
    position,
    vault,
    ownerUsdt,
    usdtMint: USDT_MINT,
    tokenProgram: TOKEN_PROGRAM,
  });

  return buildPrepared(
    auth,
    [ix],
    {
      kind: "tokenAccount",
      address: ownerUsdt,
      preAmount: await getUsdtBalanceBase(owner),
    },
    "redeem",
  );
}

/* --------------------------------------------------------- 1X2 trade + claim */

/**
 * On-chain outcome index into the `Position1x2.tokens[3]` array and the
 * `buy_1x2`/`sell_1x2` `outcome` u8 arg: [0]=Team1, [1]=Draw, [2]=Team2.
 * Mirrors the shared `Outcome1x2` string enum (minus the payout-only `Void`).
 */
export const OUTCOME_1X2_IDX: Record<
  Exclude<Outcome1x2, "Void">,
  number
> = {
  Team1: 0,
  Draw: 1,
  Team2: 2,
};

export interface Trade1x2TxParams {
  /** Market1x2 PDA (base58) — the DTO `id`. */
  marketId: string;
  /** MarketConfig PDA (base58) — the DTO `configId`. */
  configId: string;
  /** Which of the three outcomes to trade. */
  outcome: Exclude<Outcome1x2, "Void">;
  action: "buy" | "sell";
  /** Base units (u64 as string): USDT in for buy, outcome tokens in for sell. */
  amountBase: string;
  /** Slippage guard, base units (tokens min for buy, USDT min for sell). */
  minOutBase: string;
}

/**
 * Buy/sell one outcome of a 3-way 1X2 LMSR market. Buy: (open_position_1x2 if
 * missing) + buy_1x2; Sell: sell_1x2. A raised compute-unit budget is prepended
 * (the LMSR math exceeds the 200k default — SPEC §3.1). Same simulate-before-
 * sign flow and 1g out-probe as the binary path.
 */
export async function prepareTrade1x2(
  auth: TxAuthority,
  params: Trade1x2TxParams,
): Promise<PreparedTx> {
  const rpc = getRpc();
  const owner = authorityAddress(auth);
  const signer = authoritySigner(auth);
  const market = address(params.marketId);
  const marketConfig = address(params.configId);
  const [vault] = await findVaultPda(market);
  const [position] = await findPosition1x2Pda(market, owner);
  const traderUsdt = await findUsdtAta(owner);
  const outcomeIdx = OUTCOME_1X2_IDX[params.outcome];

  // Raised CU budget first — the LMSR softmax overruns the default limit.
  const ixs: Instruction[] = [setComputeUnitLimitIx(CU_LIMIT_1X2)];
  let probe: OutProbe;

  if (params.action === "buy") {
    const existing = await fetchMaybePosition1x2(rpc, position);
    if (!existing.exists) {
      ixs.push(
        await getOpenPosition1x2InstructionAsync({
          owner: signer,
          market,
          position,
        }),
      );
    }
    ixs.push(
      await getBuy1x2InstructionAsync({
        trader: signer,
        market,
        marketConfig,
        position,
        traderUsdt,
        vault,
        usdtMint: USDT_MINT,
        tokenProgram: TOKEN_PROGRAM,
        outcome: outcomeIdx,
        usdtIn: BigInt(params.amountBase),
        minTokensOut: BigInt(params.minOutBase),
      }),
    );
    probe = {
      kind: "position1x2",
      address: position,
      outcomeIdx,
      preTokens: existing.exists
        ? existing.data.tokens[outcomeIdx] ?? 0n
        : 0n,
    };
  } else {
    ixs.push(
      await getSell1x2InstructionAsync({
        trader: signer,
        market,
        marketConfig,
        position,
        traderUsdt,
        vault,
        usdtMint: USDT_MINT,
        tokenProgram: TOKEN_PROGRAM,
        outcome: outcomeIdx,
        tokensIn: BigInt(params.amountBase),
        minUsdtOut: BigInt(params.minOutBase),
      }),
    );
    probe = {
      kind: "tokenAccount",
      address: traderUsdt,
      preAmount: await getUsdtBalanceBase(owner),
    };
  }

  return buildPrepared(auth, ixs, probe, params.action);
}

/** Redeem the winning (or Void-refunded) outcome of a resolved 1X2 market. */
export async function prepareClaim1x2(
  auth: TxAuthority,
  params: ClaimTxParams,
): Promise<PreparedTx> {
  const owner = authorityAddress(auth);
  const signer = authoritySigner(auth);
  const market = address(params.marketId);
  const [vault] = await findVaultPda(market);
  const [position] = await findPosition1x2Pda(market, owner);
  const ownerUsdt = await findUsdtAta(owner);

  const ix = await getRedeem1x2InstructionAsync({
    owner: signer,
    market,
    position,
    vault,
    ownerUsdt,
    usdtMint: USDT_MINT,
    tokenProgram: TOKEN_PROGRAM,
  });

  return buildPrepared(
    auth,
    [ix],
    {
      kind: "tokenAccount",
      address: ownerUsdt,
      preAmount: await getUsdtBalanceBase(owner),
    },
    "redeem",
  );
}

/* ----------------------------------------------------------------- faucet */

/** Create-ATA-idempotent (ix 1 of the ATA program) so the faucet always lands. */
function createAtaIdempotentIx(
  payer: Address,
  ata: Address,
  owner: Address,
): Instruction {
  return {
    programAddress: ATA_PROGRAM,
    accounts: [
      { address: payer, role: AccountRole.WRITABLE_SIGNER },
      { address: ata, role: AccountRole.WRITABLE },
      { address: owner, role: AccountRole.READONLY },
      { address: USDT_MINT, role: AccountRole.READONLY },
      { address: SYSTEM_PROGRAM, role: AccountRole.READONLY },
      { address: TOKEN_PROGRAM, role: AccountRole.READONLY },
    ],
    data: new Uint8Array([1]),
  };
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

/**
 * Trader onboarding: ensure gas SOL (devnet airdrop for the demo wallet),
 * create the USDT ATA idempotently, then TxLINE `request_devnet_faucet`
 * (100 USDT). Same simulate → sign → confirm chain as trades.
 */
export async function prepareFaucet(auth: TxAuthority): Promise<PreparedTx> {
  const rpc = getRpc();
  const owner = authorityAddress(auth);

  // Gas check — a fresh demo keypair holds 0 SOL.
  let sol = await getSolBalanceLamports(owner);
  if (sol < MIN_GAS_LAMPORTS) {
    try {
      await rpc.requestAirdrop(owner, lamports(AIRDROP_LAMPORTS)).send();
      for (let i = 0; i < 10 && sol < MIN_GAS_LAMPORTS; i++) {
        await new Promise((r) => setTimeout(r, 1_000));
        sol = await getSolBalanceLamports(owner);
      }
    } catch {
      // fall through to the balance check below
    }
    if (sol < MIN_GAS_LAMPORTS) {
      throw new Error(
        "Wallet needs devnet SOL for fees and the airdrop faucet is dry — retry in a minute or fund it manually.",
      );
    }
  }

  const ata = await findUsdtAta(owner);
  const ixs = [
    createAtaIdempotentIx(owner, ata, owner),
    await buildFaucetIx(owner, ata),
  ];
  return buildPrepared(
    auth,
    ixs,
    {
      kind: "tokenAccount",
      address: ata,
      preAmount: await getUsdtBalanceBase(owner),
    },
    "faucet",
  );
}


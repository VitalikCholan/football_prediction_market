import {
  appendTransactionMessageInstructions,
  compileTransaction,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  pipe,
  sendAndConfirmTransactionFactory,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Address,
  type Instruction,
  type KeyPairSigner,
  type Rpc,
  type RpcSubscriptions,
  type SolanaRpcApi,
  type SolanaRpcSubscriptionsApi,
} from "@solana/kit";
import {
  getSetComputeUnitLimitInstruction,
  getSetComputeUnitPriceInstruction,
} from "@solana-program/compute-budget";
import type { KeeperConfig } from "../config.ts";
import { log } from "../log.ts";
import type { SolanaClients } from "./rpc.ts";

export interface BuildParams {
  /** Instructions to run AFTER the compute-budget instructions. */
  instructions: Instruction[];
  /** Writable accounts the tx locks — used for dynamic priority-fee sampling. */
  writableAccounts?: Address[];
  /** Optional explicit CU limit; otherwise derived from simulation. */
  computeUnitLimit?: number;
}

export interface SimResult {
  ok: boolean;
  unitsConsumed?: bigint;
  logs?: readonly string[];
  err?: unknown;
}

/**
 * Reliability layer the keeper depends on. Kept as an interface so `kitguard`
 * (if it turns out to be a real package) can be swapped in behind it without
 * touching action code. The default implementation below is Kit-native.
 */
export interface TxSender {
  /** Simulate; must succeed before any send. */
  simulate(params: BuildParams): Promise<SimResult>;
  /** Simulate -> build -> sign -> send with failover + rebroadcast. */
  sendAndConfirm(params: BuildParams): Promise<string>;
}

const DEFAULT_CU_LIMIT = 400_000;

/**
 * Kit-native TxSender:
 *  - simulate-before-send (never sends a tx that fails simulation)
 *  - dynamic priority fee via getRecentPrioritizationFees (p75, clamped)
 *  - RPC failover across the configured pool
 *  - confirmation via sendAndConfirmTransactionFactory (built-in rebroadcast loop)
 *
 * Fee escalation on retry is applied by the caller re-invoking sendAndConfirm
 * (idempotent actions make that safe).
 */
export class KitTxSender implements TxSender {
  private readonly clients: SolanaClients;
  private readonly signer: KeyPairSigner;
  private readonly config: KeeperConfig;
  private readonly rpc: Rpc<SolanaRpcApi>;
  private readonly rpcPool: { url: string; rpc: Rpc<SolanaRpcApi> }[];
  private readonly subscriptions: RpcSubscriptions<SolanaRpcSubscriptionsApi>;

  constructor(
    clients: SolanaClients,
    signer: KeyPairSigner,
    config: KeeperConfig,
  ) {
    this.clients = clients;
    this.signer = signer;
    this.config = config;
    this.rpc = clients.rpc;
    this.rpcPool = clients.rpcPool;
    this.subscriptions = clients.subscriptions;
  }

  async simulate(params: BuildParams): Promise<SimResult> {
    try {
      const message = await this.buildMessage(params, DEFAULT_CU_LIMIT, 0);
      const signed = await signTransactionMessageWithSigners(message);
      const wire = getBase64EncodedWireTransaction(signed);
      const { value } = await this.rpc
        .simulateTransaction(wire, { encoding: "base64", sigVerify: false })
        .send();
      if (value.err) {
        return { ok: false, err: value.err, logs: value.logs ?? undefined };
      }
      return {
        ok: true,
        unitsConsumed: value.unitsConsumed ?? undefined,
        logs: value.logs ?? undefined,
      };
    } catch (err) {
      return { ok: false, err };
    }
  }

  async sendAndConfirm(params: BuildParams): Promise<string> {
    // 1. Simulate first (safety). Abort on failure.
    const sim = await this.simulate(params);
    if (!sim.ok) {
      log.error(
        { err: sim.err, logs: sim.logs },
        "simulation failed — aborting send",
      );
      throw new Error(`simulation failed: ${JSON.stringify(sim.err)}`);
    }

    const cuLimit =
      params.computeUnitLimit ??
      (sim.unitsConsumed
        ? Math.ceil(Number(sim.unitsConsumed) * 1.1)
        : DEFAULT_CU_LIMIT);
    const priorityFee = await this.computePriorityFee(
      params.writableAccounts ?? [],
    );

    if (this.config.dryRun) {
      log.info(
        { cuLimit, priorityFee },
        "DRY_RUN — skipping send (simulation succeeded)",
      );
      return "DRY_RUN";
    }

    // 2. Build + sign the final tx.
    const message = await this.buildMessage(params, cuLimit, priorityFee);
    const signed = await signTransactionMessageWithSigners(message);
    const signature = getSignatureFromTransaction(signed);

    // 3. Send with failover: try each RPC's confirmation factory in order.
    let lastErr: unknown;
    for (const { url, rpc } of this.rpcPool) {
      try {
        const sendAndConfirm = sendAndConfirmTransactionFactory({
          rpc,
          rpcSubscriptions: this.subscriptions,
        });
        await sendAndConfirm(signed, { commitment: "confirmed" });
        log.info({ rpc: url, signature }, "tx confirmed");
        return signature;
      } catch (err) {
        lastErr = err;
        log.warn({ rpc: url, err }, "send failed on endpoint — failing over");
      }
    }
    throw new Error(`all RPC endpoints failed: ${JSON.stringify(lastErr)}`);
  }

  /** Dynamic priority fee: sample recent fees over the writable accounts. */
  private async computePriorityFee(writable: Address[]): Promise<number> {
    const {
      mode,
      fixedMicroLamports,
      floorMicroLamports,
      ceilingMicroLamports,
    } = this.config.priorityFee;
    if (mode === "fixed") return fixedMicroLamports;
    try {
      const fees = await this.rpc
        .getRecentPrioritizationFees(writable.length ? writable : undefined)
        .send();
      const values = fees
        .map((f) => Number(f.prioritizationFee))
        .filter((n) => n > 0)
        .sort((a, b) => a - b);
      if (values.length === 0) return floorMicroLamports;
      const p75 = values[Math.floor(values.length * 0.75)];
      return Math.min(Math.max(p75, floorMicroLamports), ceilingMicroLamports);
    } catch (err) {
      log.warn({ err }, "priority-fee sampling failed — using floor");
      return floorMicroLamports;
    }
  }

  /** Assemble a transaction message with compute-budget instructions prepended. */
  private async buildMessage(
    params: BuildParams,
    cuLimit: number,
    priorityFeeMicroLamports: number,
  ) {
    const { value: latestBlockhash } = await this.rpc
      .getLatestBlockhash()
      .send();
    return pipe(
      createTransactionMessage({ version: 0 }),
      (tx) => setTransactionMessageFeePayerSigner(this.signer, tx),
      (tx) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, tx),
      (tx) =>
        appendTransactionMessageInstructions(
          [
            getSetComputeUnitLimitInstruction({ units: cuLimit }),
            getSetComputeUnitPriceInstruction({
              microLamports: priorityFeeMicroLamports,
            }),
            ...params.instructions,
          ],
          tx,
        ),
    );
  }
}

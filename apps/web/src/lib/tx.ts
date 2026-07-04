/**
 * Transaction builders (buy / sell / redeem / claim).
 *
 * STATUS: the on-chain program is being written in parallel — `@fpm/idl`
 * currently only exposes `initialize`, so the trade/redeem instructions do not
 * exist yet. These builders are STUBBED so the full UI flow (quote → review →
 * "sign 1 Solana tx" → confirmation) is complete and typechecks today. When the
 * program IDL lands, replace the stub bodies with real Kit instruction
 * composition (see pattern below) and wire the framework-kit signer.
 *
 * Real path (once IDL exists), per plans/frontend-plan.md §4.2:
 *   import { getBuyInstructionAsync } from "@fpm/idl";
 *   const ix = await getBuyInstructionAsync({ market, position, vault, trader: signer, side, usdcIn, minOut });
 *   return pipe(createTransactionMessage({ version: 0 }),
 *     m => setTransactionMessageFeePayerSigner(signer, m),
 *     m => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
 *     m => appendTransactionMessageInstruction(ix, m));
 *   → simulate → TxReviewDialog → signAndSendTransactionMessageWithSigners.
 */
import type { Side } from "@fpm/shared";

export interface TradeTxParams {
  marketId: string;
  fixtureId: string;
  side: Side;
  action: "buy" | "sell";
  /** Base units (u64 as string): USDC in for buy, shares in for sell. */
  amountBase: string;
  /** Slippage guard, base units. */
  minOutBase: string;
  /** Connected wallet address (base58). */
  owner: string;
}

export interface ClaimTxParams {
  marketId: string;
  fixtureId: string;
  owner: string;
}

export interface TxResult {
  signature: string;
  /** True while the real instruction is stubbed. */
  simulated: boolean;
}

/** Deterministic fake signature so the demo shows a plausible "View tx ↗". */
function fakeSignature(seed: string): string {
  const alphabet =
    "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0;
  let s = "";
  let x = Math.abs(h) || 1;
  for (let i = 0; i < 88; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    s += alphabet[x % alphabet.length];
  }
  return s;
}

/** Simulated latency so the UI can show a pending → confirmed transition. */
function settle(seed: string): Promise<TxResult> {
  return new Promise((resolve) =>
    setTimeout(
      () => resolve({ signature: fakeSignature(seed), simulated: true }),
      900,
    ),
  );
}

// TODO(program IDL): replace with real getBuyInstructionAsync composition.
export async function submitTrade(params: TradeTxParams): Promise<TxResult> {
  return settle(
    `${params.action}:${params.marketId}:${params.side}:${params.amountBase}`,
  );
}

// TODO(program IDL): replace with real getRedeemInstructionAsync composition.
export async function submitClaim(params: ClaimTxParams): Promise<TxResult> {
  return settle(`claim:${params.marketId}:${params.owner}`);
}

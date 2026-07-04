import { address, type KeyPairSigner } from "@solana/kit";
import type { KeeperConfig } from "../config.ts";
import type { SolanaClients } from "../solana/rpc.ts";
import type { TxSender } from "../solana/txSender.ts";

/** Shared dependencies passed to every action. */
export interface ActionContext {
  config: KeeperConfig;
  clients: SolanaClients;
  signer: KeyPairSigner;
  txSender: TxSender;
}

/** On-chain Market states we care about for idempotency guards. */
export type OnChainMarketState =
  | "Open"
  | "Trading"
  | "Locked"
  | "Resolved"
  | "Closed";

/**
 * Read the current on-chain Market.state so every action can no-op if the
 * transition already happened.
 *
 * TODO(program-team IDL): replace with the Codama `fetchMarket` decoder from
 * `@fpm/idl` once the Market account is in the IDL. Returns null when the
 * account doesn't exist yet.
 */
export async function readMarketState(
  ctx: ActionContext,
  market: string,
): Promise<OnChainMarketState | null> {
  const { value } = await ctx.clients.rpc
    .getAccountInfo(address(market), { encoding: "base64" })
    .send();
  if (!value) return null;
  // TODO: decode with getMarketDecoder() from @fpm/idl and read `.state`.
  return "Open";
}

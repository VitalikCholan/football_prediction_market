import type { Address, KeyPairSigner } from "@solana/kit";
import { fetchMaybeMarket, MarketState, type Market } from "@fpm/idl";
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

/**
 * Fetch + decode the on-chain Market account (Codama decoder from `@fpm/idl`)
 * so every action can no-op if the transition already happened. Returns null
 * when the account doesn't exist yet.
 */
export async function readMarket(
  ctx: ActionContext,
  market: Address,
): Promise<Market | null> {
  const maybe = await fetchMaybeMarket(ctx.clients.rpc, market);
  return maybe.exists ? maybe.data : null;
}

/** Human-readable name of a MarketState enum value (for logs). */
export function marketStateName(state: MarketState): string {
  return MarketState[state] ?? `Unknown(${state})`;
}

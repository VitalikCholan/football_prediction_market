/**
 * Solana cluster + program config. RPC/cluster come from env with devnet
 * defaults (deploy target). The program id and PDA derivations live in
 * `@fpm/shared` — never hardcode a seed or id here.
 */
import { createSolanaRpc, type Rpc, type SolanaRpcApi } from "@solana/kit";
import { AMM_PROGRAM_ID } from "@fpm/shared";

export const PROGRAM_ID = AMM_PROGRAM_ID;

export const CLUSTER = (process.env.NEXT_PUBLIC_CLUSTER ?? "devnet") as
  | "devnet"
  | "mainnet-beta"
  | "localnet";

export const RPC_URL =
  process.env.NEXT_PUBLIC_SOLANA_RPC_URL ?? "https://api.devnet.solana.com";

/** Chain moniker for framework-kit signers (`solana:devnet`). */
export const CHAIN =
  CLUSTER === "mainnet-beta" ? "solana:mainnet" : "solana:devnet";

/** Explorer link for a signature (discreet on-chain proof — "View tx ↗"). */
export function explorerTx(signature: string): string {
  const suffix = CLUSTER === "mainnet-beta" ? "" : `?cluster=${CLUSTER}`;
  return `https://explorer.solana.com/tx/${signature}${suffix}`;
}

/**
 * Shared Kit RPC (kit ^2, same version as `@fpm/idl` / `@fpm/shared`, so
 * generated fetchers and PDA helpers plug in with no type seams). Lazy module
 * singleton — created on first on-chain read/tx, reused everywhere after.
 */
let _rpc: Rpc<SolanaRpcApi> | null = null;
export function getRpc(): Rpc<SolanaRpcApi> {
  if (!_rpc) _rpc = createSolanaRpc(RPC_URL);
  return _rpc;
}

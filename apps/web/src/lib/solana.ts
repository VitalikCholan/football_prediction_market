/**
 * Solana cluster + program config. RPC/cluster come from env with devnet
 * defaults (deploy target). The program id and PDA derivations live in
 * `@fpm/shared` — never hardcode a seed or id here.
 */
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

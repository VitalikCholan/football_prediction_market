import {
  createSolanaRpc,
  createSolanaRpcSubscriptions,
  type Rpc,
  type RpcSubscriptions,
  type SolanaRpcApi,
  type SolanaRpcSubscriptionsApi,
} from "@solana/kit";
import type { KeeperConfig } from "../config.ts";

export interface SolanaClients {
  /** Primary RPC (index 0 of RPC_URLS). */
  rpc: Rpc<SolanaRpcApi>;
  /** All RPCs in priority order (for failover in TxSender). */
  rpcPool: { url: string; rpc: Rpc<SolanaRpcApi> }[];
  subscriptions: RpcSubscriptions<SolanaRpcSubscriptionsApi>;
}

/** Build the RPC clients: a primary + an ordered failover pool + subscriptions. */
export function createClients(config: KeeperConfig): SolanaClients {
  const rpcPool = config.rpcUrls.map((url) => ({
    url,
    rpc: createSolanaRpc(url),
  }));
  return {
    rpc: rpcPool[0].rpc,
    rpcPool,
    subscriptions: createSolanaRpcSubscriptions(config.rpcWsUrl),
  };
}

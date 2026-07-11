/**
 * On-chain Position reads for the connected wallet. The indexer is the source
 * for history/aggregates; the chain is the source for user funds — so /positions
 * and the trade ticket decode the `Position` PDA directly via `@fpm/idl`
 * (frontend-plan §6.2 authority split).
 */
import { address } from "@solana/kit";
import { fetchAllMaybePosition } from "@fpm/idl";
import { findPositionPda } from "@fpm/shared";
import type { MarketDto } from "@fpm/shared";
import { getRpc } from "@/lib/solana";

export interface UserPosition {
  market: MarketDto;
  /** Position PDA (base58). */
  address: string;
  yesTokens: bigint;
  noTokens: bigint;
  /** Net USDT basis deposited (buys − sell proceeds), base units. */
  collateralBase: bigint;
  redeemed: boolean;
}

/**
 * Batch-fetch the wallet's Position PDAs for the given markets (one RPC call
 * via `fetchAllMaybePosition`). Markets without a position are dropped; fully
 * empty positions are kept only when redeemable state matters (redeemed flag).
 */
export async function fetchUserPositions(
  owner: string,
  markets: MarketDto[],
): Promise<UserPosition[]> {
  if (markets.length === 0) return [];
  const ownerAddr = address(owner);
  const pdas = await Promise.all(
    markets.map(async (m) => {
      const [pda] = await findPositionPda(address(m.id), ownerAddr);
      return pda;
    }),
  );
  const accounts = await fetchAllMaybePosition(getRpc(), pdas);
  const out: UserPosition[] = [];
  accounts.forEach((acc, i) => {
    if (!acc.exists) return;
    out.push({
      market: markets[i],
      address: acc.address,
      yesTokens: acc.data.yesTokens,
      noTokens: acc.data.noTokens,
      collateralBase: acc.data.collateral,
      redeemed: acc.data.redeemed,
    });
  });
  return out;
}

/** Winning-side token balance on a resolved market (0n when not resolved). */
export function winningTokens(p: UserPosition): bigint {
  if (p.market.state !== "Resolved" || !p.market.outcome) return 0n;
  return p.market.outcome === "YES" ? p.yesTokens : p.noTokens;
}

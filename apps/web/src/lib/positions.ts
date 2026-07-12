/**
 * On-chain Position reads for the connected wallet. The indexer is the source
 * for history/aggregates; the chain is the source for user funds — so /positions
 * and the trade ticket decode the `Position` PDA directly via `@fpm/idl`
 * (frontend-plan §6.2 authority split).
 *
 * A market is always 3-way (Team1/Draw/Team2); a `UserPosition` carries the
 * per-outcome token balances ordered `[team1, draw, team2]`.
 */
import { address } from "@solana/kit";
import { fetchAllMaybePosition } from "@fpm/idl";
import {
  findPositionPda,
  type MarketDto,
  type Outcome,
} from "@fpm/shared";
import { getRpc } from "@/lib/solana";

/** 3-way position — token balances ordered [Team1, Draw, Team2]. */
export interface UserPosition {
  /** Position PDA (base58). */
  address: string;
  market: MarketDto;
  /** [Team1, Draw, Team2] balances, base units. */
  tokens: readonly [bigint, bigint, bigint];
  /** Net USDT basis deposited (buys − sell proceeds), base units. */
  collateralBase: bigint;
  redeemed: boolean;
}

/** Sum of every outcome token held (base units) — non-empty test. */
export function totalTokens(p: UserPosition): bigint {
  return p.tokens[0] + p.tokens[1] + p.tokens[2];
}

/**
 * Batch-fetch the wallet's Position PDAs for the given markets in one grouped
 * RPC call, stitched back into the caller's order. Markets without a position
 * are dropped.
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
    const t = acc.data.tokens;
    out.push({
      market: markets[i],
      address: acc.address,
      tokens: [t[0] ?? 0n, t[1] ?? 0n, t[2] ?? 0n],
      collateralBase: acc.data.collateral,
      redeemed: acc.data.redeemed,
    });
  });
  return out;
}

/** Map a resolved `Outcome` to its token-array index (Void → null). */
export function outcomeIndex(o: Outcome): number | null {
  switch (o) {
    case "Team1":
      return 0;
    case "Draw":
      return 1;
    case "Team2":
      return 2;
    case "Void":
      return null;
  }
}

/**
 * Winning-outcome token balance on a resolved market (0n when not resolved).
 * The winning tokens are the resolved outcome's balance; a `Void` outcome
 * refunds pro-rata (handled on-chain), so there is no single winning side —
 * return 0n and let redeem settle it.
 */
export function winningTokens(p: UserPosition): bigint {
  if (p.market.state !== "Resolved") return 0n;
  const o = p.market.outcome;
  if (!o) return 0n;
  const idx = outcomeIndex(o);
  return idx === null ? 0n : p.tokens[idx] ?? 0n;
}

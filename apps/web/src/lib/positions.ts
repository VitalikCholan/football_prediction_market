/**
 * On-chain Position reads for the connected wallet. The indexer is the source
 * for history/aggregates; the chain is the source for user funds — so /positions
 * and the trade ticket decode the `Position` / `Position1x2` PDA directly via
 * `@fpm/idl` (frontend-plan §6.2 authority split).
 *
 * A `UserPosition` is discriminated on its market kind (C2): a binary market
 * yields `{ kind: "binary", yesTokens, noTokens }`; a 1X2 market yields
 * `{ kind: "1x2", tokens: [team1, draw, team2] }`.
 */
import { address } from "@solana/kit";
import { fetchAllMaybePosition, fetchAllMaybePosition1x2 } from "@fpm/idl";
import {
  findPosition1x2Pda,
  findPositionPda,
  type AnyMarketDto,
  type Market1x2Dto,
  type MarketDto,
  type Outcome1x2,
} from "@fpm/shared";
import { isMarket1x2 } from "@/lib/data";
import { getRpc } from "@/lib/solana";

interface UserPositionBase {
  /** Position PDA (base58). */
  address: string;
  /** Net USDT basis deposited (buys − sell proceeds), base units. */
  collateralBase: bigint;
  redeemed: boolean;
}

/** Binary (YES/NO) position, unchanged v0 shape. */
export interface BinaryUserPosition extends UserPositionBase {
  kind: "binary";
  market: MarketDto;
  yesTokens: bigint;
  noTokens: bigint;
}

/** 3-way (1X2) position — token balances ordered [Team1, Draw, Team2]. */
export interface OneXTwoUserPosition extends UserPositionBase {
  kind: "1x2";
  market: Market1x2Dto;
  /** [Team1, Draw, Team2] balances, base units. */
  tokens: readonly [bigint, bigint, bigint];
}

export type UserPosition = BinaryUserPosition | OneXTwoUserPosition;

/** Sum of every outcome token held (base units) — non-empty test for both kinds. */
export function totalTokens(p: UserPosition): bigint {
  return p.kind === "binary"
    ? p.yesTokens + p.noTokens
    : p.tokens[0] + p.tokens[1] + p.tokens[2];
}

/**
 * Batch-fetch the wallet's Position PDAs for the given markets. Binary and 1X2
 * markets are fetched in two grouped RPC calls (one per account type) then
 * stitched back into the caller's order. Markets without a position are dropped.
 */
export async function fetchUserPositions(
  owner: string,
  markets: AnyMarketDto[],
): Promise<UserPosition[]> {
  if (markets.length === 0) return [];
  const ownerAddr = address(owner);

  const binaryMarkets = markets.filter(
    (m): m is MarketDto => !isMarket1x2(m),
  );
  const oneXTwoMarkets = markets.filter(isMarket1x2);

  const out: UserPosition[] = [];

  if (binaryMarkets.length > 0) {
    const pdas = await Promise.all(
      binaryMarkets.map(async (m) => {
        const [pda] = await findPositionPda(address(m.id), ownerAddr);
        return pda;
      }),
    );
    const accounts = await fetchAllMaybePosition(getRpc(), pdas);
    accounts.forEach((acc, i) => {
      if (!acc.exists) return;
      out.push({
        kind: "binary",
        market: binaryMarkets[i],
        address: acc.address,
        yesTokens: acc.data.yesTokens,
        noTokens: acc.data.noTokens,
        collateralBase: acc.data.collateral,
        redeemed: acc.data.redeemed,
      });
    });
  }

  if (oneXTwoMarkets.length > 0) {
    const pdas = await Promise.all(
      oneXTwoMarkets.map(async (m) => {
        const [pda] = await findPosition1x2Pda(address(m.id), ownerAddr);
        return pda;
      }),
    );
    const accounts = await fetchAllMaybePosition1x2(getRpc(), pdas);
    accounts.forEach((acc, i) => {
      if (!acc.exists) return;
      const t = acc.data.tokens;
      out.push({
        kind: "1x2",
        market: oneXTwoMarkets[i],
        address: acc.address,
        tokens: [t[0] ?? 0n, t[1] ?? 0n, t[2] ?? 0n],
        collateralBase: acc.data.collateral,
        redeemed: acc.data.redeemed,
      });
    });
  }

  return out;
}

/** Map a resolved `Outcome1x2` to its token-array index (Void → null). */
export function outcome1x2Index(o: Outcome1x2): number | null {
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
 * Winning-side token balance on a resolved market (0n when not resolved). For a
 * 1X2 market the winning tokens are the resolved outcome's balance; a `Void`
 * outcome refunds pro-rata (handled on-chain), so there is no single winning
 * side — return 0n and let redeem settle it.
 */
export function winningTokens(p: UserPosition): bigint {
  if (p.market.state !== "Resolved") return 0n;
  if (p.kind === "binary") {
    if (!p.market.outcome) return 0n;
    return p.market.outcome === "YES" ? p.yesTokens : p.noTokens;
  }
  const o = p.market.outcome1x2;
  if (!o) return 0n;
  const idx = outcome1x2Index(o);
  return idx === null ? 0n : p.tokens[idx] ?? 0n;
}

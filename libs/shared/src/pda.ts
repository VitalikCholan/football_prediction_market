/**
 * PDA derivation helpers.
 *
 * Reuses the seed constants so the client and the on-chain program can never
 * diverge (anchor-programs-plan.md §2.6, D-7).
 */
import {
  getAddressEncoder,
  getI64Encoder,
  getU16Encoder,
  getProgramDerivedAddress,
  type Address,
  type ProgramDerivedAddress,
} from "@solana/kit";
import {
  AMM_PROGRAM_ID,
  CONFIG_SEED,
  LEV_LP_SEED,
  LEV_POOL_SEED,
  LEV_POSITION_SEED,
  LEV_VAULT_SEED,
  MARKET_SEED,
  MKT_CONFIG_SEED,
  POSITION_SEED,
  VAULT_SEED,
} from "#src/constants.ts";

const addressEncoder = getAddressEncoder();
const u16Encoder = getU16Encoder();
const i64Encoder = getI64Encoder();

/** GlobalConfig singleton: seeds = [CONFIG_SEED]. */
export async function findConfigPda(
  programAddress: Address = AMM_PROGRAM_ID,
): Promise<ProgramDerivedAddress> {
  return getProgramDerivedAddress({
    programAddress,
    seeds: [CONFIG_SEED],
  });
}

/** MarketConfig: seeds = [MKT_CONFIG_SEED, config_id: u16 LE]. */
export async function findMarketConfigPda(
  configId: number,
  programAddress: Address = AMM_PROGRAM_ID,
): Promise<ProgramDerivedAddress> {
  return getProgramDerivedAddress({
    programAddress,
    seeds: [MKT_CONFIG_SEED, u16Encoder.encode(configId)],
  });
}

/** Market: seeds = [MARKET_SEED, fixture_id: i64 LE] (D-7). */
export async function findMarketPda(
  fixtureId: number | bigint,
  programAddress: Address = AMM_PROGRAM_ID,
): Promise<ProgramDerivedAddress> {
  return getProgramDerivedAddress({
    programAddress,
    seeds: [MARKET_SEED, i64Encoder.encode(fixtureId)],
  });
}

/** Position: seeds = [POSITION_SEED, market: Pubkey, owner: Pubkey]. */
export async function findPositionPda(
  market: Address,
  owner: Address,
  programAddress: Address = AMM_PROGRAM_ID,
): Promise<ProgramDerivedAddress> {
  return getProgramDerivedAddress({
    programAddress,
    seeds: [
      POSITION_SEED,
      addressEncoder.encode(market),
      addressEncoder.encode(owner),
    ],
  });
}

/** LeveragePool: seeds = [LEV_POOL_SEED, market: Pubkey] (leverage-v1 §2). */
export async function findLevPoolPda(
  market: Address,
  programAddress: Address = AMM_PROGRAM_ID,
): Promise<ProgramDerivedAddress> {
  return getProgramDerivedAddress({
    programAddress,
    seeds: [LEV_POOL_SEED, addressEncoder.encode(market)],
  });
}

/** Lev vault token account: seeds = [LEV_VAULT_SEED, market: Pubkey] (leverage-v1 §2). */
export async function findLevVaultPda(
  market: Address,
  programAddress: Address = AMM_PROGRAM_ID,
): Promise<ProgramDerivedAddress> {
  return getProgramDerivedAddress({
    programAddress,
    seeds: [LEV_VAULT_SEED, addressEncoder.encode(market)],
  });
}

/** LevPosition: seeds = [LEV_POSITION_SEED, market: Pubkey, owner: Pubkey] (leverage-v1 §2). */
export async function findLevPositionPda(
  market: Address,
  owner: Address,
  programAddress: Address = AMM_PROGRAM_ID,
): Promise<ProgramDerivedAddress> {
  return getProgramDerivedAddress({
    programAddress,
    seeds: [
      LEV_POSITION_SEED,
      addressEncoder.encode(market),
      addressEncoder.encode(owner),
    ],
  });
}

/** LpAccount: seeds = [LEV_LP_SEED, market: Pubkey, owner: Pubkey] (leverage-v1 §2). */
export async function findLpAccountPda(
  market: Address,
  owner: Address,
  programAddress: Address = AMM_PROGRAM_ID,
): Promise<ProgramDerivedAddress> {
  return getProgramDerivedAddress({
    programAddress,
    seeds: [
      LEV_LP_SEED,
      addressEncoder.encode(market),
      addressEncoder.encode(owner),
    ],
  });
}

/** Vault: seeds = [VAULT_SEED, market: Pubkey] — pass the Market PDA key. */
export async function findVaultPda(
  market: Address,
  programAddress: Address = AMM_PROGRAM_ID,
): Promise<ProgramDerivedAddress> {
  return getProgramDerivedAddress({
    programAddress,
    seeds: [VAULT_SEED, addressEncoder.encode(market)],
  });
}

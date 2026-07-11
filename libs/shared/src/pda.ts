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
  MARKET_1X2_SEED,
  MARKET_SEED,
  MKT_CONFIG_SEED,
  POSITION_1X2_SEED,
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

/** Vault: seeds = [VAULT_SEED, market: Pubkey].
 *
 * Shared by binary and 1X2 markets — pass the relevant market PDA key. For a
 * 1X2 market pass the `findMarket1x2Pda` address; distinct market seeds keep
 * the two vaults from colliding for the same fixture. */
export async function findVaultPda(
  market: Address,
  programAddress: Address = AMM_PROGRAM_ID,
): Promise<ProgramDerivedAddress> {
  return getProgramDerivedAddress({
    programAddress,
    seeds: [VAULT_SEED, addressEncoder.encode(market)],
  });
}

/** Market1x2: seeds = [MARKET_1X2_SEED, fixture_id: i64 LE] (SPEC §3.1). */
export async function findMarket1x2Pda(
  fixtureId: number | bigint,
  programAddress: Address = AMM_PROGRAM_ID,
): Promise<ProgramDerivedAddress> {
  return getProgramDerivedAddress({
    programAddress,
    seeds: [MARKET_1X2_SEED, i64Encoder.encode(fixtureId)],
  });
}

/** Position1x2: seeds = [POSITION_1X2_SEED, market: Pubkey, owner: Pubkey]. */
export async function findPosition1x2Pda(
  market: Address,
  owner: Address,
  programAddress: Address = AMM_PROGRAM_ID,
): Promise<ProgramDerivedAddress> {
  return getProgramDerivedAddress({
    programAddress,
    seeds: [
      POSITION_1X2_SEED,
      addressEncoder.encode(market),
      addressEncoder.encode(owner),
    ],
  });
}

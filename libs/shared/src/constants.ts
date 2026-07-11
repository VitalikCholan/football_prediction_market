/**
 * Contract-boundary constants shared by keeper/indexer/web.
 *
 * These MUST stay byte-identical to the on-chain program:
 *  - PDA seeds mirror `anchor-programs-plan.md §2.6` (with D-7: fixture_id is i64).
 *  - Fixed-point denominators mirror `programs/amm/src/constants.rs`.
 *  - TxLINE addresses/mints mirror `anchor-programs-plan.md §11.1`.
 *
 * Never hardcode a seed or denominator anywhere else — import from here.
 */
import { address, type Address } from "@solana/kit";

/** The amm program id (matches `declare_id!` / Anchor.toml, from `anchor keys`). */
export const AMM_PROGRAM_ID: Address = address(
  "H59qQz8DXzUWWc3L528iTCFL36ozwBhJc4tHzuwL2JuY",
);

/* --------------------------------------------------------------------------
 * PDA seed byte-strings (anchor-programs-plan.md §2.6)
 *
 *   CONFIG_SEED      = b"config"
 *   MKT_CONFIG_SEED  = b"mkt_config" + config_id: u16 LE
 *   MARKET_SEED      = b"market"     + fixture_id: i64 LE   (D-7)
 *   POSITION_SEED    = b"position"   + market: Pubkey + owner: Pubkey
 *   VAULT_SEED       = b"vault"      + market: Pubkey
 * ------------------------------------------------------------------------ */
export const CONFIG_SEED = "config";
export const MKT_CONFIG_SEED = "mkt_config";
export const MARKET_SEED = "market";
export const POSITION_SEED = "position";
export const VAULT_SEED = "vault";

/* --------------------------------------------------------------------------
 * 3-way (1X2) LMSR market seeds (programs/amm/src/constants.rs §3.1 phase C).
 *
 *   MARKET_1X2_SEED   = b"market3"   + fixture_id: i64 LE
 *   POSITION_1X2_SEED = b"position3" + market: Pubkey + owner: Pubkey
 *
 * The vault is shared: [VAULT_SEED, market1x2Key]. Distinct market seeds
 * (b"market" vs b"market3") keep binary and 1X2 vaults from colliding.
 * ------------------------------------------------------------------------ */
export const MARKET_1X2_SEED = "market3";
export const POSITION_1X2_SEED = "position3";

/** MarketConfig.market_kind discriminant (on-chain u8). */
export const MARKET_KIND_BINARY = 0;
export const MARKET_KIND_1X2 = 1;

/* --------------------------------------------------------------------------
 * Fixed-point denominators (must match programs/amm/src/constants.rs)
 * ------------------------------------------------------------------------ */
/** Basis-points denominator (fees, prices). */
export const BPS_DENOM = 10_000;
/** Scale applied to the volatility accumulator. */
export const VOLATILITY_ACCUMULATOR_SCALE = 10_000;
/** Denominator for the fee reduction factor. */
export const REDUCTION_FACTOR_DENOMINATOR = 10_000;
/** Denominator for the dynamic-fee control term. */
export const DYNAMIC_FEE_CONTROL_DENOMINATOR = 100_000;

/* --------------------------------------------------------------------------
 * TxLINE constants (anchor-programs-plan.md §11.1), keyed by cluster.
 * All TxLINE token ops use TOKEN_2022_PROGRAM_ID.
 * ------------------------------------------------------------------------ */
export type Cluster = "devnet" | "mainnet";

export interface TxlineClusterConstants {
  /** TxLINE oracle program id. */
  readonly txlineProgram: Address;
  /** TxL governance token mint (Token-2022). */
  readonly txlMint: Address;
  /** USDT mint used across the TxLINE ecosystem. */
  readonly usdtMint: Address;
}

export const TXLINE: Record<Cluster, TxlineClusterConstants> = {
  devnet: {
    txlineProgram: address("6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J"),
    txlMint: address("4Zao8ocPhmMgq7PdsYWyxvqySMGx7xb9cMftPMkEokRG"),
    usdtMint: address("ELWTKspHKCnCfCiCiqYw1EDH77k8VCP74dK9qytG2Ujh"),
  },
  mainnet: {
    txlineProgram: address("9ExbZjAapQww1vfcisDmrngPinHTEfpjYRWMunJgcKaA"),
    txlMint: address("Zhw9TVKp68a1QrftncMSd6ELXKDtpVMNuMGr1jNwdeL"),
    usdtMint: address("Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB"),
  },
};

/**
 * TxLINE PDA seed for the daily score merkle roots we read in `resolve`:
 *   daily_scores_roots + epoch_day: u16 LE
 */
export const DAILY_SCORES_ROOTS_SEED = "daily_scores_roots";

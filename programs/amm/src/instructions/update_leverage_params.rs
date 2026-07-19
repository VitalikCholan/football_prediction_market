//! `update_leverage_params` — admin-gated retro-update of ONLY the 7 v1
//! leverage fields on an existing `MarketConfig` (leverage-v1.md §2 carve).
//!
//! Leverage instructions read the market config LIVE (never a snapshot), so
//! mutating a shared config takes effect IMMEDIATELY for EVERY market that
//! references it (marginfi `configure_bank` pattern) — this is the
//! retro-enable path for live markets created against a `max_leverage = 0`
//! config.
//!
//! Scope is deliberately narrow:
//! * affects FUTURE funding accrual and NEW opens only — existing positions
//!   keep their entry terms (entry mark, units, collateral); only the
//!   funding-rate slope going forward changes, which is by-design mutable
//!   exactly like Drift's funding rate;
//! * the resolution predicate fields (threshold/comparison, stat keys, op,
//!   period) and the fee params are NOT touchable here: the D-8
//!   pre-commitment (resolve proves a question the keeper can't alter)
//!   requires the predicate to stay immutable once markets exist.

use anchor_lang::prelude::*;

use crate::constants::{CONFIG_SEED, MKT_CONFIG_SEED};
use crate::error::AmmError;
use crate::instructions::create_market_config::validate_leverage_params;
use crate::state::{GlobalConfig, LeverageParamsUpdated, MarketConfig};

/// The 7 leverage fields — same types/order as the `FeeParamsArgs` tail
/// (leverage-v1.md §2). Zero everywhere = leverage disabled.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct LeverageParamsArgs {
    pub max_open_interest: u64,
    pub time_fee_num: u32,
    pub funding_epoch_secs: u32,
    pub max_mark_age_secs: u32,
    pub leverage_cutoff_secs: u32,
    pub max_leverage: u16,
    pub min_coverage_bps: u16,
}

#[derive(Accounts)]
pub struct UpdateLeverageParams<'info> {
    pub authority: Signer<'info>,

    #[account(
        seeds = [CONFIG_SEED],
        bump = global.bump,
        // admin gate: signer must be the stored authority
        constraint = global.authority == authority.key() @ AmmError::Unauthorized,
    )]
    pub global: Box<Account<'info, GlobalConfig>>,

    #[account(
        mut,
        seeds = [MKT_CONFIG_SEED, &market_config.config_id.to_le_bytes()],
        bump = market_config.bump,
    )]
    pub market_config: Box<Account<'info, MarketConfig>>,
}

pub(crate) fn handler(
    ctx: Context<UpdateLeverageParams>,
    params: LeverageParamsArgs,
) -> Result<()> {
    // exactly the same rules `create_market_config` enforces
    validate_leverage_params(
        params.max_leverage,
        params.time_fee_num,
        params.funding_epoch_secs,
        params.max_mark_age_secs,
        params.min_coverage_bps,
    )?;

    let mc = &mut ctx.accounts.market_config;
    mc.max_open_interest = params.max_open_interest;
    mc.time_fee_num = params.time_fee_num;
    mc.funding_epoch_secs = params.funding_epoch_secs;
    mc.max_mark_age_secs = params.max_mark_age_secs;
    mc.leverage_cutoff_secs = params.leverage_cutoff_secs;
    mc.max_leverage = params.max_leverage;
    mc.min_coverage_bps = params.min_coverage_bps;

    emit!(LeverageParamsUpdated {
        config: mc.key(),
        max_leverage: params.max_leverage,
        time_fee_num: params.time_fee_num,
    });
    Ok(())
}

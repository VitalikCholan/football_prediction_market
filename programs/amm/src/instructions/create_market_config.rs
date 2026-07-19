//! `create_market_config` — admin-gated `MarketConfig` creation for the 3-way
//! (1X2) LMSR market (SPEC §3.1). Reusable per-tournament fee + resolution
//! params (plan §4.2).
//!
//! - stores `resolution_period` — the expected `stat_to_prove.period` pinned
//!   at resolve time (stale-batch replay guard, resolve-1x2.md O-1x2-1;
//!   TxLINE full-time final stats carry `period = 100`);
//! - enforces the 1X2 predicate shape (`validate_config`): both stat keys
//!   set + distinct, `stat_op = Subtract`. `resolution_comparison` is stored
//!   but IGNORED by `resolve` (the comparator is derived per-hint).

use anchor_lang::prelude::*;

use crate::constants::{
    BPS_DENOM, CONFIG_SEED, MAX_FEE_BPS_CAP, MKT_CONFIG_SEED, REDUCTION_FACTOR_DENOMINATOR,
};
use crate::error::AmmError;
use crate::instructions::resolve::predicate::{validate_config, StoredPredicate};
use crate::state::{GlobalConfig, MarketConfig};

/// Plain args struct mirroring the fee fields + grace + resolution predicate (D-8).
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct FeeParamsArgs {
    pub base_fee_bps: u16,
    pub max_fee_bps: u16,
    pub vfc_num: u32,
    pub filter_period: u32,
    pub decay_period: u32,
    pub reduction_bps: u16,
    pub max_v_acc: u64,
    pub resolution_grace_secs: i64,
    // resolution predicate (D-8)
    pub resolution_threshold: i32,
    pub resolution_comparison: u8,
    pub stat_key_a: u32,
    pub stat_key_b: u32,
    pub stat_op: u8,
    // v1 leverage (leverage-v1.md §2) — APPENDED, IDL-additive.
    // Zero everywhere = leverage disabled.
    pub max_open_interest: u64,
    pub time_fee_num: u32,
    pub funding_epoch_secs: u32,
    pub max_mark_age_secs: u32,
    pub leverage_cutoff_secs: u32,
    pub max_leverage: u16,
    pub min_coverage_bps: u16,
}

#[derive(Accounts)]
#[instruction(config_id: u16)]
pub struct CreateMarketConfig<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        seeds = [CONFIG_SEED],
        bump = global.bump,
        // admin gate: signer must be the stored authority
        constraint = global.authority == authority.key() @ AmmError::Unauthorized,
    )]
    pub global: Box<Account<'info, GlobalConfig>>,

    #[account(
        init,
        payer = authority,
        space = 8 + MarketConfig::INIT_SPACE,
        seeds = [MKT_CONFIG_SEED, &config_id.to_le_bytes()],
        bump,
    )]
    pub market_config: Box<Account<'info, MarketConfig>>,

    pub system_program: Program<'info, System>,
}

pub(crate) fn handler(
    ctx: Context<CreateMarketConfig>,
    config_id: u16,
    params: FeeParamsArgs,
    resolution_period: i32,
) -> Result<()> {
    // ---- param validation (plan §4.2) ----
    require!(
        params.base_fee_bps <= params.max_fee_bps
            && params.max_fee_bps <= MAX_FEE_BPS_CAP,
        AmmError::InvalidFeeParams
    );
    require!(
        (params.reduction_bps as u64) <= REDUCTION_FACTOR_DENOMINATOR,
        AmmError::InvalidFeeParams
    );
    require!(
        params.filter_period <= params.decay_period,
        AmmError::InvalidFeeParams
    );
    require!(params.max_v_acc > 0, AmmError::InvalidFeeParams);
    require!(params.vfc_num > 0, AmmError::InvalidFeeParams);
    require!(params.resolution_comparison <= 2, AmmError::InvalidFeeParams);
    require!(params.stat_op <= 2, AmmError::InvalidFeeParams);

    // ---- v1 leverage params (leverage-v1.md §2): only checked when enabled ----
    if params.max_leverage > 0 {
        require!(params.funding_epoch_secs > 0, AmmError::InvalidFeeParams);
        require!(params.max_mark_age_secs > 0, AmmError::InvalidFeeParams);
        require!(
            (params.min_coverage_bps as u64) >= BPS_DENOM,
            AmmError::InvalidFeeParams
        );
        require!(params.time_fee_num > 0, AmmError::InvalidFeeParams);
    }

    // ---- 1X2 predicate shape: two distinct stat keys, Subtract ----
    validate_config(&StoredPredicate {
        resolution_threshold: params.resolution_threshold,
        stat_key_a: params.stat_key_a,
        stat_key_b: params.stat_key_b,
        stat_op: params.stat_op,
    })?;

    let mc = &mut ctx.accounts.market_config;
    mc.config_id = config_id;
    mc.authority = ctx.accounts.global.authority;
    mc.base_fee_bps = params.base_fee_bps;
    mc.max_fee_bps = params.max_fee_bps;
    mc.vfc_num = params.vfc_num;
    mc.filter_period = params.filter_period;
    mc.decay_period = params.decay_period;
    mc.reduction_bps = params.reduction_bps;
    mc.max_v_acc = params.max_v_acc;
    mc.resolution_grace_secs = params.resolution_grace_secs;
    mc.resolution_threshold = params.resolution_threshold;
    mc.resolution_comparison = params.resolution_comparison;
    mc.stat_key_a = params.stat_key_a;
    mc.stat_key_b = params.stat_key_b;
    mc.stat_op = params.stat_op;
    mc.bump = ctx.bumps.market_config;
    mc.resolution_period = resolution_period;
    // v1 leverage (zero everywhere = disabled)
    mc.max_open_interest = params.max_open_interest;
    mc.time_fee_num = params.time_fee_num;
    mc.funding_epoch_secs = params.funding_epoch_secs;
    mc.max_mark_age_secs = params.max_mark_age_secs;
    mc.leverage_cutoff_secs = params.leverage_cutoff_secs;
    mc.max_leverage = params.max_leverage;
    mc.min_coverage_bps = params.min_coverage_bps;
    mc._reserved = [0u8; 12];
    Ok(())
}

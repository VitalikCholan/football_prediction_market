//! `create_market_config` — reusable per-tournament fee + resolution params
//! (plan §4.2). Admin-gated.

use anchor_lang::prelude::*;

use crate::constants::{CONFIG_SEED, MAX_FEE_BPS_CAP, MKT_CONFIG_SEED, REDUCTION_FACTOR_DENOMINATOR};
use crate::error::AmmError;
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
    mc._reserved = [0u8; 44];
    Ok(())
}

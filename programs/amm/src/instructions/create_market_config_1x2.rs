//! `create_market_config_1x2` — admin-gated `MarketConfig` creation for the
//! 3-way (1X2) LMSR market (SPEC §3.1 phase C).
//!
//! A SEPARATE instruction (not a new param on `create_market_config`) so the
//! shipped binary instruction stays byte-stable in the IDL. Differences from
//! the binary path:
//! - sets `market_kind = MARKET_KIND_1X2` (gates `resolve` vs `resolve_1x2`);
//! - stores `resolution_period` — the expected `stat_to_prove.period` pinned
//!   at resolve time (stale-batch replay guard, resolve-1x2.md O-1x2-1;
//!   TxLINE full-time final stats carry `period = 100`);
//! - enforces the 1X2 predicate shape (`validate_1x2_config`): both stat keys
//!   set + distinct, `stat_op = Subtract`. `resolution_comparison` is stored
//!   but IGNORED by `resolve_1x2` (the comparator is derived per-hint).

use anchor_lang::prelude::*;

use crate::constants::{
    CONFIG_SEED, MARKET_KIND_1X2, MAX_FEE_BPS_CAP, MKT_CONFIG_SEED,
    REDUCTION_FACTOR_DENOMINATOR,
};
use crate::error::AmmError;
use crate::instructions::create_market_config::FeeParamsArgs;
use crate::instructions::resolve::predicate_1x2::{validate_1x2_config, Stored1x2Predicate};
use crate::state::{GlobalConfig, MarketConfig};

#[derive(Accounts)]
#[instruction(config_id: u16)]
pub struct CreateMarketConfig1x2<'info> {
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
    ctx: Context<CreateMarketConfig1x2>,
    config_id: u16,
    params: FeeParamsArgs,
    resolution_period: i32,
) -> Result<()> {
    // ---- param validation (mirrors create_market_config, plan §4.2) ----
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

    // ---- 1X2 predicate shape: two distinct stat keys, Subtract ----
    validate_1x2_config(&Stored1x2Predicate {
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
    mc.market_kind = MARKET_KIND_1X2;
    mc.resolution_period = resolution_period;
    mc._reserved = [0u8; 39];
    Ok(())
}

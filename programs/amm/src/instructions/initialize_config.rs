//! `initialize_config` — create the singleton `GlobalConfig` (plan §4.1).

use anchor_lang::prelude::*;

use crate::constants::CONFIG_SEED;
use crate::state::GlobalConfig;

#[derive(Accounts)]
pub struct InitializeConfig<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        init,
        payer = authority,
        space = 8 + GlobalConfig::INIT_SPACE,
        seeds = [CONFIG_SEED],
        bump,
    )]
    pub config: Account<'info, GlobalConfig>,

    pub system_program: Program<'info, System>,
}

pub(crate) fn handler(
    ctx: Context<InitializeConfig>,
    keeper: Pubkey,
    txline_program: Pubkey,
    usdc_mint: Pubkey,
    token_program: Pubkey,
) -> Result<()> {
    let config = &mut ctx.accounts.config;
    config.authority = ctx.accounts.authority.key();
    config.keeper = keeper;
    config.txline_program = txline_program;
    config.usdc_mint = usdc_mint;
    config.token_program = token_program;
    config.bump = ctx.bumps.config;
    config._reserved = [0u8; 64];
    Ok(())
}

//! `init_leverage_pool` — admin-gated creation of the LP-funded
//! `LeveragePool` (options writer, leverage-v1.md §0) + its lev vault token
//! account for one market. The pool PDA is the vault authority; all leverage
//! flows (collateral in, payouts out, LP deposits/withdrawals) move through
//! this vault and NEVER touch the market's spot escrow.

use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

use crate::constants::{
    BPS_DENOM, CONFIG_SEED, LEV_POOL_SEED, LEV_VAULT_SEED, MARKET_SEED,
};
use crate::error::AmmError;
use crate::state::{
    GlobalConfig, LeveragePool, LeveragePoolInitialized, Market, MarketConfig,
};

#[derive(Accounts)]
pub struct InitLeveragePool<'info> {
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
        seeds = [MARKET_SEED, &market.fixture_id.to_le_bytes()],
        bump = market.bump,
    )]
    pub market: Box<Account<'info, Market>>,

    #[account(address = market.config)]
    pub market_config: Box<Account<'info, MarketConfig>>,

    #[account(
        init,
        payer = authority,
        space = 8 + LeveragePool::INIT_SPACE,
        seeds = [LEV_POOL_SEED, market.key().as_ref()],
        bump,
    )]
    pub pool: Box<Account<'info, LeveragePool>>,

    #[account(
        init,
        payer = authority,
        seeds = [LEV_VAULT_SEED, market.key().as_ref()],
        bump,
        token::mint = usdt_mint,
        token::authority = pool,
        token::token_program = token_program,
    )]
    pub lev_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(address = global.usdt_mint)]
    pub usdt_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(address = global.token_program)]
    pub token_program: Interface<'info, TokenInterface>,

    pub system_program: Program<'info, System>,
}

pub(crate) fn handler(ctx: Context<InitLeveragePool>) -> Result<()> {
    // leverage must be enabled on this market's config (0 = disabled).
    require!(
        ctx.accounts.market_config.max_leverage > 0,
        AmmError::LeverageDisabled
    );

    let pool = &mut ctx.accounts.pool;
    pool.market = ctx.accounts.market.key();
    pool.vault = ctx.accounts.lev_vault.key();
    pool.total_shares = 0;
    pool.pending_withdraw_shares = 0;
    pool.open_interest = 0;
    pool.total_max_payout = 0;
    pool.mark_bps = [0u16; 3];
    // 0 until the keeper's first post_mark (which initializes without accrual).
    pool.mark_ts = 0;
    pool.last_funding_ts = 0;
    pool.cum_funding_index = [0u128; 3];
    pool.valve_paused_until = 0;
    // neutral multiplier: only values > BPS amplify funding (funding.rs).
    pool.valve_multiplier_bps = BPS_DENOM as u16;
    pool.valve_until_ts = 0;
    pool.bump = ctx.bumps.pool;
    pool.vault_bump = ctx.bumps.lev_vault;
    pool._reserved = [0u8; 32];

    emit!(LeveragePoolInitialized {
        market: pool.market,
        vault: pool.vault,
    });
    Ok(())
}

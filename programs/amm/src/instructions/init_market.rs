//! `init_market` — create the `Market` + USDT escrow vault, seed reserves and
//! liquidity (plan §4.3). Admin-gated.
//!
//! D-2: reserves are virtual (odds only). Seed USDC = the real collateral the
//! admin deposits so the vault starts solvent for both sides.

use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    self, Mint, TokenAccount, TokenInterface, TransferChecked,
};

use crate::constants::{CONFIG_SEED, MARKET_SEED, MKT_CONFIG_SEED, VAULT_SEED};
use crate::error::AmmError;
use crate::math;
use crate::state::{GlobalConfig, Market, MarketConfig, MarketCreated, MarketState, Outcome};

#[derive(Accounts)]
#[instruction(fixture_id: i64)]
pub struct InitMarket<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        seeds = [CONFIG_SEED],
        bump = global.bump,
        constraint = global.authority == authority.key() @ AmmError::Unauthorized,
    )]
    pub global: Box<Account<'info, GlobalConfig>>,

    #[account(
        seeds = [MKT_CONFIG_SEED, &market_config.config_id.to_le_bytes()],
        bump = market_config.bump,
    )]
    pub market_config: Box<Account<'info, MarketConfig>>,

    #[account(
        init,
        payer = authority,
        space = 8 + Market::INIT_SPACE,
        seeds = [MARKET_SEED, &fixture_id.to_le_bytes()],
        bump,
    )]
    pub market: Box<Account<'info, Market>>,

    #[account(
        init,
        payer = authority,
        seeds = [VAULT_SEED, market.key().as_ref()],
        bump,
        token::mint = usdc_mint,
        token::authority = market,
        token::token_program = token_program,
    )]
    pub vault: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(address = global.usdc_mint)]
    pub usdc_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(
        mut,
        token::mint = usdc_mint,
        token::authority = authority,
        token::token_program = token_program,
    )]
    pub authority_usdc: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(address = global.token_program)]
    pub token_program: Interface<'info, TokenInterface>,

    pub system_program: Program<'info, System>,
}

pub(crate) fn handler(
    ctx: Context<InitMarket>,
    fixture_id: i64,
    kickoff_ts: i64,
    freeze_ts: i64,
    seed_yes: u64,
    seed_no: u64,
    seed_liquidity: u64,
) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;

    // ---- timing + seed validation ----
    require!(kickoff_ts < freeze_ts, AmmError::InvalidTiming);
    require!(kickoff_ts > now, AmmError::InvalidTiming);
    require!(seed_yes > 0 && seed_no > 0, AmmError::InvalidSeedLiquidity);
    require!(seed_liquidity > 0, AmmError::InvalidSeedLiquidity);

    let price_bps = math::price_yes_bps(seed_yes, seed_no)?;

    // ---- write market state ----
    let market = &mut ctx.accounts.market;
    market.config = ctx.accounts.market_config.key();
    market.fixture_id = fixture_id;
    market.yes_reserve = seed_yes;
    market.no_reserve = seed_no;
    market.usdc_collateral = seed_liquidity;
    market.yes_supply = 0;
    market.no_supply = 0;
    market.state = MarketState::Open;
    market.outcome = Outcome::Unset;
    market.vault = ctx.accounts.vault.key();
    market.vault_bump = ctx.bumps.vault;
    market.kickoff_ts = kickoff_ts;
    market.freeze_ts = freeze_ts;
    market.usdc_mint = ctx.accounts.usdc_mint.key();
    market.last_price_bps = price_bps;
    market.last_ts = now;
    market.v_acc = 0;
    market.bump = ctx.bumps.market;
    market._reserved = [0u8; 64];

    // ---- transfer seed liquidity: authority_usdc -> vault (authority signs) ----
    let decimals = ctx.accounts.usdc_mint.decimals;
    let before = ctx.accounts.vault.amount;

    let cpi_accounts = TransferChecked {
        from: ctx.accounts.authority_usdc.to_account_info(),
        mint: ctx.accounts.usdc_mint.to_account_info(),
        to: ctx.accounts.vault.to_account_info(),
        authority: ctx.accounts.authority.to_account_info(),
    };
    let cpi_ctx = CpiContext::new(ctx.accounts.token_program.key(), cpi_accounts);
    token_interface::transfer_checked(cpi_ctx, seed_liquidity, decimals)?;

    // balance-delta accounting (D-6 insurance): trust the vault, not the arg.
    ctx.accounts.vault.reload()?;
    let credited = ctx
        .accounts
        .vault
        .amount
        .checked_sub(before)
        .ok_or(AmmError::MathOverflow)?;
    // usdc_collateral tracks the real vault balance credited.
    let market = &mut ctx.accounts.market;
    market.usdc_collateral = credited;

    // solvency holds trivially (supplies are 0).
    math::assert_solvent(ctx.accounts.vault.amount, market.yes_supply, market.no_supply)?;

    emit!(MarketCreated {
        fixture_id,
        config: market.config,
        yes_reserve: market.yes_reserve,
        no_reserve: market.no_reserve,
        price_bps,
    });
    Ok(())
}

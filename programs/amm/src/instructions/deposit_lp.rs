//! `deposit_lp(amount)` — deposit USDT into the leverage pool's lev vault
//! for internal LP shares (no SPL mint; leverage-v1.md §4).
//!
//! Shares are priced on the PRE-deposit vault balance
//! (`shares_for_deposit(amount, total_shares, vault.amount)`, FLOOR — a
//! deposit/withdraw round-trip can never mint value out of the pool). A dust
//! deposit that floors to 0 shares is rejected here (the pure fn documents
//! that this is the caller's guard).

use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    self, Mint, TokenAccount, TokenInterface, TransferChecked,
};

use crate::constants::{LEV_LP_SEED, LEV_POOL_SEED, MARKET_SEED};
use crate::error::AmmError;
use crate::funding;
use crate::state::{LeveragePool, LpAccount, LpDeposited, Market};

#[derive(Accounts)]
pub struct DepositLp<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        seeds = [MARKET_SEED, &market.fixture_id.to_le_bytes()],
        bump = market.bump,
    )]
    pub market: Box<Account<'info, Market>>,

    #[account(
        mut,
        seeds = [LEV_POOL_SEED, market.key().as_ref()],
        bump = pool.bump,
    )]
    pub pool: Box<Account<'info, LeveragePool>>,

    #[account(
        mut,
        seeds = [LEV_LP_SEED, market.key().as_ref(), owner.key().as_ref()],
        bump = lp_account.bump,
        constraint = lp_account.owner == owner.key() @ AmmError::Unauthorized,
        constraint = lp_account.market == market.key() @ AmmError::Unauthorized,
    )]
    pub lp_account: Box<Account<'info, LpAccount>>,

    #[account(mut, address = pool.vault)]
    pub lev_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        mut,
        token::mint = usdt_mint,
        token::authority = owner,
        token::token_program = token_program,
    )]
    pub owner_usdt: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(address = market.usdt_mint)]
    pub usdt_mint: Box<InterfaceAccount<'info, Mint>>,

    pub token_program: Interface<'info, TokenInterface>,
}

pub(crate) fn handler(ctx: Context<DepositLp>, amount: u64) -> Result<()> {
    require!(amount > 0, AmmError::ZeroAmount);

    // ---- shares priced on the PRE-deposit vault balance ----
    let shares = funding::shares_for_deposit(
        amount,
        ctx.accounts.pool.total_shares,
        ctx.accounts.lev_vault.amount,
    )
    .map_err(|_| AmmError::FundingMath)?;
    require!(shares > 0, AmmError::InsufficientShares);

    // ---- deposit USDT: owner_usdt -> lev vault (owner signs, plain CPI) ----
    let decimals = ctx.accounts.usdt_mint.decimals;
    let cpi_accounts = TransferChecked {
        from: ctx.accounts.owner_usdt.to_account_info(),
        mint: ctx.accounts.usdt_mint.to_account_info(),
        to: ctx.accounts.lev_vault.to_account_info(),
        authority: ctx.accounts.owner.to_account_info(),
    };
    let cpi_ctx = CpiContext::new(ctx.accounts.token_program.key(), cpi_accounts);
    token_interface::transfer_checked(cpi_ctx, amount, decimals)?;

    // ---- mint internal shares ----
    let pool = &mut ctx.accounts.pool;
    pool.total_shares = pool
        .total_shares
        .checked_add(shares)
        .ok_or(AmmError::MathOverflow)?;
    let lp = &mut ctx.accounts.lp_account;
    lp.shares = lp.shares.checked_add(shares).ok_or(AmmError::MathOverflow)?;

    emit!(LpDeposited {
        market: ctx.accounts.market.key(),
        owner: ctx.accounts.owner.key(),
        amount,
        shares,
    });
    Ok(())
}

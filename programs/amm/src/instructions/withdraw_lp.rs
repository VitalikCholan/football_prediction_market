//! `withdraw_lp` — claim an unlocked pending LP withdrawal from the lev
//! vault (leverage-v1.md §4). Pays `value_for_shares(pending_shares)` at the
//! CURRENT share price (FLOOR, pool-favorable), burns the pending shares.
//!
//! Effects run before the payout CPI (checks-effects-interactions).

use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    self, Mint, TokenAccount, TokenInterface, TransferChecked,
};

use crate::constants::{LEV_LP_SEED, LEV_POOL_SEED, MARKET_SEED};
use crate::error::AmmError;
use crate::funding;
use crate::state::{LeveragePool, LpAccount, LpWithdrawn, Market};

#[derive(Accounts)]
pub struct WithdrawLp<'info> {
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

pub(crate) fn handler(ctx: Context<WithdrawLp>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;

    let pending = ctx.accounts.lp_account.pending_shares;
    require!(pending > 0, AmmError::NothingPending);
    require!(
        now >= ctx.accounts.lp_account.unlock_ts,
        AmmError::WithdrawLocked
    );

    // value at the CURRENT share price (may differ from request time).
    let value = funding::value_for_shares(
        pending,
        ctx.accounts.pool.total_shares,
        ctx.accounts.lev_vault.amount,
    )
    .map_err(|_| AmmError::FundingMath)?;

    // ---- effects FIRST: burn shares, clear pending ----
    {
        let pool = &mut ctx.accounts.pool;
        pool.total_shares = pool
            .total_shares
            .checked_sub(pending)
            .ok_or(AmmError::MathOverflow)?;
        pool.pending_withdraw_shares = pool
            .pending_withdraw_shares
            .checked_sub(pending)
            .ok_or(AmmError::MathOverflow)?;
    }
    {
        let lp = &mut ctx.accounts.lp_account;
        lp.shares = lp
            .shares
            .checked_sub(pending)
            .ok_or(AmmError::MathOverflow)?;
        lp.pending_shares = 0;
    }

    // ---- interaction: lev vault -> owner_usdt, signed by the pool PDA ----
    if value > 0 {
        let decimals = ctx.accounts.usdt_mint.decimals;
        let market_key = ctx.accounts.market.key();
        let pool_bump = ctx.accounts.pool.bump;
        let signer_seeds: &[&[&[u8]]] =
            &[&[LEV_POOL_SEED, market_key.as_ref(), &[pool_bump]]];

        let cpi_accounts = TransferChecked {
            from: ctx.accounts.lev_vault.to_account_info(),
            mint: ctx.accounts.usdt_mint.to_account_info(),
            to: ctx.accounts.owner_usdt.to_account_info(),
            authority: ctx.accounts.pool.to_account_info(),
        };
        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),
            cpi_accounts,
            signer_seeds,
        );
        token_interface::transfer_checked(cpi_ctx, value, decimals)?;
    }

    emit!(LpWithdrawn {
        market: ctx.accounts.market.key(),
        owner: ctx.accounts.owner.key(),
        shares: pending,
        value,
    });
    Ok(())
}

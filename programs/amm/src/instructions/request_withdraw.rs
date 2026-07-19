//! `request_withdraw(shares)` — earmark LP shares for withdrawal and start
//! the `LP_WITHDRAW_DELAY_SECS` lockup (leverage-v1.md §4). Two-step exit
//! (JLP pattern): LPs cannot front-run a bad mark out of the pool.
//!
//! The post-withdraw coverage check uses the CURRENT share value — the vault
//! must still cover `min_coverage_bps` of `total_max_payout` after the
//! requested value leaves (actual payout is re-priced at claim time in
//! `withdraw_lp`).
//!
//! NOTE: a new request while one is pending ADDS to `pending_shares` but
//! OVERWRITES `unlock_ts` — the combined pending amount unlocks
//! `LP_WITHDRAW_DELAY_SECS` after the LATEST request.

use anchor_lang::prelude::*;
use anchor_spl::token_interface::TokenAccount;

use crate::constants::{
    LEV_LP_SEED, LEV_POOL_SEED, LP_WITHDRAW_DELAY_SECS, MARKET_SEED,
};
use crate::error::AmmError;
use crate::funding;
use crate::state::{LeveragePool, LpAccount, LpWithdrawRequested, Market, MarketConfig};

#[derive(Accounts)]
pub struct RequestWithdraw<'info> {
    pub owner: Signer<'info>,

    #[account(
        seeds = [MARKET_SEED, &market.fixture_id.to_le_bytes()],
        bump = market.bump,
    )]
    pub market: Box<Account<'info, Market>>,

    #[account(address = market.config)]
    pub market_config: Box<Account<'info, MarketConfig>>,

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

    #[account(address = pool.vault)]
    pub lev_vault: Box<InterfaceAccount<'info, TokenAccount>>,
}

pub(crate) fn handler(ctx: Context<RequestWithdraw>, shares: u64) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;

    require!(shares > 0, AmmError::ZeroAmount);
    // free shares = shares − already-pending (structurally non-negative).
    let free = ctx
        .accounts
        .lp_account
        .shares
        .checked_sub(ctx.accounts.lp_account.pending_shares)
        .ok_or(AmmError::MathOverflow)?;
    require!(shares <= free, AmmError::InsufficientShares);

    // ---- coverage must hold AFTER the requested value leaves the vault ----
    let withdraw_value = funding::value_for_shares(
        shares,
        ctx.accounts.pool.total_shares,
        ctx.accounts.lev_vault.amount,
    )
    .map_err(|_| AmmError::FundingMath)?;
    let remaining = ctx
        .accounts
        .lev_vault
        .amount
        .checked_sub(withdraw_value)
        .ok_or(AmmError::MathOverflow)?;
    let covered = funding::coverage_ok(
        remaining,
        ctx.accounts.market_config.min_coverage_bps,
        ctx.accounts.pool.total_max_payout,
        0,
    )
    .map_err(|_| AmmError::FundingMath)?;
    require!(covered, AmmError::CoverageBreached);

    // ---- earmark + start (or restart) the lockup clock ----
    let unlock_ts = now
        .checked_add(LP_WITHDRAW_DELAY_SECS)
        .ok_or(AmmError::MathOverflow)?;
    let lp = &mut ctx.accounts.lp_account;
    lp.pending_shares = lp
        .pending_shares
        .checked_add(shares)
        .ok_or(AmmError::MathOverflow)?;
    lp.unlock_ts = unlock_ts;
    let pool = &mut ctx.accounts.pool;
    pool.pending_withdraw_shares = pool
        .pending_withdraw_shares
        .checked_add(shares)
        .ok_or(AmmError::MathOverflow)?;

    emit!(LpWithdrawRequested {
        market: ctx.accounts.market.key(),
        owner: ctx.accounts.owner.key(),
        shares,
        unlock_ts,
    });
    Ok(())
}

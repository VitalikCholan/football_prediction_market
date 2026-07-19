//! `expire_position` — PERMISSIONLESS crank (any signer) that settles a
//! fee-dead leveraged position: accrued funding has reached the collateral
//! (`F ≥ C`, leverage-v1.md §0 deterministic fee-death). Same unified
//! settlement math as `close_leverage` (`compute_settlement`); the cranker
//! gets nothing — the payout (usually 0 at a flat mark, but pnl can still
//! rescue equity) goes to the position owner's token account and the
//! `LevPosition` rent returns to the position owner, NOT the cranker.

use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    self, Mint, TokenAccount, TokenInterface, TransferChecked,
};

use crate::constants::{LEV_POOL_SEED, LEV_POSITION_SEED, MARKET_SEED};
use crate::error::AmmError;
use crate::funding;
use crate::instructions::close_leverage::compute_settlement;
use crate::state::{LeveragePool, LeverageSettled, LevPosition, Market, MarketConfig};

#[derive(Accounts)]
pub struct ExpirePosition<'info> {
    /// Anyone may crank; pays only the tx fee.
    pub cranker: Signer<'info>,

    /// CHECK: rent + payout destination. Bound to the settled position twice:
    /// it is a seed of `lev_position` AND must equal the stored
    /// `lev_position.owner` (belt constraint below).
    #[account(mut)]
    pub position_owner: UncheckedAccount<'info>,

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
        close = position_owner,
        seeds = [LEV_POSITION_SEED, market.key().as_ref(), position_owner.key().as_ref()],
        bump = lev_position.bump,
        constraint = lev_position.owner == position_owner.key() @ AmmError::Unauthorized,
        constraint = lev_position.market == market.key() @ AmmError::Unauthorized,
    )]
    pub lev_position: Box<Account<'info, LevPosition>>,

    #[account(mut, address = pool.vault)]
    pub lev_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    /// Payout destination — must be OWNED by the position owner.
    #[account(
        mut,
        token::mint = usdt_mint,
        token::authority = position_owner,
        token::token_program = token_program,
    )]
    pub owner_usdt: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(address = market.usdt_mint)]
    pub usdt_mint: Box<InterfaceAccount<'info, Mint>>,

    pub token_program: Interface<'info, TokenInterface>,
}

pub(crate) fn handler(ctx: Context<ExpirePosition>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;

    let settlement = compute_settlement(
        &ctx.accounts.market,
        &ctx.accounts.market_config,
        &ctx.accounts.pool,
        &ctx.accounts.lev_position,
        now,
        true,
    )?;
    // fee-death gate: only cranks a position whose funding ate the collateral.
    require!(
        settlement.funding >= ctx.accounts.lev_position.collateral,
        AmmError::PositionNotExpired
    );

    // ---- effects FIRST: flag settled, release pool exposure ----
    ctx.accounts.lev_position.settled = true;
    // deterministic re-computation of the liability booked at open.
    let max_gain = funding::max_gain(
        ctx.accounts.lev_position.units,
        ctx.accounts.lev_position.entry_mark_bps,
    )
    .map_err(|_| AmmError::FundingMath)?;
    {
        let pool = &mut ctx.accounts.pool;
        pool.open_interest = pool
            .open_interest
            .saturating_sub(ctx.accounts.lev_position.notional);
        pool.total_max_payout = pool.total_max_payout.saturating_sub(max_gain);
    }

    // ---- interaction: lev vault -> position owner, signed by the pool PDA.
    //      NO cap at vault.amount (fail loudly, never haircut). ----
    if settlement.payout > 0 {
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
        token_interface::transfer_checked(cpi_ctx, settlement.payout, decimals)?;
    }

    emit!(LeverageSettled {
        market: ctx.accounts.market.key(),
        owner: ctx.accounts.position_owner.key(),
        payout: settlement.payout,
        funding_paid: settlement.funding,
        reason: settlement.reason,
    });
    Ok(())
}

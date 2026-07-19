//! `open_leverage(outcome, collateral, leverage)` — open a no-liquidation
//! leveraged position: a cash-settled binary option on one outcome, written
//! by the `LeveragePool` (leverage-v1.md §0/§4). Exposure is marked to the
//! posted TxLINE mark, never our own LMSR spot. Max trader loss = collateral.
//!
//! Guards run in the plan-§4 order EXACTLY (enabled → state → cutoff →
//! mark fresh → valve → outcome/leverage taper → amount → OI → coverage).
//! `LevPosition` is a plain `init` — a second open while one is live fails
//! at init (one live leveraged position per user per market).

use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    self, Mint, TokenAccount, TokenInterface, TransferChecked,
};

use crate::constants::{LEV_POOL_SEED, LEV_POSITION_SEED, MARKET_SEED};
use crate::error::AmmError;
use crate::funding;
use crate::state::{
    LeverageOpened, LeveragePool, LevPosition, Market, MarketConfig, MarketState,
};

#[derive(Accounts)]
pub struct OpenLeverage<'info> {
    #[account(mut)]
    pub trader: Signer<'info>,

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
        init,
        payer = trader,
        space = 8 + LevPosition::INIT_SPACE,
        seeds = [LEV_POSITION_SEED, market.key().as_ref(), trader.key().as_ref()],
        bump,
    )]
    pub lev_position: Box<Account<'info, LevPosition>>,

    #[account(mut, address = pool.vault)]
    pub lev_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        mut,
        token::mint = usdt_mint,
        token::authority = trader,
        token::token_program = token_program,
    )]
    pub trader_usdt: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(address = market.usdt_mint)]
    pub usdt_mint: Box<InterfaceAccount<'info, Mint>>,

    pub token_program: Interface<'info, TokenInterface>,

    pub system_program: Program<'info, System>,
}

pub(crate) fn handler(
    ctx: Context<OpenLeverage>,
    outcome: u8,
    collateral: u64,
    leverage: u16,
) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let market = &ctx.accounts.market;
    let config = &ctx.accounts.market_config;
    let pool = &ctx.accounts.pool;

    // (1) leverage enabled on this config
    require!(
        config.max_leverage > 0 && config.funding_epoch_secs > 0,
        AmmError::LeverageDisabled
    );
    // (2) market state
    require!(
        market.state == MarketState::Trading,
        AmmError::InvalidMarketState
    );
    // (3) not within the pre-freeze cutoff window
    let cutoff_ts = market
        .freeze_ts
        .checked_sub(i64::from(config.leverage_cutoff_secs))
        .ok_or(AmmError::MathOverflow)?;
    require!(now < cutoff_ts, AmmError::LeverageCutoff);
    // (4) mark posted and fresh
    require!(pool.mark_ts > 0, AmmError::MarkNotPosted);
    require!(
        now.saturating_sub(pool.mark_ts) <= i64::from(config.max_mark_age_secs),
        AmmError::MarkStale
    );
    // (5) risk valve not pausing opens
    require!(now >= pool.valve_paused_until, AmmError::RiskValvePaused);
    // (6) outcome + leverage vs the tapered cap at the entry mark
    let idx = usize::from(outcome);
    require!(idx < 3, AmmError::LmsrInvalidOutcomeIndex);
    let entry_mark_bps = pool.mark_bps[idx];
    require!(leverage >= 2, AmmError::LeverageTooLow);
    require!(
        leverage <= funding::max_leverage_for_p(entry_mark_bps, config.max_leverage),
        AmmError::LeverageTooHigh
    );
    // (7) nonzero collateral
    require!(collateral > 0, AmmError::ZeroAmount);
    // (8) sizing + open-interest cap
    let units = funding::units_for(collateral, leverage, entry_mark_bps)
        .map_err(|_| AmmError::FundingMath)?;
    let notional = collateral
        .checked_mul(u64::from(leverage))
        .ok_or(AmmError::MathOverflow)?;
    let max_gain =
        funding::max_gain(units, entry_mark_bps).map_err(|_| AmmError::FundingMath)?;
    let new_open_interest = pool
        .open_interest
        .checked_add(notional)
        .ok_or(AmmError::MathOverflow)?;
    require!(
        new_open_interest <= config.max_open_interest,
        AmmError::OpenInterestExceeded
    );
    // (9) pool coverage with the new liability (pre-transfer vault balance)
    let covered = funding::coverage_ok(
        ctx.accounts.lev_vault.amount,
        config.min_coverage_bps,
        pool.total_max_payout,
        max_gain,
    )
    .map_err(|_| AmmError::FundingMath)?;
    require!(covered, AmmError::CoverageBreached);

    // ---- deposit collateral: trader_usdt -> lev vault (trader signs) ----
    let decimals = ctx.accounts.usdt_mint.decimals;
    let cpi_accounts = TransferChecked {
        from: ctx.accounts.trader_usdt.to_account_info(),
        mint: ctx.accounts.usdt_mint.to_account_info(),
        to: ctx.accounts.lev_vault.to_account_info(),
        authority: ctx.accounts.trader.to_account_info(),
    };
    let cpi_ctx = CpiContext::new(ctx.accounts.token_program.key(), cpi_accounts);
    token_interface::transfer_checked(cpi_ctx, collateral, decimals)?;

    // ---- write the position + bump pool exposure ----
    let position = &mut ctx.accounts.lev_position;
    position.market = ctx.accounts.market.key();
    position.owner = ctx.accounts.trader.key();
    position.outcome_idx = outcome;
    position.leverage = leverage;
    position.collateral = collateral;
    position.notional = notional;
    position.units = units;
    position.entry_mark_bps = entry_mark_bps;
    position.funding_index_snap = ctx.accounts.pool.cum_funding_index[idx];
    position.open_ts = now;
    position.settled = false;
    position.bump = ctx.bumps.lev_position;
    position._reserved = [0u8; 16];

    let pool = &mut ctx.accounts.pool;
    pool.open_interest = new_open_interest;
    pool.total_max_payout = pool
        .total_max_payout
        .checked_add(max_gain)
        .ok_or(AmmError::MathOverflow)?;

    emit!(LeverageOpened {
        market: ctx.accounts.market.key(),
        owner: ctx.accounts.trader.key(),
        outcome,
        collateral,
        leverage,
        units,
        entry_mark_bps,
    });
    Ok(())
}

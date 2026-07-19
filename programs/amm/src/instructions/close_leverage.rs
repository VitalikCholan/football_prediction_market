//! `close_leverage` — owner-signed settlement of a leveraged position at the
//! unified payout `max(0, C + pnl(p) − F)` (leverage-v1.md §1):
//!
//! * market `Trading`/`Locked`: `p` = current posted mark for the position's
//!   outcome (mark must be fresh; Locked allowed — the trader may exit while
//!   awaiting the resolution proof, at the last mark);
//! * market `Resolved` for the position's outcome: `p = BPS`;
//! * market `Resolved` for another real outcome: `p = 0`;
//! * market `Resolved(Void)`: `payout = max(0, C − F)` (D-4 basis-refund mirror).
//!
//! Funding stays in the lev vault (writer revenue). The `LevPosition` is
//! closed, rent → owner. `compute_settlement` is shared with
//! `expire_position` (the permissionless fee-death crank).

use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    self, Mint, TokenAccount, TokenInterface, TransferChecked,
};

use crate::constants::{BPS_DENOM, LEV_POOL_SEED, LEV_POSITION_SEED, MARKET_SEED};
use crate::error::AmmError;
use crate::funding;
use crate::state::{
    LeveragePool, LeverageSettled, LevPosition, Market, MarketConfig, MarketState,
    Outcome,
};

/// Result of the unified settlement math (plan §1), shared by
/// `close_leverage` and `expire_position`.
pub(crate) struct Settlement {
    /// USDT owed from the lev vault: `max(0, C + pnl(p) − F)`.
    pub payout: u64,
    /// Funding accrued since open (retained by the pool).
    pub funding: u64,
    /// Event reason byte: 0 = closed, 1 = expired, 2 = resolved, 3 = void.
    pub reason: u8,
}

/// Unified settlement (plan §1): pick `p` from the market state, compute
/// `pnl` and accrued funding, clamp the payout at 0. `is_expire` only
/// selects the reason byte on the live (Trading/Locked) path — the math is
/// identical for close and expire.
pub(crate) fn compute_settlement(
    market: &Market,
    config: &MarketConfig,
    pool: &LeveragePool,
    position: &LevPosition,
    now: i64,
    is_expire: bool,
) -> Result<Settlement> {
    require!(!position.settled, AmmError::PositionSettled);

    let idx = usize::from(position.outcome_idx);
    let funding = funding::funding_accrued(
        position.notional,
        pool.cum_funding_index[idx],
        position.funding_index_snap,
    )
    .map_err(|_| AmmError::FundingMath)?;

    let (payout, reason) = match market.state {
        // live exit at the posted mark — must be fresh.
        MarketState::Trading | MarketState::Locked => {
            require!(pool.mark_ts > 0, AmmError::MarkNotPosted);
            require!(
                now.saturating_sub(pool.mark_ts)
                    <= i64::from(config.max_mark_age_secs),
                AmmError::MarkStale
            );
            let p = pool.mark_bps[idx];
            let pnl = funding::pnl(position.units, position.entry_mark_bps, p)
                .map_err(|_| AmmError::FundingMath)?;
            (
                funding::settle_payout(position.collateral, pnl, funding),
                if is_expire { 1 } else { 0 },
            )
        }
        MarketState::Resolved => match market.outcome {
            // D-4 mirror: pnl = 0, basis refund net of funding.
            Outcome::Void => (
                funding::settle_payout(position.collateral, 0, funding),
                3,
            ),
            Outcome::Team1 | Outcome::Draw | Outcome::Team2 => {
                let win_idx = match market.outcome {
                    Outcome::Team1 => 0usize,
                    Outcome::Draw => 1,
                    _ => 2,
                };
                let p = if idx == win_idx { BPS_DENOM as u16 } else { 0 };
                let pnl = funding::pnl(position.units, position.entry_mark_bps, p)
                    .map_err(|_| AmmError::FundingMath)?;
                (funding::settle_payout(position.collateral, pnl, funding), 2)
            }
            Outcome::Unset => return err!(AmmError::InvalidMarketState),
        },
        _ => return err!(AmmError::InvalidMarketState),
    };

    Ok(Settlement {
        payout,
        funding,
        reason,
    })
}

#[derive(Accounts)]
pub struct CloseLeverage<'info> {
    #[account(mut)]
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
        close = owner,
        seeds = [LEV_POSITION_SEED, market.key().as_ref(), owner.key().as_ref()],
        bump = lev_position.bump,
        constraint = lev_position.owner == owner.key() @ AmmError::Unauthorized,
        constraint = lev_position.market == market.key() @ AmmError::Unauthorized,
    )]
    pub lev_position: Box<Account<'info, LevPosition>>,

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

pub(crate) fn handler(ctx: Context<CloseLeverage>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;

    let settlement = compute_settlement(
        &ctx.accounts.market,
        &ctx.accounts.market_config,
        &ctx.accounts.pool,
        &ctx.accounts.lev_position,
        now,
        false,
    )?;

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

    // ---- interaction: lev vault -> owner, signed by the pool PDA.
    //      NO cap at vault.amount: if the vault cannot pay, the transfer
    //      fails loudly (solvency is coverage-guarded; never haircut). ----
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
        owner: ctx.accounts.owner.key(),
        payout: settlement.payout,
        funding_paid: settlement.funding,
        reason: settlement.reason,
    });
    Ok(())
}

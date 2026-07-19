//! `post_mark(marks)` — keeper-gated mark update + cumulative-funding-index
//! accrual (leverage-v1.md §1/§4, Drift pattern).
//!
//! The elapsed segment `[last_funding_ts, now]` is priced at the PREVIOUS
//! stored marks (they were the prices in force), THEN the new marks are
//! stored. First post (`mark_ts == 0`) initializes without accrual.
//! `idx_delta` floors `t_remaining` at `MIN_T_REMAINING_SECS` internally, so
//! the raw `freeze_ts − now` is passed through. The valve multiplier applies
//! only while `now < valve_until_ts` (neutral `BPS_DENOM` otherwise).

use anchor_lang::prelude::*;

use crate::constants::{BPS_DENOM, CONFIG_SEED, LEV_POOL_SEED, MARKET_SEED};
use crate::error::AmmError;
use crate::funding;
use crate::state::{GlobalConfig, LeveragePool, Market, MarkPosted, MarketConfig};

#[derive(Accounts)]
pub struct PostMark<'info> {
    pub keeper: Signer<'info>,

    #[account(
        seeds = [CONFIG_SEED],
        bump = global.bump,
        // keeper gate (D-1): signer must be the stored keeper
        constraint = global.keeper == keeper.key() @ AmmError::Unauthorized,
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
        mut,
        seeds = [LEV_POOL_SEED, market.key().as_ref()],
        bump = pool.bump,
    )]
    pub pool: Box<Account<'info, LeveragePool>>,
}

pub(crate) fn handler(ctx: Context<PostMark>, marks: [u16; 3]) -> Result<()> {
    // each mark must be an interior price: 1..=BPS-1.
    for &m in marks.iter() {
        require!(
            m >= 1 && u64::from(m) < BPS_DENOM,
            AmmError::MarkOutOfRange
        );
    }

    let now = Clock::get()?.unix_timestamp;
    let pool = &mut ctx.accounts.pool;

    if pool.mark_ts > 0 {
        // accrue the elapsed segment at the PREVIOUS marks.
        require!(now >= pool.last_funding_ts, AmmError::MonotonicClock);
        let elapsed = now - pool.last_funding_ts;
        // raw t_remaining; idx_delta floors at MIN_T_REMAINING_SECS internally.
        let t_remaining = ctx.accounts.market.freeze_ts.saturating_sub(now);
        let multiplier = if now < pool.valve_until_ts {
            pool.valve_multiplier_bps
        } else {
            BPS_DENOM as u16
        };
        for i in 0..3 {
            let delta = funding::idx_delta(
                ctx.accounts.market_config.time_fee_num,
                pool.mark_bps[i],
                elapsed,
                t_remaining,
                multiplier,
            )
            .map_err(|_| AmmError::FundingMath)?;
            pool.cum_funding_index[i] = pool.cum_funding_index[i]
                .checked_add(delta)
                .ok_or(AmmError::MathOverflow)?;
        }
    }

    pool.mark_bps = marks;
    pool.mark_ts = now;
    pool.last_funding_ts = now;

    emit!(MarkPosted {
        market: ctx.accounts.market.key(),
        marks,
        idx: pool.cum_funding_index,
    });
    Ok(())
}

//! `freeze_market` — keeper-gated (D-1), clock-guarded `Trading → Locked`
//! transition; trading halts (plan §4.4).

use anchor_lang::prelude::*;

use crate::constants::{CONFIG_SEED, MARKET_SEED};
use crate::error::AmmError;
use crate::state::{GlobalConfig, Market, MarketFrozen, MarketState};

#[derive(Accounts)]
pub struct FreezeMarket<'info> {
    pub keeper: Signer<'info>,

    #[account(
        seeds = [CONFIG_SEED],
        bump = global.bump,
        // keeper gate (D-1): signer must be the stored keeper
        constraint = global.keeper == keeper.key() @ AmmError::Unauthorized,
    )]
    pub global: Box<Account<'info, GlobalConfig>>,

    #[account(
        mut,
        seeds = [MARKET_SEED, &market.fixture_id.to_le_bytes()],
        bump = market.bump,
    )]
    pub market: Box<Account<'info, Market>>,
}

pub(crate) fn handler(ctx: Context<FreezeMarket>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let market = &mut ctx.accounts.market;

    require!(market.state == MarketState::Trading, AmmError::InvalidMarketState);
    require!(now >= market.freeze_ts, AmmError::FreezeNotReached);

    market.state = MarketState::Locked;

    emit!(MarketFrozen { fixture_id: market.fixture_id, ts: now });
    Ok(())
}

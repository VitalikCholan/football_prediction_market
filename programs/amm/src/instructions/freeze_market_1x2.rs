//! `freeze_market_1x2` — keeper-gated (D-1), clock-guarded `Trading → Locked`
//! transition for a 1X2 market; trading halts (mirror of `freeze_market`).

use anchor_lang::prelude::*;

use crate::constants::{CONFIG_SEED, MARKET_1X2_SEED};
use crate::error::AmmError;
use crate::state::{GlobalConfig, Market1x2, Market1x2Frozen, MarketState};

#[derive(Accounts)]
pub struct FreezeMarket1x2<'info> {
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
        seeds = [MARKET_1X2_SEED, &market.fixture_id.to_le_bytes()],
        bump = market.bump,
    )]
    pub market: Box<Account<'info, Market1x2>>,
}

pub(crate) fn handler(ctx: Context<FreezeMarket1x2>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let market = &mut ctx.accounts.market;

    require!(market.state == MarketState::Trading, AmmError::InvalidMarketState);
    require!(now >= market.freeze_ts, AmmError::FreezeNotReached);

    market.state = MarketState::Locked;

    emit!(Market1x2Frozen { fixture_id: market.fixture_id, ts: now });
    Ok(())
}

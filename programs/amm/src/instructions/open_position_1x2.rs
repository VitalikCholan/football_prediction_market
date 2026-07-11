//! `open_position_1x2` — explicit, one-time init of a trader's `Position1x2`
//! PDA (D-3). NO `init_if_needed`. `buy_1x2`/`sell_1x2` require an
//! already-created position.

use anchor_lang::prelude::*;

use crate::constants::{MARKET_1X2_SEED, POSITION_1X2_SEED};
use crate::state::{Market1x2, Position1x2};

#[derive(Accounts)]
pub struct OpenPosition1x2<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        seeds = [MARKET_1X2_SEED, &market.fixture_id.to_le_bytes()],
        bump = market.bump,
    )]
    pub market: Box<Account<'info, Market1x2>>,

    #[account(
        init,
        payer = owner,
        space = 8 + Position1x2::INIT_SPACE,
        seeds = [POSITION_1X2_SEED, market.key().as_ref(), owner.key().as_ref()],
        bump,
    )]
    pub position: Box<Account<'info, Position1x2>>,

    pub system_program: Program<'info, System>,
}

pub(crate) fn handler(ctx: Context<OpenPosition1x2>) -> Result<()> {
    let position = &mut ctx.accounts.position;
    position.market = ctx.accounts.market.key();
    position.owner = ctx.accounts.owner.key();
    position.tokens = [0u64; 3];
    position.collateral = 0;
    position.redeemed = false;
    position.bump = ctx.bumps.position;
    position._reserved = [0u8; 32];
    Ok(())
}

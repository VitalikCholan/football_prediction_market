//! `open_position` — explicit, one-time init of a trader's `Position` PDA (D-3).
//! NO `init_if_needed`. `buy`/`sell` require an already-created position.

use anchor_lang::prelude::*;

use crate::constants::{MARKET_SEED, POSITION_SEED};
use crate::state::{Market, Position};

#[derive(Accounts)]
pub struct OpenPosition<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        seeds = [MARKET_SEED, &market.fixture_id.to_le_bytes()],
        bump = market.bump,
    )]
    pub market: Box<Account<'info, Market>>,

    #[account(
        init,
        payer = owner,
        space = 8 + Position::INIT_SPACE,
        seeds = [POSITION_SEED, market.key().as_ref(), owner.key().as_ref()],
        bump,
    )]
    pub position: Box<Account<'info, Position>>,

    pub system_program: Program<'info, System>,
}

pub(crate) fn handler(ctx: Context<OpenPosition>) -> Result<()> {
    let position = &mut ctx.accounts.position;
    position.market = ctx.accounts.market.key();
    position.owner = ctx.accounts.owner.key();
    position.yes_tokens = 0;
    position.no_tokens = 0;
    position.collateral = 0;
    position.leverage = 1; // v0: pure FPMM, no leverage
    position.notional = 0;
    position.entry_slot = 0;
    position.fee_rate_snapshot = 0;
    position.redeemed = false;
    position.bump = ctx.bumps.position;
    position._reserved = [0u8; 16];
    Ok(())
}

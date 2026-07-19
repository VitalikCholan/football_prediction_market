//! `open_lp_account` — explicit, one-time init of an LP's `LpAccount`
//! PDA (D-3 pattern; mirrors `open_position`). NO `init_if_needed`.
//! `deposit_lp`/`request_withdraw`/`withdraw_lp` require an
//! already-created LP account.

use anchor_lang::prelude::*;

use crate::constants::{LEV_LP_SEED, MARKET_SEED};
use crate::state::{LpAccount, Market};

#[derive(Accounts)]
pub struct OpenLpAccount<'info> {
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
        space = 8 + LpAccount::INIT_SPACE,
        seeds = [LEV_LP_SEED, market.key().as_ref(), owner.key().as_ref()],
        bump,
    )]
    pub lp_account: Box<Account<'info, LpAccount>>,

    pub system_program: Program<'info, System>,
}

pub(crate) fn handler(ctx: Context<OpenLpAccount>) -> Result<()> {
    let lp = &mut ctx.accounts.lp_account;
    lp.market = ctx.accounts.market.key();
    lp.owner = ctx.accounts.owner.key();
    lp.shares = 0;
    lp.pending_shares = 0;
    lp.unlock_ts = 0;
    lp.bump = ctx.bumps.lp_account;
    lp._reserved = [0u8; 16];
    Ok(())
}

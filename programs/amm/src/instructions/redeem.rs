//! `redeem` — pay out a resolved market position (plan §4.8).
//!
//! - Winner: 1 winning token = 1 USDT (both 6 dp).
//! - Loser: payout 0 (position still closed + flagged).
//! - `Outcome::Void`: pro-rata stake refund per D-4 — refund the position's
//!   net USDT basis (`Position.collateral`), clamped to the market's remaining
//!   collateral (pool-favorable; guards the extreme case where realized sell
//!   profits exceeded the seed liquidity).
//!
//! Double-redeem defense: balances are ZEROED and the `redeemed` flag set
//! BEFORE the payout CPI (checks-effects-interactions), plus the state gate.

use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    self, Mint, TokenAccount, TokenInterface, TransferChecked,
};

use crate::constants::{MARKET_SEED, POSITION_SEED};
use crate::error::AmmError;
use crate::state::{Market, MarketState, Outcome, Position, Redeemed};

#[derive(Accounts)]
pub struct Redeem<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        mut,
        seeds = [MARKET_SEED, &market.fixture_id.to_le_bytes()],
        bump = market.bump,
    )]
    pub market: Box<Account<'info, Market>>,

    #[account(
        mut,
        seeds = [POSITION_SEED, market.key().as_ref(), owner.key().as_ref()],
        bump = position.bump,
        constraint = position.owner == owner.key() @ AmmError::Unauthorized,
        constraint = position.market == market.key() @ AmmError::Unauthorized,
    )]
    pub position: Box<Account<'info, Position>>,

    #[account(mut, address = market.vault)]
    pub vault: Box<InterfaceAccount<'info, TokenAccount>>,

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

pub(crate) fn handler(ctx: Context<Redeem>) -> Result<()> {
    // ---- gates ----
    require!(
        ctx.accounts.market.state == MarketState::Resolved,
        AmmError::InvalidMarketState
    );
    require!(!ctx.accounts.position.redeemed, AmmError::AlreadyRedeemed);

    let outcome = ctx.accounts.market.outcome;
    let payout = match outcome {
        Outcome::Yes => ctx.accounts.position.yes_tokens,
        Outcome::No => ctx.accounts.position.no_tokens,
        // D-4: refund net stake, clamped pool-favorably to what's tracked.
        Outcome::Void => ctx
            .accounts
            .position
            .collateral
            .min(ctx.accounts.market.usdt_collateral),
        Outcome::Unset => return err!(AmmError::InvalidMarketState),
    };

    // capture for signing/event before the mutable borrows
    let fixture_id = ctx.accounts.market.fixture_id;
    let market_bump = ctx.accounts.market.bump;

    // ---- effects FIRST: zero balances, flag, decrement supplies ----
    let (yes_bal, no_bal) = {
        let position = &mut ctx.accounts.position;
        let yes_bal = position.yes_tokens;
        let no_bal = position.no_tokens;
        position.yes_tokens = 0;
        position.no_tokens = 0;
        position.collateral = 0;
        position.redeemed = true;
        (yes_bal, no_bal)
    };
    {
        let market = &mut ctx.accounts.market;
        market.yes_supply = market
            .yes_supply
            .checked_sub(yes_bal)
            .ok_or(AmmError::MathOverflow)?;
        market.no_supply = market
            .no_supply
            .checked_sub(no_bal)
            .ok_or(AmmError::MathOverflow)?;
        market.usdt_collateral = market
            .usdt_collateral
            .checked_sub(payout)
            .ok_or(AmmError::MathOverflow)?;
    }

    // ---- interaction: vault -> owner_usdt, signed by the market PDA ----
    if payout > 0 {
        let decimals = ctx.accounts.usdt_mint.decimals;
        let fixture_le = fixture_id.to_le_bytes();
        let signer_seeds: &[&[&[u8]]] = &[&[MARKET_SEED, &fixture_le, &[market_bump]]];

        let cpi_accounts = TransferChecked {
            from: ctx.accounts.vault.to_account_info(),
            mint: ctx.accounts.usdt_mint.to_account_info(),
            to: ctx.accounts.owner_usdt.to_account_info(),
            authority: ctx.accounts.market.to_account_info(),
        };
        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),
            cpi_accounts,
            signer_seeds,
        );
        token_interface::transfer_checked(cpi_ctx, payout, decimals)?;
    }

    emit!(Redeemed {
        fixture_id,
        owner: ctx.accounts.owner.key(),
        outcome,
        payout,
    });
    Ok(())
}

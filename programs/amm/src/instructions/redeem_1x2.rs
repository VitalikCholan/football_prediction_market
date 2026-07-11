//! `redeem_1x2` — pay out a resolved 1X2 position (SPEC §3.1 phase C; mirror
//! of `redeem`).
//!
//! - Winning outcome: 1 token = 1 USDT (both 6 dp). Losers pay 0.
//! - `Outcome1x2::Void`: pro-rata net-basis refund per D-4
//!   (`Position1x2.collateral`, clamped to the market's remaining collateral).
//!
//! Double-redeem defense: all three balances are ZEROED and the `redeemed`
//! flag set BEFORE the payout CPI (checks-effects-interactions) + state gate.

use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    self, Mint, TokenAccount, TokenInterface, TransferChecked,
};

use crate::constants::{MARKET_1X2_SEED, POSITION_1X2_SEED};
use crate::error::AmmError;
use crate::state::{Market1x2, MarketState, Outcome1x2, Position1x2, Redeemed1x2};

#[derive(Accounts)]
pub struct Redeem1x2<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        mut,
        seeds = [MARKET_1X2_SEED, &market.fixture_id.to_le_bytes()],
        bump = market.bump,
    )]
    pub market: Box<Account<'info, Market1x2>>,

    #[account(
        mut,
        seeds = [POSITION_1X2_SEED, market.key().as_ref(), owner.key().as_ref()],
        bump = position.bump,
        constraint = position.owner == owner.key() @ AmmError::Unauthorized,
        constraint = position.market == market.key() @ AmmError::Unauthorized,
    )]
    pub position: Box<Account<'info, Position1x2>>,

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

pub(crate) fn handler(ctx: Context<Redeem1x2>) -> Result<()> {
    // ---- gates ----
    require!(
        ctx.accounts.market.state == MarketState::Resolved,
        AmmError::InvalidMarketState
    );
    require!(!ctx.accounts.position.redeemed, AmmError::AlreadyRedeemed);

    let outcome = ctx.accounts.market.outcome;
    let payout = match outcome {
        Outcome1x2::Team1 => ctx.accounts.position.tokens[0],
        Outcome1x2::Draw => ctx.accounts.position.tokens[1],
        Outcome1x2::Team2 => ctx.accounts.position.tokens[2],
        // D-4: refund net stake, clamped pool-favorably to what's tracked.
        Outcome1x2::Void => ctx
            .accounts
            .position
            .collateral
            .min(ctx.accounts.market.usdt_collateral),
        Outcome1x2::Unset => return err!(AmmError::InvalidMarketState),
    };

    // capture for signing/event before the mutable borrows
    let fixture_id = ctx.accounts.market.fixture_id;
    let market_bump = ctx.accounts.market.bump;

    // ---- effects FIRST: zero balances, flag, decrement supplies ----
    let balances = {
        let position = &mut ctx.accounts.position;
        let balances = position.tokens;
        position.tokens = [0u64; 3];
        position.collateral = 0;
        position.redeemed = true;
        balances
    };
    {
        let market = &mut ctx.accounts.market;
        for (supply, bal) in market.supply.iter_mut().zip(balances.iter()) {
            *supply = supply.checked_sub(*bal).ok_or(AmmError::MathOverflow)?;
        }
        market.usdt_collateral = market
            .usdt_collateral
            .checked_sub(payout)
            .ok_or(AmmError::MathOverflow)?;
    }

    // ---- interaction: vault -> owner_usdt, signed by the market PDA ----
    if payout > 0 {
        let decimals = ctx.accounts.usdt_mint.decimals;
        let fixture_le = fixture_id.to_le_bytes();
        let signer_seeds: &[&[&[u8]]] = &[&[MARKET_1X2_SEED, &fixture_le, &[market_bump]]];

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

    emit!(Redeemed1x2 {
        fixture_id,
        owner: ctx.accounts.owner.key(),
        outcome,
        payout,
    });
    Ok(())
}

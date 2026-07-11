//! `redeem_set_1x2(amount)` — burn a COMPLETE SET back to par: burn `amount`
//! base-unit tokens of EVERY outcome {Team1, Draw, Team2}, receive EXACTLY
//! `amount` USDT (SPEC §3.1 phase C-add). The exact inverse of `mint_set_1x2`.
//!
//! A complete set is worth exactly `amount` USDT (one guaranteed winner at
//! resolution), so burning one pays the flat `amount` — fee-free, slippage-free,
//! price-neutral. See `mint_set_1x2` for the full rationale.
//!
//! ## Posture (inverse of mint_set)
//!
//! * Requires `position.tokens[i] >= amount` for ALL three i.
//! * `q[i] -= amount` and `supply[i] -= amount` for all i → prices UNCHANGED
//!   (equal shift, softmax shift-invariance) and the `q = seed_q + supply`
//!   invariant preserved.
//! * **NO dynamic fee** (directionally neutral).
//! * `collateral -= amount` (saturating, mirroring `sell_1x2`'s basis reduction)
//!   so a later Void refund basis stays correct.
//! * **Checks-effects-interactions**: decrement position balances, supply, and
//!   collateral BEFORE the PDA-signed payout CPI.
//! * Solvency re-checked at the tail (vault and every supply both fell by
//!   `amount`; belt, mirrors buy/sell/redeem).
//!
//! State gate: `Trading` only (v0 simplicity — a par exit before resolution
//! lives in the same window as buy/sell; `Locked`/`Resolved` exits go through
//! `resolve` + `redeem_1x2`). Position must already exist.

use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    self, Mint, TokenAccount, TokenInterface, TransferChecked,
};

use crate::constants::{MARKET_1X2_SEED, POSITION_1X2_SEED};
use crate::error::AmmError;
use crate::lmsr;
use crate::math;
use crate::state::{Market1x2, MarketState, Position1x2, SetRedeemed1x2};

#[derive(Accounts)]
pub struct RedeemSet1x2<'info> {
    #[account(mut)]
    pub trader: Signer<'info>,

    #[account(
        mut,
        seeds = [MARKET_1X2_SEED, &market.fixture_id.to_le_bytes()],
        bump = market.bump,
    )]
    pub market: Box<Account<'info, Market1x2>>,

    #[account(
        mut,
        seeds = [POSITION_1X2_SEED, market.key().as_ref(), trader.key().as_ref()],
        bump = position.bump,
        constraint = position.owner == trader.key() @ AmmError::Unauthorized,
        constraint = position.market == market.key() @ AmmError::Unauthorized,
    )]
    pub position: Box<Account<'info, Position1x2>>,

    #[account(
        mut,
        token::mint = usdt_mint,
        token::authority = trader,
        token::token_program = token_program,
    )]
    pub trader_usdt: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(mut, address = market.vault)]
    pub vault: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(address = market.usdt_mint)]
    pub usdt_mint: Box<InterfaceAccount<'info, Mint>>,

    pub token_program: Interface<'info, TokenInterface>,
}

pub(crate) fn handler(ctx: Context<RedeemSet1x2>, amount: u64) -> Result<()> {
    // ---- gates ----
    require!(
        ctx.accounts.market.state == MarketState::Trading,
        AmmError::InvalidMarketState
    );
    require!(amount > 0, AmmError::ZeroAmount);
    for i in 0..lmsr::N_OUTCOMES {
        require!(
            ctx.accounts.position.tokens[i] >= amount,
            AmmError::InsufficientPositionBalance
        );
    }

    // capture for signing/event before the mutable borrow chain
    let fixture_id = ctx.accounts.market.fixture_id;
    let market_bump = ctx.accounts.market.bump;

    // ---- effects FIRST (checks-effects-interactions) ----
    {
        let market = &mut ctx.accounts.market;
        for i in 0..lmsr::N_OUTCOMES {
            // q = seed_q + supply invariant preserved: both -= amount.
            market.q[i] = market.q[i]
                .checked_sub(amount)
                .ok_or(AmmError::MathOverflow)?;
            market.supply[i] = market.supply[i]
                .checked_sub(amount)
                .ok_or(AmmError::MathOverflow)?;
        }
        market.usdt_collateral = market
            .usdt_collateral
            .checked_sub(amount)
            .ok_or(AmmError::MathOverflow)?;
    }
    {
        let position = &mut ctx.accounts.position;
        for i in 0..lmsr::N_OUTCOMES {
            position.tokens[i] = position.tokens[i]
                .checked_sub(amount)
                .ok_or(AmmError::MathOverflow)?;
        }
        // reduce the trader's basis by the par value returned (saturating; ≥ 0).
        position.collateral = position.collateral.saturating_sub(amount);
    }

    // ---- interaction: pay EXACTLY `amount` USDT, vault -> trader, PDA-signed ----
    let decimals = ctx.accounts.usdt_mint.decimals;
    let fixture_le = fixture_id.to_le_bytes();
    let signer_seeds: &[&[&[u8]]] = &[&[MARKET_1X2_SEED, &fixture_le, &[market_bump]]];

    let cpi_accounts = TransferChecked {
        from: ctx.accounts.vault.to_account_info(),
        mint: ctx.accounts.usdt_mint.to_account_info(),
        to: ctx.accounts.trader_usdt.to_account_info(),
        authority: ctx.accounts.market.to_account_info(),
    };
    let cpi_ctx = CpiContext::new_with_signer(
        ctx.accounts.token_program.key(),
        cpi_accounts,
        signer_seeds,
    );
    token_interface::transfer_checked(cpi_ctx, amount, decimals)?;

    // ---- re-validate solvency ----
    ctx.accounts.vault.reload()?;
    let market = &ctx.accounts.market;
    math::assert_solvent_multi(ctx.accounts.vault.amount, &market.supply)?;

    emit!(SetRedeemed1x2 {
        fixture_id,
        owner: ctx.accounts.trader.key(),
        amount,
    });
    Ok(())
}

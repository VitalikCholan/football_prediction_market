//! `mint_set(amount)` — mint a COMPLETE SET of the 3-way market: deposit
//! EXACTLY `amount` USDT, receive `amount` base-unit tokens of every outcome
//! {Team1, Draw, Team2} (SPEC §3.1 phase C-add).
//!
//! ## Why a set is worth exactly `amount`, always
//!
//! At resolution exactly one outcome pays 1 USDT per winning base-unit token;
//! the other two pay 0. A complete set therefore redeems for EXACTLY `amount`
//! USDT regardless of the outcome (one guaranteed winner) — it is definitionally
//! face value. So the trader is charged the flat `amount`, NOT the approximate
//! LMSR `cost` (the LMSR identity `cost(q + [c,c,c]) − cost(q) = c` confirms
//! this is curve-consistent; we charge the exact `amount` to avoid ±1-unit
//! rounding of the approximated cost).
//!
//! ## Price / fee / solvency posture
//!
//! * **Prices UNCHANGED** — an equal shift of all three `q_i` cancels in the
//!   softmax (`lmsr::prices_bps` shift-invariance). A set is directionally
//!   neutral, so there is **NO dynamic fee** (no adverse selection to defend).
//! * **q/supply invariant** — phase-C keeps `q[i] = seed_q[i] + supply[i]`
//!   (buy/sell move both by the same delta; init sets `q = seed_q, supply = 0`).
//!   A set adds `amount` to ALL THREE `supply[i]` AND ALL THREE `q[i]`, so the
//!   invariant holds and the shift is equal across outcomes (prices fixed).
//! * **Solvency preserved trivially** — vault and every `supply[i]` both rise by
//!   `amount`, so `max(supply)` and the vault move together; we still call
//!   `lmsr::assert_solvent_multi` at the tail (belt, mirrors buy/sell).
//! * **`collateral` (D-4 Void basis)** — add `amount` (net USDT basis in),
//!   mirroring how `buy` adds the gross USDT deposited.
//!
//! State gate: `Trading` only (mirror buy/sell). Position must already exist.

use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    self, Mint, TokenAccount, TokenInterface, TransferChecked,
};

use crate::constants::{MARKET_SEED, POSITION_SEED};
use crate::error::AmmError;
use crate::lmsr;
use crate::state::{Market, MarketState, Position, SetMinted};

#[derive(Accounts)]
pub struct MintSet<'info> {
    #[account(mut)]
    pub trader: Signer<'info>,

    #[account(
        mut,
        seeds = [MARKET_SEED, &market.fixture_id.to_le_bytes()],
        bump = market.bump,
    )]
    pub market: Box<Account<'info, Market>>,

    #[account(
        mut,
        seeds = [POSITION_SEED, market.key().as_ref(), trader.key().as_ref()],
        bump = position.bump,
        constraint = position.owner == trader.key() @ AmmError::Unauthorized,
        constraint = position.market == market.key() @ AmmError::Unauthorized,
    )]
    pub position: Box<Account<'info, Position>>,

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

pub(crate) fn handler(ctx: Context<MintSet>, amount: u64) -> Result<()> {
    let market = &mut ctx.accounts.market;

    require!(market.state == MarketState::Trading, AmmError::InvalidMarketState);
    require!(amount > 0, AmmError::ZeroAmount);

    // ---- update curve + supply (equal shift → prices UNCHANGED) ----
    // q[i] = seed_q[i] + supply[i] invariant preserved: both += amount.
    // Q_MAX cap enforced on q (mirrors buy's LmsrQuantityTooLarge posture).
    for i in 0..lmsr::N_OUTCOMES {
        let new_q = market.q[i]
            .checked_add(amount)
            .ok_or(AmmError::MathOverflow)?;
        require!(new_q <= lmsr::Q_MAX, AmmError::LmsrQuantityTooLarge);
        market.q[i] = new_q;
        market.supply[i] = market.supply[i]
            .checked_add(amount)
            .ok_or(AmmError::MathOverflow)?;
    }

    // ---- credit position: +amount of EVERY outcome; +amount net basis ----
    let position = &mut ctx.accounts.position;
    for i in 0..lmsr::N_OUTCOMES {
        position.tokens[i] = position.tokens[i]
            .checked_add(amount)
            .ok_or(AmmError::MathOverflow)?;
    }
    position.collateral = position
        .collateral
        .checked_add(amount)
        .ok_or(AmmError::MathOverflow)?;

    // ---- deposit EXACTLY `amount` USDT: trader_usdt -> vault (trader signs) ----
    let decimals = ctx.accounts.usdt_mint.decimals;
    let before = ctx.accounts.vault.amount;
    let cpi_accounts = TransferChecked {
        from: ctx.accounts.trader_usdt.to_account_info(),
        mint: ctx.accounts.usdt_mint.to_account_info(),
        to: ctx.accounts.vault.to_account_info(),
        authority: ctx.accounts.trader.to_account_info(),
    };
    let cpi_ctx = CpiContext::new(ctx.accounts.token_program.key(), cpi_accounts);
    token_interface::transfer_checked(cpi_ctx, amount, decimals)?;

    ctx.accounts.vault.reload()?;
    let credited = ctx
        .accounts
        .vault
        .amount
        .checked_sub(before)
        .ok_or(AmmError::MathOverflow)?;
    market.usdt_collateral = market
        .usdt_collateral
        .checked_add(credited)
        .ok_or(AmmError::MathOverflow)?;

    // ---- re-validate solvency: vault ≥ max_i(supply_i) (belt) ----
    lmsr::assert_solvent_multi(ctx.accounts.vault.amount, &market.supply)?;

    emit!(SetMinted {
        fixture_id: market.fixture_id,
        owner: ctx.accounts.trader.key(),
        amount,
    });
    Ok(())
}

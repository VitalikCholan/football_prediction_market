//! `buy_1x2(outcome, usdt_in, min_tokens_out)` — dynamic fee → LMSR
//! delta-for-cost solve → credit position → deposit USDT → re-validate
//! solvency (SPEC §3.1 phase C; mirrors `buy`'s security posture).
//!
//! Flow: fee is charged on `usdt_in` (volatility measured on the traded
//! outcome's price move, `fee.rs` unchanged); the net amount buys the LARGEST
//! `delta` with `buy_cost(q, b, outcome, delta) ≤ net` (bracketed binary
//! search, `lmsr::buy_delta_for_cost`, ≤ 61 cost evaluations — callers should
//! request a raised CU limit for large trades). The whole `usdt_in` enters
//! the vault (fee + any sub-token remainder stay with the pool —
//! pool-favorable, mirroring the binary CPMM).

use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    self, Mint, TokenAccount, TokenInterface, TransferChecked,
};

use crate::constants::{BPS_DENOM, MARKET_1X2_SEED, POSITION_1X2_SEED};
use crate::error::AmmError;
use crate::fee::{self, FeeParams, FeeState};
use crate::lmsr;
use crate::math;
use crate::state::{Market1x2, MarketConfig, MarketState, Position1x2, Trade1x2};

#[derive(Accounts)]
pub struct Buy1x2<'info> {
    #[account(mut)]
    pub trader: Signer<'info>,

    #[account(
        mut,
        seeds = [MARKET_1X2_SEED, &market.fixture_id.to_le_bytes()],
        bump = market.bump,
        constraint = market.config == market_config.key() @ AmmError::Unauthorized,
    )]
    pub market: Box<Account<'info, Market1x2>>,

    #[account(address = market.config)]
    pub market_config: Box<Account<'info, MarketConfig>>,

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

pub(crate) fn handler(
    ctx: Context<Buy1x2>,
    outcome: u8,
    usdt_in: u64,
    min_tokens_out: u64,
) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let market = &mut ctx.accounts.market;

    require!(market.state == MarketState::Trading, AmmError::InvalidMarketState);
    require!(usdt_in > 0, AmmError::ZeroAmount);
    require!(now >= market.last_ts, AmmError::MonotonicClock);
    let idx = usize::from(outcome);
    require!(idx < lmsr::N_OUTCOMES, AmmError::LmsrInvalidOutcomeIndex);

    // ---- dynamic fee from pre-trade state (fee.rs reused verbatim) ----
    let mc = &ctx.accounts.market_config;
    let params = FeeParams {
        base_fee_bps: mc.base_fee_bps,
        max_fee_bps: mc.max_fee_bps,
        vfc_num: mc.vfc_num,
        filter_period: mc.filter_period,
        decay_period: mc.decay_period,
        reduction_bps: mc.reduction_bps,
        max_v_acc: mc.max_v_acc,
    };
    let state = FeeState {
        last_price_bps: market.last_price_bps,
        last_ts: market.last_ts,
        v_acc: market.v_acc,
    };
    let (fee_bps, v_ref) = fee::compute_fee_bps(&params, &state, now)?;

    // net = usdt_in * (10_000 - fee_bps) / 10_000
    let net = (usdt_in as u128)
        .checked_mul((BPS_DENOM - fee_bps as u64) as u128)
        .ok_or(AmmError::MathOverflow)?
        .checked_div(BPS_DENOM as u128)
        .ok_or(AmmError::DivideByZero)?;
    let amount_in_net = u64::try_from(net).map_err(|_| AmmError::NumericConversion)?;
    require!(amount_in_net > 0, AmmError::ZeroAmount);

    // ---- LMSR delta-for-cost solve: largest delta affordable with `net` ----
    let delta = lmsr::buy_delta_for_cost(&market.q, market.b, idx, amount_in_net)?;
    require!(delta > 0, AmmError::SlippageExceeded);
    require!(delta >= min_tokens_out, AmmError::SlippageExceeded);

    // ---- update curve + supply + fee state ----
    market.q[idx] = market.q[idx].checked_add(delta).ok_or(AmmError::MathOverflow)?;
    market.supply[idx] = market.supply[idx]
        .checked_add(delta)
        .ok_or(AmmError::MathOverflow)?;
    let new_price_bps = lmsr::price_bps(&market.q, market.b, idx)?;
    market.v_acc = fee::next_v_acc(&params, v_ref, market.last_price_bps, new_price_bps)?;
    market.last_price_bps = new_price_bps;
    market.last_ts = now;

    // ---- credit position ----
    let position = &mut ctx.accounts.position;
    position.tokens[idx] = position.tokens[idx]
        .checked_add(delta)
        .ok_or(AmmError::MathOverflow)?;
    position.collateral = position
        .collateral
        .checked_add(usdt_in)
        .ok_or(AmmError::MathOverflow)?;

    // ---- deposit USDT: trader_usdt -> vault (trader signs, plain CPI) ----
    let decimals = ctx.accounts.usdt_mint.decimals;
    let before = ctx.accounts.vault.amount;
    let cpi_accounts = TransferChecked {
        from: ctx.accounts.trader_usdt.to_account_info(),
        mint: ctx.accounts.usdt_mint.to_account_info(),
        to: ctx.accounts.vault.to_account_info(),
        authority: ctx.accounts.trader.to_account_info(),
    };
    let cpi_ctx = CpiContext::new(ctx.accounts.token_program.key(), cpi_accounts);
    token_interface::transfer_checked(cpi_ctx, usdt_in, decimals)?;

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

    // ---- re-validate solvency: vault ≥ max_i(supply_i) ----
    math::assert_solvent_multi(ctx.accounts.vault.amount, &market.supply)?;

    emit!(Trade1x2 {
        fixture_id: market.fixture_id,
        owner: ctx.accounts.trader.key(),
        outcome,
        is_buy: true,
        usdt: usdt_in,
        tokens: delta,
        price_bps: new_price_bps,
        fee_bps,
    });
    Ok(())
}

//! `sell_1x2(outcome, tokens_in, min_usdt_out)` — inverse of `buy_1x2`:
//! LMSR refund (`sell_refund`, floor-rounded) → fee on the refund → vault
//! pays out signed by the `market` PDA → re-validate solvency (SPEC §3.1
//! phase C; mirrors `sell`'s security posture).

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
pub struct Sell1x2<'info> {
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
        token::mint = usdc_mint,
        token::authority = trader,
        token::token_program = token_program,
    )]
    pub trader_usdc: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(mut, address = market.vault)]
    pub vault: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(address = market.usdc_mint)]
    pub usdc_mint: Box<InterfaceAccount<'info, Mint>>,

    pub token_program: Interface<'info, TokenInterface>,
}

pub(crate) fn handler(
    ctx: Context<Sell1x2>,
    outcome: u8,
    tokens_in: u64,
    min_usdt_out: u64,
) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let idx = usize::from(outcome);
    require!(idx < lmsr::N_OUTCOMES, AmmError::LmsrInvalidOutcomeIndex);

    // ---- pre-flight validation (borrow immutably first) ----
    {
        let market = &ctx.accounts.market;
        require!(market.state == MarketState::Trading, AmmError::InvalidMarketState);
        require!(tokens_in > 0, AmmError::ZeroAmount);
        require!(now >= market.last_ts, AmmError::MonotonicClock);
    }
    require!(
        ctx.accounts.position.tokens[idx] >= tokens_in,
        AmmError::InsufficientPositionBalance
    );

    // ---- dynamic fee from pre-trade state ----
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
        last_price_bps: ctx.accounts.market.last_price_bps,
        last_ts: ctx.accounts.market.last_ts,
        v_acc: ctx.accounts.market.v_acc,
    };
    let (fee_bps, v_ref) = fee::compute_fee_bps(&params, &state, now)?;

    // ---- LMSR refund (floor-rounded, pool-favorable) ----
    let gross = lmsr::sell_refund(
        &ctx.accounts.market.q,
        ctx.accounts.market.b,
        idx,
        tokens_in,
    )?;

    // usdt_out = gross * (10_000 - fee_bps) / 10_000
    let out = (gross as u128)
        .checked_mul((BPS_DENOM - fee_bps as u64) as u128)
        .ok_or(AmmError::MathOverflow)?
        .checked_div(BPS_DENOM as u128)
        .ok_or(AmmError::DivideByZero)?;
    let usdt_out = u64::try_from(out).map_err(|_| AmmError::NumericConversion)?;
    require!(usdt_out >= min_usdt_out, AmmError::SlippageExceeded);

    // capture fixture_id + bump for signing before the mutable borrow chain
    let fixture_id = ctx.accounts.market.fixture_id;
    let market_bump = ctx.accounts.market.bump;

    // ---- update curve, supply, fee state, position (before payout) ----
    let old_price_bps = ctx.accounts.market.last_price_bps;
    let new_price_bps;
    {
        let market = &mut ctx.accounts.market;
        market.q[idx] = market.q[idx]
            .checked_sub(tokens_in)
            .ok_or(AmmError::MathOverflow)?;
        market.supply[idx] = market.supply[idx]
            .checked_sub(tokens_in)
            .ok_or(AmmError::MathOverflow)?;
        new_price_bps = lmsr::price_bps(&market.q, market.b, idx)?;
        market.v_acc = fee::next_v_acc(&params, v_ref, old_price_bps, new_price_bps)?;
        market.last_price_bps = new_price_bps;
        market.last_ts = now;
        market.usdc_collateral = market
            .usdc_collateral
            .checked_sub(usdt_out)
            .ok_or(AmmError::MathOverflow)?;
    }
    {
        let position = &mut ctx.accounts.position;
        position.tokens[idx] = position.tokens[idx]
            .checked_sub(tokens_in)
            .ok_or(AmmError::MathOverflow)?;
        // reduce the trader's basis by the proceeds (saturating; ≥ 0).
        position.collateral = position.collateral.saturating_sub(usdt_out);
    }

    // ---- payout: vault -> trader_usdc, signed by the market PDA ----
    let decimals = ctx.accounts.usdc_mint.decimals;
    let fixture_le = fixture_id.to_le_bytes();
    let signer_seeds: &[&[&[u8]]] = &[&[MARKET_1X2_SEED, &fixture_le, &[market_bump]]];

    let cpi_accounts = TransferChecked {
        from: ctx.accounts.vault.to_account_info(),
        mint: ctx.accounts.usdc_mint.to_account_info(),
        to: ctx.accounts.trader_usdc.to_account_info(),
        authority: ctx.accounts.market.to_account_info(),
    };
    let cpi_ctx = CpiContext::new_with_signer(
        ctx.accounts.token_program.key(),
        cpi_accounts,
        signer_seeds,
    );
    token_interface::transfer_checked(cpi_ctx, usdt_out, decimals)?;

    // ---- re-validate solvency ----
    ctx.accounts.vault.reload()?;
    let market = &ctx.accounts.market;
    math::assert_solvent_multi(ctx.accounts.vault.amount, &market.supply)?;

    emit!(Trade1x2 {
        fixture_id,
        owner: ctx.accounts.trader.key(),
        outcome,
        is_buy: false,
        usdc: usdt_out,
        tokens: tokens_in,
        price_bps: new_price_bps,
        fee_bps,
    });
    Ok(())
}

//! `buy(side, usdc_in, min_out)` — dynamic fee → CPMM → credit position → deposit
//! USDC → re-validate solvency (plan §4.5).

use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    self, Mint, TokenAccount, TokenInterface, TransferChecked,
};

use crate::constants::{BPS_DENOM, MARKET_SEED, POSITION_SEED};
use crate::error::AmmError;
use crate::fee::{self, FeeParams, FeeState};
use crate::math;
use crate::state::{Market, MarketConfig, MarketState, Position, Side, Trade};

#[derive(Accounts)]
pub struct Buy<'info> {
    #[account(mut)]
    pub trader: Signer<'info>,

    #[account(
        mut,
        seeds = [MARKET_SEED, &market.fixture_id.to_le_bytes()],
        bump = market.bump,
        constraint = market.config == market_config.key() @ AmmError::Unauthorized,
    )]
    pub market: Box<Account<'info, Market>>,

    #[account(address = market.config)]
    pub market_config: Box<Account<'info, MarketConfig>>,

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
    ctx: Context<Buy>,
    side: Side,
    usdc_in: u64,
    min_out: u64,
) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let market = &mut ctx.accounts.market;

    require!(market.state == MarketState::Trading, AmmError::InvalidMarketState);
    require!(usdc_in > 0, AmmError::ZeroAmount);
    require!(now >= market.last_ts, AmmError::MonotonicClock);

    // ---- Step A+B: dynamic fee from pre-trade state ----
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

    // amount_in_after_fee = usdc_in * (10_000 - fee_bps) / 10_000
    let net = (usdc_in as u128)
        .checked_mul((BPS_DENOM - fee_bps as u64) as u128)
        .ok_or(AmmError::MathOverflow)?
        .checked_div(BPS_DENOM as u128)
        .ok_or(AmmError::DivideByZero)?;
    let amount_in_net = u64::try_from(net).map_err(|_| AmmError::NumericConversion)?;
    require!(amount_in_net > 0, AmmError::ZeroAmount);

    // ---- CPMM virtual-reserve swap (D-2): moves the price, mints the tokens ----
    let side_yes = matches!(side, Side::Yes);
    let res = math::buy(side_yes, market.yes_reserve, market.no_reserve, amount_in_net)?;
    require!(res.tokens_out >= min_out, AmmError::SlippageExceeded);

    // ---- update reserves + fee state ----
    market.yes_reserve = res.new_yes_reserve;
    market.no_reserve = res.new_no_reserve;
    let new_price_bps = math::price_yes_bps(market.yes_reserve, market.no_reserve)?;
    market.v_acc = fee::next_v_acc(&params, v_ref, market.last_price_bps, new_price_bps)?;
    market.last_price_bps = new_price_bps;
    market.last_ts = now;

    // ---- credit position + supply ----
    let position = &mut ctx.accounts.position;
    if side_yes {
        position.yes_tokens = position
            .yes_tokens
            .checked_add(res.tokens_out)
            .ok_or(AmmError::MathOverflow)?;
        market.yes_supply = market
            .yes_supply
            .checked_add(res.tokens_out)
            .ok_or(AmmError::MathOverflow)?;
    } else {
        position.no_tokens = position
            .no_tokens
            .checked_add(res.tokens_out)
            .ok_or(AmmError::MathOverflow)?;
        market.no_supply = market
            .no_supply
            .checked_add(res.tokens_out)
            .ok_or(AmmError::MathOverflow)?;
    }
    position.collateral = position
        .collateral
        .checked_add(usdc_in)
        .ok_or(AmmError::MathOverflow)?;

    // ---- deposit USDC: trader_usdc -> vault (trader signs, plain CPI) ----
    let decimals = ctx.accounts.usdc_mint.decimals;
    let before = ctx.accounts.vault.amount;
    let cpi_accounts = TransferChecked {
        from: ctx.accounts.trader_usdc.to_account_info(),
        mint: ctx.accounts.usdc_mint.to_account_info(),
        to: ctx.accounts.vault.to_account_info(),
        authority: ctx.accounts.trader.to_account_info(),
    };
    let cpi_ctx = CpiContext::new(ctx.accounts.token_program.key(), cpi_accounts);
    token_interface::transfer_checked(cpi_ctx, usdc_in, decimals)?;

    ctx.accounts.vault.reload()?;
    let credited = ctx
        .accounts
        .vault
        .amount
        .checked_sub(before)
        .ok_or(AmmError::MathOverflow)?;
    market.usdc_collateral = market
        .usdc_collateral
        .checked_add(credited)
        .ok_or(AmmError::MathOverflow)?;

    // ---- re-validate reserves + solvency ----
    require!(market.yes_reserve > 0 && market.no_reserve > 0, AmmError::ZeroReserve);
    math::assert_solvent(ctx.accounts.vault.amount, market.yes_supply, market.no_supply)?;

    emit!(Trade {
        fixture_id: market.fixture_id,
        owner: ctx.accounts.trader.key(),
        side_yes,
        is_buy: true,
        usdc: usdc_in,
        tokens: res.tokens_out,
        price_bps: new_price_bps,
        fee_bps,
    });
    Ok(())
}

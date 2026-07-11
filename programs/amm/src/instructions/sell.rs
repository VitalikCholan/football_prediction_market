//! `sell(side, tokens_in, min_usdt_out)` — inverse of buy. Vault pays out signed
//! by the `market` PDA (the vault's authority). (plan §4.6)

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
pub struct Sell<'info> {
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
    ctx: Context<Sell>,
    side: Side,
    tokens_in: u64,
    min_usdt_out: u64,
) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;

    // ---- pre-flight validation (borrow immutably first) ----
    {
        let market = &ctx.accounts.market;
        require!(market.state == MarketState::Trading, AmmError::InvalidMarketState);
        require!(tokens_in > 0, AmmError::ZeroAmount);
        require!(now >= market.last_ts, AmmError::MonotonicClock);
    }
    let side_yes = matches!(side, Side::Yes);
    {
        let position = &ctx.accounts.position;
        let bal = if side_yes { position.yes_tokens } else { position.no_tokens };
        require!(bal >= tokens_in, AmmError::InsufficientPositionBalance);
    }

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

    // ---- CPMM inverse ----
    let res = math::sell(
        side_yes,
        ctx.accounts.market.yes_reserve,
        ctx.accounts.market.no_reserve,
        tokens_in,
    )?;

    // usdt_out = usdt_gross * (10_000 - fee_bps) / 10_000
    let out = (res.usdt_gross as u128)
        .checked_mul((BPS_DENOM - fee_bps as u64) as u128)
        .ok_or(AmmError::MathOverflow)?
        .checked_div(BPS_DENOM as u128)
        .ok_or(AmmError::DivideByZero)?;
    let usdt_out = u64::try_from(out).map_err(|_| AmmError::NumericConversion)?;
    require!(usdt_out >= min_usdt_out, AmmError::SlippageExceeded);

    // capture fixture_id + bump for signing before taking the mutable borrow chain
    let fixture_id = ctx.accounts.market.fixture_id;
    let market_bump = ctx.accounts.market.bump;

    // ---- update reserves, fee state, position/supply/collateral (before payout) ----
    let old_price_bps = ctx.accounts.market.last_price_bps;
    {
        let market = &mut ctx.accounts.market;
        market.yes_reserve = res.new_yes_reserve;
        market.no_reserve = res.new_no_reserve;
        let new_price_bps = math::price_yes_bps(market.yes_reserve, market.no_reserve)?;
        market.v_acc = fee::next_v_acc(&params, v_ref, old_price_bps, new_price_bps)?;
        market.last_price_bps = new_price_bps;
        market.last_ts = now;

        if side_yes {
            market.yes_supply = market
                .yes_supply
                .checked_sub(tokens_in)
                .ok_or(AmmError::MathOverflow)?;
        } else {
            market.no_supply = market
                .no_supply
                .checked_sub(tokens_in)
                .ok_or(AmmError::MathOverflow)?;
        }
        market.usdt_collateral = market
            .usdt_collateral
            .checked_sub(usdt_out)
            .ok_or(AmmError::MathOverflow)?;
    }
    {
        let position = &mut ctx.accounts.position;
        if side_yes {
            position.yes_tokens = position
                .yes_tokens
                .checked_sub(tokens_in)
                .ok_or(AmmError::MathOverflow)?;
        } else {
            position.no_tokens = position
                .no_tokens
                .checked_sub(tokens_in)
                .ok_or(AmmError::MathOverflow)?;
        }
        // reduce the trader's basis by the proceeds (saturating; can't go below 0).
        position.collateral = position.collateral.saturating_sub(usdt_out);
    }

    // ---- payout: vault -> trader_usdt, signed by the market PDA ----
    let decimals = ctx.accounts.usdt_mint.decimals;
    let fixture_le = fixture_id.to_le_bytes();
    let signer_seeds: &[&[&[u8]]] = &[&[MARKET_SEED, &fixture_le, &[market_bump]]];

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
    token_interface::transfer_checked(cpi_ctx, usdt_out, decimals)?;

    // ---- re-validate reserves + solvency ----
    ctx.accounts.vault.reload()?;
    let market = &ctx.accounts.market;
    require!(market.yes_reserve > 0 && market.no_reserve > 0, AmmError::ZeroReserve);
    math::assert_solvent(ctx.accounts.vault.amount, market.yes_supply, market.no_supply)?;

    emit!(Trade {
        fixture_id,
        owner: ctx.accounts.trader.key(),
        side_yes,
        is_buy: false,
        usdt: usdt_out,
        tokens: tokens_in,
        price_bps: market.last_price_bps,
        fee_bps,
    });
    Ok(())
}

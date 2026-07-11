//! `close_market` — admin-gated teardown after the resolution grace period
//! (plan §4.9).
//!
//! Order matters (a token account with a nonzero balance cannot be closed):
//! 1. sweep remaining vault USDT → admin ATA (signed by the market PDA),
//! 2. `close_account` CPI on the vault (rent → admin),
//! 3. Anchor `close = authority` reclaims the `Market` data account
//!    (secure close: data zeroed + discriminator poisoned → revival-safe).

use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    self, CloseAccount, Mint, TokenAccount, TokenInterface, TransferChecked,
};

use crate::constants::{CONFIG_SEED, MARKET_SEED};
use crate::error::AmmError;
use crate::state::{GlobalConfig, Market, MarketClosed, MarketConfig, MarketState};

#[derive(Accounts)]
pub struct CloseMarket<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        seeds = [CONFIG_SEED],
        bump = global.bump,
        // admin gate: signer must be the stored authority
        constraint = global.authority == authority.key() @ AmmError::Unauthorized,
    )]
    pub global: Box<Account<'info, GlobalConfig>>,

    #[account(
        mut,
        close = authority,
        seeds = [MARKET_SEED, &market.fixture_id.to_le_bytes()],
        bump = market.bump,
    )]
    pub market: Box<Account<'info, Market>>,

    #[account(address = market.config)]
    pub market_config: Box<Account<'info, MarketConfig>>,

    #[account(mut, address = market.vault)]
    pub vault: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        mut,
        token::mint = usdt_mint,
        token::authority = authority,
        token::token_program = token_program,
    )]
    pub authority_usdt: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(address = market.usdt_mint)]
    pub usdt_mint: Box<InterfaceAccount<'info, Mint>>,

    pub token_program: Interface<'info, TokenInterface>,
}

pub(crate) fn handler(ctx: Context<CloseMarket>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;

    // ---- gates: resolved + grace elapsed ----
    require!(
        ctx.accounts.market.state == MarketState::Resolved,
        AmmError::InvalidMarketState
    );
    let deadline = ctx
        .accounts
        .market
        .freeze_ts
        .checked_add(ctx.accounts.market_config.resolution_grace_secs)
        .ok_or(AmmError::MathOverflow)?;
    require!(now >= deadline, AmmError::GraceNotElapsed);

    let fixture_id = ctx.accounts.market.fixture_id;
    let fixture_le = fixture_id.to_le_bytes();
    let market_bump = ctx.accounts.market.bump;
    let signer_seeds: &[&[&[u8]]] = &[&[MARKET_SEED, &fixture_le, &[market_bump]]];

    // ---- 1. sweep residual vault USDT → admin (policy: after grace, dust
    //         and unredeemed funds go to the treasury/admin) ----
    let swept = ctx.accounts.vault.amount;
    if swept > 0 {
        let decimals = ctx.accounts.usdt_mint.decimals;
        let cpi_accounts = TransferChecked {
            from: ctx.accounts.vault.to_account_info(),
            mint: ctx.accounts.usdt_mint.to_account_info(),
            to: ctx.accounts.authority_usdt.to_account_info(),
            authority: ctx.accounts.market.to_account_info(),
        };
        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),
            cpi_accounts,
            signer_seeds,
        );
        token_interface::transfer_checked(cpi_ctx, swept, decimals)?;
    }

    // ---- 2. close the (now empty) vault token account, rent → admin ----
    let close_accounts = CloseAccount {
        account: ctx.accounts.vault.to_account_info(),
        destination: ctx.accounts.authority.to_account_info(),
        authority: ctx.accounts.market.to_account_info(),
    };
    let close_ctx = CpiContext::new_with_signer(
        ctx.accounts.token_program.key(),
        close_accounts,
        signer_seeds,
    );
    token_interface::close_account(close_ctx)?;

    // ---- 3. mark Closed; Anchor `close = authority` reclaims Market ----
    let market = &mut ctx.accounts.market;
    market.state = MarketState::Closed;
    market.usdt_collateral = 0;

    emit!(MarketClosed { fixture_id, swept });
    Ok(())
}

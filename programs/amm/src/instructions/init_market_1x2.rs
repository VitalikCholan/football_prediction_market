//! `init_market_1x2` — create the `Market1x2` + USDT escrow vault, seed the
//! LMSR curve and liquidity (SPEC §3.1 phase C). Admin-gated. Mirrors
//! `init_market` (D-2 posture: curve state sets odds only, the vault holds
//! all real USDT).
//!
//! ## Seeding approach (documented decision)
//!
//! The admin passes the LMSR liquidity `b` and per-outcome seed offsets
//! `seed_q = [q1, qx, q2]` — the opening odds are the softmax of `seed_q/b`
//! (symmetric `[0,0,0]` → 1/3 each; a larger `seed_q[i]` makes outcome i more
//! expensive). Seed offsets are POOL-OWNED (not user supply): `supply` starts
//! at `[0,0,0]` and only user trades move it.
//!
//! ## Solvency-at-init requirement (structural, makes the invariant
//! self-maintaining)
//!
//! `seed_liquidity ≥ C(seed_q, b) − min_i(seed_q_i)`.
//!
//! Proof that `vault ≥ max_i(supply_i)` then holds after ANY trade sequence:
//! collected premiums telescope to `≥ C(q) − C(seed_q)` (buy=ceil,
//! sell=floor, pool-favorable), so
//! `vault ≥ seed + C(q) − C(seed_q) ≥ C(q) − min(seed_q)
//!        ≥ max_i(q_i) − min(seed_q) ≥ max_i(q_i − seed_q_i) = max_i(supply_i)`.
//! For symmetric seeding this is the classic `b·ln 3` LMSR subsidy.
//! `assert_solvent_multi` still re-checks after every mutation (belt).

use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    self, Mint, TokenAccount, TokenInterface, TransferChecked,
};

use crate::constants::{
    CONFIG_SEED, MARKET_1X2_SEED, MARKET_KIND_1X2, MKT_CONFIG_SEED, VAULT_SEED,
};
use crate::error::AmmError;
use crate::lmsr;
use crate::math;
use crate::state::{
    GlobalConfig, Market1x2, Market1x2Created, MarketConfig, MarketState, Outcome1x2,
};

#[derive(Accounts)]
#[instruction(fixture_id: i64)]
pub struct InitMarket1x2<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        seeds = [CONFIG_SEED],
        bump = global.bump,
        constraint = global.authority == authority.key() @ AmmError::Unauthorized,
    )]
    pub global: Box<Account<'info, GlobalConfig>>,

    #[account(
        seeds = [MKT_CONFIG_SEED, &market_config.config_id.to_le_bytes()],
        bump = market_config.bump,
        // a 1X2 market must bind a 1X2-shaped config (resolve-1x2.md §5)
        constraint = market_config.market_kind == MARKET_KIND_1X2 @ AmmError::MarketKindMismatch,
    )]
    pub market_config: Box<Account<'info, MarketConfig>>,

    #[account(
        init,
        payer = authority,
        space = 8 + Market1x2::INIT_SPACE,
        seeds = [MARKET_1X2_SEED, &fixture_id.to_le_bytes()],
        bump,
    )]
    pub market: Box<Account<'info, Market1x2>>,

    #[account(
        init,
        payer = authority,
        seeds = [VAULT_SEED, market.key().as_ref()],
        bump,
        token::mint = usdt_mint,
        token::authority = market,
        token::token_program = token_program,
    )]
    pub vault: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(address = global.usdt_mint)]
    pub usdt_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(
        mut,
        token::mint = usdt_mint,
        token::authority = authority,
        token::token_program = token_program,
    )]
    pub authority_usdt: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(address = global.token_program)]
    pub token_program: Interface<'info, TokenInterface>,

    pub system_program: Program<'info, System>,
}

pub(crate) fn handler(
    ctx: Context<InitMarket1x2>,
    fixture_id: i64,
    kickoff_ts: i64,
    freeze_ts: i64,
    b: u64,
    seed_q: [u64; 3],
    seed_liquidity: u64,
) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;

    // ---- timing validation (mirror binary) ----
    require!(kickoff_ts < freeze_ts, AmmError::InvalidTiming);
    require!(kickoff_ts > now, AmmError::InvalidTiming);

    // ---- LMSR seed validation: ranges + the solvency-at-init bound ----
    // `cost` validates b ∈ [B_MIN, B_MAX] and every seed_q[i] ≤ Q_MAX.
    let seed_cost = lmsr::cost(&seed_q, b)?;
    let min_q = seed_q[0].min(seed_q[1]).min(seed_q[2]);
    let min_seed = seed_cost
        .checked_sub(min_q)
        .ok_or(AmmError::MathOverflow)?; // cost ≥ max(q) ≥ min(q) structurally
    require!(seed_liquidity >= min_seed, AmmError::InvalidSeedLiquidity);
    require!(seed_liquidity > 0, AmmError::InvalidSeedLiquidity);

    let prices = lmsr::prices_bps(&seed_q, b)?;

    // ---- write market state ----
    let market = &mut ctx.accounts.market;
    market.config = ctx.accounts.market_config.key();
    market.fixture_id = fixture_id;
    market.q = seed_q;
    market.b = b;
    market.usdt_collateral = seed_liquidity;
    market.supply = [0u64; 3];
    market.state = MarketState::Open;
    market.outcome = Outcome1x2::Unset;
    market.vault = ctx.accounts.vault.key();
    market.vault_bump = ctx.bumps.vault;
    market.kickoff_ts = kickoff_ts;
    market.freeze_ts = freeze_ts;
    market.usdt_mint = ctx.accounts.usdt_mint.key();
    // arm the fee state with the Team1 opening price (documented convention:
    // last_price_bps always tracks the most recently TRADED outcome's price).
    market.last_price_bps = prices[0];
    market.last_ts = now;
    market.v_acc = 0;
    market.bump = ctx.bumps.market;
    market._reserved = [0u8; 64];

    // ---- transfer seed liquidity: authority_usdt -> vault ----
    let decimals = ctx.accounts.usdt_mint.decimals;
    let before = ctx.accounts.vault.amount;

    let cpi_accounts = TransferChecked {
        from: ctx.accounts.authority_usdt.to_account_info(),
        mint: ctx.accounts.usdt_mint.to_account_info(),
        to: ctx.accounts.vault.to_account_info(),
        authority: ctx.accounts.authority.to_account_info(),
    };
    let cpi_ctx = CpiContext::new(ctx.accounts.token_program.key(), cpi_accounts);
    token_interface::transfer_checked(cpi_ctx, seed_liquidity, decimals)?;

    // balance-delta accounting (D-6 insurance): trust the vault, not the arg.
    ctx.accounts.vault.reload()?;
    let credited = ctx
        .accounts
        .vault
        .amount
        .checked_sub(before)
        .ok_or(AmmError::MathOverflow)?;
    // the solvency-at-init bound must hold for what actually LANDED.
    require!(credited >= min_seed, AmmError::InvalidSeedLiquidity);
    let market = &mut ctx.accounts.market;
    market.usdt_collateral = credited;

    // solvency holds trivially (supplies are 0); belt anyway.
    math::assert_solvent_multi(ctx.accounts.vault.amount, &market.supply)?;

    emit!(Market1x2Created {
        fixture_id,
        config: market.config,
        b,
        q: seed_q,
        prices_bps: prices,
    });
    Ok(())
}

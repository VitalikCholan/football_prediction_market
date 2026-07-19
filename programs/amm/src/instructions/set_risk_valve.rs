//! `set_risk_valve(pause_secs, multiplier_bps, window_secs)` — keeper-gated,
//! hard-bounded risk damper (leverage-v1.md §4): pause NEW leveraged opens
//! for up to `VALVE_MAX_DURATION_SECS` and/or amplify funding by up to
//! `VALVE_MAX_MULTIPLIER_BPS` (×5) for a bounded window. The bounds mean the
//! keeper can dampen, not rug: existing positions keep their max-loss = C
//! guarantee and the multiplier can never go below neutral.

use anchor_lang::prelude::*;

use crate::constants::{
    BPS_DENOM, CONFIG_SEED, LEV_POOL_SEED, MARKET_SEED, VALVE_MAX_DURATION_SECS,
    VALVE_MAX_MULTIPLIER_BPS,
};
use crate::error::AmmError;
use crate::state::{GlobalConfig, LeveragePool, Market, RiskValveSet};

#[derive(Accounts)]
pub struct SetRiskValve<'info> {
    pub keeper: Signer<'info>,

    #[account(
        seeds = [CONFIG_SEED],
        bump = global.bump,
        // keeper gate (D-1): signer must be the stored keeper
        constraint = global.keeper == keeper.key() @ AmmError::Unauthorized,
    )]
    pub global: Box<Account<'info, GlobalConfig>>,

    #[account(
        seeds = [MARKET_SEED, &market.fixture_id.to_le_bytes()],
        bump = market.bump,
    )]
    pub market: Box<Account<'info, Market>>,

    #[account(
        mut,
        seeds = [LEV_POOL_SEED, market.key().as_ref()],
        bump = pool.bump,
    )]
    pub pool: Box<Account<'info, LeveragePool>>,
}

pub(crate) fn handler(
    ctx: Context<SetRiskValve>,
    pause_secs: i64,
    multiplier_bps: u16,
    window_secs: i64,
) -> Result<()> {
    // hard bounds: neutral ≤ multiplier ≤ ×5; each window in [0, 600s].
    require!(
        multiplier_bps <= VALVE_MAX_MULTIPLIER_BPS
            && u64::from(multiplier_bps) >= BPS_DENOM
            && (0..=VALVE_MAX_DURATION_SECS).contains(&pause_secs)
            && (0..=VALVE_MAX_DURATION_SECS).contains(&window_secs),
        AmmError::ValveOutOfBounds
    );

    let now = Clock::get()?.unix_timestamp;
    let paused_until = now.checked_add(pause_secs).ok_or(AmmError::MathOverflow)?;
    let until_ts = now.checked_add(window_secs).ok_or(AmmError::MathOverflow)?;

    let pool = &mut ctx.accounts.pool;
    pool.valve_paused_until = paused_until;
    pool.valve_multiplier_bps = multiplier_bps;
    pool.valve_until_ts = until_ts;

    emit!(RiskValveSet {
        market: ctx.accounts.market.key(),
        paused_until,
        multiplier_bps,
        until_ts,
    });
    Ok(())
}

pub mod constants;
pub mod error;
pub mod fee;
pub mod instructions;
pub mod math;
pub mod state;

use anchor_lang::prelude::*;

pub use constants::*;
pub use error::*;
pub use instructions::*;
pub use state::*;

declare_id!("H59qQz8DXzUWWc3L528iTCFL36ozwBhJc4tHzuwL2JuY");

#[program]
pub mod amm {
    use super::*;

    /// Create the singleton `GlobalConfig` (admin, keeper, txline, mint, token program).
    pub fn initialize_config(
        ctx: Context<InitializeConfig>,
        keeper: Pubkey,
        txline_program: Pubkey,
        usdc_mint: Pubkey,
        token_program: Pubkey,
    ) -> Result<()> {
        initialize_config::handler(ctx, keeper, txline_program, usdc_mint, token_program)
    }

    /// Create a reusable per-tournament `MarketConfig` (fee + resolution params).
    pub fn create_market_config(
        ctx: Context<CreateMarketConfig>,
        config_id: u16,
        params: FeeParamsArgs,
    ) -> Result<()> {
        create_market_config::handler(ctx, config_id, params)
    }

    /// Create a `Market` + USDT escrow vault and seed reserves/liquidity.
    pub fn init_market(
        ctx: Context<InitMarket>,
        fixture_id: i64,
        kickoff_ts: i64,
        freeze_ts: i64,
        seed_yes: u64,
        seed_no: u64,
        seed_liquidity: u64,
    ) -> Result<()> {
        init_market::handler(
            ctx,
            fixture_id,
            kickoff_ts,
            freeze_ts,
            seed_yes,
            seed_no,
            seed_liquidity,
        )
    }

    /// Explicitly create a trader's `Position` PDA (D-3; no init_if_needed).
    pub fn open_position(ctx: Context<OpenPosition>) -> Result<()> {
        open_position::handler(ctx)
    }

    /// Buy YES/NO for USDC.
    pub fn buy(ctx: Context<Buy>, side: Side, usdc_in: u64, min_out: u64) -> Result<()> {
        buy::handler(ctx, side, usdc_in, min_out)
    }

    /// Sell YES/NO tokens back for USDC.
    pub fn sell(
        ctx: Context<Sell>,
        side: Side,
        tokens_in: u64,
        min_usdc_out: u64,
    ) -> Result<()> {
        sell::handler(ctx, side, tokens_in, min_usdc_out)
    }
}

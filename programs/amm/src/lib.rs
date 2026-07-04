pub mod constants;
pub mod error;
pub mod fee;
pub mod instructions;
pub mod math;
pub mod state;
pub mod txline_types;

use anchor_lang::prelude::*;

pub use constants::*;
pub use error::*;
pub use instructions::*;
pub use state::*;

declare_id!("H59qQz8DXzUWWc3L528iTCFL36ozwBhJc4tHzuwL2JuY");

// Typed CPI client for the TxLINE oracle, generated from idls/txline.json
// (txoracle v1.5.2, devnet). Used only by `resolve` — see instructions/resolve.rs.
declare_program!(txline);

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

    /// Keeper-gated, clock-guarded `Open -> Trading` at kickoff.
    pub fn activate_market(ctx: Context<ActivateMarket>) -> Result<()> {
        activate_market::handler(ctx)
    }

    /// Keeper-gated, clock-guarded `Trading -> Locked` at the final whistle.
    pub fn freeze_market(ctx: Context<FreezeMarket>) -> Result<()> {
        freeze_market::handler(ctx)
    }

    /// Verify the outcome via CPI into TxLINE `validate_stat` (Merkle proof
    /// against on-chain oracle roots) and set `Resolved`. The predicate is the
    /// STORED one from `MarketConfig` (or its sound negation for a NO hint).
    #[allow(clippy::too_many_arguments)]
    pub fn resolve(
        ctx: Context<Resolve>,
        outcome_hint: Side,
        ts: i64,
        fixture_summary: txline_types::ScoresBatchSummary,
        fixture_proof: Vec<txline_types::ProofNode>,
        main_tree_proof: Vec<txline_types::ProofNode>,
        stat_a: txline_types::StatTerm,
        stat_b: Option<txline_types::StatTerm>,
        op: Option<txline_types::BinaryExpression>,
    ) -> Result<()> {
        resolve::handler(
            ctx,
            outcome_hint,
            ts,
            fixture_summary,
            fixture_proof,
            main_tree_proof,
            stat_a,
            stat_b,
            op,
        )
    }

    /// Redeem a resolved position: 1 winning token = 1 USDT; Void refunds stake.
    pub fn redeem(ctx: Context<Redeem>) -> Result<()> {
        redeem::handler(ctx)
    }

    /// Admin teardown after the grace window: sweep vault, close accounts.
    pub fn close_market(ctx: Context<CloseMarket>) -> Result<()> {
        close_market::handler(ctx)
    }
}

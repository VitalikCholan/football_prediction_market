pub mod constants;
pub mod error;
pub mod fee;
pub mod instructions;
pub mod lmsr;
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
        usdt_mint: Pubkey,
        token_program: Pubkey,
    ) -> Result<()> {
        initialize_config::handler(ctx, keeper, txline_program, usdt_mint, token_program)
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

    /// Buy YES/NO for USDT.
    pub fn buy(ctx: Context<Buy>, side: Side, usdt_in: u64, min_out: u64) -> Result<()> {
        buy::handler(ctx, side, usdt_in, min_out)
    }

    /// Sell YES/NO tokens back for USDT.
    pub fn sell(
        ctx: Context<Sell>,
        side: Side,
        tokens_in: u64,
        min_usdt_out: u64,
    ) -> Result<()> {
        sell::handler(ctx, side, tokens_in, min_usdt_out)
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

    // =======================================================================
    // 3-way (1X2) LMSR market — SPEC §3.1 phase C. A PARALLEL instruction
    // set: the binary instructions above are untouched and byte-stable.
    // =======================================================================

    /// Create a `MarketConfig` for 1X2 markets (`market_kind = 1`): enforces
    /// the two-stat Subtract predicate shape and pins `resolution_period`.
    pub fn create_market_config_1x2(
        ctx: Context<CreateMarketConfig1x2>,
        config_id: u16,
        params: FeeParamsArgs,
        resolution_period: i32,
    ) -> Result<()> {
        create_market_config_1x2::handler(ctx, config_id, params, resolution_period)
    }

    /// Create a `Market1x2` + USDT escrow vault; seed the LMSR curve
    /// (`b`, `seed_q` offsets set the opening odds) and the solvency subsidy
    /// (`seed_liquidity ≥ C(seed_q, b) − min(seed_q)`).
    pub fn init_market_1x2(
        ctx: Context<InitMarket1x2>,
        fixture_id: i64,
        kickoff_ts: i64,
        freeze_ts: i64,
        b: u64,
        seed_q: [u64; 3],
        seed_liquidity: u64,
    ) -> Result<()> {
        init_market_1x2::handler(
            ctx,
            fixture_id,
            kickoff_ts,
            freeze_ts,
            b,
            seed_q,
            seed_liquidity,
        )
    }

    /// Explicitly create a trader's `Position1x2` PDA (D-3; no init_if_needed).
    pub fn open_position_1x2(ctx: Context<OpenPosition1x2>) -> Result<()> {
        open_position_1x2::handler(ctx)
    }

    /// Buy `outcome ∈ {0=Team1, 1=Draw, 2=Team2}` tokens for USDT (LMSR).
    pub fn buy_1x2(
        ctx: Context<Buy1x2>,
        outcome: u8,
        usdt_in: u64,
        min_tokens_out: u64,
    ) -> Result<()> {
        buy_1x2::handler(ctx, outcome, usdt_in, min_tokens_out)
    }

    /// Sell `outcome` tokens back for USDT (LMSR refund − fee).
    pub fn sell_1x2(
        ctx: Context<Sell1x2>,
        outcome: u8,
        tokens_in: u64,
        min_usdt_out: u64,
    ) -> Result<()> {
        sell_1x2::handler(ctx, outcome, tokens_in, min_usdt_out)
    }

    /// Keeper-gated, clock-guarded `Open -> Trading` at kickoff (1X2).
    pub fn activate_market_1x2(ctx: Context<ActivateMarket1x2>) -> Result<()> {
        activate_market_1x2::handler(ctx)
    }

    /// Keeper-gated, clock-guarded `Trading -> Locked` at the whistle (1X2).
    pub fn freeze_market_1x2(ctx: Context<FreezeMarket1x2>) -> Result<()> {
        freeze_market_1x2::handler(ctx)
    }

    /// Hint-and-prove-positively 1X2 resolution: the keeper hints
    /// `0=Team1 / 1=Draw / 2=Team2`; the program derives that outcome's
    /// predicate from the stored config and ONE `validate_stat` CPI must
    /// return `true` (plans/resolve-1x2.md).
    #[allow(clippy::too_many_arguments)]
    pub fn resolve_1x2(
        ctx: Context<Resolve1x2>,
        hint: u8,
        ts: i64,
        fixture_summary: txline_types::ScoresBatchSummary,
        fixture_proof: Vec<txline_types::ProofNode>,
        main_tree_proof: Vec<txline_types::ProofNode>,
        stat_a: txline_types::StatTerm,
        stat_b: Option<txline_types::StatTerm>,
        op: Option<txline_types::BinaryExpression>,
    ) -> Result<()> {
        resolve_1x2::handler(
            ctx,
            hint,
            ts,
            fixture_summary,
            fixture_proof,
            main_tree_proof,
            stat_a,
            stat_b,
            op,
        )
    }

    /// Redeem a resolved 1X2 position: 1 winning token = 1 USDT; Void
    /// refunds the net basis pro-rata (D-4).
    pub fn redeem_1x2(ctx: Context<Redeem1x2>) -> Result<()> {
        redeem_1x2::handler(ctx)
    }

    /// Mint a COMPLETE SET (SPEC §3.1 phase C-add): deposit EXACTLY `amount`
    /// USDT, receive `amount` tokens of every outcome. Fee-free, price-neutral
    /// (equal `q` shift → softmax unchanged). Trading-only.
    pub fn mint_set_1x2(ctx: Context<MintSet1x2>, amount: u64) -> Result<()> {
        mint_set_1x2::handler(ctx, amount)
    }

    /// Redeem a COMPLETE SET back to par (SPEC §3.1 phase C-add): burn `amount`
    /// tokens of every outcome, receive EXACTLY `amount` USDT. Fee-free,
    /// price-neutral. Trading-only. Inverse of `mint_set_1x2`.
    pub fn redeem_set_1x2(ctx: Context<RedeemSet1x2>, amount: u64) -> Result<()> {
        redeem_set_1x2::handler(ctx, amount)
    }

    /// Admin teardown after the grace window (1X2): sweep vault, close accounts.
    pub fn close_market_1x2(ctx: Context<CloseMarket1x2>) -> Result<()> {
        close_market_1x2::handler(ctx)
    }
}

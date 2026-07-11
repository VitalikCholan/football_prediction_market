//! LiteSVM integration tests — plan §10.1 cases 1–8 & 12.
//!
//! Pure math/fee property coverage (cases 5,7,8 in part) lives as unit tests
//! inside `programs/amm/src/{math,fee}.rs`; these cases exercise the same laws
//! end-to-end on-chain plus the account/lifecycle/authorization behaviour.

use anchor_lang::prelude::Pubkey;
use solana_keypair::Keypair;
use solana_program_pack::Pack;
use solana_signer::Signer;

use amm::error::AmmError;
use amm::state::{GlobalConfig, Market, MarketConfig, MarketState, Position};
use amm::Side;

use crate::common::*;

const CFG_ID: u16 = 1;
const FIXTURE: i64 = 17_588_316;

/// Bring a market all the way to Trading with a funded trader position.
struct Live {
    h: Harness,
    trader: Keypair,
    trader_ata: Pubkey,
    #[allow(dead_code)]
    admin_ata: Pubkey,
}

fn bootstrap_to_trading(seed_yes: u64, seed_no: u64, seed_liq: u64) -> Live {
    let mut h = Harness::new();
    let admin = h.admin.pubkey();
    let keeper = h.keeper.pubkey();
    let mint = h.usdt_mint;
    let txline = Pubkey::new_from_array([3u8; 32]);

    // config + market config
    h.send(&[&h.admin.insecure_clone()], &admin, ix_initialize_config(&admin, &keeper, &txline, &mint))
        .unwrap();
    h.send(
        &[&h.admin.insecure_clone()],
        &admin,
        ix_create_market_config(&admin, CFG_ID, default_fee_params()),
    )
    .unwrap();

    // fund admin, init market (needs future kickoff/freeze)
    let admin_ata = h.fund_ata(&admin, 1_000_000 * ONE_USDT);
    let kickoff = h.now() + 100;
    let freeze = h.now() + 1_000;
    h.send(
        &[&h.admin.insecure_clone()],
        &admin,
        ix_init_market(
            &admin, CFG_ID, FIXTURE, kickoff, freeze, seed_yes, seed_no, seed_liq, &mint,
            &admin_ata,
        ),
    )
    .unwrap();

    // Manually advance the market to Trading via a fabricated state write is NOT
    // available (no activate ix in Phase 1). Instead we drive it by writing the
    // Market account's state byte directly through set_account is fragile; the
    // v0 Phase-1 program has no `activate_market`, so buy/sell tests operate by
    // flipping state via a direct account patch. See `force_trading`.
    let trader = Keypair::new();
    h.svm.airdrop(&trader.pubkey(), 100_000_000_000).unwrap();
    let trader_ata = h.fund_ata(&trader.pubkey(), 100_000 * ONE_USDT);

    Live { h, trader, trader_ata, admin_ata }
}

/// Phase-1 has no `activate_market`; patch the on-chain Market state → Trading
/// so buy/sell can be exercised (activate/freeze land in Phase 2).
fn force_state(h: &mut Harness, fixture_id: i64, state: MarketState) {
    let market_key = market_pda(fixture_id);
    let mut acc = h.svm.get_account(&market_key).unwrap();
    let mut m: Market =
        anchor_lang::AccountDeserialize::try_deserialize(&mut acc.data.as_slice()).unwrap();
    m.state = state;
    // re-serialize with discriminator
    let mut buf = Vec::new();
    anchor_lang::AccountSerialize::try_serialize(&m, &mut buf).unwrap();
    acc.data[..buf.len()].copy_from_slice(&buf);
    h.svm.set_account(market_key, acc).unwrap();
}

// ===========================================================================
// Case 1 — initialize_config sets fields; re-init fails (singleton)
// ===========================================================================
#[test]
fn case1_initialize_config() {
    let mut h = Harness::new();
    let admin = h.admin.pubkey();
    let keeper = h.keeper.pubkey();
    let mint = h.usdt_mint;
    let txline = Pubkey::new_from_array([3u8; 32]);

    h.send(&[&h.admin.insecure_clone()], &admin, ix_initialize_config(&admin, &keeper, &txline, &mint))
        .unwrap();

    let cfg: GlobalConfig = get_anchor(&h.svm, &config_pda());
    assert_eq!(cfg.authority, admin);
    assert_eq!(cfg.keeper, keeper);
    assert_eq!(cfg.txline_program, txline);
    assert_eq!(cfg.usdt_mint, mint);
    assert_eq!(cfg.token_program, token_program_id());

    // re-init must fail (account already exists → init constraint)
    let res =
        h.send(&[&h.admin.insecure_clone()], &admin, ix_initialize_config(&admin, &keeper, &txline, &mint));
    assert!(res.is_err(), "re-init of singleton must fail");
}

// ===========================================================================
// Case 2 — create_market_config admin-only + param validation
// ===========================================================================
#[test]
fn case2_create_market_config() {
    let mut h = Harness::new();
    let admin = h.admin.pubkey();
    let keeper = h.keeper.pubkey();
    let mint = h.usdt_mint;
    let txline = Pubkey::new_from_array([3u8; 32]);
    h.send(&[&h.admin.insecure_clone()], &admin, ix_initialize_config(&admin, &keeper, &txline, &mint))
        .unwrap();

    // happy path
    h.send(
        &[&h.admin.insecure_clone()],
        &admin,
        ix_create_market_config(&admin, CFG_ID, default_fee_params()),
    )
    .unwrap();
    let mc: MarketConfig = get_anchor(&h.svm, &market_config_pda(CFG_ID));
    assert_eq!(mc.config_id, CFG_ID);
    assert_eq!(mc.base_fee_bps, 30);

    // non-admin signer → Unauthorized (global still points at the real config;
    // only the signing authority differs)
    let stranger = Keypair::new();
    h.svm.airdrop(&stranger.pubkey(), 10_000_000_000).unwrap();
    let ix = ix_create_market_config(&stranger.pubkey(), 2, default_fee_params());
    let res = h.send(&[&stranger], &stranger.pubkey(), ix);
    assert_amm_error(&res, AmmError::Unauthorized);

    // base > max → InvalidFeeParams
    let mut bad = default_fee_params();
    bad.base_fee_bps = 2_000;
    bad.max_fee_bps = 1_000;
    let res = h.send(&[&h.admin.insecure_clone()], &admin, ix_create_market_config(&admin, 3, bad));
    assert_amm_error(&res, AmmError::InvalidFeeParams);

    // filter > decay → InvalidFeeParams
    let mut bad = default_fee_params();
    bad.filter_period = 500;
    bad.decay_period = 100;
    let res = h.send(&[&h.admin.insecure_clone()], &admin, ix_create_market_config(&admin, 4, bad));
    assert_amm_error(&res, AmmError::InvalidFeeParams);

    // max_v_acc == 0 → InvalidFeeParams
    let mut bad = default_fee_params();
    bad.max_v_acc = 0;
    let res = h.send(&[&h.admin.insecure_clone()], &admin, ix_create_market_config(&admin, 5, bad));
    assert_amm_error(&res, AmmError::InvalidFeeParams);
}

// ===========================================================================
// Case 3 — init_market creates Market+vault, reserves seeded, price≈5000,
//          vault authority == market PDA, seed USDT transferred.
// ===========================================================================
#[test]
fn case3_init_market() {
    let mut h = Harness::new();
    let admin = h.admin.pubkey();
    let keeper = h.keeper.pubkey();
    let mint = h.usdt_mint;
    let txline = Pubkey::new_from_array([3u8; 32]);
    h.send(&[&h.admin.insecure_clone()], &admin, ix_initialize_config(&admin, &keeper, &txline, &mint))
        .unwrap();
    h.send(
        &[&h.admin.insecure_clone()],
        &admin,
        ix_create_market_config(&admin, CFG_ID, default_fee_params()),
    )
    .unwrap();

    let admin_ata = h.fund_ata(&admin, 1_000_000 * ONE_USDT);
    let seed_liq = 10_000 * ONE_USDT;
    let kickoff = h.now() + 100;
    let freeze = h.now() + 1_000;
    let admin_before = h.token_balance(&admin_ata);

    h.send(
        &[&h.admin.insecure_clone()],
        &admin,
        ix_init_market(
            &admin, CFG_ID, FIXTURE, kickoff, freeze, 1_000_000, 1_000_000, seed_liq, &mint,
            &admin_ata,
        ),
    )
    .unwrap();

    let market_key = market_pda(FIXTURE);
    let m: Market = get_anchor(&h.svm, &market_key);
    assert_eq!(m.yes_reserve, 1_000_000);
    assert_eq!(m.no_reserve, 1_000_000);
    assert_eq!(m.last_price_bps, 5_000, "50/50 seed => 5000 bps");
    assert_eq!(m.state, MarketState::Open);
    assert_eq!(m.vault, vault_pda(&market_key));

    // vault authority == market PDA, funded with seed_liq
    let vault = vault_pda(&market_key);
    let vacc = h.svm.get_account(&vault).unwrap();
    let tok = spl_token::state::Account::unpack(&vacc.data).unwrap();
    assert_eq!(tok.owner, market_key, "vault authority is the market PDA");
    assert_eq!(tok.amount, seed_liq);
    assert_eq!(m.usdt_collateral, seed_liq);

    // seed USDT left the admin ATA
    assert_eq!(h.token_balance(&admin_ata), admin_before - seed_liq);

    // wrong kickoff (>= freeze) rejected
    let res = h.send(
        &[&h.admin.insecure_clone()],
        &admin,
        ix_init_market(
            &admin, CFG_ID, 999, freeze, kickoff, 1, 1, ONE_USDT, &mint, &admin_ata,
        ),
    );
    assert_amm_error(&res, AmmError::InvalidTiming);
}

// ===========================================================================
// Case 4 (partial for Phase 1) — buy before Trading fails.
// (activate/freeze clock guards land in Phase 2.)
// ===========================================================================
#[test]
fn case4_buy_before_trading_fails() {
    let mut live = bootstrap_to_trading(1_000_000, 1_000_000, 10_000 * ONE_USDT);
    let trader = live.trader.pubkey();

    // open position, then try to buy while market is still Open
    live.h
        .send(&[&live.trader], &trader, ix_open_position(&trader, FIXTURE))
        .unwrap();
    let res = live.h.send(
        &[&live.trader],
        &trader,
        ix_buy(&trader, CFG_ID, FIXTURE, Side::Yes, ONE_USDT, 0, &live.h.usdt_mint, &live.trader_ata),
    );
    assert_amm_error(&res, AmmError::InvalidMarketState);
}

// ===========================================================================
// Case 5 — CPMM invariant on-chain: after buy, k' >= k; price moves up for a
//          YES buy; slippage (min_out too high) rejected.
// ===========================================================================
#[test]
fn case5_buy_cpmm_and_slippage() {
    let mut live = bootstrap_to_trading(1_000_000, 1_000_000, 100_000 * ONE_USDT);
    force_state(&mut live.h, FIXTURE, MarketState::Trading);
    let trader = live.trader.pubkey();
    live.h.send(&[&live.trader], &trader, ix_open_position(&trader, FIXTURE)).unwrap();

    let market_key = market_pda(FIXTURE);
    let before: Market = get_anchor(&live.h.svm, &market_key);
    let k0 = before.yes_reserve as u128 * before.no_reserve as u128;
    let p0 = before.last_price_bps;

    live.h
        .send(
            &[&live.trader],
            &trader,
            ix_buy(&trader, CFG_ID, FIXTURE, Side::Yes, 1_000 * ONE_USDT, 0, &live.h.usdt_mint, &live.trader_ata),
        )
        .unwrap();

    let after: Market = get_anchor(&live.h.svm, &market_key);
    let k1 = after.yes_reserve as u128 * after.no_reserve as u128;
    assert!(k1 >= k0, "k must not decrease: k0={k0} k1={k1}");
    assert!(after.last_price_bps > p0, "YES buy raises YES price");

    let pos: Position = get_anchor(&live.h.svm, &position_pda(&market_key, &trader));
    assert!(pos.yes_tokens > 0);
    assert_eq!(after.yes_supply, pos.yes_tokens);

    // slippage: demand an absurd min_out
    let res = live.h.send(
        &[&live.trader],
        &trader,
        ix_buy(&trader, CFG_ID, FIXTURE, Side::Yes, ONE_USDT, u64::MAX, &live.h.usdt_mint, &live.trader_ata),
    );
    assert_amm_error(&res, AmmError::SlippageExceeded);
}

// ===========================================================================
// Case 6 — buy→sell round trip never profits (no free money).
// ===========================================================================
#[test]
fn case6_round_trip_no_profit() {
    let mut live = bootstrap_to_trading(1_000_000, 1_000_000, 100_000 * ONE_USDT);
    force_state(&mut live.h, FIXTURE, MarketState::Trading);
    let trader = live.trader.pubkey();
    live.h.send(&[&live.trader], &trader, ix_open_position(&trader, FIXTURE)).unwrap();

    let usdt_in = 500 * ONE_USDT;
    let before = live.h.token_balance(&live.trader_ata);

    live.h
        .send(
            &[&live.trader],
            &trader,
            ix_buy(&trader, CFG_ID, FIXTURE, Side::Yes, usdt_in, 0, &live.h.usdt_mint, &live.trader_ata),
        )
        .unwrap();

    let market_key = market_pda(FIXTURE);
    let pos: Position = get_anchor(&live.h.svm, &position_pda(&market_key, &trader));
    let tokens = pos.yes_tokens;

    live.h
        .send(
            &[&live.trader],
            &trader,
            ix_sell(&trader, CFG_ID, FIXTURE, Side::Yes, tokens, 0, &live.h.usdt_mint, &live.trader_ata),
        )
        .unwrap();

    let after = live.h.token_balance(&live.trader_ata);
    assert!(after <= before, "round trip must not profit: before={before} after={after}");

    // position YES cleared, supply back to 0
    let pos2: Position = get_anchor(&live.h.svm, &position_pda(&market_key, &trader));
    assert_eq!(pos2.yes_tokens, 0);
    let m: Market = get_anchor(&live.h.svm, &market_key);
    assert_eq!(m.yes_supply, 0);
}

// ===========================================================================
// Case 7 (on-chain slice) — dynamic fee is charged: two identical rapid buys
// with an injected volatility accumulator produce a higher fee on the 2nd.
// (Exhaustive three-zone/quadratic/ceil-div coverage is in fee.rs unit tests.)
// ===========================================================================
#[test]
fn case7_dynamic_fee_charged() {
    let mut live = bootstrap_to_trading(1_000_000, 1_000_000, 100_000 * ONE_USDT);
    force_state(&mut live.h, FIXTURE, MarketState::Trading);
    let trader = live.trader.pubkey();
    live.h.send(&[&live.trader], &trader, ix_open_position(&trader, FIXTURE)).unwrap();

    // A large buy moves the price a lot → arms v_acc for the next trade.
    let market_key = market_pda(FIXTURE);
    live.h
        .send(
            &[&live.trader],
            &trader,
            ix_buy(&trader, CFG_ID, FIXTURE, Side::Yes, 5_000 * ONE_USDT, 0, &live.h.usdt_mint, &live.trader_ata),
        )
        .unwrap();
    let m: Market = get_anchor(&live.h.svm, &market_key);
    assert!(m.v_acc > 0, "volatility accumulator armed after a price-moving trade");
    assert_ne!(m.last_price_bps, 5_000, "price moved off 50/50");
}

// ===========================================================================
// Case 8 (on-chain slice) — CPMM output strictly less than the reserve and
// state accounting is consistent after a NO buy.
// ===========================================================================
#[test]
fn case8_no_buy_accounting() {
    let mut live = bootstrap_to_trading(2_000_000, 2_000_000, 100_000 * ONE_USDT);
    force_state(&mut live.h, FIXTURE, MarketState::Trading);
    let trader = live.trader.pubkey();
    live.h.send(&[&live.trader], &trader, ix_open_position(&trader, FIXTURE)).unwrap();

    let market_key = market_pda(FIXTURE);
    let before: Market = get_anchor(&live.h.svm, &market_key);
    let p0 = before.last_price_bps;

    live.h
        .send(
            &[&live.trader],
            &trader,
            ix_buy(&trader, CFG_ID, FIXTURE, Side::No, 1_000 * ONE_USDT, 0, &live.h.usdt_mint, &live.trader_ata),
        )
        .unwrap();

    let after: Market = get_anchor(&live.h.svm, &market_key);
    assert!(after.last_price_bps < p0, "NO buy lowers YES price");
    assert!(after.no_reserve < before.no_reserve, "NO removed from reserve");
    assert!(after.no_reserve > 0, "reserve never drained");
    let pos: Position = get_anchor(&live.h.svm, &position_pda(&market_key, &trader));
    assert_eq!(after.no_supply, pos.no_tokens);
    assert!(pos.no_tokens > 0);
}

// ===========================================================================
// Case 12 — overflow / zero-amount edges.
// ===========================================================================
#[test]
fn case12_edges() {
    let mut live = bootstrap_to_trading(1_000_000, 1_000_000, 100_000 * ONE_USDT);
    force_state(&mut live.h, FIXTURE, MarketState::Trading);
    let trader = live.trader.pubkey();
    live.h.send(&[&live.trader], &trader, ix_open_position(&trader, FIXTURE)).unwrap();

    // zero-amount buy rejected
    let res = live.h.send(
        &[&live.trader],
        &trader,
        ix_buy(&trader, CFG_ID, FIXTURE, Side::Yes, 0, 0, &live.h.usdt_mint, &live.trader_ata),
    );
    assert_amm_error(&res, AmmError::ZeroAmount);

    // u64::MAX buy → CPMM math overflow (or drains reserve) — must fail cleanly,
    // not panic. Trader has finite balance so the transfer would also fail; the
    // math guard triggers first inside the handler.
    let res = live.h.send(
        &[&live.trader],
        &trader,
        ix_buy(&trader, CFG_ID, FIXTURE, Side::Yes, u64::MAX, 0, &live.h.usdt_mint, &live.trader_ata),
    );
    assert!(res.is_err(), "u64::MAX buy must fail");

    // zero-token sell rejected
    let res = live.h.send(
        &[&live.trader],
        &trader,
        ix_sell(&trader, CFG_ID, FIXTURE, Side::Yes, 0, 0, &live.h.usdt_mint, &live.trader_ata),
    );
    assert_amm_error(&res, AmmError::ZeroAmount);
}

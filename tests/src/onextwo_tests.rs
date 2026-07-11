//! LiteSVM tests for the 3-way (1X2) LMSR market — SPEC §3.1 phase C.
//!
//! Mirrors `phase2_tests.rs`: markets run through the REAL lifecycle
//! instructions with Clock warping; the TxLINE oracle is the shared mock
//! (`tests/mock-txoracle`), which evaluates the passed predicate — including
//! `EqualTo`, the Draw wall-dissolver — against the passed stat values.
//!
//! Void is forced via account patch, exactly like the binary suite: neither
//! kind has an on-chain Void path yet (flagged in SPEC §3.1 as follow-up).

use anchor_lang::prelude::Pubkey;
use solana_keypair::Keypair;
use solana_signer::Signer;

use amm::error::AmmError;
use amm::state::{Market1x2, MarketState, Outcome1x2, Position1x2};
use amm::{lmsr, math};

use crate::common::*;

const CFG_ID: u16 = 3;
const FIXTURE: i64 = 18_179_549;

/// 100 USDT of LMSR depth — max vault subsidy b·ln3 ≈ 110 USDT.
const B: u64 = 100 * ONE_USDC;
/// Symmetric opening book (1/3 each); required subsidy = ceil(b·ln3).
const SEED_Q: [u64; 3] = [0, 0, 0];
const SEED_LIQ: u64 = 200 * ONE_USDC;

struct Live {
    h: Harness,
    trader: Keypair,
    trader_ata: Pubkey,
    admin_ata: Pubkey,
    kickoff: i64,
    freeze: i64,
}

/// Bootstrap a 1X2 config + market to `Open` with the mock oracle loaded.
fn bootstrap_open() -> Live {
    let mut h = Harness::new_with_oracle();
    let admin = h.admin.pubkey();
    let keeper = h.keeper.pubkey();
    let mint = h.usdc_mint;

    h.send(
        &[&h.admin.insecure_clone()],
        &admin,
        ix_initialize_config(&admin, &keeper, &txline_id(), &mint),
    )
    .unwrap();
    h.send(
        &[&h.admin.insecure_clone()],
        &admin,
        ix_create_market_config_1x2(&admin, CFG_ID, default_fee_params(), FINAL_PERIOD),
    )
    .unwrap();

    let admin_ata = h.fund_ata(&admin, 1_000_000 * ONE_USDC);
    let kickoff = h.now() + 100;
    let freeze = h.now() + 1_000;
    h.send(
        &[&h.admin.insecure_clone()],
        &admin,
        ix_init_market_1x2(
            &admin, CFG_ID, FIXTURE, kickoff, freeze, B, SEED_Q, SEED_LIQ, &mint, &admin_ata,
        ),
    )
    .unwrap();

    let trader = Keypair::new();
    h.svm.airdrop(&trader.pubkey(), 100_000_000_000).unwrap();
    let trader_ata = h.fund_ata(&trader.pubkey(), 100_000 * ONE_USDC);

    Live { h, trader, trader_ata, admin_ata, kickoff, freeze }
}

fn to_trading(live: &mut Live) {
    live.h.set_time(live.kickoff);
    let keeper = live.h.keeper.insecure_clone();
    live.h
        .send(&[&keeper], &keeper.pubkey(), ix_activate_market_1x2(&keeper.pubkey(), FIXTURE))
        .unwrap();
}

/// Buy `usdt` of `outcome` as the harness trader (position must exist).
/// Requests a raised CU limit — the LMSR delta-solve exceeds the 200k
/// default (exactly what production clients must do). Returns consumed CU.
fn buy(live: &mut Live, outcome: u8, usdt: u64) -> u64 {
    let trader = live.trader.pubkey();
    let meta = send_tx_ixs(
        &mut live.h.svm,
        &[&live.trader.insecure_clone()],
        &trader,
        &[
            ix_set_cu_limit(CU_LIMIT_1X2_BUY),
            ix_buy_1x2(&trader, CFG_ID, FIXTURE, outcome, usdt, 0, &live.h.usdc_mint, &live.trader_ata),
        ],
    )
    .unwrap();
    meta.compute_units_consumed
}

fn to_locked(live: &mut Live, buys: &[(u8, u64)]) {
    to_trading(live);
    let trader = live.trader.pubkey();
    live.h
        .send(&[&live.trader.insecure_clone()], &trader, ix_open_position_1x2(&trader, FIXTURE))
        .unwrap();
    for &(outcome, usdt) in buys {
        buy(live, outcome, usdt);
    }
    live.h.set_time(live.freeze);
    let keeper = live.h.keeper.insecure_clone();
    live.h
        .send(&[&keeper], &keeper.pubkey(), ix_freeze_market_1x2(&keeper.pubkey(), FIXTURE))
        .unwrap();
}

/// `resolve_1x2` with the given hint + final score (fabricates the roots PDA;
/// stats carry the pinned FINAL_PERIOD unless overridden).
fn do_resolve(
    live: &mut Live,
    hint: u8,
    home: i32,
    away: i32,
    period: i32,
) -> litesvm::types::TransactionResult {
    let ts = live.h.now();
    let roots = write_roots_account(&mut live.h.svm, &txline_id(), epoch_day(ts), 0x00);
    let keeper = live.h.keeper.insecure_clone();
    live.h.send(
        &[&keeper],
        &keeper.pubkey(),
        ix_resolve_1x2(
            &keeper.pubkey(),
            CFG_ID,
            FIXTURE,
            hint,
            resolve_args_1x2(FIXTURE, ts, home, away, period),
            &txline_id(),
            &roots,
        ),
    )
}

/// Assert the on-chain LMSR invariants: Σ prices ∈ [9_997, 10_000] and
/// solvency `vault ≥ max_i(supply_i)` (the D-2 generalization).
fn assert_market_invariants(live: &Live) {
    let market_key = market_1x2_pda(FIXTURE);
    let m: Market1x2 = get_anchor(&live.h.svm, &market_key);
    let prices = lmsr::prices_bps(&m.q, m.b).unwrap();
    let sum: u32 = prices.iter().map(|&p| u32::from(p)).sum();
    assert!(
        (9_997..=10_000).contains(&sum),
        "sum of prices {sum} outside rounding band; prices={prices:?}"
    );
    let vault_bal = live.h.token_balance(&vault_pda(&market_key));
    math::assert_solvent_multi(vault_bal, &m.supply).expect("solvency violated");
    assert_eq!(m.usdc_collateral, vault_bal, "collateral mirror out of sync");
}

/// Patch the Market1x2 state/outcome directly (only for paths with no
/// instruction, i.e. forcing Void — same pattern as the binary suite).
fn force_market_1x2(h: &mut Harness, fixture_id: i64, state: MarketState, outcome: Outcome1x2) {
    let market_key = market_1x2_pda(fixture_id);
    let mut acc = h.svm.get_account(&market_key).unwrap();
    let mut m: Market1x2 =
        anchor_lang::AccountDeserialize::try_deserialize(&mut acc.data.as_slice()).unwrap();
    m.state = state;
    m.outcome = outcome;
    let mut buf = Vec::new();
    anchor_lang::AccountSerialize::try_serialize(&m, &mut buf).unwrap();
    acc.data[..buf.len()].copy_from_slice(&buf);
    h.svm.set_account(market_key, acc).unwrap();
}

// ===========================================================================
// init — seeding: opening odds + the solvency-at-init bound
// ===========================================================================
#[test]
fn init_seeds_symmetric_odds_and_enforces_subsidy() {
    let live = bootstrap_open();
    let m: Market1x2 = get_anchor(&live.h.svm, &market_1x2_pda(FIXTURE));
    assert_eq!(m.q, SEED_Q);
    assert_eq!(m.b, B);
    assert_eq!(m.supply, [0, 0, 0]);
    assert_eq!(m.state, MarketState::Open);
    assert_eq!(m.outcome, Outcome1x2::Unset);
    let prices = lmsr::prices_bps(&m.q, m.b).unwrap();
    // symmetric book: 1/3 each (floor → 3333)
    assert_eq!(prices, [3_333, 3_333, 3_333]);
    assert_market_invariants(&live);
}

#[test]
fn init_rejects_insufficient_subsidy_and_binary_config() {
    // (a) seed below C(seed_q,b) − min(seed_q) = ceil(b·ln3) → rejected
    let mut h = Harness::new_with_oracle();
    let admin = h.admin.pubkey();
    let keeper = h.keeper.pubkey();
    let mint = h.usdc_mint;
    h.send(
        &[&h.admin.insecure_clone()],
        &admin,
        ix_initialize_config(&admin, &keeper, &txline_id(), &mint),
    )
    .unwrap();
    h.send(
        &[&h.admin.insecure_clone()],
        &admin,
        ix_create_market_config_1x2(&admin, CFG_ID, default_fee_params(), FINAL_PERIOD),
    )
    .unwrap();
    let admin_ata = h.fund_ata(&admin, 1_000_000 * ONE_USDC);
    let subsidy = lmsr::cost(&SEED_Q, B).unwrap(); // = ceil(b·ln3), min(seed_q)=0
    let (kickoff, freeze) = (h.now() + 100, h.now() + 1_000);
    let ix = ix_init_market_1x2(
        &admin,
        CFG_ID,
        FIXTURE,
        kickoff,
        freeze,
        B,
        SEED_Q,
        subsidy - 1,
        &mint,
        &admin_ata,
    );
    let res = send_tx(&mut h.svm, &[&h.admin.insecure_clone()], &admin, ix);
    assert_amm_error(&res, AmmError::InvalidSeedLiquidity);

    // (b) 1X2 market on a BINARY config → MarketKindMismatch
    const BIN_CFG: u16 = 4;
    h.send(
        &[&h.admin.insecure_clone()],
        &admin,
        ix_create_market_config(&admin, BIN_CFG, default_fee_params()),
    )
    .unwrap();
    let ix = ix_init_market_1x2(
        &admin,
        BIN_CFG,
        FIXTURE,
        kickoff,
        freeze,
        B,
        SEED_Q,
        SEED_LIQ,
        &mint,
        &admin_ata,
    );
    let res = send_tx(&mut h.svm, &[&h.admin.insecure_clone()], &admin, ix);
    assert_amm_error(&res, AmmError::MarketKindMismatch);
}

// ===========================================================================
// (a)+(d) trading: every outcome buyable, Σ prices band + solvency after an
// arbitrary buy/sell sequence, slippage guards
// ===========================================================================
#[test]
fn trade_sequence_holds_price_sum_and_solvency() {
    let mut live = bootstrap_open();
    to_trading(&mut live);
    let trader = live.trader.pubkey();
    live.h
        .send(&[&live.trader.insecure_clone()], &trader, ix_open_position_1x2(&trader, FIXTURE))
        .unwrap();

    // buy each of the three outcomes (all buyable), invariants after each
    let mut max_cu = 0u64;
    for outcome in 0..3u8 {
        max_cu = max_cu.max(buy(&mut live, outcome, 50 * ONE_USDC));
        assert_market_invariants(&live);
    }
    // the delta-solve must fit a requestable budget (devnet hard cap 1.4M)
    eprintln!("max buy_1x2 CU observed: {max_cu}");
    assert!(max_cu < 1_400_000, "buy_1x2 CU {max_cu} must fit the 1.4M cap");
    // buying an outcome raises its price
    let m: Market1x2 = get_anchor(&live.h.svm, &market_1x2_pda(FIXTURE));
    let p_before = lmsr::prices_bps(&m.q, m.b).unwrap()[0];
    buy(&mut live, 0, 200 * ONE_USDC);
    let m: Market1x2 = get_anchor(&live.h.svm, &market_1x2_pda(FIXTURE));
    let p_after = lmsr::prices_bps(&m.q, m.b).unwrap()[0];
    assert!(p_after > p_before, "buying Team1 must raise its price");
    assert_market_invariants(&live);

    // longer arbitrary sequence: alternating buys + partial sells
    let seq: &[(u8, u64, bool)] = &[
        (1, 30 * ONE_USDC, true),
        (2, 80 * ONE_USDC, true),
        (0, 10 * ONE_USDC, false),
        (1, 5 * ONE_USDC, false),
        (0, 25 * ONE_USDC, true),
        (2, 40 * ONE_USDC, false),
        (1, 120 * ONE_USDC, true),
    ];
    for &(outcome, amount, is_buy) in seq {
        if is_buy {
            buy(&mut live, outcome, amount);
        } else {
            // sell `amount`-scaled tokens (bounded by holdings)
            let pos: Position1x2 =
                get_anchor(&live.h.svm, &position_1x2_pda(&market_1x2_pda(FIXTURE), &trader));
            let tokens = pos.tokens[usize::from(outcome)].min(amount);
            assert!(tokens > 0, "test setup: nothing to sell on outcome {outcome}");
            live.h
                .send(
                    &[&live.trader.insecure_clone()],
                    &trader,
                    ix_sell_1x2(
                        &trader,
                        CFG_ID,
                        FIXTURE,
                        outcome,
                        tokens,
                        0,
                        &live.h.usdc_mint,
                        &live.trader_ata,
                    ),
                )
                .unwrap();
        }
        assert_market_invariants(&live);
    }

    // a buy-then-sell round trip never profits the trader
    let bal_before = live.h.token_balance(&live.trader_ata);
    buy(&mut live, 2, 100 * ONE_USDC);
    let pos: Position1x2 =
        get_anchor(&live.h.svm, &position_1x2_pda(&market_1x2_pda(FIXTURE), &trader));
    let bought = pos.tokens[2];
    live.h
        .send(
            &[&live.trader.insecure_clone()],
            &trader,
            ix_sell_1x2(&trader, CFG_ID, FIXTURE, 2, bought, 0, &live.h.usdc_mint, &live.trader_ata),
        )
        .unwrap();
    assert!(
        live.h.token_balance(&live.trader_ata) <= bal_before,
        "round trip must never profit"
    );
    assert_market_invariants(&live);
}

#[test]
fn slippage_guards_and_input_validation() {
    let mut live = bootstrap_open();
    to_trading(&mut live);
    let trader = live.trader.pubkey();
    live.h
        .send(&[&live.trader.insecure_clone()], &trader, ix_open_position_1x2(&trader, FIXTURE))
        .unwrap();

    // buy: min_tokens_out above what 10 USDT can buy → SlippageExceeded
    let res = send_tx_ixs(
        &mut live.h.svm,
        &[&live.trader.insecure_clone()],
        &trader,
        &[
            ix_set_cu_limit(CU_LIMIT_1X2_BUY),
            ix_buy_1x2(
                &trader,
                CFG_ID,
                FIXTURE,
                0,
                10 * ONE_USDC,
                100 * ONE_USDC,
                &live.h.usdc_mint,
                &live.trader_ata,
            ),
        ],
    );
    assert_amm_error(&res, AmmError::SlippageExceeded);

    // invalid outcome index
    let res = send_tx(
        &mut live.h.svm,
        &[&live.trader.insecure_clone()],
        &trader,
        ix_buy_1x2(&trader, CFG_ID, FIXTURE, 3, ONE_USDC, 0, &live.h.usdc_mint, &live.trader_ata),
    );
    assert_amm_error(&res, AmmError::LmsrInvalidOutcomeIndex);

    // sell: more than held → InsufficientPositionBalance
    buy(&mut live, 1, 10 * ONE_USDC);
    let pos: Position1x2 =
        get_anchor(&live.h.svm, &position_1x2_pda(&market_1x2_pda(FIXTURE), &trader));
    let res = send_tx(
        &mut live.h.svm,
        &[&live.trader.insecure_clone()],
        &trader,
        ix_sell_1x2(
            &trader,
            CFG_ID,
            FIXTURE,
            1,
            pos.tokens[1] + 1,
            0,
            &live.h.usdc_mint,
            &live.trader_ata,
        ),
    );
    assert_amm_error(&res, AmmError::InsufficientPositionBalance);

    // sell: min_usdt_out above the refund → SlippageExceeded
    let res = send_tx(
        &mut live.h.svm,
        &[&live.trader.insecure_clone()],
        &trader,
        ix_sell_1x2(
            &trader,
            CFG_ID,
            FIXTURE,
            1,
            pos.tokens[1],
            100 * ONE_USDC,
            &live.h.usdc_mint,
            &live.trader_ata,
        ),
    );
    assert_amm_error(&res, AmmError::SlippageExceeded);
}

// ===========================================================================
// (f) resolve — all three hints prove positively; wrong hints rejected with
// no state change; double-resolve rejected; period pin enforced
// ===========================================================================
#[test]
fn resolve_team1_wrong_hints_rejected_first() {
    let mut live = bootstrap_open();
    to_locked(&mut live, &[(0, 100 * ONE_USDC)]);

    // final 2–0: Draw and Team2 hints must fail and leave the market Locked
    for wrong_hint in [1u8, 2u8] {
        let res = do_resolve(&mut live, wrong_hint, 2, 0, FINAL_PERIOD);
        assert_amm_error(&res, AmmError::ProofRejected);
        let m: Market1x2 = get_anchor(&live.h.svm, &market_1x2_pda(FIXTURE));
        assert_eq!(m.state, MarketState::Locked, "wrong hint must not mutate state");
        assert_eq!(m.outcome, Outcome1x2::Unset);
    }

    do_resolve(&mut live, 0, 2, 0, FINAL_PERIOD).unwrap();
    let m: Market1x2 = get_anchor(&live.h.svm, &market_1x2_pda(FIXTURE));
    assert_eq!(m.state, MarketState::Resolved);
    assert_eq!(m.outcome, Outcome1x2::Team1);

    // double-resolve (any hint) → InvalidMarketState
    let res = do_resolve(&mut live, 0, 2, 0, FINAL_PERIOD);
    assert_amm_error(&res, AmmError::InvalidMarketState);
}

#[test]
fn resolve_draw_via_positive_equal_to() {
    // THE wall-dissolver: Draw proven positively with EqualTo — no negation.
    let mut live = bootstrap_open();
    to_locked(&mut live, &[(1, 100 * ONE_USDC)]);

    for wrong_hint in [0u8, 2u8] {
        let res = do_resolve(&mut live, wrong_hint, 1, 1, FINAL_PERIOD);
        assert_amm_error(&res, AmmError::ProofRejected);
    }
    do_resolve(&mut live, 1, 1, 1, FINAL_PERIOD).unwrap();
    let m: Market1x2 = get_anchor(&live.h.svm, &market_1x2_pda(FIXTURE));
    assert_eq!(m.outcome, Outcome1x2::Draw);
}

#[test]
fn resolve_team2() {
    let mut live = bootstrap_open();
    to_locked(&mut live, &[(2, 100 * ONE_USDC)]);
    do_resolve(&mut live, 2, 0, 3, FINAL_PERIOD).unwrap();
    let m: Market1x2 = get_anchor(&live.h.svm, &market_1x2_pda(FIXTURE));
    assert_eq!(m.outcome, Outcome1x2::Team2);
}

#[test]
fn resolve_rejects_wrong_period_and_bad_hint() {
    let mut live = bootstrap_open();
    to_locked(&mut live, &[(0, 50 * ONE_USDC)]);

    // stale-batch replay guard: mid-match period (0) ≠ pinned 100
    let res = do_resolve(&mut live, 0, 2, 0, 0);
    assert_amm_error(&res, AmmError::ResolutionPeriodMismatch);
    let m: Market1x2 = get_anchor(&live.h.svm, &market_1x2_pda(FIXTURE));
    assert_eq!(m.state, MarketState::Locked);

    // hint out of range
    let res = do_resolve(&mut live, 3, 2, 0, FINAL_PERIOD);
    assert_amm_error(&res, AmmError::LmsrInvalidOutcomeIndex);

    // correct period → resolves
    do_resolve(&mut live, 0, 2, 0, FINAL_PERIOD).unwrap();
}

#[test]
fn resolve_oracle_error_mode_propagates() {
    let mut live = bootstrap_open();
    to_locked(&mut live, &[(0, 50 * ONE_USDC)]);

    let ts = live.h.now();
    let roots = write_roots_account(
        &mut live.h.svm,
        &txline_id(),
        epoch_day(ts),
        mock_txoracle::ERROR_MODE_SENTINEL,
    );
    let keeper = live.h.keeper.insecure_clone();
    let res = live.h.send(
        &[&keeper],
        &keeper.pubkey(),
        ix_resolve_1x2(
            &keeper.pubkey(),
            CFG_ID,
            FIXTURE,
            0,
            resolve_args_1x2(FIXTURE, ts, 2, 0, FINAL_PERIOD),
            &txline_id(),
            &roots,
        ),
    );
    // RootNotAvailable(6007) propagates verbatim — keeper-retryable
    assert_custom_error(&res, 6007);
    let m: Market1x2 = get_anchor(&live.h.svm, &market_1x2_pda(FIXTURE));
    assert_eq!(m.state, MarketState::Locked);
}

// ===========================================================================
// market-kind gate: BINARY resolve on a market bound to a 1X2 config
// ===========================================================================
#[test]
fn binary_resolve_rejected_on_1x2_config() {
    // A binary market wired (admin mistake) to a 1X2-kind config: the binary
    // `resolve` must refuse it (MarketKindMismatch) — 2 outcomes cannot
    // settle a 3-outcome question.
    let mut h = Harness::new_with_oracle();
    let admin = h.admin.pubkey();
    let keeper_pk = h.keeper.pubkey();
    let mint = h.usdc_mint;
    h.send(
        &[&h.admin.insecure_clone()],
        &admin,
        ix_initialize_config(&admin, &keeper_pk, &txline_id(), &mint),
    )
    .unwrap();
    h.send(
        &[&h.admin.insecure_clone()],
        &admin,
        ix_create_market_config_1x2(&admin, CFG_ID, default_fee_params(), FINAL_PERIOD),
    )
    .unwrap();
    let admin_ata = h.fund_ata(&admin, 1_000_000 * ONE_USDC);
    let kickoff = h.now() + 100;
    let freeze = h.now() + 1_000;
    h.send(
        &[&h.admin.insecure_clone()],
        &admin,
        ix_init_market(
            &admin,
            CFG_ID,
            FIXTURE,
            kickoff,
            freeze,
            1_000_000,
            1_000_000,
            10_000 * ONE_USDC,
            &mint,
            &admin_ata,
        ),
    )
    .unwrap();
    // drive the BINARY market to Locked
    h.set_time(kickoff);
    let keeper = h.keeper.insecure_clone();
    send_tx(&mut h.svm, &[&keeper], &keeper.pubkey(), ix_activate_market(&keeper.pubkey(), FIXTURE))
        .unwrap();
    h.set_time(freeze);
    send_tx(&mut h.svm, &[&keeper], &keeper.pubkey(), ix_freeze_market(&keeper.pubkey(), FIXTURE))
        .unwrap();

    let ts = h.now();
    let roots = write_roots_account(&mut h.svm, &txline_id(), epoch_day(ts), 0x00);
    let res = send_tx(
        &mut h.svm,
        &[&keeper],
        &keeper.pubkey(),
        ix_resolve(
            &keeper.pubkey(),
            CFG_ID,
            FIXTURE,
            amm::Side::Yes,
            resolve_args(FIXTURE, ts, 2, 1),
            &txline_id(),
            &roots,
        ),
    );
    assert_amm_error(&res, AmmError::MarketKindMismatch);
}

// ===========================================================================
// (f)+(g) redeem: winner 1:1, loser 0, double rejected, Void pro-rata
// ===========================================================================
#[test]
fn redeem_winner_loser_and_double() {
    let mut live = bootstrap_open();
    // trader holds Team1 AND Draw; Team1 wins → Draw side pays 0
    to_locked(&mut live, &[(0, 100 * ONE_USDC), (1, 50 * ONE_USDC)]);
    do_resolve(&mut live, 0, 2, 0, FINAL_PERIOD).unwrap();

    let trader = live.trader.pubkey();
    let market_key = market_1x2_pda(FIXTURE);
    let pos_key = position_1x2_pda(&market_key, &trader);
    let pos: Position1x2 = get_anchor(&live.h.svm, &pos_key);
    let winning = pos.tokens[0];
    assert!(winning > 0 && pos.tokens[1] > 0);

    let before = live.h.token_balance(&live.trader_ata);
    let vault_before = live.h.token_balance(&vault_pda(&market_key));
    live.h
        .send(
            &[&live.trader.insecure_clone()],
            &trader,
            ix_redeem_1x2(&trader, FIXTURE, &live.h.usdc_mint, &live.trader_ata),
        )
        .unwrap();

    // ONLY the winning outcome pays, 1 token = 1 USDT; loser tokens pay 0
    assert_eq!(live.h.token_balance(&live.trader_ata), before + winning);
    assert_eq!(live.h.token_balance(&vault_pda(&market_key)), vault_before - winning);

    let pos: Position1x2 = get_anchor(&live.h.svm, &pos_key);
    assert!(pos.redeemed);
    assert_eq!(pos.tokens, [0, 0, 0]);
    let m: Market1x2 = get_anchor(&live.h.svm, &market_key);
    assert_eq!(m.supply, [0, 0, 0], "all balances decremented from supply");

    // double-redeem → AlreadyRedeemed
    let res = send_tx(
        &mut live.h.svm,
        &[&live.trader.insecure_clone()],
        &trader,
        ix_redeem_1x2(&trader, FIXTURE, &live.h.usdc_mint, &live.trader_ata),
    );
    assert_amm_error(&res, AmmError::AlreadyRedeemed);
}

#[test]
fn redeem_void_refunds_net_basis() {
    let mut live = bootstrap_open();
    let stake = 100 * ONE_USDC;
    // stakes across two outcomes: Void refunds the SUM of net basis
    to_locked(&mut live, &[(0, stake), (2, stake)]);
    force_market_1x2(&mut live.h, FIXTURE, MarketState::Resolved, Outcome1x2::Void);

    let trader = live.trader.pubkey();
    let market_key = market_1x2_pda(FIXTURE);
    let pos: Position1x2 = get_anchor(&live.h.svm, &position_1x2_pda(&market_key, &trader));
    assert_eq!(pos.collateral, 2 * stake, "net basis = the two buys");

    let before = live.h.token_balance(&live.trader_ata);
    live.h
        .send(
            &[&live.trader.insecure_clone()],
            &trader,
            ix_redeem_1x2(&trader, FIXTURE, &live.h.usdc_mint, &live.trader_ata),
        )
        .unwrap();
    assert_eq!(
        live.h.token_balance(&live.trader_ata),
        before + 2 * stake,
        "Void refunds the net USDT stake (D-4)"
    );
    let pos: Position1x2 = get_anchor(&live.h.svm, &position_1x2_pda(&market_key, &trader));
    assert!(pos.redeemed);
    assert_eq!(pos.collateral, 0);
}

// ===========================================================================
// full happy circle: init → activate → buy all 3 → sell → freeze → resolve →
// redeem winner/loser → grace → close (real instructions, Clock warp only)
// ===========================================================================
#[test]
fn full_1x2_circle() {
    let mut live = bootstrap_open();
    let trader = live.trader.pubkey();
    let market_key = market_1x2_pda(FIXTURE);
    let vault_key = vault_pda(&market_key);

    // a second trader who will LOSE
    let loser = Keypair::new();
    live.h.svm.airdrop(&loser.pubkey(), 100_000_000_000).unwrap();
    let loser_ata = live.h.fund_ata(&loser.pubkey(), 100_000 * ONE_USDC);

    live.h
        .send(&[&live.trader.insecure_clone()], &trader, ix_open_position_1x2(&trader, FIXTURE))
        .unwrap();
    to_trading(&mut live);
    live.h
        .send(&[&loser.insecure_clone()], &loser.pubkey(), ix_open_position_1x2(&loser.pubkey(), FIXTURE))
        .unwrap();

    // winner buys all three outcomes, then sells part of Draw
    for outcome in 0..3u8 {
        buy(&mut live, outcome, 60 * ONE_USDC);
        assert_market_invariants(&live);
    }
    let pos: Position1x2 = get_anchor(&live.h.svm, &position_1x2_pda(&market_key, &trader));
    live.h
        .send(
            &[&live.trader.insecure_clone()],
            &trader,
            ix_sell_1x2(
                &trader,
                CFG_ID,
                FIXTURE,
                1,
                pos.tokens[1] / 2,
                0,
                &live.h.usdc_mint,
                &live.trader_ata,
            ),
        )
        .unwrap();
    assert_market_invariants(&live);

    // loser goes all-in on Team2
    send_tx_ixs(
        &mut live.h.svm,
        &[&loser.insecure_clone()],
        &loser.pubkey(),
        &[
            ix_set_cu_limit(CU_LIMIT_1X2_BUY),
            ix_buy_1x2(&loser.pubkey(), CFG_ID, FIXTURE, 2, 150 * ONE_USDC, 0, &live.h.usdc_mint, &loser_ata),
        ],
    )
    .unwrap();
    assert_market_invariants(&live);

    // freeze at the whistle; resolve Team1 (2–0)
    live.h.set_time(live.freeze);
    let keeper = live.h.keeper.insecure_clone();
    live.h
        .send(&[&keeper], &keeper.pubkey(), ix_freeze_market_1x2(&keeper.pubkey(), FIXTURE))
        .unwrap();
    do_resolve(&mut live, 0, 2, 0, FINAL_PERIOD).unwrap();

    // winner redeems 1:1 on Team1; loser redeems 0
    let pos: Position1x2 = get_anchor(&live.h.svm, &position_1x2_pda(&market_key, &trader));
    let winning = pos.tokens[0];
    let before = live.h.token_balance(&live.trader_ata);
    live.h
        .send(
            &[&live.trader.insecure_clone()],
            &trader,
            ix_redeem_1x2(&trader, FIXTURE, &live.h.usdc_mint, &live.trader_ata),
        )
        .unwrap();
    assert_eq!(live.h.token_balance(&live.trader_ata), before + winning);

    let loser_before = live.h.token_balance(&loser_ata);
    live.h
        .send(
            &[&loser.insecure_clone()],
            &loser.pubkey(),
            ix_redeem_1x2(&loser.pubkey(), FIXTURE, &live.h.usdc_mint, &loser_ata),
        )
        .unwrap();
    assert_eq!(live.h.token_balance(&loser_ata), loser_before, "loser gets 0");

    // close: grace gate first, then sweep + secure close
    let admin = live.h.admin.insecure_clone();
    let res = send_tx(
        &mut live.h.svm,
        &[&admin],
        &admin.pubkey(),
        ix_close_market_1x2(&admin.pubkey(), CFG_ID, FIXTURE, &live.h.usdc_mint, &live.admin_ata),
    );
    assert_amm_error(&res, AmmError::GraceNotElapsed);

    live.h.set_time(live.freeze + 3_600);
    let residual = live.h.token_balance(&vault_key);
    let admin_before = live.h.token_balance(&live.admin_ata);
    live.h
        .send(
            &[&admin],
            &admin.pubkey(),
            ix_close_market_1x2(&admin.pubkey(), CFG_ID, FIXTURE, &live.h.usdc_mint, &live.admin_ata),
        )
        .unwrap();
    assert_eq!(
        live.h.token_balance(&live.admin_ata),
        admin_before + residual,
        "residual vault USDT swept to admin"
    );
    let vault_acc = live.h.svm.get_account(&vault_key);
    assert!(
        vault_acc.map_or(true, |a| a.lamports == 0 && a.data.is_empty()),
        "vault token account must be closed"
    );
    let market_acc = live.h.svm.get_account(&market_key);
    assert!(
        market_acc.map_or(true, |a| a.lamports == 0 || a.data.iter().all(|b| *b == 0)),
        "market account must be closed"
    );
}

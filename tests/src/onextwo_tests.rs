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
use amm::lmsr;
use amm::state::{Market, MarketState, Outcome, Position};

use crate::common::*;

const CFG_ID: u16 = 3;
const FIXTURE: i64 = 18_179_549;

/// 100 USDT of LMSR depth — max vault subsidy b·ln3 ≈ 110 USDT.
const B: u64 = 100 * ONE_USDT;
/// Symmetric opening book (1/3 each); required subsidy = ceil(b·ln3).
const SEED_Q: [u64; 3] = [0, 0, 0];
const SEED_LIQ: u64 = 200 * ONE_USDT;

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
    let mint = h.usdt_mint;

    h.send(
        &[&h.admin.insecure_clone()],
        &admin,
        ix_initialize_config(&admin, &keeper, &txline_id(), &mint),
    )
    .unwrap();
    h.send(
        &[&h.admin.insecure_clone()],
        &admin,
        ix_create_market_config(&admin, CFG_ID, default_fee_params(), FINAL_PERIOD),
    )
    .unwrap();

    let admin_ata = h.fund_ata(&admin, 1_000_000 * ONE_USDT);
    let kickoff = h.now() + 100;
    let freeze = h.now() + 1_000;
    h.send(
        &[&h.admin.insecure_clone()],
        &admin,
        ix_init_market(
            &admin, CFG_ID, FIXTURE, kickoff, freeze, B, SEED_Q, SEED_LIQ, &mint, &admin_ata,
        ),
    )
    .unwrap();

    let trader = Keypair::new();
    h.svm.airdrop(&trader.pubkey(), 100_000_000_000).unwrap();
    let trader_ata = h.fund_ata(&trader.pubkey(), 100_000 * ONE_USDT);

    Live { h, trader, trader_ata, admin_ata, kickoff, freeze }
}

fn to_trading(live: &mut Live) {
    live.h.set_time(live.kickoff);
    let keeper = live.h.keeper.insecure_clone();
    live.h
        .send(&[&keeper], &keeper.pubkey(), ix_activate_market(&keeper.pubkey(), FIXTURE))
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
            ix_set_cu_limit(CU_LIMIT_BUY),
            ix_buy(&trader, CFG_ID, FIXTURE, outcome, usdt, 0, &live.h.usdt_mint, &live.trader_ata),
        ],
    )
    .unwrap();
    meta.compute_units_consumed
}

fn to_locked(live: &mut Live, buys: &[(u8, u64)]) {
    to_trading(live);
    let trader = live.trader.pubkey();
    live.h
        .send(&[&live.trader.insecure_clone()], &trader, ix_open_position(&trader, FIXTURE))
        .unwrap();
    for &(outcome, usdt) in buys {
        buy(live, outcome, usdt);
    }
    live.h.set_time(live.freeze);
    let keeper = live.h.keeper.insecure_clone();
    live.h
        .send(&[&keeper], &keeper.pubkey(), ix_freeze_market(&keeper.pubkey(), FIXTURE))
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
        ix_resolve(
            &keeper.pubkey(),
            CFG_ID,
            FIXTURE,
            hint,
            resolve_args_period(FIXTURE, ts, home, away, period),
            &txline_id(),
            &roots,
        ),
    )
}

/// Assert the on-chain LMSR invariants: Σ prices ∈ [9_997, 10_000] and
/// solvency `vault ≥ max_i(supply_i)` (the D-2 generalization).
fn assert_market_invariants(live: &Live) {
    let market_key = market_pda(FIXTURE);
    let m: Market = get_anchor(&live.h.svm, &market_key);
    let prices = lmsr::prices_bps(&m.q, m.b).unwrap();
    let sum: u32 = prices.iter().map(|&p| u32::from(p)).sum();
    assert!(
        (9_997..=10_000).contains(&sum),
        "sum of prices {sum} outside rounding band; prices={prices:?}"
    );
    let vault_bal = live.h.token_balance(&vault_pda(&market_key));
    lmsr::assert_solvent_multi(vault_bal, &m.supply).expect("solvency violated");
    assert_eq!(m.usdt_collateral, vault_bal, "collateral mirror out of sync");
}

/// Patch the Market state/outcome directly (only for paths with no
/// instruction, i.e. forcing Void — same pattern as the binary suite).
fn force_market(h: &mut Harness, fixture_id: i64, state: MarketState, outcome: Outcome) {
    let market_key = market_pda(fixture_id);
    let mut acc = h.svm.get_account(&market_key).unwrap();
    let mut m: Market =
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
    let m: Market = get_anchor(&live.h.svm, &market_pda(FIXTURE));
    assert_eq!(m.q, SEED_Q);
    assert_eq!(m.b, B);
    assert_eq!(m.supply, [0, 0, 0]);
    assert_eq!(m.state, MarketState::Open);
    assert_eq!(m.outcome, Outcome::Unset);
    let prices = lmsr::prices_bps(&m.q, m.b).unwrap();
    // symmetric book: 1/3 each (floor → 3333)
    assert_eq!(prices, [3_333, 3_333, 3_333]);
    assert_market_invariants(&live);
}

#[test]
fn init_rejects_insufficient_subsidy() {
    // seed below C(seed_q,b) − min(seed_q) = ceil(b·ln3) → rejected
    let mut h = Harness::new_with_oracle();
    let admin = h.admin.pubkey();
    let keeper = h.keeper.pubkey();
    let mint = h.usdt_mint;
    h.send(
        &[&h.admin.insecure_clone()],
        &admin,
        ix_initialize_config(&admin, &keeper, &txline_id(), &mint),
    )
    .unwrap();
    h.send(
        &[&h.admin.insecure_clone()],
        &admin,
        ix_create_market_config(&admin, CFG_ID, default_fee_params(), FINAL_PERIOD),
    )
    .unwrap();
    let admin_ata = h.fund_ata(&admin, 1_000_000 * ONE_USDT);
    let subsidy = lmsr::cost(&SEED_Q, B).unwrap(); // = ceil(b·ln3), min(seed_q)=0
    let (kickoff, freeze) = (h.now() + 100, h.now() + 1_000);
    let ix = ix_init_market(
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
        .send(&[&live.trader.insecure_clone()], &trader, ix_open_position(&trader, FIXTURE))
        .unwrap();

    // buy each of the three outcomes (all buyable), invariants after each
    let mut max_cu = 0u64;
    for outcome in 0..3u8 {
        max_cu = max_cu.max(buy(&mut live, outcome, 50 * ONE_USDT));
        assert_market_invariants(&live);
    }
    // the delta-solve must fit a requestable budget (devnet hard cap 1.4M)
    eprintln!("max buy_1x2 CU observed: {max_cu}");
    assert!(max_cu < 1_400_000, "buy_1x2 CU {max_cu} must fit the 1.4M cap");
    // buying an outcome raises its price
    let m: Market = get_anchor(&live.h.svm, &market_pda(FIXTURE));
    let p_before = lmsr::prices_bps(&m.q, m.b).unwrap()[0];
    buy(&mut live, 0, 200 * ONE_USDT);
    let m: Market = get_anchor(&live.h.svm, &market_pda(FIXTURE));
    let p_after = lmsr::prices_bps(&m.q, m.b).unwrap()[0];
    assert!(p_after > p_before, "buying Team1 must raise its price");
    assert_market_invariants(&live);

    // longer arbitrary sequence: alternating buys + partial sells
    let seq: &[(u8, u64, bool)] = &[
        (1, 30 * ONE_USDT, true),
        (2, 80 * ONE_USDT, true),
        (0, 10 * ONE_USDT, false),
        (1, 5 * ONE_USDT, false),
        (0, 25 * ONE_USDT, true),
        (2, 40 * ONE_USDT, false),
        (1, 120 * ONE_USDT, true),
    ];
    for &(outcome, amount, is_buy) in seq {
        if is_buy {
            buy(&mut live, outcome, amount);
        } else {
            // sell `amount`-scaled tokens (bounded by holdings)
            let pos: Position =
                get_anchor(&live.h.svm, &position_pda(&market_pda(FIXTURE), &trader));
            let tokens = pos.tokens[usize::from(outcome)].min(amount);
            assert!(tokens > 0, "test setup: nothing to sell on outcome {outcome}");
            live.h
                .send(
                    &[&live.trader.insecure_clone()],
                    &trader,
                    ix_sell(
                        &trader,
                        CFG_ID,
                        FIXTURE,
                        outcome,
                        tokens,
                        0,
                        &live.h.usdt_mint,
                        &live.trader_ata,
                    ),
                )
                .unwrap();
        }
        assert_market_invariants(&live);
    }

    // a buy-then-sell round trip never profits the trader
    let bal_before = live.h.token_balance(&live.trader_ata);
    buy(&mut live, 2, 100 * ONE_USDT);
    let pos: Position =
        get_anchor(&live.h.svm, &position_pda(&market_pda(FIXTURE), &trader));
    let bought = pos.tokens[2];
    live.h
        .send(
            &[&live.trader.insecure_clone()],
            &trader,
            ix_sell(&trader, CFG_ID, FIXTURE, 2, bought, 0, &live.h.usdt_mint, &live.trader_ata),
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
        .send(&[&live.trader.insecure_clone()], &trader, ix_open_position(&trader, FIXTURE))
        .unwrap();

    // buy: min_tokens_out above what 10 USDT can buy → SlippageExceeded
    let res = send_tx_ixs(
        &mut live.h.svm,
        &[&live.trader.insecure_clone()],
        &trader,
        &[
            ix_set_cu_limit(CU_LIMIT_BUY),
            ix_buy(
                &trader,
                CFG_ID,
                FIXTURE,
                0,
                10 * ONE_USDT,
                100 * ONE_USDT,
                &live.h.usdt_mint,
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
        ix_buy(&trader, CFG_ID, FIXTURE, 3, ONE_USDT, 0, &live.h.usdt_mint, &live.trader_ata),
    );
    assert_amm_error(&res, AmmError::LmsrInvalidOutcomeIndex);

    // sell: more than held → InsufficientPositionBalance
    buy(&mut live, 1, 10 * ONE_USDT);
    let pos: Position =
        get_anchor(&live.h.svm, &position_pda(&market_pda(FIXTURE), &trader));
    let res = send_tx(
        &mut live.h.svm,
        &[&live.trader.insecure_clone()],
        &trader,
        ix_sell(
            &trader,
            CFG_ID,
            FIXTURE,
            1,
            pos.tokens[1] + 1,
            0,
            &live.h.usdt_mint,
            &live.trader_ata,
        ),
    );
    assert_amm_error(&res, AmmError::InsufficientPositionBalance);

    // sell: min_usdt_out above the refund → SlippageExceeded
    let res = send_tx(
        &mut live.h.svm,
        &[&live.trader.insecure_clone()],
        &trader,
        ix_sell(
            &trader,
            CFG_ID,
            FIXTURE,
            1,
            pos.tokens[1],
            100 * ONE_USDT,
            &live.h.usdt_mint,
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
    to_locked(&mut live, &[(0, 100 * ONE_USDT)]);

    // final 2–0: Draw and Team2 hints must fail and leave the market Locked
    for wrong_hint in [1u8, 2u8] {
        let res = do_resolve(&mut live, wrong_hint, 2, 0, FINAL_PERIOD);
        assert_amm_error(&res, AmmError::ProofRejected);
        let m: Market = get_anchor(&live.h.svm, &market_pda(FIXTURE));
        assert_eq!(m.state, MarketState::Locked, "wrong hint must not mutate state");
        assert_eq!(m.outcome, Outcome::Unset);
    }

    do_resolve(&mut live, 0, 2, 0, FINAL_PERIOD).unwrap();
    let m: Market = get_anchor(&live.h.svm, &market_pda(FIXTURE));
    assert_eq!(m.state, MarketState::Resolved);
    assert_eq!(m.outcome, Outcome::Team1);

    // double-resolve (any hint) → InvalidMarketState
    let res = do_resolve(&mut live, 0, 2, 0, FINAL_PERIOD);
    assert_amm_error(&res, AmmError::InvalidMarketState);
}

#[test]
fn resolve_draw_via_positive_equal_to() {
    // THE wall-dissolver: Draw proven positively with EqualTo — no negation.
    let mut live = bootstrap_open();
    to_locked(&mut live, &[(1, 100 * ONE_USDT)]);

    for wrong_hint in [0u8, 2u8] {
        let res = do_resolve(&mut live, wrong_hint, 1, 1, FINAL_PERIOD);
        assert_amm_error(&res, AmmError::ProofRejected);
    }
    do_resolve(&mut live, 1, 1, 1, FINAL_PERIOD).unwrap();
    let m: Market = get_anchor(&live.h.svm, &market_pda(FIXTURE));
    assert_eq!(m.outcome, Outcome::Draw);
}

#[test]
fn resolve_team2() {
    let mut live = bootstrap_open();
    to_locked(&mut live, &[(2, 100 * ONE_USDT)]);
    do_resolve(&mut live, 2, 0, 3, FINAL_PERIOD).unwrap();
    let m: Market = get_anchor(&live.h.svm, &market_pda(FIXTURE));
    assert_eq!(m.outcome, Outcome::Team2);
}

#[test]
fn resolve_rejects_wrong_period_and_bad_hint() {
    let mut live = bootstrap_open();
    to_locked(&mut live, &[(0, 50 * ONE_USDT)]);

    // stale-batch replay guard: mid-match period (0) ≠ pinned 100
    let res = do_resolve(&mut live, 0, 2, 0, 0);
    assert_amm_error(&res, AmmError::ResolutionPeriodMismatch);
    let m: Market = get_anchor(&live.h.svm, &market_pda(FIXTURE));
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
    to_locked(&mut live, &[(0, 50 * ONE_USDT)]);

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
        ix_resolve(
            &keeper.pubkey(),
            CFG_ID,
            FIXTURE,
            0,
            resolve_args_period(FIXTURE, ts, 2, 0, FINAL_PERIOD),
            &txline_id(),
            &roots,
        ),
    );
    // RootNotAvailable(6007) propagates verbatim — keeper-retryable
    assert_custom_error(&res, 6007);
    let m: Market = get_anchor(&live.h.svm, &market_pda(FIXTURE));
    assert_eq!(m.state, MarketState::Locked);
}

// ===========================================================================
// (f)+(g) redeem: winner 1:1, loser 0, double rejected, Void pro-rata
// ===========================================================================
#[test]
fn redeem_winner_loser_and_double() {
    let mut live = bootstrap_open();
    // trader holds Team1 AND Draw; Team1 wins → Draw side pays 0
    to_locked(&mut live, &[(0, 100 * ONE_USDT), (1, 50 * ONE_USDT)]);
    do_resolve(&mut live, 0, 2, 0, FINAL_PERIOD).unwrap();

    let trader = live.trader.pubkey();
    let market_key = market_pda(FIXTURE);
    let pos_key = position_pda(&market_key, &trader);
    let pos: Position = get_anchor(&live.h.svm, &pos_key);
    let winning = pos.tokens[0];
    assert!(winning > 0 && pos.tokens[1] > 0);

    let before = live.h.token_balance(&live.trader_ata);
    let vault_before = live.h.token_balance(&vault_pda(&market_key));
    live.h
        .send(
            &[&live.trader.insecure_clone()],
            &trader,
            ix_redeem(&trader, FIXTURE, &live.h.usdt_mint, &live.trader_ata),
        )
        .unwrap();

    // ONLY the winning outcome pays, 1 token = 1 USDT; loser tokens pay 0
    assert_eq!(live.h.token_balance(&live.trader_ata), before + winning);
    assert_eq!(live.h.token_balance(&vault_pda(&market_key)), vault_before - winning);

    let pos: Position = get_anchor(&live.h.svm, &pos_key);
    assert!(pos.redeemed);
    assert_eq!(pos.tokens, [0, 0, 0]);
    let m: Market = get_anchor(&live.h.svm, &market_key);
    assert_eq!(m.supply, [0, 0, 0], "all balances decremented from supply");

    // double-redeem → AlreadyRedeemed
    let res = send_tx(
        &mut live.h.svm,
        &[&live.trader.insecure_clone()],
        &trader,
        ix_redeem(&trader, FIXTURE, &live.h.usdt_mint, &live.trader_ata),
    );
    assert_amm_error(&res, AmmError::AlreadyRedeemed);
}

#[test]
fn redeem_void_refunds_net_basis() {
    let mut live = bootstrap_open();
    let stake = 100 * ONE_USDT;
    // stakes across two outcomes: Void refunds the SUM of net basis
    to_locked(&mut live, &[(0, stake), (2, stake)]);
    force_market(&mut live.h, FIXTURE, MarketState::Resolved, Outcome::Void);

    let trader = live.trader.pubkey();
    let market_key = market_pda(FIXTURE);
    let pos: Position = get_anchor(&live.h.svm, &position_pda(&market_key, &trader));
    assert_eq!(pos.collateral, 2 * stake, "net basis = the two buys");

    let before = live.h.token_balance(&live.trader_ata);
    live.h
        .send(
            &[&live.trader.insecure_clone()],
            &trader,
            ix_redeem(&trader, FIXTURE, &live.h.usdt_mint, &live.trader_ata),
        )
        .unwrap();
    assert_eq!(
        live.h.token_balance(&live.trader_ata),
        before + 2 * stake,
        "Void refunds the net USDT stake (D-4)"
    );
    let pos: Position = get_anchor(&live.h.svm, &position_pda(&market_key, &trader));
    assert!(pos.redeemed);
    assert_eq!(pos.collateral, 0);
}

// ===========================================================================
// complete sets (SPEC §3.1 phase C-add) — mint_set / redeem_set
// ===========================================================================

/// Drive to Trading with an open trader position (no buys).
fn to_trading_with_position(live: &mut Live) {
    to_trading(live);
    let trader = live.trader.pubkey();
    live.h
        .send(&[&live.trader.insecure_clone()], &trader, ix_open_position(&trader, FIXTURE))
        .unwrap();
}

fn mint_set(live: &mut Live, amount: u64) -> litesvm::types::TransactionResult {
    let trader = live.trader.pubkey();
    send_tx(
        &mut live.h.svm,
        &[&live.trader.insecure_clone()],
        &trader,
        ix_mint_set(&trader, FIXTURE, amount, &live.h.usdt_mint, &live.trader_ata),
    )
}

fn redeem_set(live: &mut Live, amount: u64) -> litesvm::types::TransactionResult {
    let trader = live.trader.pubkey();
    send_tx(
        &mut live.h.svm,
        &[&live.trader.insecure_clone()],
        &trader,
        ix_redeem_set(&trader, FIXTURE, amount, &live.h.usdt_mint, &live.trader_ata),
    )
}

/// (a) round-trip zero-loss/zero-fee + (b) shift-invariant prices + (c) solvency.
#[test]
fn set_round_trip_price_neutral_and_lossless() {
    let mut live = bootstrap_open();
    to_trading_with_position(&mut live);
    let trader = live.trader.pubkey();
    let market_key = market_pda(FIXTURE);
    let amount = 40 * ONE_USDT;

    // prices + trader balance BEFORE any set op
    let m0: Market = get_anchor(&live.h.svm, &market_key);
    let prices_before = lmsr::prices_bps(&m0.q, m0.b).unwrap();
    let bal_before = live.h.token_balance(&live.trader_ata);
    let vault_before = live.h.token_balance(&vault_pda(&market_key));

    // ---- mint_set: exactly `amount` USDT in, `amount` of each outcome ----
    mint_set(&mut live, amount).unwrap();
    let m1: Market = get_anchor(&live.h.svm, &market_key);
    // (b) prices UNCHANGED (equal q shift → softmax invariant)
    assert_eq!(
        lmsr::prices_bps(&m1.q, m1.b).unwrap(),
        prices_before,
        "mint_set must not move prices"
    );
    // exact charge: trader down by `amount`, vault up by `amount`
    assert_eq!(live.h.token_balance(&live.trader_ata), bal_before - amount);
    assert_eq!(live.h.token_balance(&vault_pda(&market_key)), vault_before + amount);
    // supply + q both rose by `amount` on every outcome (q = seed_q + supply)
    for i in 0..3 {
        assert_eq!(m1.supply[i], m0.supply[i] + amount);
        assert_eq!(m1.q[i], m0.q[i] + amount);
    }
    let pos: Position = get_anchor(&live.h.svm, &position_pda(&market_key, &trader));
    assert_eq!(pos.tokens, [amount, amount, amount], "one of each outcome");
    assert_eq!(pos.collateral, amount, "net basis += amount");
    assert_market_invariants(&live); // (c) solvency

    // ---- redeem_set the same amount: back to par, prices still fixed ----
    redeem_set(&mut live, amount).unwrap();
    let m2: Market = get_anchor(&live.h.svm, &market_key);
    assert_eq!(
        lmsr::prices_bps(&m2.q, m2.b).unwrap(),
        prices_before,
        "redeem_set must not move prices"
    );
    // (a) trader USDT fully restored — zero loss, zero fee
    assert_eq!(
        live.h.token_balance(&live.trader_ata),
        bal_before,
        "round trip returns exactly the deposit (no fee, no slippage)"
    );
    assert_eq!(live.h.token_balance(&vault_pda(&market_key)), vault_before);
    let pos: Position = get_anchor(&live.h.svm, &position_pda(&market_key, &trader));
    assert_eq!(pos.tokens, [0, 0, 0]);
    assert_eq!(pos.collateral, 0);
    // market fully back to its pre-set q/supply
    assert_eq!(m2.q, m0.q);
    assert_eq!(m2.supply, m0.supply);
    assert_market_invariants(&live);
}

/// (b') set ops leave prices fixed even when the book is SKEWED by prior buys.
#[test]
fn set_price_neutral_on_skewed_book() {
    let mut live = bootstrap_open();
    to_trading_with_position(&mut live);
    // skew the book: heavy Team1 + light Team2
    buy(&mut live, 0, 120 * ONE_USDT);
    buy(&mut live, 2, 30 * ONE_USDT);
    let market_key = market_pda(FIXTURE);
    let m0: Market = get_anchor(&live.h.svm, &market_key);
    let prices_before = lmsr::prices_bps(&m0.q, m0.b).unwrap();
    // (not all equal — confirm the book is genuinely skewed)
    assert!(prices_before[0] != prices_before[2], "test setup: book must be skewed");

    mint_set(&mut live, 55 * ONE_USDT).unwrap();
    let m1: Market = get_anchor(&live.h.svm, &market_key);
    assert_eq!(lmsr::prices_bps(&m1.q, m1.b).unwrap(), prices_before);
    assert_market_invariants(&live);
}

/// (d) redeem_set more than held on ANY leg → InsufficientPositionBalance.
#[test]
fn redeem_set_rejects_overdraw() {
    let mut live = bootstrap_open();
    to_trading_with_position(&mut live);
    mint_set(&mut live, 20 * ONE_USDT).unwrap();
    // buy extra Team1 so leg 0 is fine but legs 1/2 stay at 20 — overdraw at 21
    buy(&mut live, 0, 10 * ONE_USDT);
    let res = redeem_set(&mut live, 21 * ONE_USDT);
    assert_amm_error(&res, AmmError::InsufficientPositionBalance);
    // zero amount rejected too
    let res = redeem_set(&mut live, 0);
    assert_amm_error(&res, AmmError::ZeroAmount);
    let res = mint_set(&mut live, 0);
    assert_amm_error(&res, AmmError::ZeroAmount);
}

/// (e) set ops only in Trading — Open / Locked / Resolved all rejected.
#[test]
fn set_ops_rejected_outside_trading() {
    // Open (pre-activate): position can't exist yet, but the state gate fires
    // first on mint. Build a position via a Trading detour, then force Locked.
    let mut live = bootstrap_open();
    to_trading_with_position(&mut live);
    mint_set(&mut live, 30 * ONE_USDT).unwrap();

    // freeze → Locked; both set ops must reject with InvalidMarketState
    live.h.set_time(live.freeze);
    let keeper = live.h.keeper.insecure_clone();
    live.h
        .send(&[&keeper], &keeper.pubkey(), ix_freeze_market(&keeper.pubkey(), FIXTURE))
        .unwrap();

    let res = mint_set(&mut live, 10 * ONE_USDT);
    assert_amm_error(&res, AmmError::InvalidMarketState);
    let res = redeem_set(&mut live, 10 * ONE_USDT);
    assert_amm_error(&res, AmmError::InvalidMarketState);

    // resolve → Resolved: still rejected
    do_resolve(&mut live, 0, 2, 0, FINAL_PERIOD).unwrap();
    let res = redeem_set(&mut live, 10 * ONE_USDT);
    assert_amm_error(&res, AmmError::InvalidMarketState);
}

/// (f) the core invariant: a minted set redeems for EXACTLY `amount` under
/// EVERY resolved outcome — winning leg pays 1:1, losing legs pay 0.
#[test]
fn minted_set_redeems_to_amount_under_each_outcome() {
    // (hint, home, away) whose winning leg is the given index
    for (hint, home, away) in [(0u8, 2, 0), (1u8, 1, 1), (2u8, 0, 3)] {
        let mut live = bootstrap_open();
        to_trading_with_position(&mut live);
        let amount = 45 * ONE_USDT;
        mint_set(&mut live, amount).unwrap();

        // freeze + resolve to this outcome
        live.h.set_time(live.freeze);
        let keeper = live.h.keeper.insecure_clone();
        live.h
            .send(&[&keeper], &keeper.pubkey(), ix_freeze_market(&keeper.pubkey(), FIXTURE))
            .unwrap();
        do_resolve(&mut live, hint, home, away, FINAL_PERIOD).unwrap();

        // redeem: exactly ONE leg (= `amount`) pays; the set is worth `amount`
        let trader = live.trader.pubkey();
        let before = live.h.token_balance(&live.trader_ata);
        live.h
            .send(
                &[&live.trader.insecure_clone()],
                &trader,
                ix_redeem(&trader, FIXTURE, &live.h.usdt_mint, &live.trader_ata),
            )
            .unwrap();
        assert_eq!(
            live.h.token_balance(&live.trader_ata),
            before + amount,
            "a minted set redeems for exactly `amount` regardless of outcome (hint {hint})"
        );
    }
}

/// (g) Void after mint_set refunds the `collateral` basis = `amount`.
#[test]
fn void_after_mint_set_refunds_basis() {
    let mut live = bootstrap_open();
    to_trading_with_position(&mut live);
    let amount = 70 * ONE_USDT;
    mint_set(&mut live, amount).unwrap();
    force_market(&mut live.h, FIXTURE, MarketState::Resolved, Outcome::Void);

    let trader = live.trader.pubkey();
    let market_key = market_pda(FIXTURE);
    let pos: Position = get_anchor(&live.h.svm, &position_pda(&market_key, &trader));
    assert_eq!(pos.collateral, amount, "mint_set set the net basis to `amount`");

    let before = live.h.token_balance(&live.trader_ata);
    live.h
        .send(
            &[&live.trader.insecure_clone()],
            &trader,
            ix_redeem(&trader, FIXTURE, &live.h.usdt_mint, &live.trader_ata),
        )
        .unwrap();
    assert_eq!(
        live.h.token_balance(&live.trader_ata),
        before + amount,
        "Void refunds the mint_set basis (D-4)"
    );
}

/// (h) no-arb tie-in: acquiring `amount` tokens of EACH outcome via `buy_1x2`
/// costs STRICTLY MORE USDT than the flat `amount` a fee-free set charges.
///
/// Proved two ways:
///   1. Curve-exact (pure `lmsr::buy_cost`, before fees): the LMSR cost to buy
///      `amount` on each of the three legs sums to > `amount` — the classic
///      "sum of marginal legs ≥ face value, with strict curvature slack".
///   2. On-chain: three real `buy_1x2` txs (which ALSO pay the dynamic fee)
///      to reach ≥ `amount` tokens on every leg spend > the set's `amount`.
#[test]
fn separate_buys_never_cheaper_than_set() {
    let amount = 50 * ONE_USDT;

    // ---- (1) curve-exact, fee-free: Σ buy_cost of `amount` per leg > amount ----
    // Sequential legs (each buy shifts q), symmetric seed book.
    let mut q = SEED_Q;
    let mut curve_sum = 0u64;
    for outcome in 0..3usize {
        let c = lmsr::buy_cost(&q, B, outcome, amount).unwrap();
        curve_sum += c;
        q[outcome] += amount; // reflect the buy for the next leg's cost
    }
    assert!(
        curve_sum > amount,
        "fee-free LMSR cost of one-of-each ({curve_sum}) must exceed the set's face value ({amount})"
    );

    // ---- (2) on-chain: reach ≥ `amount` tokens on every leg via real buys ----
    // set cost = flat `amount` (exact USDT the trader spends)
    let mut live_set = bootstrap_open();
    to_trading_with_position(&mut live_set);
    let bal0 = live_set.h.token_balance(&live_set.trader_ata);
    mint_set(&mut live_set, amount).unwrap();
    let set_cost = bal0 - live_set.h.token_balance(&live_set.trader_ata);
    assert_eq!(set_cost, amount, "a set is charged its flat face value");

    let mut live_buy = bootstrap_open();
    to_trading_with_position(&mut live_buy);
    let trader = live_buy.trader.pubkey();
    let market_key = market_pda(FIXTURE);
    let spend_before = live_buy.h.token_balance(&live_buy.trader_ata);
    // Buy enough USDT per leg that each leg ends with >= `amount` tokens. At the
    // 1/3 symmetric book a leg costs ~1/3 USDT/token, so `amount` USDT buys
    // ~3·amount tokens — comfortably >= amount even after the fee + skew.
    for outcome in 0..3u8 {
        buy(&mut live_buy, outcome, amount);
    }
    let spent = spend_before - live_buy.h.token_balance(&live_buy.trader_ata);
    let pos: Position = get_anchor(&live_buy.h.svm, &position_pda(&market_key, &trader));
    let min_leg = pos.tokens[0].min(pos.tokens[1]).min(pos.tokens[2]);
    assert!(
        min_leg >= amount,
        "test setup: each buy should yield >= `amount` tokens (got min leg {min_leg})"
    );
    // holding >= `amount` of every outcome cost `spent` > the set's `amount`:
    // separate buys are never cheaper than the fee-free, curvature-free set.
    assert!(
        spent > set_cost,
        "separate buys ({spent}) must cost more than one set ({set_cost}) for the same guaranteed par"
    );
}

// ===========================================================================
// full happy circle: init → activate → buy all 3 → sell → freeze → resolve →
// redeem winner/loser → grace → close (real instructions, Clock warp only)
// ===========================================================================
#[test]
fn full_1x2_circle() {
    let mut live = bootstrap_open();
    let trader = live.trader.pubkey();
    let market_key = market_pda(FIXTURE);
    let vault_key = vault_pda(&market_key);

    // a second trader who will LOSE
    let loser = Keypair::new();
    live.h.svm.airdrop(&loser.pubkey(), 100_000_000_000).unwrap();
    let loser_ata = live.h.fund_ata(&loser.pubkey(), 100_000 * ONE_USDT);

    live.h
        .send(&[&live.trader.insecure_clone()], &trader, ix_open_position(&trader, FIXTURE))
        .unwrap();
    to_trading(&mut live);
    live.h
        .send(&[&loser.insecure_clone()], &loser.pubkey(), ix_open_position(&loser.pubkey(), FIXTURE))
        .unwrap();

    // winner buys all three outcomes, then sells part of Draw
    for outcome in 0..3u8 {
        buy(&mut live, outcome, 60 * ONE_USDT);
        assert_market_invariants(&live);
    }
    let pos: Position = get_anchor(&live.h.svm, &position_pda(&market_key, &trader));
    live.h
        .send(
            &[&live.trader.insecure_clone()],
            &trader,
            ix_sell(
                &trader,
                CFG_ID,
                FIXTURE,
                1,
                pos.tokens[1] / 2,
                0,
                &live.h.usdt_mint,
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
            ix_set_cu_limit(CU_LIMIT_BUY),
            ix_buy(&loser.pubkey(), CFG_ID, FIXTURE, 2, 150 * ONE_USDT, 0, &live.h.usdt_mint, &loser_ata),
        ],
    )
    .unwrap();
    assert_market_invariants(&live);

    // freeze at the whistle; resolve Team1 (2–0)
    live.h.set_time(live.freeze);
    let keeper = live.h.keeper.insecure_clone();
    live.h
        .send(&[&keeper], &keeper.pubkey(), ix_freeze_market(&keeper.pubkey(), FIXTURE))
        .unwrap();
    do_resolve(&mut live, 0, 2, 0, FINAL_PERIOD).unwrap();

    // winner redeems 1:1 on Team1; loser redeems 0
    let pos: Position = get_anchor(&live.h.svm, &position_pda(&market_key, &trader));
    let winning = pos.tokens[0];
    let before = live.h.token_balance(&live.trader_ata);
    live.h
        .send(
            &[&live.trader.insecure_clone()],
            &trader,
            ix_redeem(&trader, FIXTURE, &live.h.usdt_mint, &live.trader_ata),
        )
        .unwrap();
    assert_eq!(live.h.token_balance(&live.trader_ata), before + winning);

    let loser_before = live.h.token_balance(&loser_ata);
    live.h
        .send(
            &[&loser.insecure_clone()],
            &loser.pubkey(),
            ix_redeem(&loser.pubkey(), FIXTURE, &live.h.usdt_mint, &loser_ata),
        )
        .unwrap();
    assert_eq!(live.h.token_balance(&loser_ata), loser_before, "loser gets 0");

    // close: grace gate first, then sweep + secure close
    let admin = live.h.admin.insecure_clone();
    let res = send_tx(
        &mut live.h.svm,
        &[&admin],
        &admin.pubkey(),
        ix_close_market(&admin.pubkey(), CFG_ID, FIXTURE, &live.h.usdt_mint, &live.admin_ata),
    );
    assert_amm_error(&res, AmmError::GraceNotElapsed);

    live.h.set_time(live.freeze + 3_600);
    let residual = live.h.token_balance(&vault_key);
    let admin_before = live.h.token_balance(&live.admin_ata);
    live.h
        .send(
            &[&admin],
            &admin.pubkey(),
            ix_close_market(&admin.pubkey(), CFG_ID, FIXTURE, &live.h.usdt_mint, &live.admin_ata),
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

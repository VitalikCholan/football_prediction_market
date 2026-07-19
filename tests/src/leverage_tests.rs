//! LiteSVM tests for the v1 no-liquidation leverage layer
//! (plans/leverage-v1.md §7 verification list).
//!
//! Markets run through the REAL lifecycle instructions with Clock warping,
//! exactly like `onextwo_tests.rs`; resolution uses the shared mock TxLINE
//! oracle. Every expected payout / funding / share value is recomputed with
//! the SAME pure functions the program uses (`amm::funding::*`) — no
//! hand-rolled math in assertions.
//!
//! Void is forced via account patch (same pattern as the 1X2 suite — there
//! is no on-chain Void instruction yet).

use anchor_lang::prelude::Pubkey;
use solana_keypair::Keypair;
use solana_signer::Signer;

use amm::constants::{
    BPS_DENOM, LP_WITHDRAW_DELAY_SECS, VALVE_MAX_DURATION_SECS, VALVE_MAX_MULTIPLIER_BPS,
};
use amm::error::AmmError;
use amm::funding;
use amm::state::{LeveragePool, LevPosition, LpAccount, Market, MarketConfig, MarketState, Outcome};

use crate::common::*;

const CFG_ID: u16 = 7;
const FIXTURE: i64 = 18_179_549;

/// Spot-market seeding (identical to the 1X2 suite — the leverage layer
/// never touches the spot escrow, these just make the market real).
const B: u64 = 100 * ONE_USDT;
const SEED_Q: [u64; 3] = [0, 0, 0];
const SEED_LIQ: u64 = 200 * ONE_USDT;

/// Long freeze horizon: leaves plenty of room outside the 600s leverage
/// cutoff and keeps `t_remaining` large (slow funding at the default slope).
const HORIZON: i64 = 100_000;

/// Default opening marks: Team1 40¢, Draw/Team2 30¢ each.
const MARKS0: [u16; 3] = [4_000, 3_000, 3_000];
/// Neutral valve multiplier (BPS_DENOM) for `funding::idx_delta` expectations.
const NEUTRAL: u16 = BPS_DENOM as u16;

struct Lev {
    h: Harness,
    trader: Keypair,
    trader_ata: Pubkey,
    lp: Keypair,
    lp_ata: Pubkey,
    kickoff: i64,
    freeze: i64,
}

/// Bootstrap: config (leverage-enabled `params`) + market + leverage pool,
/// funded trader/LP wallets. Market is left in `Open`.
fn bootstrap(params: amm::FeeParamsArgs) -> Lev {
    let mut live = bootstrap_without_pool(params);
    let admin = live.h.admin.insecure_clone();
    let mint = live.h.usdt_mint;
    live.h
        .send(
            &[&admin],
            &admin.pubkey(),
            ix_init_leverage_pool(&admin.pubkey(), CFG_ID, FIXTURE, &mint),
        )
        .unwrap();
    live
}

/// `bootstrap` minus `init_leverage_pool` — the `update_leverage_params`
/// retro-enable tests start from a leverage-DISABLED config where pool
/// creation must fail first.
fn bootstrap_without_pool(params: amm::FeeParamsArgs) -> Lev {
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
        ix_create_market_config(&admin, CFG_ID, params, FINAL_PERIOD),
    )
    .unwrap();

    let admin_ata = h.fund_ata(&admin, 1_000_000 * ONE_USDT);
    let kickoff = h.now() + 100;
    let freeze = h.now() + HORIZON;
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
    let lp = Keypair::new();
    h.svm.airdrop(&lp.pubkey(), 100_000_000_000).unwrap();
    let lp_ata = h.fund_ata(&lp.pubkey(), 100_000 * ONE_USDT);

    Lev { h, trader, trader_ata, lp, lp_ata, kickoff, freeze }
}

fn to_trading(live: &mut Lev) {
    live.h.set_time(live.kickoff);
    let keeper = live.h.keeper.insecure_clone();
    live.h
        .send(&[&keeper], &keeper.pubkey(), ix_activate_market(&keeper.pubkey(), FIXTURE))
        .unwrap();
}

fn post_mark(live: &mut Lev, marks: [u16; 3]) -> litesvm::types::TransactionResult {
    let keeper = live.h.keeper.insecure_clone();
    live.h.send(
        &[&keeper],
        &keeper.pubkey(),
        ix_post_mark(&keeper.pubkey(), CFG_ID, FIXTURE, marks),
    )
}

/// One-time LP onboarding: `open_lp_account` + first `deposit_lp`.
fn lp_join(live: &mut Lev, amount: u64) {
    let lp = live.lp.insecure_clone();
    live.h
        .send(&[&lp], &lp.pubkey(), ix_open_lp_account(&lp.pubkey(), FIXTURE))
        .unwrap();
    live.h
        .send(
            &[&lp],
            &lp.pubkey(),
            ix_deposit_lp(&lp.pubkey(), FIXTURE, amount, &live.h.usdt_mint, &live.lp_ata),
        )
        .unwrap();
}

fn open_leverage(
    live: &mut Lev,
    outcome: u8,
    collateral: u64,
    leverage: u16,
) -> litesvm::types::TransactionResult {
    let trader = live.trader.insecure_clone();
    live.h.send(
        &[&trader],
        &trader.pubkey(),
        ix_open_leverage(
            &trader.pubkey(),
            CFG_ID,
            FIXTURE,
            outcome,
            collateral,
            leverage,
            &live.h.usdt_mint,
            &live.trader_ata,
        ),
    )
}

fn close_leverage(live: &mut Lev) -> litesvm::types::TransactionResult {
    let trader = live.trader.insecure_clone();
    live.h.send(
        &[&trader],
        &trader.pubkey(),
        ix_close_leverage(&trader.pubkey(), CFG_ID, FIXTURE, &live.h.usdt_mint, &live.trader_ata),
    )
}

fn pool_state(live: &Lev) -> LeveragePool {
    get_anchor(&live.h.svm, &lev_pool_pda(&market_pda(FIXTURE)))
}

fn lev_vault_balance(live: &Lev) -> u64 {
    live.h.token_balance(&lev_vault_pda(&market_pda(FIXTURE)))
}

/// Assert a closed-account shape (same tolerance as the 1X2 close test:
/// LiteSVM may keep a zero-lamport / zeroed shell).
fn assert_account_closed(live: &Lev, key: &Pubkey, what: &str) {
    let acc = live.h.svm.get_account(key);
    assert!(
        acc.map_or(true, |a| a.lamports == 0 || a.data.iter().all(|b| *b == 0)),
        "{what} account must be closed"
    );
}

/// Patch the Market state/outcome directly — only for Void, which has no
/// on-chain instruction path yet (same pattern as `onextwo_tests.rs`).
fn force_market(h: &mut Harness, state: MarketState, outcome: Outcome) {
    let market_key = market_pda(FIXTURE);
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

/// Freeze at `freeze_ts` + resolve via the mock oracle (hint/score picks the
/// winner; stats carry the pinned FINAL_PERIOD).
fn freeze_and_resolve(live: &mut Lev, hint: u8, home: i32, away: i32) {
    live.h.set_time(live.freeze);
    let keeper = live.h.keeper.insecure_clone();
    live.h
        .send(&[&keeper], &keeper.pubkey(), ix_freeze_market(&keeper.pubkey(), FIXTURE))
        .unwrap();
    let ts = live.h.now();
    let roots = write_roots_account(&mut live.h.svm, &txline_id(), epoch_day(ts), 0x00);
    live.h
        .send(
            &[&keeper],
            &keeper.pubkey(),
            ix_resolve(
                &keeper.pubkey(),
                CFG_ID,
                FIXTURE,
                hint,
                resolve_args_period(FIXTURE, ts, home, away, FINAL_PERIOD),
                &txline_id(),
                &roots,
            ),
        )
        .unwrap();
}

// ===========================================================================
// (1) happy path: open → mark up → close pays C + pnl − F, pool books clear
// ===========================================================================
#[test]
fn happy_path_open_mark_up_close() {
    let mut live = bootstrap(leverage_fee_params());
    let deposit = 10_000 * ONE_USDT;
    lp_join(&mut live, deposit);
    to_trading(&mut live);

    let t1 = live.h.now();
    post_mark(&mut live, MARKS0).unwrap(); // first post: initializes, no accrual

    let collateral = 100 * ONE_USDT;
    let leverage = 3u16;
    let entry = MARKS0[0];
    open_leverage(&mut live, 0, collateral, leverage).unwrap();

    // position + pool exposure booked exactly as funding.rs sizes them
    let market_key = market_pda(FIXTURE);
    let pos_key = lev_position_pda(&market_key, &live.trader.pubkey());
    let notional = collateral * u64::from(leverage);
    let units = funding::units_for(collateral, leverage, entry).unwrap();
    let max_gain = funding::max_gain(units, entry).unwrap();
    let pos: LevPosition = get_anchor(&live.h.svm, &pos_key);
    assert_eq!(pos.outcome_idx, 0);
    assert_eq!(pos.leverage, leverage);
    assert_eq!(pos.collateral, collateral);
    assert_eq!(pos.notional, notional);
    assert_eq!(pos.units, units);
    assert_eq!(pos.entry_mark_bps, entry);
    assert_eq!(pos.funding_index_snap, 0, "first post initialized the index at 0");
    let pool = pool_state(&live);
    assert_eq!(pool.open_interest, notional);
    assert_eq!(pool.total_max_payout, max_gain);
    assert_eq!(lev_vault_balance(&live), deposit + collateral);

    // ---- warp one funding epoch, mark UP: 4000 → 5000 ----
    let t2 = t1 + 120;
    live.h.set_time(t2);
    post_mark(&mut live, [5_000, 2_500, 2_500]).unwrap();

    // expected funding: one segment priced at the PREVIOUS mark (4000)
    let params = leverage_fee_params();
    let idx0 =
        funding::idx_delta(params.time_fee_num, entry, t2 - t1, live.freeze - t2, NEUTRAL)
            .unwrap();
    let pool = pool_state(&live);
    assert_eq!(pool.cum_funding_index[0], idx0);
    let funding_owed = funding::funding_accrued(notional, idx0, 0).unwrap();
    assert!(funding_owed > 0, "a nonzero segment must never be free");

    // expected payout: C + pnl(5000) − F
    let pnl = funding::pnl(units, entry, 5_000).unwrap();
    assert!(pnl > 0, "mark moved up — pnl must be positive");
    let payout = funding::settle_payout(collateral, pnl, funding_owed);

    let ata_before = live.h.token_balance(&live.trader_ata);
    let lamports_before = live.h.svm.get_balance(&live.trader.pubkey()).unwrap();
    close_leverage(&mut live).unwrap();

    assert_eq!(
        live.h.token_balance(&live.trader_ata),
        ata_before + payout,
        "close pays exactly the funding-model payout"
    );
    assert_eq!(lev_vault_balance(&live), deposit + collateral - payout);
    let pool = pool_state(&live);
    assert_eq!(pool.open_interest, 0, "OI released");
    assert_eq!(pool.total_max_payout, 0, "liability released");
    assert_account_closed(&live, &pos_key, "LevPosition");
    assert!(
        live.h.svm.get_balance(&live.trader.pubkey()).unwrap() > lamports_before,
        "position rent must return to the owner"
    );
}

// ===========================================================================
// (2) fee-death: expire gated on F ≥ C; permissionless crank pays the OWNER
// ===========================================================================
#[test]
fn fee_death_expire_by_third_party_cranker() {
    // steep theta so two 60s epochs eat a small collateral
    let params = amm::FeeParamsArgs { time_fee_num: 50_000, ..leverage_fee_params() };
    let mut live = bootstrap(params.clone());
    lp_join(&mut live, 10_000 * ONE_USDT);
    to_trading(&mut live);

    let t1 = live.h.now();
    let marks = [5_000, 2_500, 2_500];
    post_mark(&mut live, marks).unwrap();

    let collateral = 10 * ONE_USDT;
    let leverage = 2u16;
    open_leverage(&mut live, 0, collateral, leverage).unwrap();
    let notional = collateral * u64::from(leverage);
    let units = funding::units_for(collateral, leverage, marks[0]).unwrap();

    let cranker = Keypair::new();
    live.h.svm.airdrop(&cranker.pubkey(), 100_000_000_000).unwrap();
    let cranker_pk = cranker.pubkey();
    let (mint, owner, owner_ata) = (live.h.usdt_mint, live.trader.pubkey(), live.trader_ata);
    let expire_ix =
        move || ix_expire_position(&cranker_pk, &owner, CFG_ID, FIXTURE, &mint, &owner_ata);

    // ---- BEFORE F ≥ C (no funding accrued yet): PositionNotExpired ----
    let res = send_tx(&mut live.h.svm, &[&cranker], &cranker.pubkey(), expire_ix());
    assert_amm_error(&res, AmmError::PositionNotExpired);

    // ---- several post_mark epochs at a flat mark until funding ≥ C ----
    let t2 = t1 + 60;
    live.h.set_time(t2);
    post_mark(&mut live, marks).unwrap();
    let t3 = t2 + 60;
    live.h.set_time(t3);
    post_mark(&mut live, marks).unwrap();

    let idx = funding::idx_delta(params.time_fee_num, marks[0], 60, live.freeze - t2, NEUTRAL)
        .unwrap()
        + funding::idx_delta(params.time_fee_num, marks[0], 60, live.freeze - t3, NEUTRAL)
            .unwrap();
    let pool = pool_state(&live);
    assert_eq!(pool.cum_funding_index[0], idx);
    let funding_owed = funding::funding_accrued(notional, idx, 0).unwrap();
    assert!(funding_owed >= collateral, "test setup: position must be fee-dead");

    // expected owner payout: max(0, pnl − (F − C)) — flat mark → pnl = 0 → 0
    let pnl = funding::pnl(units, marks[0], marks[0]).unwrap();
    assert_eq!(pnl, 0);
    let payout = funding::settle_payout(collateral, pnl, funding_owed);
    assert_eq!(payout, 0);

    let pos_key = lev_position_pda(&market_pda(FIXTURE), &live.trader.pubkey());
    let owner_ata_before = live.h.token_balance(&live.trader_ata);
    let owner_lamports_before = live.h.svm.get_balance(&live.trader.pubkey()).unwrap();
    let cranker_lamports_before = live.h.svm.get_balance(&cranker.pubkey()).unwrap();

    send_tx(&mut live.h.svm, &[&cranker], &cranker.pubkey(), expire_ix()).unwrap();

    assert_eq!(
        live.h.token_balance(&live.trader_ata),
        owner_ata_before + payout,
        "payout (0 here) goes to the OWNER's token account"
    );
    assert!(
        live.h.svm.get_balance(&live.trader.pubkey()).unwrap() > owner_lamports_before,
        "position rent goes to the OWNER, not the cranker"
    );
    assert!(
        live.h.svm.get_balance(&cranker.pubkey()).unwrap() <= cranker_lamports_before,
        "the cranker gains nothing (pays the tx fee)"
    );
    assert_account_closed(&live, &pos_key, "LevPosition");
    let pool = pool_state(&live);
    assert_eq!(pool.open_interest, 0);
    assert_eq!(pool.total_max_payout, 0);
}

// ===========================================================================
// (3) resolution settle: win pays C + max_gain − F; lose pays 0; Void C − F
// ===========================================================================
#[test]
fn resolved_win_and_lose_settle() {
    let mut live = bootstrap(leverage_fee_params());
    lp_join(&mut live, 10_000 * ONE_USDT);
    to_trading(&mut live);
    post_mark(&mut live, MARKS0).unwrap();

    // winner (harness trader): 3x on Team1 @ 4000
    let win_c = 100 * ONE_USDT;
    open_leverage(&mut live, 0, win_c, 3).unwrap();
    let win_units = funding::units_for(win_c, 3, MARKS0[0]).unwrap();
    let win_max_gain = funding::max_gain(win_units, MARKS0[0]).unwrap();

    // loser: 2x on Team2 @ 3000
    let loser = Keypair::new();
    live.h.svm.airdrop(&loser.pubkey(), 100_000_000_000).unwrap();
    let loser_ata = live.h.fund_ata(&loser.pubkey(), 1_000 * ONE_USDT);
    let lose_c = 50 * ONE_USDT;
    live.h
        .send(
            &[&loser.insecure_clone()],
            &loser.pubkey(),
            ix_open_leverage(
                &loser.pubkey(),
                CFG_ID,
                FIXTURE,
                2,
                lose_c,
                2,
                &live.h.usdt_mint,
                &loser_ata,
            ),
        )
        .unwrap();
    let lose_units = funding::units_for(lose_c, 2, MARKS0[2]).unwrap();

    // Team1 wins 2–0. No post_mark after the opens → F = 0 for both.
    freeze_and_resolve(&mut live, 0, 2, 0);

    // ---- winning position: p = BPS → payout = C + max_gain ----
    let win_pnl = funding::pnl(win_units, MARKS0[0], BPS_DENOM as u16).unwrap();
    assert_eq!(win_pnl, i64::try_from(win_max_gain).unwrap(), "pnl at p=BPS IS max_gain");
    let win_payout = funding::settle_payout(win_c, win_pnl, 0);
    assert_eq!(win_payout, win_c + win_max_gain);
    let before = live.h.token_balance(&live.trader_ata);
    close_leverage(&mut live).unwrap();
    assert_eq!(live.h.token_balance(&live.trader_ata), before + win_payout);

    // ---- losing position: p = 0 → payout = 0 ----
    let lose_pnl = funding::pnl(lose_units, MARKS0[2], 0).unwrap();
    let lose_payout = funding::settle_payout(lose_c, lose_pnl, 0);
    assert_eq!(lose_payout, 0);
    let before = live.h.token_balance(&loser_ata);
    live.h
        .send(
            &[&loser.insecure_clone()],
            &loser.pubkey(),
            ix_close_leverage(&loser.pubkey(), CFG_ID, FIXTURE, &live.h.usdt_mint, &loser_ata),
        )
        .unwrap();
    assert_eq!(live.h.token_balance(&loser_ata), before, "losing side pays 0");

    let pool = pool_state(&live);
    assert_eq!(pool.open_interest, 0);
    assert_eq!(pool.total_max_payout, 0);
}

#[test]
fn resolved_void_refunds_collateral_minus_funding() {
    let mut live = bootstrap(leverage_fee_params());
    lp_join(&mut live, 10_000 * ONE_USDT);
    to_trading(&mut live);
    let t1 = live.h.now();
    post_mark(&mut live, MARKS0).unwrap();

    let collateral = 100 * ONE_USDT;
    open_leverage(&mut live, 0, collateral, 3).unwrap();
    let notional = collateral * 3;

    // accrue one funding epoch so the Void refund is genuinely net of F
    let t2 = t1 + 300;
    live.h.set_time(t2);
    post_mark(&mut live, MARKS0).unwrap();
    let params = leverage_fee_params();
    let idx = funding::idx_delta(params.time_fee_num, MARKS0[0], t2 - t1, live.freeze - t2, NEUTRAL)
        .unwrap();
    let funding_owed = funding::funding_accrued(notional, idx, 0).unwrap();
    assert!(funding_owed > 0);

    // Void has no instruction path — patch, exactly like the 1X2 suite
    force_market(&mut live.h, MarketState::Resolved, Outcome::Void);

    // payout = max(0, C − F): pnl term is zero by definition on Void
    let payout = funding::settle_payout(collateral, 0, funding_owed);
    assert_eq!(payout, collateral - funding_owed);
    let before = live.h.token_balance(&live.trader_ata);
    close_leverage(&mut live).unwrap();
    assert_eq!(live.h.token_balance(&live.trader_ata), before + payout);
}

// ===========================================================================
// (4) guard rejections — one exact AmmError each
// ===========================================================================
#[test]
fn open_rejects_stale_mark() {
    let mut live = bootstrap(leverage_fee_params());
    lp_join(&mut live, 10_000 * ONE_USDT);
    to_trading(&mut live);
    let t1 = live.h.now();
    post_mark(&mut live, MARKS0).unwrap();

    // warp past max_mark_age (still well before the cutoff window)
    live.h.set_time(t1 + i64::from(leverage_fee_params().max_mark_age_secs) + 1);
    let res = open_leverage(&mut live, 0, 100 * ONE_USDT, 3);
    assert_amm_error(&res, AmmError::MarkStale);
}

#[test]
fn open_rejects_inside_cutoff_window() {
    let mut live = bootstrap(leverage_fee_params());
    lp_join(&mut live, 10_000 * ONE_USDT);
    to_trading(&mut live);
    post_mark(&mut live, MARKS0).unwrap();

    // at exactly freeze − cutoff the window has begun (guard is now < cutoff_ts);
    // the cutoff guard fires BEFORE mark freshness (plan §4 order)
    live.h.set_time(live.freeze - i64::from(leverage_fee_params().leverage_cutoff_secs));
    let res = open_leverage(&mut live, 0, 100 * ONE_USDT, 3);
    assert_amm_error(&res, AmmError::LeverageCutoff);
}

#[test]
fn open_rejects_while_valve_paused() {
    let mut live = bootstrap(leverage_fee_params());
    lp_join(&mut live, 10_000 * ONE_USDT);
    to_trading(&mut live);
    post_mark(&mut live, MARKS0).unwrap();

    let keeper = live.h.keeper.insecure_clone();
    live.h
        .send(
            &[&keeper],
            &keeper.pubkey(),
            ix_set_risk_valve(&keeper.pubkey(), FIXTURE, VALVE_MAX_DURATION_SECS, NEUTRAL, 0),
        )
        .unwrap();
    let res = open_leverage(&mut live, 0, 100 * ONE_USDT, 3);
    assert_amm_error(&res, AmmError::RiskValvePaused);
}

#[test]
fn open_rejects_over_open_interest_cap() {
    // OI cap 100 USDT; N = 50 × 3 = 150 USDT notional busts it
    let params = amm::FeeParamsArgs {
        max_open_interest: 100 * ONE_USDT,
        ..leverage_fee_params()
    };
    let mut live = bootstrap(params);
    lp_join(&mut live, 10_000 * ONE_USDT);
    to_trading(&mut live);
    post_mark(&mut live, MARKS0).unwrap();

    let res = open_leverage(&mut live, 0, 50 * ONE_USDT, 3);
    assert_amm_error(&res, AmmError::OpenInterestExceeded);
}

#[test]
fn open_rejects_when_coverage_breached() {
    let mut live = bootstrap(leverage_fee_params());
    // tiny pool vs a big open: 100 USDT vault cannot cover 120% of max_gain
    lp_join(&mut live, 100 * ONE_USDT);
    to_trading(&mut live);
    post_mark(&mut live, MARKS0).unwrap();

    let collateral = 1_000 * ONE_USDT;
    let units = funding::units_for(collateral, 5, MARKS0[0]).unwrap();
    let max_gain = funding::max_gain(units, MARKS0[0]).unwrap();
    assert!(
        !funding::coverage_ok(100 * ONE_USDT, 12_000, 0, max_gain).unwrap(),
        "test setup: the open must breach coverage"
    );
    let res = open_leverage(&mut live, 0, collateral, 5);
    assert_amm_error(&res, AmmError::CoverageBreached);
}

#[test]
fn open_rejects_leverage_above_taper() {
    let mut live = bootstrap(leverage_fee_params());
    lp_join(&mut live, 10_000 * ONE_USDT);
    to_trading(&mut live);
    // edge mark p = 1000 < 2000: cap tapers to 1 + 4·1000/2000 = 3
    post_mark(&mut live, [1_000, 5_000, 4_000]).unwrap();
    assert_eq!(funding::max_leverage_for_p(1_000, 5), 3);

    let res = open_leverage(&mut live, 0, 100 * ONE_USDT, 4);
    assert_amm_error(&res, AmmError::LeverageTooHigh);
    // at the tapered cap itself the open goes through
    open_leverage(&mut live, 0, 100 * ONE_USDT, 3).unwrap();
}

#[test]
fn open_rejects_before_first_mark() {
    let mut live = bootstrap(leverage_fee_params());
    lp_join(&mut live, 10_000 * ONE_USDT);
    to_trading(&mut live);
    // no post_mark ever
    let res = open_leverage(&mut live, 0, 100 * ONE_USDT, 3);
    assert_amm_error(&res, AmmError::MarkNotPosted);
}

#[test]
fn init_pool_rejects_leverage_disabled_config() {
    // default config: max_leverage = 0 → the pool cannot even be created
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
    let (kickoff, freeze) = (h.now() + 100, h.now() + HORIZON);
    h.send(
        &[&h.admin.insecure_clone()],
        &admin,
        ix_init_market(
            &admin, CFG_ID, FIXTURE, kickoff, freeze, B, SEED_Q, SEED_LIQ, &mint, &admin_ata,
        ),
    )
    .unwrap();

    let res = send_tx(
        &mut h.svm,
        &[&h.admin.insecure_clone()],
        &admin,
        ix_init_leverage_pool(&admin, CFG_ID, FIXTURE, &mint),
    );
    assert_amm_error(&res, AmmError::LeverageDisabled);
}

// ===========================================================================
// (5) LP flow: lockup, proportional claim, coverage-blocked request,
//     second-deposit floor share math
// ===========================================================================
#[test]
fn lp_withdraw_lockup_then_proportional_claim() {
    let mut live = bootstrap(leverage_fee_params());
    let deposit = 10_000 * ONE_USDT;
    lp_join(&mut live, deposit);
    to_trading(&mut live);
    post_mark(&mut live, MARKS0).unwrap();
    // an open position: the vault now holds deposit + C, and the claim
    // value is a genuine pro-rata of a vault ≠ share supply
    let collateral = 100 * ONE_USDT;
    open_leverage(&mut live, 0, collateral, 3).unwrap();

    let lp = live.lp.insecure_clone();
    let lp_key = lev_lp_pda(&market_pda(FIXTURE), &lp.pubkey());
    let acct: LpAccount = get_anchor(&live.h.svm, &lp_key);
    assert_eq!(acct.shares, deposit, "first deposit mints 1:1");

    let req_shares = deposit / 4;
    live.h
        .send(
            &[&lp],
            &lp.pubkey(),
            ix_request_withdraw(&lp.pubkey(), CFG_ID, FIXTURE, req_shares),
        )
        .unwrap();
    let t_req = live.h.now();

    // ---- before unlock: WithdrawLocked ----
    let res = send_tx(
        &mut live.h.svm,
        &[&lp],
        &lp.pubkey(),
        ix_withdraw_lp(&lp.pubkey(), FIXTURE, &live.h.usdt_mint, &live.lp_ata),
    );
    assert_amm_error(&res, AmmError::WithdrawLocked);

    // ---- past LP_WITHDRAW_DELAY_SECS: pays value_for_shares at claim ----
    live.h.set_time(t_req + LP_WITHDRAW_DELAY_SECS);
    let pool = pool_state(&live);
    let vault_now = lev_vault_balance(&live);
    let expected =
        funding::value_for_shares(req_shares, pool.total_shares, vault_now).unwrap();
    assert!(expected > req_shares, "vault grew by the open's collateral — pro-rata > 1:1");
    let before = live.h.token_balance(&live.lp_ata);
    live.h
        .send(
            &[&lp],
            &lp.pubkey(),
            ix_withdraw_lp(&lp.pubkey(), FIXTURE, &live.h.usdt_mint, &live.lp_ata),
        )
        .unwrap();
    assert_eq!(live.h.token_balance(&live.lp_ata), before + expected);
    let acct: LpAccount = get_anchor(&live.h.svm, &lp_key);
    assert_eq!(acct.shares, deposit - req_shares);
    assert_eq!(acct.pending_shares, 0);
    let pool = pool_state(&live);
    assert_eq!(pool.total_shares, deposit - req_shares);
    assert_eq!(pool.pending_withdraw_shares, 0);
}

#[test]
fn lp_request_breaking_coverage_rejected() {
    let mut live = bootstrap(leverage_fee_params());
    let deposit = 1_000 * ONE_USDT;
    lp_join(&mut live, deposit);
    to_trading(&mut live);
    post_mark(&mut live, MARKS0).unwrap();

    // 5x on Team1 @ 4000: max_gain = 750 USDT → 120% coverage needs 900 USDT
    let collateral = 100 * ONE_USDT;
    open_leverage(&mut live, 0, collateral, 5).unwrap();
    let units = funding::units_for(collateral, 5, MARKS0[0]).unwrap();
    let max_gain = funding::max_gain(units, MARKS0[0]).unwrap();

    // requesting 400 USDT of shares would leave the vault under coverage
    let lp = live.lp.insecure_clone();
    let vault = lev_vault_balance(&live);
    let big = 400 * ONE_USDT;
    let big_value = funding::value_for_shares(big, deposit, vault).unwrap();
    assert!(
        !funding::coverage_ok(vault - big_value, 12_000, max_gain, 0).unwrap(),
        "test setup: the big request must break coverage"
    );
    let res = send_tx(
        &mut live.h.svm,
        &[&lp],
        &lp.pubkey(),
        ix_request_withdraw(&lp.pubkey(), CFG_ID, FIXTURE, big),
    );
    assert_amm_error(&res, AmmError::CoverageBreached);

    // a small request that keeps coverage passes
    live.h
        .send(
            &[&lp],
            &lp.pubkey(),
            ix_request_withdraw(&lp.pubkey(), CFG_ID, FIXTURE, 100 * ONE_USDT),
        )
        .unwrap();
}

#[test]
fn second_deposit_share_math_floors() {
    let mut live = bootstrap(leverage_fee_params());
    let first = 1_000 * ONE_USDT;
    lp_join(&mut live, first);
    to_trading(&mut live);
    post_mark(&mut live, MARKS0).unwrap();
    // vault grows past the share supply (trader collateral sits in the vault)
    open_leverage(&mut live, 0, 100 * ONE_USDT, 2).unwrap();

    let lp2 = Keypair::new();
    live.h.svm.airdrop(&lp2.pubkey(), 100_000_000_000).unwrap();
    let lp2_ata = live.h.fund_ata(&lp2.pubkey(), 10_000 * ONE_USDT);
    live.h
        .send(&[&lp2.insecure_clone()], &lp2.pubkey(), ix_open_lp_account(&lp2.pubkey(), FIXTURE))
        .unwrap();

    let pool = pool_state(&live);
    let vault = lev_vault_balance(&live);
    assert!(vault > pool.total_shares, "vault must exceed share supply for the floor to bite");
    let amount = 500 * ONE_USDT;
    let expected = funding::shares_for_deposit(amount, pool.total_shares, vault).unwrap();
    assert!(expected < amount, "second deposit into a grown pool mints < 1:1 (floor)");

    live.h
        .send(
            &[&lp2.insecure_clone()],
            &lp2.pubkey(),
            ix_deposit_lp(&lp2.pubkey(), FIXTURE, amount, &live.h.usdt_mint, &lp2_ata),
        )
        .unwrap();
    let acct: LpAccount =
        get_anchor(&live.h.svm, &lev_lp_pda(&market_pda(FIXTURE), &lp2.pubkey()));
    assert_eq!(acct.shares, expected);
    let pool = pool_state(&live);
    assert_eq!(pool.total_shares, first + expected);
}

// ===========================================================================
// (6) funding monotonicity across segments with changing marks
// ===========================================================================
#[test]
fn funding_index_monotone_across_segments() {
    let mut live = bootstrap(leverage_fee_params());
    let params = leverage_fee_params();
    let t1 = live.h.now();
    post_mark(&mut live, MARKS0).unwrap(); // initialize (no accrual)

    // (elapsed, new marks): each segment is priced at the PREVIOUS marks
    let segments: [(i64, [u16; 3]); 3] = [
        (60, [5_000, 2_500, 2_500]),
        (90, [6_000, 2_000, 2_000]),
        (120, [3_000, 3_500, 3_500]),
    ];

    let mut now = t1;
    let mut prev_marks = MARKS0;
    let mut expected = [0u128; 3];
    let mut last_idx = [0u128; 3];
    for (elapsed, marks) in segments {
        now += elapsed;
        live.h.set_time(now);
        post_mark(&mut live, marks).unwrap();
        for i in 0..3 {
            expected[i] += funding::idx_delta(
                params.time_fee_num,
                prev_marks[i],
                elapsed,
                live.freeze - now,
                NEUTRAL,
            )
            .unwrap();
        }
        let pool = pool_state(&live);
        for i in 0..3 {
            assert!(
                pool.cum_funding_index[i] > last_idx[i],
                "index must be STRICTLY increasing (outcome {i})"
            );
            assert_eq!(
                pool.cum_funding_index[i], expected[i],
                "index must equal the sum of per-segment idx_delta (outcome {i})"
            );
        }
        last_idx = pool.cum_funding_index;
        prev_marks = marks;
    }
}

// ===========================================================================
// (7) one live position per user per market; close is once-only
// ===========================================================================
#[test]
fn one_position_per_user_and_single_close() {
    let mut live = bootstrap(leverage_fee_params());
    lp_join(&mut live, 10_000 * ONE_USDT);
    to_trading(&mut live);
    post_mark(&mut live, MARKS0).unwrap();

    open_leverage(&mut live, 0, 100 * ONE_USDT, 3).unwrap();
    // second open: `init` on the existing LevPosition PDA fails (account in use)
    let res = open_leverage(&mut live, 1, 50 * ONE_USDT, 2);
    assert!(res.is_err(), "a second live position per user per market must fail");

    close_leverage(&mut live).unwrap();
    // second close: the account was closed — deserialization fails
    let res = close_leverage(&mut live);
    assert!(res.is_err(), "closing twice must fail (account gone)");
}

// ===========================================================================
// (8) risk valve: bounded multiplier amplifies funding; out-of-bounds rejected
// ===========================================================================
#[test]
fn valve_multiplier_amplifies_funding() {
    let mut live = bootstrap(leverage_fee_params());
    let params = leverage_fee_params();
    let marks = [5_000, 2_500, 2_500];
    let t1 = live.h.now();
    post_mark(&mut live, marks).unwrap();

    // ---- neutral 60s segment ----
    let t2 = t1 + 60;
    live.h.set_time(t2);
    post_mark(&mut live, marks).unwrap();
    let neutral_delta = pool_state(&live).cum_funding_index[0];
    assert_eq!(
        neutral_delta,
        funding::idx_delta(params.time_fee_num, marks[0], 60, live.freeze - t2, NEUTRAL)
            .unwrap()
    );

    // ---- 2x valve window, identical 60s segment ----
    let mult = 2 * NEUTRAL; // 20_000 bps = ×2, within VALVE_MAX_MULTIPLIER_BPS
    let keeper = live.h.keeper.insecure_clone();
    live.h
        .send(
            &[&keeper],
            &keeper.pubkey(),
            ix_set_risk_valve(&keeper.pubkey(), FIXTURE, 0, mult, VALVE_MAX_DURATION_SECS),
        )
        .unwrap();
    let t3 = t2 + 60;
    live.h.set_time(t3);
    post_mark(&mut live, marks).unwrap();
    let valve_delta = pool_state(&live).cum_funding_index[0] - neutral_delta;
    assert_eq!(
        valve_delta,
        funding::idx_delta(params.time_fee_num, marks[0], 60, live.freeze - t3, mult).unwrap()
    );
    // ~2x the neutral segment (exact 2x up to the ceil + slightly smaller t_rem)
    assert!(
        valve_delta >= 2 * neutral_delta,
        "a 2x valve must at least double the accrual ({valve_delta} vs {neutral_delta})"
    );
}

#[test]
fn valve_out_of_bounds_rejected() {
    let mut live = bootstrap(leverage_fee_params());
    let keeper = live.h.keeper.insecure_clone();

    // multiplier above the ×5 hard cap
    let res = live.h.send(
        &[&keeper],
        &keeper.pubkey(),
        ix_set_risk_valve(&keeper.pubkey(), FIXTURE, 0, VALVE_MAX_MULTIPLIER_BPS + 1, 0),
    );
    assert_amm_error(&res, AmmError::ValveOutOfBounds);

    // window beyond the 600s hard cap
    let res = live.h.send(
        &[&keeper],
        &keeper.pubkey(),
        ix_set_risk_valve(&keeper.pubkey(), FIXTURE, 0, NEUTRAL, VALVE_MAX_DURATION_SECS + 1),
    );
    assert_amm_error(&res, AmmError::ValveOutOfBounds);

    // pause beyond the 600s hard cap
    let res = live.h.send(
        &[&keeper],
        &keeper.pubkey(),
        ix_set_risk_valve(&keeper.pubkey(), FIXTURE, VALVE_MAX_DURATION_SECS + 1, NEUTRAL, 0),
    );
    assert_amm_error(&res, AmmError::ValveOutOfBounds);

    // sub-neutral multiplier (keeper cannot discount funding either)
    let res = live.h.send(
        &[&keeper],
        &keeper.pubkey(),
        ix_set_risk_valve(&keeper.pubkey(), FIXTURE, 0, NEUTRAL - 1, 0),
    );
    assert_amm_error(&res, AmmError::ValveOutOfBounds);

    // the maximal legal valve is accepted
    live.h
        .send(
            &[&keeper],
            &keeper.pubkey(),
            ix_set_risk_valve(
                &keeper.pubkey(),
                FIXTURE,
                VALVE_MAX_DURATION_SECS,
                VALVE_MAX_MULTIPLIER_BPS,
                VALVE_MAX_DURATION_SECS,
            ),
        )
        .unwrap();
}

// ===========================================================================
// (9) update_leverage_params — retro-enable leverage on a shared config
// ===========================================================================
#[test]
fn update_leverage_params_retro_enables_shared_config() {
    // config + market created with the 7 leverage fields all ZERO (disabled)
    let mut live = bootstrap_without_pool(default_fee_params());
    let admin = live.h.admin.insecure_clone();
    let mint = live.h.usdt_mint;

    // pool creation is refused while the config says disabled
    let res = send_tx(
        &mut live.h.svm,
        &[&admin],
        &admin.pubkey(),
        ix_init_leverage_pool(&admin.pubkey(), CFG_ID, FIXTURE, &mint),
    );
    assert_amm_error(&res, AmmError::LeverageDisabled);

    // retro-enable: mutate ONLY the leverage fields on the shared config
    send_tx(
        &mut live.h.svm,
        &[&admin],
        &admin.pubkey(),
        ix_update_leverage_params(&admin.pubkey(), CFG_ID, leverage_params_args()),
    )
    .unwrap();

    // the SAME pre-existing market (config read live) now accepts the pool …
    send_tx(
        &mut live.h.svm,
        &[&admin],
        &admin.pubkey(),
        ix_init_leverage_pool(&admin.pubkey(), CFG_ID, FIXTURE, &mint),
    )
    .unwrap();

    // … and a full open works after LP funding + a fresh mark
    lp_join(&mut live, 10_000 * ONE_USDT);
    to_trading(&mut live);
    post_mark(&mut live, MARKS0).unwrap();
    let collateral = 100 * ONE_USDT;
    open_leverage(&mut live, 0, collateral, 3).unwrap();

    let pos: LevPosition = get_anchor(
        &live.h.svm,
        &lev_position_pda(&market_pda(FIXTURE), &live.trader.pubkey()),
    );
    assert_eq!(pos.leverage, 3);
    assert_eq!(pos.collateral, collateral);
    assert_eq!(pos.entry_mark_bps, MARKS0[0]);
    let pool = pool_state(&live);
    assert_eq!(pool.open_interest, collateral * 3);
}

#[test]
fn update_leverage_params_rejects_non_authority() {
    let mut live = bootstrap_without_pool(default_fee_params());
    let mallory = Keypair::new();
    live.h.svm.airdrop(&mallory.pubkey(), 10_000_000_000).unwrap();

    let res = send_tx(
        &mut live.h.svm,
        &[&mallory],
        &mallory.pubkey(),
        ix_update_leverage_params(&mallory.pubkey(), CFG_ID, leverage_params_args()),
    );
    assert_amm_error(&res, AmmError::Unauthorized);

    // config untouched: leverage still disabled
    let mc: MarketConfig = get_anchor(&live.h.svm, &market_config_pda(CFG_ID));
    assert_eq!(mc.max_leverage, 0);
}

#[test]
fn update_leverage_params_rejects_invalid_params() {
    let mut live = bootstrap_without_pool(default_fee_params());
    let admin = live.h.admin.insecure_clone();

    // enabling (max_leverage > 0) with funding_epoch_secs = 0 — the same rule
    // create_market_config enforces, via the shared validator
    let bad = amm::LeverageParamsArgs { funding_epoch_secs: 0, ..leverage_params_args() };
    let res = send_tx(
        &mut live.h.svm,
        &[&admin],
        &admin.pubkey(),
        ix_update_leverage_params(&admin.pubkey(), CFG_ID, bad),
    );
    assert_amm_error(&res, AmmError::InvalidFeeParams);

    // config untouched: leverage still disabled
    let mc: MarketConfig = get_anchor(&live.h.svm, &market_config_pda(CFG_ID));
    assert_eq!(mc.max_leverage, 0);
}

#[test]
fn update_leverage_params_leaves_predicate_and_fees_untouched() {
    let mut live = bootstrap_without_pool(default_fee_params());
    let admin = live.h.admin.insecure_clone();
    let cfg_key = market_config_pda(CFG_ID);
    let before: MarketConfig = get_anchor(&live.h.svm, &cfg_key);

    let args = leverage_params_args();
    send_tx(
        &mut live.h.svm,
        &[&admin],
        &admin.pubkey(),
        ix_update_leverage_params(&admin.pubkey(), CFG_ID, args.clone()),
    )
    .unwrap();
    let after: MarketConfig = get_anchor(&live.h.svm, &cfg_key);

    // exactly the 7 leverage fields moved, to exactly the requested values
    assert_eq!(after.max_open_interest, args.max_open_interest);
    assert_eq!(after.time_fee_num, args.time_fee_num);
    assert_eq!(after.funding_epoch_secs, args.funding_epoch_secs);
    assert_eq!(after.max_mark_age_secs, args.max_mark_age_secs);
    assert_eq!(after.leverage_cutoff_secs, args.leverage_cutoff_secs);
    assert_eq!(after.max_leverage, args.max_leverage);
    assert_eq!(after.min_coverage_bps, args.min_coverage_bps);

    // EVERYTHING else — identity, fee params, resolution predicate (D-8),
    // grace, bump, period, reserved — is byte-identical: revert just the 7
    // leverage fields and the serialized accounts must match exactly.
    let mut reverted = after.clone();
    reverted.max_open_interest = before.max_open_interest;
    reverted.time_fee_num = before.time_fee_num;
    reverted.funding_epoch_secs = before.funding_epoch_secs;
    reverted.max_mark_age_secs = before.max_mark_age_secs;
    reverted.leverage_cutoff_secs = before.leverage_cutoff_secs;
    reverted.max_leverage = before.max_leverage;
    reverted.min_coverage_bps = before.min_coverage_bps;
    let mut before_bytes = Vec::new();
    anchor_lang::AccountSerialize::try_serialize(&before, &mut before_bytes).unwrap();
    let mut reverted_bytes = Vec::new();
    anchor_lang::AccountSerialize::try_serialize(&reverted, &mut reverted_bytes).unwrap();
    assert_eq!(
        reverted_bytes, before_bytes,
        "update_leverage_params must not touch any non-leverage field \
         (predicate immutability, D-8)"
    );
}

//! LiteSVM Phase-2 tests — plan §10.1 cases 9–11 + lifecycle clock gates.
//!
//! The TxLINE oracle is mocked by `tests/mock-txoracle` (loaded at the real
//! TxLINE devnet program id): it shares `validate_stat`'s discriminator and
//! Borsh arg layout, treats Merkle proofs as valid, and evaluates the passed
//! predicate against the passed stat values; a 0xFF sentinel in the fabricated
//! roots PDA flips it into a RootNotAvailable(6007) error mode.
//!
//! Markets are driven through the REAL lifecycle instructions
//! (`activate_market`/`freeze_market`) with Clock warping — `force_*` account
//! patches are used only where no instruction path exists (forcing a Void
//! outcome, which v0 has no resolution path for).

use anchor_lang::prelude::Pubkey;
use solana_keypair::Keypair;
use solana_signer::Signer;

use amm::error::AmmError;
use amm::state::{Market, MarketState, Outcome, Position};
use amm::Side;

use crate::common::*;

const CFG_ID: u16 = 1;
const FIXTURE: i64 = 17_588_316;

/// A market with the mock oracle loaded, plus a funded trader.
struct Live {
    h: Harness,
    trader: Keypair,
    trader_ata: Pubkey,
    admin_ata: Pubkey,
    kickoff: i64,
    freeze: i64,
}

/// Bootstrap to `Open` with the mock oracle loaded at the TxLINE devnet id.
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
        ix_create_market_config(&admin, CFG_ID, default_fee_params()),
    )
    .unwrap();

    let admin_ata = h.fund_ata(&admin, 1_000_000 * ONE_USDT);
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
            10_000 * ONE_USDT,
            &mint,
            &admin_ata,
        ),
    )
    .unwrap();

    let trader = Keypair::new();
    h.svm.airdrop(&trader.pubkey(), 100_000_000_000).unwrap();
    let trader_ata = h.fund_ata(&trader.pubkey(), 100_000 * ONE_USDT);

    Live { h, trader, trader_ata, admin_ata, kickoff, freeze }
}

/// … → Trading via the REAL `activate_market` (clock warped to kickoff).
fn to_trading(live: &mut Live) {
    live.h.set_time(live.kickoff);
    let keeper = live.h.keeper.insecure_clone();
    live.h
        .send(&[&keeper], &keeper.pubkey(), ix_activate_market(&keeper.pubkey(), FIXTURE))
        .unwrap();
}

/// … → Locked via the REAL `freeze_market` (clock warped to freeze_ts),
/// with `buy_side`/`buy_usdt` traded in between (0 = no trade).
fn to_locked(live: &mut Live, buy_side: Side, buy_usdt: u64) {
    to_trading(live);
    let trader = live.trader.pubkey();
    live.h
        .send(&[&live.trader.insecure_clone()], &trader, ix_open_position(&trader, FIXTURE))
        .unwrap();
    if buy_usdt > 0 {
        live.h
            .send(
                &[&live.trader.insecure_clone()],
                &trader,
                ix_buy(&trader, CFG_ID, FIXTURE, buy_side, buy_usdt, 0, &live.h.usdt_mint, &live.trader_ata),
            )
            .unwrap();
    }
    live.h.set_time(live.freeze);
    let keeper = live.h.keeper.insecure_clone();
    live.h
        .send(&[&keeper], &keeper.pubkey(), ix_freeze_market(&keeper.pubkey(), FIXTURE))
        .unwrap();
}

/// Successful `resolve` with the given hint + goals (fabricates the roots PDA).
fn do_resolve(live: &mut Live, hint: Side, home: i32, away: i32) -> litesvm::types::TransactionResult {
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
            resolve_args(FIXTURE, ts, home, away),
            &txline_id(),
            &roots,
        ),
    )
}

/// Patch the Market account state/outcome directly (only for paths with no
/// v0 instruction, e.g. forcing a Void resolution).
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
// activate_market — clock + signer gates (case 4 completion)
// ===========================================================================
#[test]
fn activate_gates() {
    let mut live = bootstrap_open();
    let keeper = live.h.keeper.insecure_clone();
    let market_key = market_pda(FIXTURE);

    // before kickoff → KickoffNotReached
    let res = live.h.send(&[&keeper], &keeper.pubkey(), ix_activate_market(&keeper.pubkey(), FIXTURE));
    assert_amm_error(&res, AmmError::KickoffNotReached);

    // wrong signer (even after kickoff) → Unauthorized
    live.h.set_time(live.kickoff);
    let stranger = Keypair::new();
    live.h.svm.airdrop(&stranger.pubkey(), 10_000_000_000).unwrap();
    let res = live.h.send(&[&stranger], &stranger.pubkey(), ix_activate_market(&stranger.pubkey(), FIXTURE));
    assert_amm_error(&res, AmmError::Unauthorized);

    // keeper at kickoff → Trading
    live.h
        .send(&[&keeper], &keeper.pubkey(), ix_activate_market(&keeper.pubkey(), FIXTURE))
        .unwrap();
    let m: Market = get_anchor(&live.h.svm, &market_key);
    assert_eq!(m.state, MarketState::Trading);

    // double-activate → InvalidMarketState
    let res = live.h.send(&[&keeper], &keeper.pubkey(), ix_activate_market(&keeper.pubkey(), FIXTURE));
    assert_amm_error(&res, AmmError::InvalidMarketState);
}

// ===========================================================================
// freeze_market — clock + signer gates (case 4 completion)
// ===========================================================================
#[test]
fn freeze_gates() {
    let mut live = bootstrap_open();
    let keeper = live.h.keeper.insecure_clone();
    let market_key = market_pda(FIXTURE);

    // freeze while still Open → InvalidMarketState (state gate before clock)
    live.h.set_time(live.freeze);
    let res = live.h.send(&[&keeper], &keeper.pubkey(), ix_freeze_market(&keeper.pubkey(), FIXTURE));
    assert_amm_error(&res, AmmError::InvalidMarketState);

    live.h.set_time(live.kickoff); // rewind; activate properly
    to_trading(&mut live);

    // before freeze_ts → FreezeNotReached
    let res = live.h.send(&[&keeper], &keeper.pubkey(), ix_freeze_market(&keeper.pubkey(), FIXTURE));
    assert_amm_error(&res, AmmError::FreezeNotReached);

    // wrong signer at freeze_ts → Unauthorized
    live.h.set_time(live.freeze);
    let stranger = Keypair::new();
    live.h.svm.airdrop(&stranger.pubkey(), 10_000_000_000).unwrap();
    let res = live.h.send(&[&stranger], &stranger.pubkey(), ix_freeze_market(&stranger.pubkey(), FIXTURE));
    assert_amm_error(&res, AmmError::Unauthorized);

    // keeper at freeze_ts → Locked; trading halted
    live.h
        .send(&[&keeper], &keeper.pubkey(), ix_freeze_market(&keeper.pubkey(), FIXTURE))
        .unwrap();
    let m: Market = get_anchor(&live.h.svm, &market_key);
    assert_eq!(m.state, MarketState::Locked);

    let trader = live.trader.pubkey();
    live.h
        .send(&[&live.trader.insecure_clone()], &trader, ix_open_position(&trader, FIXTURE))
        .unwrap();
    let res = live.h.send(
        &[&live.trader.insecure_clone()],
        &trader,
        ix_buy(&trader, CFG_ID, FIXTURE, Side::Yes, ONE_USDT, 0, &live.h.usdt_mint, &live.trader_ata),
    );
    assert_amm_error(&res, AmmError::InvalidMarketState);
}

// ===========================================================================
// Case 9 — resolve success (Yes hint): outcome Yes + Resolved + event
// ===========================================================================
#[test]
fn resolve_yes_success() {
    let mut live = bootstrap_open();
    to_locked(&mut live, Side::Yes, 1_000 * ONE_USDT);

    let meta = do_resolve(&mut live, Side::Yes, 2, 1).unwrap();
    // Anchor `emit!` writes the event as a `Program data:` log line.
    assert!(
        meta.logs.iter().any(|l| l.starts_with("Program data: ")),
        "MarketResolved event log missing: {:?}",
        meta.logs
    );

    let m: Market = get_anchor(&live.h.svm, &market_pda(FIXTURE));
    assert_eq!(m.state, MarketState::Resolved);
    assert_eq!(m.outcome, Outcome::Yes);
}

// ===========================================================================
// Case 9 — resolve success (No hint): negated predicate path → outcome No
// ===========================================================================
#[test]
fn resolve_no_success() {
    let mut live = bootstrap_open();
    to_locked(&mut live, Side::No, 1_000 * ONE_USDT);

    // home 1 - away 2 = -1: stored predicate (>0) false, negation (<1) true.
    do_resolve(&mut live, Side::No, 1, 2).unwrap();

    let m: Market = get_anchor(&live.h.svm, &market_pda(FIXTURE));
    assert_eq!(m.state, MarketState::Resolved);
    assert_eq!(m.outcome, Outcome::No);
}

// ===========================================================================
// Case 9 — resolve rejected: CPI returns false → ProofRejected, stays Locked
// ===========================================================================
#[test]
fn resolve_proof_rejected() {
    let mut live = bootstrap_open();
    to_locked(&mut live, Side::Yes, 1_000 * ONE_USDT);

    // Yes hint but the "proven" stats say home lost → validate_stat = false.
    let res = do_resolve(&mut live, Side::Yes, 0, 3);
    assert_amm_error(&res, AmmError::ProofRejected);

    let m: Market = get_anchor(&live.h.svm, &market_pda(FIXTURE));
    assert_eq!(m.state, MarketState::Locked, "market must stay Locked for keeper retry");
    assert_eq!(m.outcome, Outcome::Unset);
}

// ===========================================================================
// Case 9 — oracle error mode: RootNotAvailable(6007) propagates verbatim
// (keeper-retryable: tx fails, market untouched)
// ===========================================================================
#[test]
fn resolve_oracle_error_mode() {
    let mut live = bootstrap_open();
    to_locked(&mut live, Side::Yes, 1_000 * ONE_USDT);

    let ts = live.h.now();
    // 0xFF sentinel → the mock fails with custom 6007, like the real oracle
    // before it posts the day's root.
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
            Side::Yes,
            resolve_args(FIXTURE, ts, 2, 1),
            &txline_id(),
            &roots,
        ),
    );
    assert_custom_error(&res, 6007);

    let m: Market = get_anchor(&live.h.svm, &market_pda(FIXTURE));
    assert_eq!(m.state, MarketState::Locked, "retryable failure must not mutate the market");
}

// ===========================================================================
// Case 9 — double-resolve rejected (state gate)
// ===========================================================================
#[test]
fn resolve_double_rejected() {
    let mut live = bootstrap_open();
    to_locked(&mut live, Side::Yes, 1_000 * ONE_USDT);

    do_resolve(&mut live, Side::Yes, 2, 1).unwrap();
    let res = do_resolve(&mut live, Side::Yes, 2, 1);
    assert_amm_error(&res, AmmError::InvalidMarketState);
}

// ===========================================================================
// Case 9 — wrong txline_program account → address-constraint failure
// ===========================================================================
#[test]
fn resolve_wrong_txline_program() {
    let mut live = bootstrap_open();
    to_locked(&mut live, Side::Yes, 1_000 * ONE_USDT);

    let ts = live.h.now();
    let roots = write_roots_account(&mut live.h.svm, &txline_id(), epoch_day(ts), 0x00);
    let keeper = live.h.keeper.insecure_clone();
    // substitute our own program id as the CPI callee
    let res = live.h.send(
        &[&keeper],
        &keeper.pubkey(),
        ix_resolve(
            &keeper.pubkey(),
            CFG_ID,
            FIXTURE,
            Side::Yes,
            resolve_args(FIXTURE, ts, 2, 1),
            &program_id(),
            &roots,
        ),
    );
    assert_amm_error(&res, AmmError::Unauthorized);
}

// ===========================================================================
// Case 9 — roots PDA with wrong owner / wrong address → InvalidMerkleRootsAccount
// ===========================================================================
#[test]
fn resolve_bad_roots_account() {
    let mut live = bootstrap_open();
    to_locked(&mut live, Side::Yes, 1_000 * ONE_USDT);
    let ts = live.h.now();
    let keeper = live.h.keeper.insecure_clone();

    // (a) correct PDA address but owned by the wrong program
    let bad_owner = program_id();
    let pda = daily_roots_pda(&txline_id(), epoch_day(ts));
    let mut data = vec![0u8; 64];
    data[0] = 0x00;
    live.h
        .svm
        .set_account(
            pda,
            solana_account::Account {
                lamports: 1_000_000_000,
                data,
                owner: bad_owner,
                executable: false,
                rent_epoch: 0,
            },
        )
        .unwrap();
    let res = live.h.send(
        &[&keeper],
        &keeper.pubkey(),
        ix_resolve(
            &keeper.pubkey(),
            CFG_ID,
            FIXTURE,
            Side::Yes,
            resolve_args(FIXTURE, ts, 2, 1),
            &txline_id(),
            &pda,
        ),
    );
    assert_amm_error(&res, AmmError::InvalidMerkleRootsAccount);

    // (b) right owner but the WRONG epoch-day PDA address
    let wrong_day = epoch_day(ts) + 1;
    let wrong_pda = write_roots_account(&mut live.h.svm, &txline_id(), wrong_day, 0x00);
    let res = live.h.send(
        &[&keeper],
        &keeper.pubkey(),
        ix_resolve(
            &keeper.pubkey(),
            CFG_ID,
            FIXTURE,
            Side::Yes,
            resolve_args(FIXTURE, ts, 2, 1),
            &txline_id(),
            &wrong_pda,
        ),
    );
    assert_amm_error(&res, AmmError::InvalidMerkleRootsAccount);
}

// ===========================================================================
// Case 9 — fixture_id mismatch → FixtureMismatch
// ===========================================================================
#[test]
fn resolve_fixture_mismatch() {
    let mut live = bootstrap_open();
    to_locked(&mut live, Side::Yes, 1_000 * ONE_USDT);

    let ts = live.h.now();
    let roots = write_roots_account(&mut live.h.svm, &txline_id(), epoch_day(ts), 0x00);
    let keeper = live.h.keeper.insecure_clone();
    let res = live.h.send(
        &[&keeper],
        &keeper.pubkey(),
        ix_resolve(
            &keeper.pubkey(),
            CFG_ID,
            FIXTURE,
            Side::Yes,
            resolve_args(FIXTURE + 1, ts, 2, 1), // proof for a different fixture
            &txline_id(),
            &roots,
        ),
    );
    assert_amm_error(&res, AmmError::FixtureMismatch);
}

// ===========================================================================
// Case 10 — redeem: winner 1 USDT/token, zeroed + flagged, double rejected
// ===========================================================================
#[test]
fn redeem_winner_and_double() {
    let mut live = bootstrap_open();
    to_locked(&mut live, Side::Yes, 1_000 * ONE_USDT);
    do_resolve(&mut live, Side::Yes, 2, 1).unwrap();

    let trader = live.trader.pubkey();
    let market_key = market_pda(FIXTURE);
    let pos_key = position_pda(&market_key, &trader);
    let pos: Position = get_anchor(&live.h.svm, &pos_key);
    let winning = pos.yes_tokens;
    assert!(winning > 0);

    let before = live.h.token_balance(&live.trader_ata);
    let vault_before = live.h.token_balance(&vault_pda(&market_key));
    live.h
        .send(
            &[&live.trader.insecure_clone()],
            &trader,
            ix_redeem(&trader, FIXTURE, &live.h.usdt_mint, &live.trader_ata),
        )
        .unwrap();

    // 1 winning token (6 dp) = 1 USDT (6 dp)
    assert_eq!(live.h.token_balance(&live.trader_ata), before + winning);
    assert_eq!(live.h.token_balance(&vault_pda(&market_key)), vault_before - winning);

    let pos: Position = get_anchor(&live.h.svm, &pos_key);
    assert!(pos.redeemed);
    assert_eq!(pos.yes_tokens, 0);
    assert_eq!(pos.no_tokens, 0);
    let m: Market = get_anchor(&live.h.svm, &market_key);
    assert_eq!(m.yes_supply, 0);

    // double-redeem → AlreadyRedeemed
    let res = live.h.send(
        &[&live.trader.insecure_clone()],
        &trader,
        ix_redeem(&trader, FIXTURE, &live.h.usdt_mint, &live.trader_ata),
    );
    assert_amm_error(&res, AmmError::AlreadyRedeemed);
}

// ===========================================================================
// Case 10 — loser payout is 0 (position closed, balance unchanged)
// ===========================================================================
#[test]
fn redeem_loser_gets_zero() {
    let mut live = bootstrap_open();
    to_locked(&mut live, Side::No, 1_000 * ONE_USDT); // trader holds NO
    do_resolve(&mut live, Side::Yes, 2, 1).unwrap(); // …but YES wins

    let trader = live.trader.pubkey();
    let market_key = market_pda(FIXTURE);
    let before = live.h.token_balance(&live.trader_ata);

    live.h
        .send(
            &[&live.trader.insecure_clone()],
            &trader,
            ix_redeem(&trader, FIXTURE, &live.h.usdt_mint, &live.trader_ata),
        )
        .unwrap();

    assert_eq!(live.h.token_balance(&live.trader_ata), before, "loser gets 0");
    let pos: Position = get_anchor(&live.h.svm, &position_pda(&market_key, &trader));
    assert!(pos.redeemed);
    assert_eq!(pos.no_tokens, 0, "losing balance still zeroed");
}

// ===========================================================================
// Case 10 — Void → pro-rata collateral refund (outcome forced via set_account:
// v0 has no Void-resolution instruction path)
// ===========================================================================
#[test]
fn redeem_void_refunds_collateral() {
    let mut live = bootstrap_open();
    let stake = 1_000 * ONE_USDT;
    to_locked(&mut live, Side::Yes, stake);
    force_market(&mut live.h, FIXTURE, MarketState::Resolved, Outcome::Void);

    let trader = live.trader.pubkey();
    let market_key = market_pda(FIXTURE);
    let pos: Position = get_anchor(&live.h.svm, &position_pda(&market_key, &trader));
    assert_eq!(pos.collateral, stake, "net basis = the one buy");

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
        before + stake,
        "Void refunds the net USDT stake"
    );
    let pos: Position = get_anchor(&live.h.svm, &position_pda(&market_key, &trader));
    assert!(pos.redeemed);
    assert_eq!(pos.collateral, 0);
}

// ===========================================================================
// Case 11 — close_market: grace gate, sweep, closes, admin-only
// ===========================================================================
#[test]
fn close_market_lifecycle() {
    let mut live = bootstrap_open();
    to_locked(&mut live, Side::Yes, 1_000 * ONE_USDT);
    do_resolve(&mut live, Side::Yes, 2, 1).unwrap();

    let admin = live.h.admin.insecure_clone();
    let market_key = market_pda(FIXTURE);
    let vault_key = vault_pda(&market_key);

    // before grace (freeze_ts + 3600) → GraceNotElapsed
    let res = live.h.send(
        &[&admin],
        &admin.pubkey(),
        ix_close_market(&admin.pubkey(), CFG_ID, FIXTURE, &live.h.usdt_mint, &live.admin_ata),
    );
    assert_amm_error(&res, AmmError::GraceNotElapsed);

    live.h.set_time(live.freeze + 3_600);

    // non-admin → Unauthorized
    let stranger = Keypair::new();
    live.h.svm.airdrop(&stranger.pubkey(), 10_000_000_000).unwrap();
    let stranger_ata = live.h.fund_ata(&stranger.pubkey(), 0);
    let res = live.h.send(
        &[&stranger],
        &stranger.pubkey(),
        ix_close_market(&stranger.pubkey(), CFG_ID, FIXTURE, &live.h.usdt_mint, &stranger_ata),
    );
    assert_amm_error(&res, AmmError::Unauthorized);

    // admin after grace → vault swept + closed, Market closed
    let vault_bal = live.h.token_balance(&vault_key);
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
        admin_before + vault_bal,
        "residual vault USDT swept to admin"
    );
    // vault token account closed
    let vault_acc = live.h.svm.get_account(&vault_key);
    assert!(
        vault_acc.map_or(true, |a| a.lamports == 0 && a.data.is_empty()),
        "vault token account must be closed"
    );
    // market data account closed (fetch fails / empty)
    let market_acc = live.h.svm.get_account(&market_key);
    assert!(
        market_acc.map_or(true, |a| a.lamports == 0 || a.data.iter().all(|b| *b == 0)),
        "market account must be closed"
    );
}

// ===========================================================================
// Full happy path: init → open_position → activate → buy → freeze → resolve
// → redeem → close (real instructions, Clock warping only)
// ===========================================================================
#[test]
fn full_happy_path() {
    let mut live = bootstrap_open();
    let trader = live.trader.pubkey();
    let market_key = market_pda(FIXTURE);

    // open position while market is still Open (allowed), then activate
    live.h
        .send(&[&live.trader.insecure_clone()], &trader, ix_open_position(&trader, FIXTURE))
        .unwrap();
    to_trading(&mut live);

    // trade
    live.h
        .send(
            &[&live.trader.insecure_clone()],
            &trader,
            ix_buy(&trader, CFG_ID, FIXTURE, Side::Yes, 500 * ONE_USDT, 0, &live.h.usdt_mint, &live.trader_ata),
        )
        .unwrap();

    // freeze at the whistle
    live.h.set_time(live.freeze);
    let keeper = live.h.keeper.insecure_clone();
    live.h
        .send(&[&keeper], &keeper.pubkey(), ix_freeze_market(&keeper.pubkey(), FIXTURE))
        .unwrap();

    // resolve YES (home 3–1)
    do_resolve(&mut live, Side::Yes, 3, 1).unwrap();
    let m: Market = get_anchor(&live.h.svm, &market_key);
    assert_eq!(m.state, MarketState::Resolved);
    assert_eq!(m.outcome, Outcome::Yes);

    // redeem
    let pos: Position = get_anchor(&live.h.svm, &position_pda(&market_key, &trader));
    let winning = pos.yes_tokens;
    let before = live.h.token_balance(&live.trader_ata);
    live.h
        .send(
            &[&live.trader.insecure_clone()],
            &trader,
            ix_redeem(&trader, FIXTURE, &live.h.usdt_mint, &live.trader_ata),
        )
        .unwrap();
    assert_eq!(live.h.token_balance(&live.trader_ata), before + winning);

    // close after grace
    live.h.set_time(live.freeze + 3_600);
    let admin = live.h.admin.insecure_clone();
    live.h
        .send(
            &[&admin],
            &admin.pubkey(),
            ix_close_market(&admin.pubkey(), CFG_ID, FIXTURE, &live.h.usdt_mint, &live.admin_ata),
        )
        .unwrap();
    let market_acc = live.h.svm.get_account(&market_key);
    assert!(market_acc.map_or(true, |a| a.lamports == 0));
}

//! Shared LiteSVM harness for the AMM program (plan §10.1).
//!
//! Fabricates a classic-SPL USDT-like mint + funded ATAs via `set_account`
//! (the "infinite USDT" pattern — no mint keypair needed), controls the clock
//! via the Clock sysvar, and provides PDA derivation + instruction builders.

#![allow(dead_code)]

use anchor_lang::{InstructionData, ToAccountMetas};
use litesvm::types::TransactionResult;
use litesvm::LiteSVM;
use solana_account::Account;
use solana_clock::Clock;
use solana_instruction::Instruction;
use solana_keypair::Keypair;
use solana_message::Message;
use solana_native_token::LAMPORTS_PER_SOL;
use solana_program_option::COption;
use solana_program_pack::Pack;
use solana_pubkey::Pubkey;
use solana_signer::Signer;
use solana_transaction::Transaction;
use spl_associated_token_account::get_associated_token_address;

use amm::constants::{
    CONFIG_SEED, DAILY_SCORES_ROOTS_SEED, MARKET_SEED, MKT_CONFIG_SEED, POSITION_SEED,
    MILLIS_PER_DAY, VAULT_SEED,
};

pub const BASE_TS: i64 = 1_700_000_000;
pub const USDT_DECIMALS: u8 = 6;
pub const ONE_USDT: u64 = 1_000_000;

/// Program ids we treat as fixed inside tests.
pub fn program_id() -> Pubkey {
    amm::ID
}

pub fn token_program_id() -> Pubkey {
    spl_token::ID
}

/// A convenient fabricated USDT mint address (arbitrary — we own its bytes).
pub fn usdt_mint() -> Pubkey {
    Pubkey::new_from_array([7u8; 32])
}

/// The TxLINE program id used in Phase-2 tests = the mock's `declare_id!`
/// (which itself is the real TxLINE **devnet** id, so PDA derivations match
/// production byte-for-byte).
pub fn txline_id() -> Pubkey {
    mock_txoracle::ID
}

/// Test harness bundle.
pub struct Harness {
    pub svm: LiteSVM,
    pub admin: Keypair,
    pub keeper: Keypair,
    pub usdt_mint: Pubkey,
}

impl Harness {
    /// Fresh SVM with the AMM program loaded, admin+keeper funded, USDT mint
    /// fabricated, and the clock set to `BASE_TS`.
    pub fn new() -> Self {
        let mut svm = LiteSVM::new();
        let so = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../target/deploy/amm.so");
        svm.add_program_from_file(program_id(), so).unwrap();

        let admin = Keypair::new();
        let keeper = Keypair::new();
        svm.airdrop(&admin.pubkey(), LAMPORTS_PER_SOL * 100).unwrap();
        svm.airdrop(&keeper.pubkey(), LAMPORTS_PER_SOL * 100).unwrap();

        let mint = usdt_mint();
        write_mint(&mut svm, &mint, USDT_DECIMALS);

        let mut h = Self { svm, admin, keeper, usdt_mint: mint };
        h.set_time(BASE_TS);
        h
    }

    /// `new()` + the mock TxLINE oracle loaded at the real TxLINE devnet id
    /// (Phase-2 resolution tests). Requires `target/deploy/mock_txoracle.so`
    /// (`cargo build-sbf --manifest-path tests/mock-txoracle/Cargo.toml`).
    pub fn new_with_oracle() -> Self {
        let mut h = Self::new();
        let so = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../target/deploy/mock_txoracle.so");
        h.svm.add_program_from_file(txline_id(), so).unwrap();
        h
    }

    pub fn set_time(&mut self, ts: i64) {
        let mut clock: Clock = self.svm.get_sysvar();
        clock.unix_timestamp = ts;
        self.svm.set_sysvar(&clock);
    }

    pub fn now(&self) -> i64 {
        let clock: Clock = self.svm.get_sysvar();
        clock.unix_timestamp
    }

    /// Create + fund an ATA for `owner` holding `amount` of the USDT mint.
    pub fn fund_ata(&mut self, owner: &Pubkey, amount: u64) -> Pubkey {
        let ata = get_associated_token_address(owner, &self.usdt_mint);
        write_token_account(&mut self.svm, &ata, &self.usdt_mint, owner, amount);
        ata
    }

    pub fn token_balance(&self, ata: &Pubkey) -> u64 {
        let acc = self.svm.get_account(ata).unwrap();
        spl_token::state::Account::unpack(&acc.data).unwrap().amount
    }

    pub fn send(&mut self, signers: &[&Keypair], payer: &Pubkey, ix: Instruction) -> TransactionResult {
        send_tx(&mut self.svm, signers, payer, ix)
    }
}

/// Free-function send so callers can hold a `&Keypair` from the harness while
/// mutably borrowing the SVM (avoids the `&self`+`&mut self` borrow conflict).
pub fn send_tx(
    svm: &mut LiteSVM,
    signers: &[&Keypair],
    payer: &Pubkey,
    ix: Instruction,
) -> TransactionResult {
    // Rotate the blockhash so a byte-identical retry (double-resolve /
    // double-redeem tests) isn't deduplicated as `AlreadyProcessed`.
    svm.expire_blockhash();
    let msg = Message::new(&[ix], Some(payer));
    let tx = Transaction::new(signers, msg, svm.latest_blockhash());
    svm.send_transaction(tx)
}

// ---------------------------------------------------------------------------
// Account fabrication
// ---------------------------------------------------------------------------

pub fn write_mint(svm: &mut LiteSVM, mint: &Pubkey, decimals: u8) {
    let state = spl_token::state::Mint {
        mint_authority: COption::Some(Pubkey::new_from_array([9u8; 32])),
        supply: 0,
        decimals,
        is_initialized: true,
        freeze_authority: COption::None,
    };
    let mut data = vec![0u8; spl_token::state::Mint::LEN];
    spl_token::state::Mint::pack(state, &mut data).unwrap();
    svm.set_account(
        *mint,
        Account {
            lamports: 1_000_000_000,
            data,
            owner: spl_token::ID,
            executable: false,
            rent_epoch: 0,
        },
    )
    .unwrap();
}

pub fn write_token_account(
    svm: &mut LiteSVM,
    ata: &Pubkey,
    mint: &Pubkey,
    owner: &Pubkey,
    amount: u64,
) {
    let state = spl_token::state::Account {
        mint: *mint,
        owner: *owner,
        amount,
        delegate: COption::None,
        state: spl_token::state::AccountState::Initialized,
        is_native: COption::None,
        delegated_amount: 0,
        close_authority: COption::None,
    };
    let mut data = vec![0u8; spl_token::state::Account::LEN];
    spl_token::state::Account::pack(state, &mut data).unwrap();
    svm.set_account(
        *ata,
        Account {
            lamports: 1_000_000_000,
            data,
            owner: spl_token::ID,
            executable: false,
            rent_epoch: 0,
        },
    )
    .unwrap();
}

// ---------------------------------------------------------------------------
// PDA derivation (mirrors amm::constants seeds)
// ---------------------------------------------------------------------------

pub fn config_pda() -> Pubkey {
    Pubkey::find_program_address(&[CONFIG_SEED], &program_id()).0
}

pub fn market_config_pda(config_id: u16) -> Pubkey {
    Pubkey::find_program_address(&[MKT_CONFIG_SEED, &config_id.to_le_bytes()], &program_id()).0
}

pub fn market_pda(fixture_id: i64) -> Pubkey {
    Pubkey::find_program_address(&[MARKET_SEED, &fixture_id.to_le_bytes()], &program_id()).0
}

pub fn vault_pda(market: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[VAULT_SEED, market.as_ref()], &program_id()).0
}

pub fn position_pda(market: &Pubkey, owner: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(
        &[POSITION_SEED, market.as_ref(), owner.as_ref()],
        &program_id(),
    )
    .0
}

// ---------------------------------------------------------------------------
// Instruction builders
// ---------------------------------------------------------------------------

pub fn ix_initialize_config(
    admin: &Pubkey,
    keeper: &Pubkey,
    txline_program: &Pubkey,
    mint: &Pubkey,
) -> Instruction {
    Instruction {
        program_id: program_id(),
        accounts: amm::accounts::InitializeConfig {
            authority: *admin,
            config: config_pda(),
            system_program: solana_pubkey::Pubkey::new_from_array(
                anchor_lang::system_program::ID.to_bytes(),
            ),
        }
        .to_account_metas(None),
        data: amm::instruction::InitializeConfig {
            keeper: *keeper,
            txline_program: *txline_program,
            usdt_mint: *mint,
            token_program: token_program_id(),
        }
        .data(),
    }
}

pub fn default_fee_params() -> amm::FeeParamsArgs {
    amm::FeeParamsArgs {
        base_fee_bps: 30,
        max_fee_bps: 1_000,
        vfc_num: 10,
        filter_period: 10,
        decay_period: 100,
        reduction_bps: 5_000,
        max_v_acc: 1_000_000_000,
        resolution_grace_secs: 3_600,
        resolution_threshold: 0,
        resolution_comparison: 0,
        stat_key_a: 1,
        stat_key_b: 2,
        stat_op: 2,
    }
}

pub fn ix_create_market_config(
    admin: &Pubkey,
    config_id: u16,
    params: amm::FeeParamsArgs,
) -> Instruction {
    Instruction {
        program_id: program_id(),
        accounts: amm::accounts::CreateMarketConfig {
            authority: *admin,
            global: config_pda(),
            market_config: market_config_pda(config_id),
            system_program: sys_program(),
        }
        .to_account_metas(None),
        data: amm::instruction::CreateMarketConfig { config_id, params }.data(),
    }
}

#[allow(clippy::too_many_arguments)]
pub fn ix_init_market(
    admin: &Pubkey,
    config_id: u16,
    fixture_id: i64,
    kickoff_ts: i64,
    freeze_ts: i64,
    seed_yes: u64,
    seed_no: u64,
    seed_liquidity: u64,
    mint: &Pubkey,
    admin_ata: &Pubkey,
) -> Instruction {
    let market = market_pda(fixture_id);
    Instruction {
        program_id: program_id(),
        accounts: amm::accounts::InitMarket {
            authority: *admin,
            global: config_pda(),
            market_config: market_config_pda(config_id),
            market,
            vault: vault_pda(&market),
            usdt_mint: *mint,
            authority_usdt: *admin_ata,
            token_program: token_program_id(),
            system_program: sys_program(),
        }
        .to_account_metas(None),
        data: amm::instruction::InitMarket {
            fixture_id,
            kickoff_ts,
            freeze_ts,
            seed_yes,
            seed_no,
            seed_liquidity,
        }
        .data(),
    }
}

pub fn ix_open_position(owner: &Pubkey, fixture_id: i64) -> Instruction {
    let market = market_pda(fixture_id);
    Instruction {
        program_id: program_id(),
        accounts: amm::accounts::OpenPosition {
            owner: *owner,
            market,
            position: position_pda(&market, owner),
            system_program: sys_program(),
        }
        .to_account_metas(None),
        data: amm::instruction::OpenPosition {}.data(),
    }
}

pub fn ix_buy(
    trader: &Pubkey,
    config_id: u16,
    fixture_id: i64,
    side: amm::Side,
    usdt_in: u64,
    min_out: u64,
    mint: &Pubkey,
    trader_ata: &Pubkey,
) -> Instruction {
    let market = market_pda(fixture_id);
    Instruction {
        program_id: program_id(),
        accounts: amm::accounts::Buy {
            trader: *trader,
            market,
            market_config: market_config_pda(config_id),
            position: position_pda(&market, trader),
            trader_usdt: *trader_ata,
            vault: vault_pda(&market),
            usdt_mint: *mint,
            token_program: token_program_id(),
        }
        .to_account_metas(None),
        data: amm::instruction::Buy { side, usdt_in, min_out }.data(),
    }
}

pub fn ix_sell(
    trader: &Pubkey,
    config_id: u16,
    fixture_id: i64,
    side: amm::Side,
    tokens_in: u64,
    min_usdt_out: u64,
    mint: &Pubkey,
    trader_ata: &Pubkey,
) -> Instruction {
    let market = market_pda(fixture_id);
    Instruction {
        program_id: program_id(),
        accounts: amm::accounts::Sell {
            trader: *trader,
            market,
            market_config: market_config_pda(config_id),
            position: position_pda(&market, trader),
            trader_usdt: *trader_ata,
            vault: vault_pda(&market),
            usdt_mint: *mint,
            token_program: token_program_id(),
        }
        .to_account_metas(None),
        data: amm::instruction::Sell { side, tokens_in, min_usdt_out }.data(),
    }
}

pub fn sys_program() -> Pubkey {
    Pubkey::new_from_array(anchor_lang::system_program::ID.to_bytes())
}

// ---------------------------------------------------------------------------
// Phase 2 — TxLINE mock-oracle fixtures (plan §10.1 cases 9–11)
// ---------------------------------------------------------------------------

/// `epoch_day` for a TxLINE timestamp, exactly as `resolve` re-derives it.
/// TxLINE `ts` is in MILLISECONDS: `epoch_day = ts / 86_400_000`.
pub fn epoch_day(ts: i64) -> u16 {
    u16::try_from(ts.div_euclid(MILLIS_PER_DAY)).unwrap()
}

/// TxLINE `daily_scores_merkle_roots` PDA for an epoch day (under `owner_id`).
pub fn daily_roots_pda(owner_id: &Pubkey, day: u16) -> Pubkey {
    Pubkey::find_program_address(&[DAILY_SCORES_ROOTS_SEED, &day.to_le_bytes()], owner_id).0
}

/// Fabricate the roots account at the canonical PDA, owned by `owner_id`.
/// `first_byte` = 0x00 for normal mode; `mock_txoracle::ERROR_MODE_SENTINEL`
/// (0xFF) flips the mock into its RootNotAvailable(6007) error mode.
pub fn write_roots_account(svm: &mut LiteSVM, owner_id: &Pubkey, day: u16, first_byte: u8) -> Pubkey {
    let pda = daily_roots_pda(owner_id, day);
    let mut data = vec![0u8; 64];
    data[0] = first_byte;
    svm.set_account(
        pda,
        Account {
            lamports: 1_000_000_000,
            data,
            owner: *owner_id,
            executable: false,
            rent_epoch: 0,
        },
    )
    .unwrap();
    pda
}

/// Proof/summary/stat args for `resolve`, shaped for `default_fee_params()`
/// (stat_key_a=1 home goals, stat_key_b=2 away goals, op=Subtract,
/// predicate `home - away > 0`). The mock treats proofs as valid and
/// evaluates the predicate against these goal values.
pub struct ResolveArgs {
    pub ts: i64,
    pub fixture_summary: amm::txline_types::ScoresBatchSummary,
    pub fixture_proof: Vec<amm::txline_types::ProofNode>,
    pub main_tree_proof: Vec<amm::txline_types::ProofNode>,
    pub stat_a: amm::txline_types::StatTerm,
    pub stat_b: Option<amm::txline_types::StatTerm>,
    pub op: Option<amm::txline_types::BinaryExpression>,
}

pub fn resolve_args(fixture_id: i64, ts: i64, home_goals: i32, away_goals: i32) -> ResolveArgs {
    use amm::txline_types as tt;
    let stat = |key: u32, value: i32| tt::StatTerm {
        stat_to_prove: tt::ScoreStat { key, value, period: 0 },
        event_stat_root: [0u8; 32],
        stat_proof: vec![tt::ProofNode { hash: [1u8; 32], is_right_sibling: false }],
    };
    ResolveArgs {
        ts,
        fixture_summary: tt::ScoresBatchSummary {
            fixture_id,
            update_stats: tt::ScoresUpdateStats {
                update_count: 1,
                min_timestamp: ts,
                max_timestamp: ts,
            },
            events_sub_tree_root: [2u8; 32],
        },
        fixture_proof: vec![tt::ProofNode { hash: [3u8; 32], is_right_sibling: true }],
        main_tree_proof: vec![tt::ProofNode { hash: [4u8; 32], is_right_sibling: false }],
        stat_a: stat(1, home_goals),
        stat_b: Some(stat(2, away_goals)),
        op: Some(tt::BinaryExpression::Subtract),
    }
}

// ---------------------------------------------------------------------------
// Phase 2 — instruction builders
// ---------------------------------------------------------------------------

pub fn ix_activate_market(keeper: &Pubkey, fixture_id: i64) -> Instruction {
    Instruction {
        program_id: program_id(),
        accounts: amm::accounts::ActivateMarket {
            keeper: *keeper,
            global: config_pda(),
            market: market_pda(fixture_id),
        }
        .to_account_metas(None),
        data: amm::instruction::ActivateMarket {}.data(),
    }
}

pub fn ix_freeze_market(keeper: &Pubkey, fixture_id: i64) -> Instruction {
    Instruction {
        program_id: program_id(),
        accounts: amm::accounts::FreezeMarket {
            keeper: *keeper,
            global: config_pda(),
            market: market_pda(fixture_id),
        }
        .to_account_metas(None),
        data: amm::instruction::FreezeMarket {}.data(),
    }
}

/// `resolve` with overridable txline program / roots account for the
/// negative-path tests (wrong callee, wrong roots owner/address).
#[allow(clippy::too_many_arguments)]
pub fn ix_resolve(
    keeper: &Pubkey,
    config_id: u16,
    fixture_id: i64,
    outcome_hint: amm::Side,
    args: ResolveArgs,
    txline_program: &Pubkey,
    daily_scores_merkle_roots: &Pubkey,
) -> Instruction {
    Instruction {
        program_id: program_id(),
        accounts: amm::accounts::Resolve {
            keeper: *keeper,
            global: config_pda(),
            market: market_pda(fixture_id),
            market_config: market_config_pda(config_id),
            txline_program: *txline_program,
            daily_scores_merkle_roots: *daily_scores_merkle_roots,
        }
        .to_account_metas(None),
        data: amm::instruction::Resolve {
            outcome_hint,
            ts: args.ts,
            fixture_summary: args.fixture_summary,
            fixture_proof: args.fixture_proof,
            main_tree_proof: args.main_tree_proof,
            stat_a: args.stat_a,
            stat_b: args.stat_b,
            op: args.op,
        }
        .data(),
    }
}

pub fn ix_redeem(owner: &Pubkey, fixture_id: i64, mint: &Pubkey, owner_ata: &Pubkey) -> Instruction {
    let market = market_pda(fixture_id);
    Instruction {
        program_id: program_id(),
        accounts: amm::accounts::Redeem {
            owner: *owner,
            market,
            position: position_pda(&market, owner),
            vault: vault_pda(&market),
            owner_usdt: *owner_ata,
            usdt_mint: *mint,
            token_program: token_program_id(),
        }
        .to_account_metas(None),
        data: amm::instruction::Redeem {}.data(),
    }
}

pub fn ix_close_market(
    authority: &Pubkey,
    config_id: u16,
    fixture_id: i64,
    mint: &Pubkey,
    authority_ata: &Pubkey,
) -> Instruction {
    let market = market_pda(fixture_id);
    Instruction {
        program_id: program_id(),
        accounts: amm::accounts::CloseMarket {
            authority: *authority,
            global: config_pda(),
            market,
            market_config: market_config_pda(config_id),
            vault: vault_pda(&market),
            authority_usdt: *authority_ata,
            usdt_mint: *mint,
            token_program: token_program_id(),
        }
        .to_account_metas(None),
        data: amm::instruction::CloseMarket {}.data(),
    }
}

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

/// Assert a failed tx carried the given AmmError custom code.
pub fn assert_amm_error(res: &TransactionResult, err: amm::error::AmmError) {
    let expected = 6000u32 + err as u32;
    match res {
        Ok(_) => panic!("expected failure with error {expected}, got success"),
        Err(failed) => {
            let s = format!("{:?}", failed.err);
            assert!(
                s.contains(&format!("Custom({expected})")),
                "expected Custom({expected}), got: {s}"
            );
        }
    }
}

/// Assert a failed tx carried an arbitrary custom code (e.g. a propagated
/// TxLINE/mock error like RootNotAvailable = 6007).
pub fn assert_custom_error(res: &TransactionResult, code: u32) {
    match res {
        Ok(_) => panic!("expected failure with Custom({code}), got success"),
        Err(failed) => {
            let s = format!("{:?}", failed.err);
            assert!(
                s.contains(&format!("Custom({code})")),
                "expected Custom({code}), got: {s}"
            );
        }
    }
}

/// Fetch + deserialize an Anchor account.
pub fn get_anchor<T: anchor_lang::AccountDeserialize>(svm: &LiteSVM, key: &Pubkey) -> T {
    let acc = svm.get_account(key).unwrap();
    T::try_deserialize(&mut acc.data.as_slice()).unwrap()
}

// ===========================================================================
// Phase C — 3-way (1X2) LMSR market helpers (SPEC §3.1)
// ===========================================================================

use amm::constants::{MARKET_1X2_SEED, POSITION_1X2_SEED};

pub fn market_1x2_pda(fixture_id: i64) -> Pubkey {
    Pubkey::find_program_address(&[MARKET_1X2_SEED, &fixture_id.to_le_bytes()], &program_id()).0
}

pub fn position_1x2_pda(market: &Pubkey, owner: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(
        &[POSITION_1X2_SEED, market.as_ref(), owner.as_ref()],
        &program_id(),
    )
    .0
}

/// TxLINE full-time final stats carry `period = 100` — the pin every 1X2
/// config in these tests uses.
pub const FINAL_PERIOD: i32 = 100;

pub fn ix_create_market_config_1x2(
    admin: &Pubkey,
    config_id: u16,
    params: amm::FeeParamsArgs,
    resolution_period: i32,
) -> Instruction {
    Instruction {
        program_id: program_id(),
        accounts: amm::accounts::CreateMarketConfig1x2 {
            authority: *admin,
            global: config_pda(),
            market_config: market_config_pda(config_id),
            system_program: sys_program(),
        }
        .to_account_metas(None),
        data: amm::instruction::CreateMarketConfig1x2 { config_id, params, resolution_period }
            .data(),
    }
}

#[allow(clippy::too_many_arguments)]
pub fn ix_init_market_1x2(
    admin: &Pubkey,
    config_id: u16,
    fixture_id: i64,
    kickoff_ts: i64,
    freeze_ts: i64,
    b: u64,
    seed_q: [u64; 3],
    seed_liquidity: u64,
    mint: &Pubkey,
    admin_ata: &Pubkey,
) -> Instruction {
    let market = market_1x2_pda(fixture_id);
    Instruction {
        program_id: program_id(),
        accounts: amm::accounts::InitMarket1x2 {
            authority: *admin,
            global: config_pda(),
            market_config: market_config_pda(config_id),
            market,
            vault: vault_pda(&market),
            usdt_mint: *mint,
            authority_usdt: *admin_ata,
            token_program: token_program_id(),
            system_program: sys_program(),
        }
        .to_account_metas(None),
        data: amm::instruction::InitMarket1x2 {
            fixture_id,
            kickoff_ts,
            freeze_ts,
            b,
            seed_q,
            seed_liquidity,
        }
        .data(),
    }
}

pub fn ix_open_position_1x2(owner: &Pubkey, fixture_id: i64) -> Instruction {
    let market = market_1x2_pda(fixture_id);
    Instruction {
        program_id: program_id(),
        accounts: amm::accounts::OpenPosition1x2 {
            owner: *owner,
            market,
            position: position_1x2_pda(&market, owner),
            system_program: sys_program(),
        }
        .to_account_metas(None),
        data: amm::instruction::OpenPosition1x2 {}.data(),
    }
}

#[allow(clippy::too_many_arguments)]
pub fn ix_buy_1x2(
    trader: &Pubkey,
    config_id: u16,
    fixture_id: i64,
    outcome: u8,
    usdt_in: u64,
    min_tokens_out: u64,
    mint: &Pubkey,
    trader_ata: &Pubkey,
) -> Instruction {
    let market = market_1x2_pda(fixture_id);
    Instruction {
        program_id: program_id(),
        accounts: amm::accounts::Buy1x2 {
            trader: *trader,
            market,
            market_config: market_config_pda(config_id),
            position: position_1x2_pda(&market, trader),
            trader_usdt: *trader_ata,
            vault: vault_pda(&market),
            usdt_mint: *mint,
            token_program: token_program_id(),
        }
        .to_account_metas(None),
        data: amm::instruction::Buy1x2 { outcome, usdt_in, min_tokens_out }.data(),
    }
}

#[allow(clippy::too_many_arguments)]
pub fn ix_sell_1x2(
    trader: &Pubkey,
    config_id: u16,
    fixture_id: i64,
    outcome: u8,
    tokens_in: u64,
    min_usdt_out: u64,
    mint: &Pubkey,
    trader_ata: &Pubkey,
) -> Instruction {
    let market = market_1x2_pda(fixture_id);
    Instruction {
        program_id: program_id(),
        accounts: amm::accounts::Sell1x2 {
            trader: *trader,
            market,
            market_config: market_config_pda(config_id),
            position: position_1x2_pda(&market, trader),
            trader_usdt: *trader_ata,
            vault: vault_pda(&market),
            usdt_mint: *mint,
            token_program: token_program_id(),
        }
        .to_account_metas(None),
        data: amm::instruction::Sell1x2 { outcome, tokens_in, min_usdt_out }.data(),
    }
}

pub fn ix_activate_market_1x2(keeper: &Pubkey, fixture_id: i64) -> Instruction {
    Instruction {
        program_id: program_id(),
        accounts: amm::accounts::ActivateMarket1x2 {
            keeper: *keeper,
            global: config_pda(),
            market: market_1x2_pda(fixture_id),
        }
        .to_account_metas(None),
        data: amm::instruction::ActivateMarket1x2 {}.data(),
    }
}

pub fn ix_freeze_market_1x2(keeper: &Pubkey, fixture_id: i64) -> Instruction {
    Instruction {
        program_id: program_id(),
        accounts: amm::accounts::FreezeMarket1x2 {
            keeper: *keeper,
            global: config_pda(),
            market: market_1x2_pda(fixture_id),
        }
        .to_account_metas(None),
        data: amm::instruction::FreezeMarket1x2 {}.data(),
    }
}

/// `resolve_args` variant with an explicit stat `period` (the 1X2 path pins
/// `stat_to_prove.period == MarketConfig.resolution_period`).
pub fn resolve_args_1x2(
    fixture_id: i64,
    ts: i64,
    home_goals: i32,
    away_goals: i32,
    period: i32,
) -> ResolveArgs {
    use amm::txline_types as tt;
    let mut args = resolve_args(fixture_id, ts, home_goals, away_goals);
    args.stat_a.stat_to_prove.period = period;
    if let Some(b) = args.stat_b.as_mut() {
        b.stat_to_prove.period = period;
    }
    let _: &tt::StatTerm = &args.stat_a; // keep the tt import used
    args
}

/// `resolve_1x2` with overridable txline program / roots account.
#[allow(clippy::too_many_arguments)]
pub fn ix_resolve_1x2(
    keeper: &Pubkey,
    config_id: u16,
    fixture_id: i64,
    hint: u8,
    args: ResolveArgs,
    txline_program: &Pubkey,
    daily_scores_merkle_roots: &Pubkey,
) -> Instruction {
    Instruction {
        program_id: program_id(),
        accounts: amm::accounts::Resolve1x2 {
            keeper: *keeper,
            global: config_pda(),
            market: market_1x2_pda(fixture_id),
            market_config: market_config_pda(config_id),
            txline_program: *txline_program,
            daily_scores_merkle_roots: *daily_scores_merkle_roots,
        }
        .to_account_metas(None),
        data: amm::instruction::Resolve1x2 {
            hint,
            ts: args.ts,
            fixture_summary: args.fixture_summary,
            fixture_proof: args.fixture_proof,
            main_tree_proof: args.main_tree_proof,
            stat_a: args.stat_a,
            stat_b: args.stat_b,
            op: args.op,
        }
        .data(),
    }
}

pub fn ix_mint_set_1x2(
    trader: &Pubkey,
    fixture_id: i64,
    amount: u64,
    mint: &Pubkey,
    trader_ata: &Pubkey,
) -> Instruction {
    let market = market_1x2_pda(fixture_id);
    Instruction {
        program_id: program_id(),
        accounts: amm::accounts::MintSet1x2 {
            trader: *trader,
            market,
            position: position_1x2_pda(&market, trader),
            trader_usdt: *trader_ata,
            vault: vault_pda(&market),
            usdt_mint: *mint,
            token_program: token_program_id(),
        }
        .to_account_metas(None),
        data: amm::instruction::MintSet1x2 { amount }.data(),
    }
}

pub fn ix_redeem_set_1x2(
    trader: &Pubkey,
    fixture_id: i64,
    amount: u64,
    mint: &Pubkey,
    trader_ata: &Pubkey,
) -> Instruction {
    let market = market_1x2_pda(fixture_id);
    Instruction {
        program_id: program_id(),
        accounts: amm::accounts::RedeemSet1x2 {
            trader: *trader,
            market,
            position: position_1x2_pda(&market, trader),
            trader_usdt: *trader_ata,
            vault: vault_pda(&market),
            usdt_mint: *mint,
            token_program: token_program_id(),
        }
        .to_account_metas(None),
        data: amm::instruction::RedeemSet1x2 { amount }.data(),
    }
}

pub fn ix_redeem_1x2(
    owner: &Pubkey,
    fixture_id: i64,
    mint: &Pubkey,
    owner_ata: &Pubkey,
) -> Instruction {
    let market = market_1x2_pda(fixture_id);
    Instruction {
        program_id: program_id(),
        accounts: amm::accounts::Redeem1x2 {
            owner: *owner,
            market,
            position: position_1x2_pda(&market, owner),
            vault: vault_pda(&market),
            owner_usdt: *owner_ata,
            usdt_mint: *mint,
            token_program: token_program_id(),
        }
        .to_account_metas(None),
        data: amm::instruction::Redeem1x2 {}.data(),
    }
}

pub fn ix_close_market_1x2(
    authority: &Pubkey,
    config_id: u16,
    fixture_id: i64,
    mint: &Pubkey,
    authority_ata: &Pubkey,
) -> Instruction {
    let market = market_1x2_pda(fixture_id);
    Instruction {
        program_id: program_id(),
        accounts: amm::accounts::CloseMarket1x2 {
            authority: *authority,
            global: config_pda(),
            market,
            market_config: market_config_pda(config_id),
            vault: vault_pda(&market),
            authority_usdt: *authority_ata,
            usdt_mint: *mint,
            token_program: token_program_id(),
        }
        .to_account_metas(None),
        data: amm::instruction::CloseMarket1x2 {}.data(),
    }
}

/// Multi-instruction send (used to prepend a `set_compute_unit_limit` for the
/// LMSR delta-solve in `buy_1x2`, exactly as production clients will).
pub fn send_tx_ixs(
    svm: &mut LiteSVM,
    signers: &[&Keypair],
    payer: &Pubkey,
    ixs: &[Instruction],
) -> TransactionResult {
    svm.expire_blockhash();
    let msg = Message::new(ixs, Some(payer));
    let tx = Transaction::new(signers, msg, svm.latest_blockhash());
    svm.send_transaction(tx)
}

/// The CU limit 1X2-buy test txs request (LMSR delta-solve is CU-heavy).
pub const CU_LIMIT_1X2_BUY: u32 = 1_400_000;

pub fn ix_set_cu_limit(units: u32) -> Instruction {
    solana_compute_budget_interface::ComputeBudgetInstruction::set_compute_unit_limit(units)
}

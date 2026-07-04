//! Shared LiteSVM harness for the AMM program (plan §10.1).
//!
//! Fabricates a classic-SPL USDC-like mint + funded ATAs via `set_account`
//! (the "infinite USDC" pattern — no mint keypair needed), controls the clock
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

use amm::constants::{CONFIG_SEED, MARKET_SEED, MKT_CONFIG_SEED, POSITION_SEED, VAULT_SEED};

pub const BASE_TS: i64 = 1_700_000_000;
pub const USDC_DECIMALS: u8 = 6;
pub const ONE_USDC: u64 = 1_000_000;

/// Program ids we treat as fixed inside tests.
pub fn program_id() -> Pubkey {
    amm::ID
}

pub fn token_program_id() -> Pubkey {
    spl_token::ID
}

/// A convenient fabricated USDC mint address (arbitrary — we own its bytes).
pub fn usdc_mint() -> Pubkey {
    Pubkey::new_from_array([7u8; 32])
}

/// Test harness bundle.
pub struct Harness {
    pub svm: LiteSVM,
    pub admin: Keypair,
    pub keeper: Keypair,
    pub usdc_mint: Pubkey,
}

impl Harness {
    /// Fresh SVM with the AMM program loaded, admin+keeper funded, USDC mint
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

        let mint = usdc_mint();
        write_mint(&mut svm, &mint, USDC_DECIMALS);

        let mut h = Self { svm, admin, keeper, usdc_mint: mint };
        h.set_time(BASE_TS);
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

    /// Create + fund an ATA for `owner` holding `amount` of the USDC mint.
    pub fn fund_ata(&mut self, owner: &Pubkey, amount: u64) -> Pubkey {
        let ata = get_associated_token_address(owner, &self.usdc_mint);
        write_token_account(&mut self.svm, &ata, &self.usdc_mint, owner, amount);
        ata
    }

    pub fn token_balance(&self, ata: &Pubkey) -> u64 {
        let acc = self.svm.get_account(ata).unwrap();
        spl_token::state::Account::unpack(&acc.data).unwrap().amount
    }

    pub fn send(&mut self, signers: &[&Keypair], payer: &Pubkey, ix: Instruction) -> TransactionResult {
        let msg = Message::new(&[ix], Some(payer));
        let tx = Transaction::new(signers, msg, self.svm.latest_blockhash());
        self.svm.send_transaction(tx)
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
            usdc_mint: *mint,
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
            usdc_mint: *mint,
            authority_usdc: *admin_ata,
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
    usdc_in: u64,
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
            trader_usdc: *trader_ata,
            vault: vault_pda(&market),
            usdc_mint: *mint,
            token_program: token_program_id(),
        }
        .to_account_metas(None),
        data: amm::instruction::Buy { side, usdc_in, min_out }.data(),
    }
}

pub fn ix_sell(
    trader: &Pubkey,
    config_id: u16,
    fixture_id: i64,
    side: amm::Side,
    tokens_in: u64,
    min_usdc_out: u64,
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
            trader_usdc: *trader_ata,
            vault: vault_pda(&market),
            usdc_mint: *mint,
            token_program: token_program_id(),
        }
        .to_account_metas(None),
        data: amm::instruction::Sell { side, tokens_in, min_usdc_out }.data(),
    }
}

pub fn sys_program() -> Pubkey {
    Pubkey::new_from_array(anchor_lang::system_program::ID.to_bytes())
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

/// Fetch + deserialize an Anchor account.
pub fn get_anchor<T: anchor_lang::AccountDeserialize>(svm: &LiteSVM, key: &Pubkey) -> T {
    let acc = svm.get_account(key).unwrap();
    T::try_deserialize(&mut acc.data.as_slice()).unwrap()
}

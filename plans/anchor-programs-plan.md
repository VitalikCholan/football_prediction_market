# Implementation Plan — Anchor Program Layer (`programs/amm/`)

**Scope:** ONLY the on-chain Rust program, its Rust (LiteSVM) tests, and the IDL/client generation that flows out of `anchor build`. NOT the keeper, indexer, or frontend — those are separate teammates. This document is the contract-boundary spec for them (IDL, PDA seeds, instruction signatures) and the full build spec for the program engineer.

**Grounded in:** master `PLAN.md` §§3–8, 10, 11.
**Owner:** on-chain / Anchor specialist.
**Anchor version: 1.0.0 (LOCKED — team decision, MCP-verified).** All code below targets Anchor **1.0.0 stable** (`anchor-lang`/`anchor-spl` `1.0.0`, TS client `@anchor-lang/core`). This is *not* the v2/`anchor-next` alpha (unaudited, git-only, zero-copy `Account<T>`/`BorshAccount<T>`/`CpiHandle` model) — we stay on stable 1.0 with the classic Borsh account model. Toolchain: Rust 1.89+, Solana CLI 3.1.10+, Anchor CLI 1.0.0 (`avm install 1.0.0 && avm use 1.0.0`), Surfpool 1.1.2+.
**Milestone mapping:** PLAN Phase 1 (Core program) + Phase 2 (Resolution). See §12 task breakdown.

---

## 0. MCP verification log (what was confirmed before writing)

Verified via `solana-mcp-server` (`Solana_Expert__Ask_For_Help` / `Solana_Documentation_Search`). **Re-verified for Anchor 1.0.0 (2026-07-02)** against anchor-docs `release-notes/1-0-0`, the Anchor `CHANGELOG.md` (1.0.0 — 2026-04-02), and the Chainstack Anchor-1.0.0 development + escrow guides:

1. **Account space.** `#[account(init, space = 8 + Foo::INIT_SPACE)]`. `#[derive(InitSpace)]` generates `INIT_SPACE` but **does NOT include the 8-byte discriminator** — you always add `8` yourself. **1.0.0 makes the 8-byte discriminator mandatory** (an account sized without it is too small). `#[max_len(N)]` = element count, not bytes. Type sizes: `bool/u8`=1, `u16`=2, `u32`=4, `u64/i64`=8, `u128`=16, `Pubkey`=32, `[T;N]`=`size(T)*N`, `Vec<T>`=`4 + size(T)*max`, `Option<T>`=`1 + size(T)`, enum=`1 + largest_variant`. (Sources: anchor-docs `references/space`, chainstack anchor-1.0.0 development.)
2. **CPI style — Anchor 1.0.0 (LOCKED).** 1.0.0 **removed the redundant `program` `AccountInfo` from `CpiContext`.** Write Pubkey-first:
   - Program-owned CPI: `CpiContext::new(ctx.accounts.token_program.key(), TransferChecked{ from, mint, to, authority })` (or `Token::id()` for a fixed program).
   - PDA-signed CPI: `CpiContext::new_with_signer(ctx.accounts.token_program.key(), TransferChecked{..}, signer_seeds)`.
   - The `TransferChecked`/`Transfer` account-fields still use `.to_account_info()` per field; only the *program* argument changed from `AccountInfo` → `Pubkey`.
   (Source: anchor-docs `release-notes/1-0-0` — "Remove program account info from CPI context"; Chainstack: *"Pre-1.0 `CpiContext::new(ctx.accounts.token_program.to_account_info(), …)` is broken in 1.0.0; use `.key()`."*) **Pre-1.0 `.to_account_info()` form is a compile break — do not use it.**
3. **Token interface.** `Interface<'info, TokenInterface>`, `InterfaceAccount<'info, Mint>`, `InterfaceAccount<'info, TokenAccount>` from `anchor_spl::token_interface` work with **either** SPL Token or Token-2022. `transfer_checked` is mandatory (validates mint decimals). `mint::token_program = token_program` / `associated_token::token_program = token_program` constraints prevent mixing the two token programs. (Source: chainstack escrow pattern @1.0.0, solana-docs tokens/advanced/cpi.)
4. **LiteSVM.** `svm.add_program(id, include_bytes!("../../target/deploy/amm.so"))`, `svm.airdrop`, `svm.set_account(...)` to fabricate arbitrary USDC/token accounts without owning the mint, `svm.set_sysvar::<Clock>(&clock)` and `warp_to_slot` for time-travel, `svm.simulate_transaction`. Custom-error assertion: `err.err == TransactionError::InstructionError(0, InstructionError::Custom(code))`. **`anchor test`/`anchor localnet` now default to Surfpool** in 1.0.0 (was solana-test-validator); LiteSVM remains the in-process unit harness. (Sources: anchor-docs `testing/litesvm`, `release-notes/1-0-0`, litesvm README, chainstack litesvm guide.)
5. **Codama client gen.** `anchor codama generate -l js -p clients target/idl/amm.json` (in-process Anchor→Codama IDL conversion, then `@codama/renderers-js` → `@solana/kit`-compatible client). Or set `[clients] auto = true` in `Anchor.toml` to run after every `anchor build`. Standalone script: `rootNodeFromAnchor(idl)` + `renderJavaScriptVisitor(outDir)`. **1.0.0 note:** the program id is read from the IDL's `address` field; migrating a *previously deployed* program requires closing old IDL accounts first (N/A for our fresh deploy). (Sources: anchor-docs `clients/typescript`, `release-notes/1-0-0`, solana-docs codama/clients.)
6. **Arbitrary-CPI guard.** `UncheckedAccount` does no validation — pair with `#[account(address = config.txline_program)]`. For a typed CPI into an Anchor callee, `declare_program!()` generates a `cpi` module from the callee IDL placed in `/idls` (1.0.0 added an instruction parser to `declare_program!`). (Sources: anchor-docs `security/secure-by-default`, `features/declare-program`.)

**Anchor 1.0.0 breaking-change deltas that this plan bakes in (verified):**
- **`#[error_code]` may appear ONLY ONCE per program** (compile-time error otherwise) → single `AmmError` enum in `error.rs`.
- **Duplicate mutable accounts are rejected by default** — opt in with `#[account(mut, dup)]` only when intentional. `init_if_needed` accounts are now *included* in the duplicate-mutable check (CHANGELOG #4239) — relevant to decision D-3.
- **`AccountInfo` in `#[derive(Accounts)]` is deprecated** (compile warning) → use `UncheckedAccount` + `/// CHECK:` doc comment everywhere.
- **`has_one` is deprecated in favor of explicit `address` checks** where the reference is a stored `Pubkey` — prefer `address =` (see §8).
- **`#[interface]` attribute + `interface-instructions` feature removed** → custom discriminators via `#[instruction(discriminator = <EXPR>)]` (only matters if we ever implement a transfer-hook for TxL Token-2022 — see O-3).
- **`Anchor.toml` `[registry]` section removed**; `arch` build options removed; new optional `[hooks]` `{pre,post}-{build,test,deploy}` section available; `check_program_id_mismatch` runs at build (skipped in `anchor test`).
- **TS client:** import from **`@anchor-lang/core`** (`^1.0.0`), not `@coral-xyz/anchor`. (We generate a Codama/Kit client anyway, so this only affects any raw Anchor-TS usage in tests/scripts.)
- **`RequestBuilder::send` returns `Err` instead of panicking** on signing failure (affects any Rust client code, not the program).

**Still to confirm before coding `resolve` — via TxLINE docs + `Solana_Expert__Ask_For_Help`:** §11 open questions (TxLINE program id, `validate_stat` account layout & proof encoding, whether the result is a CPI or an account read, Token-2022 extensions on TxL accounts). See §11 of this doc.

---

## 1. File / module structure

```
programs/amm/
├─ Cargo.toml            # anchor-lang, anchor-spl (token_interface), features
├─ Xargo.toml
└─ src/
   ├─ lib.rs             # declare_id!, #[program] mod amm { thin instruction fns }
   ├─ constants.rs       # seeds (b"config", b"mkt_config", ...), denominators, scales
   ├─ error.rs           # #[error_code] enum AmmError (ONE block — 1.0 requires single)
   ├─ state.rs           # GlobalConfig, MarketConfig, Market, Position + enums + impls
   ├─ math.rs            # pure CPMM math (no Anchor types) — unit-testable
   ├─ fee.rs             # pure dynamic-fee math (no Anchor types) — unit-testable
   └─ instructions/
      ├─ mod.rs          # pub use each; re-export Accounts structs
      ├─ initialize_config.rs
      ├─ create_market_config.rs
      ├─ init_market.rs
      ├─ activate_market.rs
      ├─ freeze_market.rs
      ├─ buy.rs
      ├─ sell.rs
      ├─ resolve.rs
      ├─ redeem.rs
      └─ close_market.rs
```

**Conventions**
- `lib.rs` handlers are one-liners that delegate to `instructions::<name>::handler(ctx, args)`. Keeps `#[program]` readable and lets each file own its `#[derive(Accounts)]` + handler.
- `math.rs` and `fee.rs` are **pure** (`u64`/`u128`/`i64` in, `Result<_, AmmError>` out). No `Clock`, no `AccountInfo`. This is what makes fast, exhaustive unit tests possible and what `program_autofixer` + property tests target.
- `constants.rs` holds all seed byte-strings and fixed-point denominators as `pub const` so tests and the client-side PDA derivation (`libs/shared`) reference the same values.
- Store the **canonical bump** in every PDA account at init; reuse via `bump = account.bump` afterward (compute saving + prevents non-canonical-bump substitution).

`Cargo.toml` essentials (**Anchor 1.0.0**):
```toml
[features]
default = []
cpi = ["no-entrypoint"]
no-entrypoint = []
idl-build = ["anchor-lang/idl-build", "anchor-spl/idl-build"]
[dependencies]
anchor-lang = { version = "1.0.0" }   # omit "init-if-needed" — see D-3; do not let it slip in
anchor-spl  = { version = "1.0.0" }   # token_interface
```
- **Omit the `init-if-needed` feature** (D-3 recommends an explicit `open_position` ix). If D-3 lands on `init_if_needed`, add `features = ["init-if-needed"]` to `anchor-lang` — but note 1.0.0 now folds `init_if_needed` accounts into the duplicate-mutable-account check, so it's safer than before, still avoid on `Market`.
- TS side (tests/scripts): `@anchor-lang/core@^1.0.0` (not `@coral-xyz/anchor`). Program interaction from JS goes through the generated Codama/Kit client in `libs/idl`, so raw Anchor-TS is only for occasional test glue.
- `Anchor.toml`: no `[registry]` section (removed in 1.0.0). Optional `[hooks]` section can run the Codama codegen as a `post-build` hook (alternative to `[clients] auto = true`).

---

## 2. Accounts / PDAs — fields, seeds, space

All space = `8 (discriminator) + INIT_SPACE`. Every struct gets `#[account] #[derive(InitSpace)]`. Sizes below are hand-computed to sanity-check `INIT_SPACE` and to size rent in tests. **Reserve padding** (`_reserved: [u8; N]`) on every account so v1 leverage / future fields don't force a migration.

### 2.1 `GlobalConfig` — seeds `[b"config"]`
Singleton admin/config.

| Field | Type | Bytes | Notes |
|---|---|---|---|
| `authority` | `Pubkey` | 32 | admin; gates config + market-config creation |
| `txline_program` | `Pubkey` | 32 | trusted callee id for `resolve` CPI (arbitrary-CPI guard) |
| `usdc_mint` | `Pubkey` | 32 | pinned collateral mint; reject any other |
| `token_program` | `Pubkey` | 32 | pinned SPL Token program id for USDC (classic Token) |
| `bump` | `u8` | 1 | canonical bump |
| `_reserved` | `[u8; 64]` | 64 | future |

INIT_SPACE = 32*4 + 1 + 64 = **193**; space = **201**.

### 2.2 `MarketConfig` — seeds `[b"mkt_config", config_id.to_le_bytes()]`
**Reusable** per-tournament params. One config → up to 104 markets. `config_id: u16` (arg).

| Field | Type | Bytes | Notes |
|---|---|---|---|
| `config_id` | `u16` | 2 | echo of seed for reads |
| `authority` | `Pubkey` | 32 | must equal `GlobalConfig.authority` (has_one at creation) |
| `base_fee_bps` | `u16` | 2 | e.g. 30 = 0.30% |
| `max_fee_bps` | `u16` | 2 | cap, e.g. 1000 = 10% |
| `vfc_num` | `u32` | 4 | dynamic-fee-control numerator (volatility→fee slope) |
| `filter_period` | `u32` | 4 | seconds; below → no decay |
| `decay_period` | `u32` | 4 | seconds; above → reset accumulator |
| `reduction_bps` | `u16` | 2 | decay factor R (5000 = ×0.5) |
| `max_v_acc` | `u64` | 8 | cap on accumulator |
| `resolution_grace_secs` | `i64` | 8 | grace before close allowed |
| `bump` | `u8` | 1 | |
| `_reserved` | `[u8; 64]` | 64 | v1 leverage params (`max_open_interest`, per-epoch funding rate + `funding_epoch_secs`, `max_mark_age_secs`, `leverage_cutoff_secs`) land here |

INIT_SPACE = 2+32+2+2+4+4+4+2+8+8+1+64 = **133**; space = **141**.

> **v1 leverage reserved budget (see §4.10):** the leverage vault binds total exposure with `max_open_interest: u64` (8 bytes) on `MarketConfig`, plus `time_fee_num: u32` (per-epoch funding-rate slope, theta), `funding_epoch_secs: u32` (rolling-funding epoch length, §4.10), `max_mark_age_secs: u32` (staleness guard on the TxLINE StablePrice mark, §4.10), `leverage_cutoff_secs: i64` (adverse-selection window before expected resolution) and `max_leverage: u16`. These are carved from the `[u8; 64]` `_reserved` above (8+4+4+4+8+2 = 30 bytes; 34 left) — **no migration needed** when v1 lands. v0 leaves them zero.

### 2.3 `Market` — seeds `[b"market", match_id.to_le_bytes()]`
`match_id: u64` (arg). One per match.

| Field | Type | Bytes | Notes |
|---|---|---|---|
| `config` | `Pubkey` | 32 | the `MarketConfig` it binds to (`has_one`/address check) |
| `match_id` | `u64` | 8 | echo of seed |
| `yes_reserve` | `u64` | 8 | CPMM x |
| `no_reserve` | `u64` | 8 | CPMM y |
| `usdc_collateral` | `u64` | 8 | total USDC held for this market (invariant vs vault) |
| `yes_supply` | `u64` | 8 | total YES positions outstanding (for redeem accounting) |
| `no_supply` | `u64` | 8 | total NO positions outstanding |
| `state` | `MarketState` (enum) | 1 | see below |
| `outcome` | `Outcome` (enum) | 1 | Unset / Yes / No / Void |
| `vault` | `Pubkey` | 32 | EscrowVault token account |
| `vault_bump` | `u8` | 1 | |
| `kickoff_ts` | `i64` | 8 | Open→Trading gate |
| `freeze_ts` | `i64` | 8 | Trading→Locked gate |
| `last_price_bps` | `u16` | 2 | dynamic-fee: YES price at last trade (0..10_000) |
| `last_ts` | `i64` | 8 | dynamic-fee: timestamp of last trade |
| `v_acc` | `u64` | 8 | dynamic-fee: volatility accumulator (scaled) |
| `bump` | `u8` | 1 | |
| `_reserved` | `[u8; 64]` | 64 | future |

INIT_SPACE = 32+8+8+8+8+8+8+1+1+32+1+8+8+2+8+8+1+64 = **214**; space = **222**.

`MarketState` enum (1 byte, `#[derive(InitSpace)]` supported for enums with unit variants):
`Uninitialized, Open, Trading, Locked, Resolved, Closed`.
`Outcome` enum: `Unset, Yes, No, Void`.

> **EscrowVault is NOT a custom account** — it is an SPL token account (USDC) whose **authority is the `Market` PDA**. It has its own address derived as a PDA `[b"vault", market.key()]` and is created with `#[account(init, ... token::mint = usdc_mint, token::authority = market, token::token_program = token_program)]`. Table §2.5.

### 2.4 `Position` — seeds `[b"position", market.key(), owner.key()]`
Per-user internal accounting (NO SPL mints).

| Field | Type | Bytes | Notes |
|---|---|---|---|
| `market` | `Pubkey` | 32 | binds; part of seeds |
| `owner` | `Pubkey` | 32 | binds; part of seeds |
| `yes_tokens` | `u64` | 8 | YES balance |
| `no_tokens` | `u64` | 8 | NO balance |
| `collateral` | `u64` | 8 | **v1 reserved** (leverage). v0 = deposited USDC basis if needed |
| `leverage` | `u16` | 2 | **v1 reserved**; v0 writes `1` |
| `notional` | `u64` | 8 | **v1 reserved** |
| `last_funding_epoch` | `u64` | 8 | **v1 reserved** (leverage); index of the last funding epoch settled into `funding_accrued` (set to the current epoch at open; rolling per-epoch funding, §4.10). Drawn from `_reserved`. v0 = 0 |
| `funding_accrued` | `u64` | 8 | **v1 reserved**; cumulative per-epoch funding accrued so far (lazy accrual, §4.10); position expires when it reaches `collateral`. Drawn from `_reserved`. v0 = 0 |
| `redeemed` | `bool` | 1 | double-redeem guard flag (belt-and-suspenders w/ zeroing) |
| `bump` | `u8` | 1 | |
| `_reserved` | `[u8; 16]` | 16 | future (was `[u8; 32]`; 16 bytes consumed by `last_funding_epoch`+`funding_accrued` for v1 leverage) |

INIT_SPACE = 32+32+8+8+8+8+8+1+1+16 = **132**; space = **140**.

> **v0 note:** `collateral`, `leverage`, `notional`, `last_funding_epoch`, `funding_accrued` all stay **zero** in v0 with `leverage = 1` (pure FPMM path, §4.5 step 7). `last_funding_epoch`/`funding_accrued` are carved from the prior `[u8; 32]` `_reserved` (shrunk to `[u8; 16]`) so total space is unchanged (140) and **no migration** is needed when v1 leverage lands. *(These two u64s were previously reserved as `entry_slot`/`fee_rate_snapshot` — the snapshot-at-open design; re-documented for the per-epoch rolling-funding model of §4.10. Same 16-byte budget, doc-only change, no space change.)* Epoch index = `unix_timestamp / funding_epoch_secs` (§2.2), so `Clock::unix_timestamp` is the only clock read; the theta term likewise uses wall-clock `T−t` against `freeze_ts`/expected resolution.

### 2.5 `EscrowVault` — seeds `[b"vault", market.key()]`
SPL Token account (`InterfaceAccount<TokenAccount>`), `mint = usdc_mint`, `authority = market` PDA. Created in `init_market`. Not an Anchor-owned data account, so no `INIT_SPACE`; Anchor sizes it via the token program.

### 2.6 Seed constants (contract boundary — publish to `libs/shared`)
```
CONFIG_SEED      = b"config"
MKT_CONFIG_SEED  = b"mkt_config"   + config_id: u16 LE
MARKET_SEED      = b"market"       + match_id:  u64 LE
POSITION_SEED    = b"position"     + market: Pubkey + owner: Pubkey
VAULT_SEED       = b"vault"        + market: Pubkey
```
These, the program id, and every instruction discriminator are the ONLY things keeper/indexer/frontend depend on. They arrive via the generated IDL — keeper/indexer/web must never hardcode seeds; they re-derive from `libs/shared` which mirrors these constants.

---

## 3. State machine

```
Uninitialized
   └─ init_market ─────────────▶ Open        (created, pre-kickoff, reserves seeded)
Open
   └─ activate_market ─────────▶ Trading     (now >= kickoff_ts)
Trading
   └─ freeze_market ───────────▶ Locked      (now >= freeze_ts; trading halts)
Locked
   └─ resolve (TxLINE CPI ok) ─▶ Resolved(outcome)
Resolved
   └─ redeem (per user, many)  ─▶ Resolved   (stays; supplies decrement)
Resolved
   └─ close_market ────────────▶ Closed      (after grace; vault drained)
```
- `buy`/`sell` allowed **only** in `Trading`.
- `resolve` allowed **only** in `Locked` (reject double-resolve — the state gate is the guard).
- `redeem` allowed **only** in `Resolved`.
- `close_market` allowed **only** in `Resolved` and `now >= freeze_ts + resolution_grace_secs`.
- Activation/freeze are keeper-driven but clock-guarded so the keeper can't jump the gun.

---

## 4. Instructions — accounts, args, validations, logic

Notation: **[C]** = compile-time Anchor constraint, **[R]** = runtime check in handler.

### 4.1 `initialize_config(txline_program: Pubkey, usdc_mint: Pubkey, token_program: Pubkey)`
Accounts:
- `authority: Signer` (payer)
- `config: init, seeds=[CONFIG_SEED], bump, payer=authority, space=8+GlobalConfig::INIT_SPACE`
- `system_program: Program<System>`

Logic: set all fields, `config.bump = ctx.bumps.config`. Admin key becomes `authority.key()`.
Validations: [C] `init` prevents re-init of the singleton (revival guard). [R] optionally reject `usdc_mint == default`/`txline_program == default`.

### 4.2 `create_market_config(config_id: u16, params: FeeParams)`
`FeeParams` = a plain args struct mirroring the 8 fee fields + `resolution_grace_secs`.
Accounts:
- `authority: Signer`
- `global: Account<GlobalConfig>, seeds=[CONFIG_SEED], bump, has_one = authority`  ← **[C] admin gate**
- `market_config: init, seeds=[MKT_CONFIG_SEED, config_id.to_le_bytes()], bump, payer=authority, space=8+MarketConfig::INIT_SPACE`
- `system_program`

Validations: [R] `base_fee_bps <= max_fee_bps <= 9900`; `reduction_bps <= 10_000`; `filter_period <= decay_period`; `max_v_acc > 0`; `vfc_num > 0`. Write `authority`, `bump`.

### 4.3 `init_market(match_id: u64, kickoff_ts: i64, freeze_ts: i64, seed_yes: u64, seed_no: u64)`
Seeds reserves so initial YES price ≈ 0.50 (`seed_yes == seed_no`, or admin chooses). Admin/keeper funds initial liquidity from an admin USDC ATA equal to the collateral backing (`seed_yes` + `seed_no` mapped to USDC per the 1-token=$1 convention, or a fixed `seed_liquidity` — see note).

Accounts:
- `authority: Signer` (must be admin; source of seed liquidity)
- `global: Account<GlobalConfig>, seeds=[CONFIG_SEED], bump, has_one = authority`
- `market_config: Account<MarketConfig>, seeds=[MKT_CONFIG_SEED, market_config.config_id.to_le_bytes()], bump`
- `market: init, seeds=[MARKET_SEED, match_id.to_le_bytes()], bump, payer=authority, space=8+Market::INIT_SPACE`
- `vault: init, seeds=[VAULT_SEED, market.key()], bump, payer=authority, token::mint = usdc_mint, token::authority = market, token::token_program = token_program`
- `usdc_mint: InterfaceAccount<Mint>, address = global.usdc_mint`  ← **[C] pin mint**
- `authority_usdc: InterfaceAccount<TokenAccount>, token::mint = usdc_mint, token::authority = authority`
- `token_program: Interface<TokenInterface>, address = global.token_program`  ← **[C] pin token program**
- `system_program`, `rent`

Logic:
1. [R] `require!(kickoff_ts < freeze_ts)`, both `> now`.
2. [R] `require!(seed_yes > 0 && seed_no > 0)`.
3. Write `market`: `config = market_config.key()`, reserves, `state = Open`, `outcome = Unset`, `vault = vault.key()`, `vault_bump`, `kickoff_ts`, `freeze_ts`, `last_price_bps = price(seed_yes, seed_no)`, `last_ts = now`, `v_acc = 0`, `usdc_collateral = seed_liquidity`, supplies=0, bump.
4. `transfer_checked` seed USDC from `authority_usdc` → `vault` (authority = the signer, so plain CPI, no PDA signing).

> **Design note on seed liquidity vs reserves.** Reserves (`x`,`y`) are the CPMM curve variables; the vault holds real USDC. Keep them decoupled: reserves set odds, `usdc_collateral` tracks real solvency for redemption. Decide the exact mapping (virtual reserves vs fully-backed) in Phase-1 math design; the invariant that matters for safety is **vault USDC balance ≥ max(yes_supply, no_supply)** at resolution so every winner can be paid $1. Document the chosen model in `math.rs` header.

### 4.4 `activate_market()` / `freeze_market()`
Accounts: `keeper: Signer`, `market: mut, seeds=[MARKET_SEED, market.match_id.to_le_bytes()], bump`.
`activate`: [R] `state == Open`, `now >= kickoff_ts` → `state = Trading`; set `last_ts = now`.
`freeze`: [R] `state == Trading`, `now >= freeze_ts` → `state = Locked`.
> Keeper authorization: for the hackathon, allow **any** signer to flip these because both are clock-gated (can't be done early) and idempotent-ish; OR gate with `has_one` to a `keeper` pubkey on `GlobalConfig`. **Recommendation:** add `keeper: Pubkey` to `GlobalConfig` and gate both — cheap, closes a griefing vector. (Add to §2.1 `_reserved` budget → make it an explicit field, adjust space +32.)

### 4.5 `buy(side: Side, usdc_in: u64, min_out: u64)`
`Side` enum arg: `Yes | No`.
Accounts:
- `trader: Signer`
- `market: mut, seeds=[MARKET_SEED, ...], bump, has_one = config`  ← **[C] market↔config binding**
- `market_config: Account<MarketConfig>, address = market.config`  ← **[C]**
- `position: init_if_needed?` — **NO.** Use two-step: caller must have created position, OR use `init_if_needed` ONLY on Position with owner+market seeds (reinit here is safe because seeds pin owner+market and we never overwrite balances, only add). **Decision:** allow `init_if_needed` on `Position` (not Market) — the PLAN forbids it on Market/Position for *reinitialization → balance overwrite*. To honor that strictly, prefer an explicit `open_position` instruction OR guard the handler to never zero balances on init. **Safest for hackathon: explicit `init` inside buy via `init_if_needed` with a handler that only *adds*, plus `program_autofixer` review.** Flag as decision D-3 (§11).
- `trader_usdc: InterfaceAccount<TokenAccount>, mut, token::mint = usdc_mint, token::authority = trader`
- `vault: InterfaceAccount<TokenAccount>, mut, address = market.vault`
- `usdc_mint: InterfaceAccount<Mint>, address = global.usdc_mint` (need `global` too, or store `usdc_mint` on `Market` to avoid extra account — **store `usdc_mint` on Market** to keep buy/sell account list short; add field, +32 space)
- `token_program: Interface<TokenInterface>, address = <pinned>`
- `system_program`

Handler logic (order matters — CEI-ish):
1. [R] `market.state == Trading`; `now >= market.last_ts` (monotonic clock guard); `usdc_in > 0`.
2. **Update dynamic fee** (`fee.rs`, §5.2): compute `elapsed = now - last_ts`, decay `v_acc`, compute `fee_bps` from the *pre-trade* price. (Fee uses the accumulator state entering this trade.)
3. `amount_in_after_fee = usdc_in * (10_000 - fee_bps) / 10_000` (checked; fee is skimmed into the pool → LPs, i.e. stays in reserves/vault).
4. **CPMM** (`math.rs`, §5.1): buying `Yes` means paying USDC to the pool and removing YES tokens: `out = compute_out(reserve_in = opposite, reserve_out = side, amount_in_after_fee)`. Spell out exact reserve mapping in math.rs; the constant-product form is `out = y - k/(x + Δx)`.
5. [R] `require!(out >= min_out, SlippageExceeded)`.
6. Update reserves (checked); recompute `last_price_bps` from new reserves; **add price move to `v_acc`** (`v_acc = min(v_ref + price_delta_bps * SCALE, max_v_acc)`); set `last_ts = now`.
7. Credit `position.<side>_tokens += out`; `market.<side>_supply += out`; `position.leverage = 1` if newly created.
8. `transfer_checked(usdc_in)` trader_usdc → vault (authority = trader, plain CPI); `market.usdc_collateral += usdc_in`.
9. Re-validate reserves > 0.

### 4.6 `sell(side: Side, tokens_in: u64, min_usdc_out: u64)`
Inverse of buy. Accounts add `vault` as source (authority = `market` PDA → **`transfer_checked` with `new_with_signer`** using `[VAULT..]`/market seeds). Logic:
1. [R] `state == Trading`, monotonic clock, `tokens_in > 0`, `position.<side>_tokens >= tokens_in`.
2. Update dynamic fee (same as buy).
3. CPMM inverse: `usdc_gross = compute_out(...)`; `usdc_out = usdc_gross * (10_000 - fee_bps)/10_000`.
4. [R] `usdc_out >= min_usdc_out`.
5. Update reserves, `last_price_bps`, `v_acc`, `last_ts`.
6. Debit `position.<side>_tokens`, `market.<side>_supply`, `market.usdc_collateral` (checked, before payout).
7. `transfer_checked(usdc_out)` vault → trader_usdc, **signed by market PDA** (`new_with_signer(&[&[VAULT_SEED, market.key().as_ref(), &[vault_bump]]])` — actually authority is `market`, so sign with the *market* seeds: `&[MARKET_SEED, &match_id_le, &[market.bump]]`). Confirm which PDA is authority: **authority = `market`**, so sign with market seeds.

### 4.7 `resolve(ts, fixture_summary, fixture_proof, main_tree_proof, stat_a, stat_b, op)` — TxLINE CPI (Phase 2)
**UNBLOCKED — TxLINE interface confirmed from official docs (2026-07-02).** See §11 for the resolved open items and §11.1 for the full TxLINE reference.

**Model (confirmed).** TxLINE is **not** a write-a-result oracle and `validate_stat` does **not** return `Ok/Err`. It is a **read-only instruction returning `bool`** that checks a caller-supplied **Merkle proof** against the **daily score roots the TxLINE oracle posts on-chain**. Our `resolve` **CPIs into `validate_stat`, reads the returned `bool`** via the `declare_program!`-generated wrapper (`Return<bool>::get()` → `get_return_data()` + program-id check, verified via MCP), and unlocks only if `true`. The CPI touches **only** the read-only `daily_scores_merkle_roots` PDA — **no token accounts, zero Token-2022 exposure in `resolve`.**

**How a market's outcome is expressed.** A YES/NO question is a **`TraderPredicate`** over one or two **`StatTerm`s** — stored on `MarketConfig` (or `Market`) at creation so the keeper/redeem path is deterministic. Example "Home team wins":
`stat_a` = P1 total goals (`ScoreStat{ key: 1, .. }`), `stat_b` = P2 total goals (`key: 2`), `op = Subtract`, `predicate = { threshold: 0, comparison: GreaterThan }`. The keeper fetches the concrete proof/values from `GET /api/scores/stat-validation?fixtureId=&seq=&statKey=1&statKey2=2` and passes them as instruction args.

**Args** (mirror TxLINE `validate_stat`; types from their IDL — see §11.1):
`ts: i64`, `fixture_summary: ScoresBatchSummary`, `fixture_proof: Vec<ProofNode>`, `main_tree_proof: Vec<ProofNode>`, `stat_a: StatTerm`, `stat_b: Option<StatTerm>`, `op: Option<BinaryExpression>`. The `predicate` for our resolve is **read from `market_config` (stored), not passed by the keeper** — so the keeper can't move the goalposts. (Optionally still pass it and `require!(passed == stored)`.)

Accounts:
- `keeper: Signer` (gated to `global.keeper` per D-1)
- `global: Account<GlobalConfig>, seeds=[CONFIG_SEED], bump`
- `market: mut, seeds=[MARKET_SEED, market.fixture_id.to_le_bytes()], bump` (bind `market_config` via `address` on the next account)
- `market_config: Account<MarketConfig>, address = market.config`
- `txline_program: UncheckedAccount, address = global.txline_program`  ← **[C] arbitrary-CPI guard.** Devnet `6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J`, mainnet `9ExbZjAapQww1vfcisDmrngPinHTEfpjYRWMunJgcKaA` — pinned via `global.txline_program`.
- `daily_scores_merkle_roots: UncheckedAccount` (read-only) — TxLINE PDA, seeds `["daily_scores_roots", epoch_day: u16 LE]` **owned by the TxLINE program**. Validate `owner == global.txline_program` + re-derive the PDA address for the target `epoch_day`.

Logic:
1. [R] `market.state == Locked` (double-resolve guard — the state gate is the only guard needed).
2. Build the CPI via the generated wrapper and read the return:
   ```rust
   // libs: declare_program!(txline);  // programs/amm/idls/txline.json (devnet IDL)
   use txline::cpi::{self, accounts::ValidateStat};
   let cpi_ctx = CpiContext::new(
       ctx.accounts.txline_program.key(),                       // Anchor 1.0 Pubkey-first
       ValidateStat { daily_scores_merkle_roots: ctx.accounts.daily_scores_merkle_roots.to_account_info() },
   );
   let predicate = market_config.resolution_predicate;          // stored, not keeper-supplied
   let is_valid: bool = cpi::validate_stat(
       cpi_ctx, ts, fixture_summary, fixture_proof, main_tree_proof, predicate, stat_a, stat_b, op,
   )?.get();                                                    // reads get_return_data() immediately
   require!(is_valid, AmmError::ProofRejected);
   ```
   > **Return-data caveat (verified):** return data is cleared before every CPI and available only immediately after — read `.get()` **before any other CPI** in this handler (there are none in `resolve`, so safe).
3. Determine `outcome` from the verified predicate: predicate `true` → the YES side is confirmed (`Outcome::Yes`); to resolve `No`, the market's stored predicate is authored so `validate_stat` proves the NO condition, or run the complementary predicate. **`outcome` is derived from what the proof proves — never taken as a keeper argument.** Set `market.outcome`, `market.state = Resolved`.
4. Emit `MarketResolved { fixture_id, outcome }` (indexer).

**Failure modes to surface (TxLINE errors, §11.1):** `RootNotAvailable (6007)` — the oracle hasn't posted this epoch-day's root yet → keeper must retry after root is posted (do **not** treat as a permanent failure). `PredicateFailed (6021)`, `InvalidStatProof (6023)`, `InvalidMainTreeProof (6004)`, `ProofTooLarge (6062)` — bad/oversized proof; keeper refetches. Since our CPI reads a `bool`, most of these surface as `is_valid == false` or a propagated CPI error; map both to a clean `AmmError::ProofRejected` and let the keeper retry.

> **Never** trust an `outcome`/`predicate` hint without the CPI returning `true`. Unlock is by cryptographic proof against the on-chain root, not the keeper's word.

### 4.8 `redeem()`
Accounts:
- `owner: Signer`
- `market: mut/read, seeds=[MARKET_SEED,...], bump`
- `position: mut, seeds=[POSITION_SEED, market.key(), owner.key()], bump, has_one = owner, has_one = market`
- `vault: InterfaceAccount<TokenAccount>, mut, address = market.vault`
- `owner_usdc: InterfaceAccount<TokenAccount>, mut, token::mint = usdc_mint, token::authority = owner`
- `token_program, system_program`
Logic:
1. [R] `market.state == Resolved`; `!position.redeemed` (or winning balance > 0).
2. Determine winning side from `market.outcome`. `payout = winning_tokens * 1 USDC` (1 token = 1 USDC at $1). For `Void`: refund `position.collateral`/stake per policy.
3. **Zero the winning balance FIRST** (`position.yes_tokens = 0` etc.), decrement `market.<side>_supply` and `market.usdc_collateral` (checked), set `position.redeemed = true`. **Then** payout.
4. `transfer_checked(payout)` vault → owner_usdc, signed by `market` PDA.
> Double-redeem prevented by zeroing-before-transfer + `redeemed` flag + state gate.

### 4.9 `close_market()`
Accounts:
- `authority: Signer`, `global: has_one=authority`
- `market: mut, close = authority, seeds=[MARKET_SEED,...], bump`  ← **[C] secure close, rent → admin**
- `vault: InterfaceAccount<TokenAccount>, mut, address = market.vault`
- `authority_usdc` (dust sweep destination), `token_program`
Logic:
1. [R] `state == Resolved`; `now >= freeze_ts + resolution_grace_secs`.
2. [R] all supplies redeemed OR grace fully elapsed (policy: after grace, sweep remaining vault USDC to admin/treasury — document).
3. Sweep vault balance → `authority_usdc` (signed by market PDA), then `close_account` CPI on the vault token account (authority = market PDA), then Anchor `close = authority` reclaims the `Market` data account.
> Order: drain token account → close token account → Anchor closes data account. Closing a token account with nonzero balance fails, so sweep first.

### 4.10 Leverage vault (v1) — no-liquidation "pay-for-time" leverage (STAGED, NOT v0)

**Not on the v0 critical path.** v0 ships pure FPMM with `Position.leverage = 1` and every leverage field zero (§2.4). This subsection is the on-chain/Rust detail for the v1 direction locked in D-9; economic framing lives in `PLAN §10`.

**The reframe (options, not perps).** No-liquidation, pay-for-time leverage **is a binary option**. The trader pays a continuous **time-fee = theta** (option decay) and can never be liquidated on price; **max loss = collateral**. The `LeveragePool` is the **options writer** (protocol-owned counterparty). This eliminates the entire perps liquidation stack.

**`LeveragePool` PDA** — protocol-owned counterparty, seeds `[b"lev_pool", market.key()]` (proposal), holds the writer's USDC and tracks open exposure. Bound total exposure with **`max_open_interest` on `MarketConfig`** (§2.2 reserved budget): reject opening a position if `pool.open_interest + new_notional > market_config.max_open_interest`. Vault mechanics reuse §7 (Token-2022-capable, balance-delta accounting, PDA-signed payouts).

**Coverage ratio (Delphi/Gensyn risk control — the primary solvency guard).** Frame the whole design as: the options vault's **bounded loss** (each position's `max_payout` is finite) is **underwritten by the pool** (the writer's USDC), **compensated by the time-fee** (theta), and **governed by a coverage ratio** — the Delphi pattern *loss bound → Vault underwrites → fee compensates → coverage governs*. On-chain this is **one PDA field + one guard**, generalizing (not duplicating) the `max_open_interest` check above:
- Track **`total_max_payout: u64`** on `LeveragePool` — the running Σ of the `max_payout` of all *open* leverage positions (incremented on `open_leverage`, decremented on `close_leverage`/`expire_position`). This is the exact liability the pool must be able to honor.
- Define `coverage = pool_balance / total_max_payout` (compute as the checked cross-multiply `pool_balance * COVERAGE_DENOM >= min_coverage_bps * total_max_payout` — no division, pool-favorable rounding). Add `min_coverage_bps: u16` as a configured threshold (on `MarketConfig`, from the reserved budget, or on `LeveragePool` at init).
- **Guard in `open_leverage`:** reject the new position if opening it would drop coverage below `min_coverage_bps` (i.e. `pool_balance * COVERAGE_DENOM >= min_coverage_bps * (total_max_payout + new_max_payout)`). `max_open_interest` bounds *notional* (position sizing); coverage bounds *pool solvency vs worst-case payout* — the coverage guard is the stricter, primary check and `max_open_interest` is the coarse cap it refines. Both live in the same `open_leverage` guard block; keep the coverage math a pure `fee.rs`/`math.rs` fn (`coverage_ok(pool_balance, total_max_payout, new_max_payout, min_coverage_bps) -> bool`), checked, no Anchor types.

**Position fields.** Reuse §2.4 `collateral`, `leverage`, `notional`; leverage opens additionally set **`last_funding_epoch`** (= current epoch) and **`funding_accrued`** (= 0) (§2.4, drawn from `_reserved`). v0 leaves them zero.

**⚠️ Funding model = per-epoch ROLLING funding, NOT snapshot-at-open (Messari/Forecast correction — replaces the earlier design).** An earlier draft snapshotted the theta rate once at `open_leverage` (`fee_rate_snapshot`) and accrued it from `entry_slot` over the position's whole life. That naive FULL-LIFE pricing variant **breaks**: with no liquidation window and a market that can instantly resolve to 0, the fair fee priced over the position's whole life exactly offsets the levered upside — leverage confers no benefit. The fix (what makes Forecast's model work) is **rolling per-epoch funding, re-quoted each epoch** like perps funding — the financier only prices jump risk over one short epoch at a time:
- Funding accrues in **epochs** of `funding_epoch_secs` (§2.2 reserved budget); epoch index = `unix_timestamp / funding_epoch_secs`.
- **Each epoch's rate** = the theta formula below evaluated at that epoch's **mark price** (TxLINE StablePrice mark, below) — NOT at the open price.
- **Lazy accrual stays:** on any interaction, walk the epochs elapsed since `Position.last_funding_epoch`, sum each epoch's funding into `Position.funding_accrued`, advance `last_funding_epoch`. (Tradeoff: the exact per-epoch walk is O(epochs elapsed) but exact; a closed-form/piecewise approximate integration is O(1) but inexact — pick one, keep the math a pure testable fn either way.)

**Per-epoch rate (theta) math — `fee.rs`, pure fn.** Add a pure, unit-testable `compute_epoch_funding_bps(...)` alongside the existing CPMM/dynamic-fee fns (no `Clock`, no `AccountInfo`; `u64`/`u128`/`i64` in, `Result<_, AmmError>` out):
```
// FPMM-cheap form (no erf, pure mul/div): fee_rate ∝ p(1−p) / (T−t)
//   max near p ≈ 0.5, spikes as t → T (resolution).
//   p in bps = the epoch's MARK price (TxLINE StablePrice, below), T−t in slots or secs.
numer   = (p_bps as u128) * ((BPS_DENOM - p_bps) as u128) * (time_fee_num as u128)
denom   = (BPS_DENOM as u128) * (BPS_DENOM as u128) * (t_remaining as u128)   // guard t_remaining != 0
fee_rate_bps = ((numer + denom - 1) / denom) as u64                          // ceil-div (never 0 under load)
```
- **"Correct" form (only if pm-AMM/erf is available, §5.3):** `fee_rate ∝ φ(Φ⁻¹(p)) / √(T−t)` — the pm-AMM/Gaussian theta. Use `p(1−p)/(T−t)` as the FPMM cheap approximation; both are pure fns and property-testable against each other.
- All checked math, ceil-div so the fee never rounds to zero near resolution (same discipline as §5.1/§5.2).

**Mark price = TxLINE StablePrice (NOT our own spot).** TxLINE streams StablePrice odds with on-chain-verifiable proofs (`validate_odds` exists in their IDL, §11.1). The funding rate and any PnL/exposure math must mark to the **TxLINE StablePrice mark**, never to our own thin FPMM spot — spot is manipulable (nudge the pool → distort funding). On-chain shape: the keeper posts the mark — e.g. `mark_price_bps` + `mark_ts` on `LeveragePool` (or a small dedicated `MarkPrice` PDA) — authenticated either as **keeper-signed** (v1 pragmatic; keeper already gated via `GlobalConfig.keeper`, D-1) or **proof-verified via CPI `validate_odds`** (v2, trustless — mirrors the §4.7 `validate_stat` resolve pattern). **Staleness guard:** `[R] require!(now - mark_ts <= max_mark_age_secs)` (§2.2 reserved budget) — reject funding updates and new `open_leverage` against a stale mark.

**Position expiry = deterministic (NO price-based liquidation).** The position dies the instant cumulative `funding_accrued == collateral` — deterministic given the on-chain mark/epoch history, no price-based trigger. Two implementations, both keeper-free of price oracles:
- **Lazy settlement (preferred):** compute accrued funding only on interaction — walk the epochs elapsed since `last_funding_epoch`, each priced at that epoch's mark, and sum into `funding_accrued`. If `funding_accrued >= collateral`, settle the position as expired (writer keeps collateral, trader keeps any in-the-money residual).
- **Permissionless crank:** an optional `expire_position` ix anyone can call once `funding_accrued >= collateral`, to reclaim rent / free open-interest.
- **This replaces liquidation entirely — call out the simplification:** NO liquidation instruction, NO TWAP/price oracle, NO liquidation-cascade logic. Expiry is a pure deterministic function of elapsed epochs and the posted mark history. This is the whole point of the options reframe.

**Adverse-selection guards (same thesis as §4.4/§5.2 dynamic fee, one layer up).** The devnet 60s feed delay (O-4) is the attack window; defend it on the leverage layer too:
- **Fee spike near T** — `p(1−p)/(T−t)` already blows up as `t → T`, pricing out late openers.
- **Cutoff window** — reject opening new leverage positions within `leverage_cutoff_secs` before expected resolution (`freeze_ts` / kickoff+expected-duration). `[R] require!(now < resolution_estimate - leverage_cutoff_secs)`.
- **Size cap vs free pool liquidity** — cap `new_notional` against `LeveragePool` free (uncommitted) USDC and `max_open_interest` (above).
- **SSE risk valve (jump events)** — around discrete jump events (goal, red card — detected by the keeper from the TxLINE SSE stream, §11.1) is exactly when a naive short-gamma vault gets picked off. Keeper-gated **`set_risk_valve(paused: bool, funding_multiplier_bps: u16, until_ts: i64)`** field-set on `LeveragePool`: while active, **new leverage opens are rejected and/or per-epoch funding is widened** by `funding_multiplier_bps`. Bound both knobs on-chain — `[R]` multiplier ≤ hard cap, `until_ts - now` ≤ max duration — so the keeper can dampen, not rug.
- **Short-gamma sizing note:** the vault's dominant loss is jumps, not drift — size `time_fee_num` (theta) off REALIZED TxLINE odds volatility (offline sim via the `fee.rs` harness, same LVR-sim instincts), not a static constant.

**Leverage cap as a function of p.** Reject/clamp `leverage` above a `p`-dependent max:
- **FPMM heuristic:** full `max_leverage` in `p ∈ [0.2, 0.8]`, linear taper → `1x` toward the edges (0/1). Pure fn `max_leverage_for_p(p_bps, max_leverage) -> u16`.
- **pm-AMM form:** `∝ 1/φ(Φ⁻¹(p))` (the Gaussian density is small at the edges → less leverage), available once §5.3's erf lands.

**LP lock / withdraw windows (Delphi/Gensyn — anti-runbank on a KNOWN resolution).** The `LeveragePool` writer capital comes from LPs; a sports resolution is a **scheduled, publicly-known event**, so an LP could yank capital in the minutes before it and dump the shortfall on the remaining LPs. Defend it with a **two-step delayed withdrawal**, not an instant one:
- LP withdrawals go through a **`request_withdraw`** that records the request and only becomes claimable via **`withdraw`** after a delay — to the **next settlement**, or gated by a **lock window before `freeze_ts`/expected resolution** (reuse `leverage_cutoff_secs` or a dedicated `lp_lock_secs`). `[R] require!(now >= request.unlock_ts)` in `withdraw`; `[R]` reject `request_withdraw` from opening a request inside the lock window if the policy is "no new requests near resolution."
- `LeveragePool` fields for the pending-withdrawal accounting: **`pending_withdraw: u64`** (aggregate USDC earmarked for in-flight requests, subtracted from *free* pool liquidity so it can't double-serve as coverage or open-interest headroom) and, per-LP, an `unlock_ts: i64` + requested amount (either on the per-LP position/share account or a small `WithdrawRequest` PDA seeded `[b"lp_withdraw", lev_pool.key(), lp.key()]`). Free liquidity for coverage/sizing = `pool_balance - pending_withdraw`.

**Instructions (v1, sketch — not scaffolded in v0):** `init_leverage_pool` (per market, funds writer, sets `min_coverage_bps`), `open_leverage` (set `collateral`/`leverage`/`notional`, `last_funding_epoch` = current epoch, `funding_accrued` = 0; apply guards incl. coverage-ratio + `max_open_interest` + mark-staleness + risk-valve, bump `open_interest` and `total_max_payout`), `close_leverage`/`expire_position` (settle elapsed funding epochs lazily or via crank; decrement `total_max_payout`), the keeper pair **`post_mark`** (write `mark_price_bps`/`mark_ts`; keeper-signed v1 → `validate_odds` CPI v2, above) / **`set_risk_valve`** (bounded pause/multiplier, above), and the LP-capital pair **`request_withdraw`** (record amount + `unlock_ts`, bump `pending_withdraw`) / **`withdraw`** (after `unlock_ts`, PDA-signed payout, clear the request, reduce `pending_withdraw`). All reuse §7 vault + §8 Anchor-1.0.0 CPI conventions (Pubkey-first, PDA-signed `transfer_checked`, checked math).

**3-way (win/draw/lose) — roadmap note, not a v0/v1 requirement.** v0 is **binary FPMM** (complete sets → coherent YES/NO probabilities for free). A real football market has a **draw**, i.e. three mutually-exclusive outcomes. Running **three independent binary FPMM pools** does *not* guarantee coherent probabilities (they need not sum to 1). A proper 3-way market wants **multi-outcome normalization** — an **LMSR** or **multi-outcome pm-AMM** over the shared outcome space so `P(win)+P(draw)+P(lose)=1` by construction. Flag as a scope/roadmap item (fits the §5.3 `PricingCurve` trait direction); binary win/not-win markets remain the v0 path.

**LiteSVM tests (add to §10 when leverage lands):** (a) **multi-epoch accrual with a CHANGING rate** — warp across several funding epochs (`warp_to_slot`/clock), post a different mark each epoch, verify `funding_accrued` equals the sum of the per-epoch rates; (b) `p(1−p)/(T−t)` peaks at `p≈0.5` and spikes as `t→T`; (b2) **full-life vs epoch pricing economic sanity** (pure-fn/property test) — over a jump path, epoch pricing leaves positive expected edge for a correct directional call while full-life snapshot pricing does not (the Messari correction); (c) **deterministic expiry** — position dies exactly when `funding_accrued == collateral` (lazy settle on interaction AND permissionless crank paths); (d) open-interest cap and `leverage_cutoff_secs` window rejections; (d2) **risk valve** — `open_leverage` rejected while the valve is active, per-epoch funding multiplied by `funding_multiplier_bps`, out-of-bounds multiplier/duration rejected; (d3) **mark staleness** — funding update / `open_leverage` rejected when `now - mark_ts > max_mark_age_secs`; (e) `max_leverage_for_p` taper at the edges; (f) **coverage-ratio rejection** — `open_leverage` succeeds while `pool_balance * COVERAGE_DENOM >= min_coverage_bps * (total_max_payout + new_max_payout)`, and is rejected the moment the new `max_payout` would drop coverage below `min_coverage_bps` (custom error); `total_max_payout` decremented correctly on `close`/`expire`; (g) **withdraw-window enforcement** — `withdraw` before `request.unlock_ts` fails (`warp_to_slot`/clock past `unlock_ts` then succeeds); `request_withdraw` inside the lock window rejected; `pending_withdraw` removes the earmarked USDC from free liquidity so a concurrent `open_leverage` sees reduced coverage/OI headroom.

---

## 5. Math — exact fixed-point spec

### 5.1 CPMM (`math.rs`)
Constants: `BPS_DENOM = 10_000`.
- `price_yes_bps(x_yes, y_no) = no_reserve * 10_000 / (yes_reserve + no_reserve)` → `u16` in `0..=10_000`. Guard denom != 0.
- Buy YES (pay USDC Δin_net, receive YES tokens Δout):
  Map to constant product on the two reserves. Using `k = yes_reserve * no_reserve` (`u128`):
  `new_x = x + Δin_net` (where x is the reserve you add to); `new_y = k / new_x` (ceil? no — floor for output-favorable-to-pool); `Δout = y - new_y`.
  **All intermediates in `u128`**: `k = (x as u128) * (y as u128)`; divide then downcast to `u64` with `try_into` + explicit `MathOverflow` error.
- **Rounding rule:** always round in the pool's favor (user gets floor of `Δout`; user pays ceil where applicable) so `k` never decreases due to rounding. Document per-branch.
- Reject: zero reserves, zero amount, output ≥ reserve (would drain), overflow.
- Every op: `checked_add/sub/mul/div`, `?`-propagate `AmmError::MathOverflow`.

### 5.2 Dynamic volatility fee (`fee.rs`) — three-zone decay + quadratic

**Verified conventions (Raydium CLMM `pool_fee.rs` / Orca adaptive fee, via MCP in PLAN §4.4):**
```
VOLATILITY_ACCUMULATOR_SCALE   = 10_000
REDUCTION_FACTOR_DENOMINATOR   = 10_000
DYNAMIC_FEE_CONTROL_DENOMINATOR= 100_000
```
Inputs: `MarketConfig` params + `Market` fee-state (`last_price_bps`, `last_ts`, `v_acc`), `now: i64`, `new_price_bps` (computed post-trade for the *store*, but fee is charged on the accumulator as it enters the trade).

**Step A — decay (three-zone), using `elapsed = now - last_ts`:**
```
require!(now >= last_ts, MonotonicClock)         // reject backward clock
if elapsed < filter_period:        v_ref = v_acc                             // burst window, no decay
else if elapsed < decay_period:    v_ref = v_acc * reduction_bps / 10_000    // decay ×R
else:                              v_ref = 0                                  // stale, reset
```

**Step B — fee from v_ref (charged on THIS trade):**
```
// quadratic term, square in u128 to avoid u64 overflow
v_sq       = (v_ref as u128) * (v_ref as u128)
fee_num    = (vfc_num as u128) * v_sq
// denom = CONTROL_DENOM * SCALE^2  (SCALE^2 undoes the accumulator scaling)
denom      = (DYNAMIC_FEE_CONTROL_DENOMINATOR as u128) * (SCALE as u128) * (SCALE as u128)
// CEILING division so fee never rounds to 0 under load
variable   = ((fee_num + denom - 1) / denom) as u64
fee_bps    = min(base_fee_bps as u64 + variable, max_fee_bps as u64)
```

**Step C — accumulate this trade's price move (for the NEXT trade), store back:**
```
price_delta_bps = abs(new_price_bps - last_price_bps)     // i32 math, take abs
v_acc_new       = min(v_ref + (price_delta_bps as u64) * SCALE, max_v_acc)
// persist: market.v_acc = v_acc_new; market.last_ts = now; market.last_price_bps = new_price_bps
```

**Ordering in buy/sell:** compute `fee_bps` from `v_ref` (Steps A+B) **before** applying the trade, apply fee to input, run CPMM, then Step C with the resulting `new_price_bps`. This charges the snapshot at trade time and arms the accumulator for the next one.

**Unit conventions summary:** all bps values 0..=10_000; `v_acc` is `price_delta_bps * SCALE` accumulated → capped at `max_v_acc`; fee output is bps.

**Calibration hook:** `fee.rs` must expose the pure `compute_fee_bps(params, state, now)` and `next_v_acc(...)` so the keeper/backtest can replay historical price paths offline (PLAN §4.4 "calibration is the whole game"). Keep them `#[cfg(feature="std")]`-free / no-Anchor so they compile in a plain Rust bench harness.

### 5.3 `PricingCurve` trait — swappable AMM curve (v0 = FPMM; pm-AMM = stretch)

The pricing curve should be an **isolated, swappable module** in `math.rs` behind a small trait, so the curve can be replaced without touching the instruction handlers or the resolution/redemption layer:
```rust
pub trait PricingCurve {
    /// tokens out for a net (post-fee) amount in, given the two reserves. u128 intermediates, checked.
    fn compute_out(reserve_in: u64, reserve_out: u64, amount_in_net: u64) -> Result<u64, AmmError>;
    /// YES price in bps (0..=10_000) from the current reserves/state.
    fn price_yes_bps(yes_reserve: u64, no_reserve: u64) -> Result<u16, AmmError>;
}
```
- **v0 impl = FPMM** (constant product) — exactly §5.1, already specced. `Fpmm::compute_out` = `out = y − k/(x + Δin_net)`; `Fpmm::price_yes_bps` = §5.1. This is the only impl on the v0 critical path.
- **Stretch 2nd impl = static pm-AMM** (Paradigm, 2024). Invariant based on the **normal distribution**: `price = Φ((y − x) / L)` where `L` is the (constant, for the *static* variant) liquidity parameter and `Φ` is the standard-normal CDF. On-chain state is the **same two reserves `x, y` plus the liquidity param `L`** — no new account shape vs FPMM. Requires:
  - **`erf` in fixed-point** via the **Abramowitz–Stegun polynomial approximation, computed in Q64.64** (`Φ(z) = ½(1 + erf(z/√2))`). Pure, unit-testable, no Anchor types — sits next to the CPMM math and is property-tested against a reference `erf`.
  - possibly a **Newton solve** for the trade size (invert `Φ` per swap to get `Δout` for a given `Δin`), also pure fixed-point.
  - **Oracle-free (verified — simplifies scope):** static pm-AMM needs **NO oracle inside the curve** — the "score" (the Gaussian state variable) is *implied* by the marginal price + time-to-maturity, not read from a feed. Only `Φ` (the normal CDF via the A–S `erf` above) is needed on-chain; **`Φ⁻¹` is NOT needed on-chain** if the swap is solved by Newton iteration on the invariant. This confirms the "one evening math module + property tests" estimate — the whole curve is `Φ` + a Newton solve over the two reserves and `L`.
  - **Jump-process caveat (verified — important, football-specific):** static pm-AMM's uniform-LVR optimality is derived from **Gaussian score dynamics**. The pm-AMM paper states basketball fits this (continuous scoring ≈ diffusion) but **football does NOT**: football win-probability is a **jump process** (flat, then a discrete goal-jump) rather than a diffusion. So for this World-Cup market pm-AMM is **"a better-shaped prior for a bounded [0,1] asset, with a jump-dynamics caveat," NOT theoretically optimal here.** Frame it as a shape improvement, not an optimality claim. The strongest, lowest-risk deliverable remains the **README LVR simulation (FPMM vs static pm-AMM) replayed on real TxLINE odds** via the offline `fee.rs`/`math.rs` harness (no on-chain code needed) — cross-ref O-4 historical replay. (Economic framing: `PLAN §10`.)
- **Skip DYNAMIC pm-AMM (two independent reasons).**
  - *On-chain:* the dynamic variant's `L ∝ √(T − t)` per-swap **clock state** is a bug surface (stateful, time-coupled invariant → rounding/monotonicity hazards on-chain).
  - *Economic (verified — decisive for live sports):* dynamic pm-AMM **surrenders ~half the LP capital by expiry and is near-empty exactly at resolution** — but in live sports **~80% of volume is in the final minutes**, so it gives up liquidity precisely on the flow the product is built for. It is **economically counterproductive for a live-sports market.** (Economic framing: `PLAN §10`.)
  - Static pm-AMM only.
- **Why isolated is safe:** the **resolution/redemption layer is identical regardless of curve** — TxLINE Merkle proof (§4.7) → `Outcome` → 1:1 redeem at $1 (§4.8). The curve only sets *odds during trading*; it never touches solvency (vault USDC ≥ winning supply) or payout. So a curve swap is contained to `math.rs`.
- **Framing: stretch, not v0.** Even without shipping pm-AMM on-chain, a **comparative LVR (loss-versus-rebalancing) benchmark in the README** — FPMM vs static pm-AMM replayed over the historical feed (O-4, `fee.rs` offline harness) — is a valuable deliverable. The Gaussian theta form in §4.10 (`φ(Φ⁻¹(p))/√(T−t)`) reuses the same `erf`/`Φ` fixed-point code, so the two stretch tracks share one math module.

---

## 6. Security checklist (§5 of PLAN) → where each check lives

| Check | Location |
|---|---|
| PDA non-sharing (Position seeds = market + owner) | `position` seeds in buy/sell/redeem `#[derive(Accounts)]` |
| No `init_if_needed` on Market | Market always uses plain `init` in `init_market` only |
| `init_if_needed` on Position — decision D-3 | buy/sell (see §4.5); if used, handler ADD-only + `program_autofixer` sign-off |
| Arbitrary-CPI guard (TxLINE id) | `resolve`: `txline_program: UncheckedAccount, address = global.txline_program` **[C]** |
| SPL Token program pinned | every token instruction: `token_program: Interface, address = global.token_program`; `token::token_program = token_program` on ATAs **[C]** |
| Signer/owner checks | `has_one = authority` on config/market-config/close; `has_one = owner` on Position; `Signer` on trader/keeper |
| Checked math everywhere | `math.rs`, `fee.rs`, and every reserve/supply/collateral mutation in handlers |
| Re-validate reserves after CPIs | tail of buy/sell handlers |
| Resolve once only | `resolve`: `require!(state == Locked)` **[R]** |
| Redeem accounting / no double-redeem | `redeem`: zero-before-transfer + `redeemed` flag + `state == Resolved` |
| Secure close (revival) | `close_market`: `close = authority` **[C]**; token account closed via CPI; grace gate |
| Clock-based locking | `Clock::get()?.unix_timestamp` in activate/freeze/close; monotonic guard in buy/sell/fee |
| USDC mint pinned | `usdc_mint` field on Market + `address = global.usdc_mint` **[C]** at init; `token::mint = usdc_mint` on all ATAs |
| Market↔MarketConfig binding | `has_one = config` on Market + `market_config: address = market.config` **[C]** |
| Dynamic-fee safety (u128 square, caps, ceil-div, monotonic ts) | `fee.rs` Steps A–C |
| Duplicate-account defense | **free in Anchor 1.0.0** — duplicate mutable accounts rejected by default (e.g. trader_usdc vs vault can't alias); only add `#[account(mut, dup)]` where aliasing is *intentional* (we never need it). `init_if_needed` accounts are included in this check. |
| Canonical bump reuse | store `bump` at init, `bump = account.bump` after |

---

## 7. Token program correctness (SPL vs Token-2022)

**All token types are `anchor_spl::token_interface` (`Interface<TokenInterface>`, `InterfaceAccount<Mint>`, `InterfaceAccount<TokenAccount>`) + `transfer_checked` everywhere** — these accept *either* classic SPL Token or Token-2022, and `transfer_checked` validates decimals. (MCP-verified.)

**"Support both" — the two readings (see D-6):**
- **(A) Type-level compatibility** — already adopted, free, safe. The code doesn't care which program backs the mint.
- **(B) Actually accepting Token-2022 *collateral* into the vault** — a real feature with real footguns. Verified against the Chainstack 1.0.0 escrow guide + Orca Whirlpools:

| Token-2022 extension | Impact on our escrow |
|---|---|
| **TransferFee** | Vault receives **less than the `amount` arg** → crediting `usdc_in` breaks solvency. **Fix: balance-delta accounting** (below). |
| **TransferHook** | `transfer_checked` needs **extra accounts** that `anchor_spl` does NOT auto-resolve (Orca appends them via `add_extra_accounts_for_execute_cpi`). |
| **DefaultAccountState = Frozen** | Vault created frozen → next deposit fails. Reject at `init_market`. |
| **CPI guard** | Rejects CPI transfers — fatal for a PDA vault moved via CPI. Reject at `init_market`. |
| **Withheld fees on vault** | `close_account` refuses until `harvest_withheld_tokens_to_mint`. Handle in `close_market`. |

**Design (Token-2022-capable, per-market pinning):**
- Store `token_program` (and `collateral_mint`) on `MarketConfig`/`Market`; the vault inits with `token::token_program = token_program` (dynamic per market, not a global classic-SPL pin). Types are `InterfaceAccount` already, so this is a config choice, not a rewrite.
- **Balance-delta accounting on every deposit** (free insurance even for fee-less mints): `let before = vault.amount; transfer_checked(..)?; vault.reload()?; let credited = vault.amount - before;` — credit `Position`/reserves with `credited`, **never the `amount` argument**. Same on payouts (measure actual out).
- **Reject hostile extensions at `init_market`** by reading the mint's TLV: reject TransferHook / DefaultFrozen / CPIGuard; either reject TransferFee or ensure delta-accounting is used everywhere.
- **`resolve` touches NO token accounts** (O-3 resolved) — it only reads TxLINE's `daily_scores_merkle_roots` PDA. So the collateral token-program choice is fully decoupled from verification.

**D-6 collateral choice (pick at scaffold):** (a) classic-SPL USDC (needs a devnet USDC faucet mint) or (b) **TxLINE's devnet USDT (Token-2022, `ELWTKspHKCnCfCiCiqYw1EDH77k8VCP74dK9qytG2Ujh`)** so demo collateral is what TxLINE users hold. Either way build the vault per the Token-2022-capable design above. Use `transfer_checked` (never `transfer`); pass mint + decimals on every transfer.

---

## 8. Anchor version — 1.0.0 (LOCKED)

**Decision (team): build on Anchor 1.0.0 stable** — resolves prior D-5. We use the classic Borsh account model on stable 1.0, **not** the v2/`anchor-next` alpha (unaudited, git-only, zero-copy `Account<T>`/`BorshAccount<T>`/`CpiHandle` — inappropriate for escrow holding real funds on a deadline). The 1.0.0 rules below are **hard requirements**, not forward-compat niceties:

1. **CPI Pubkey-first (mandatory).** 1.0.0 removed the `program` `AccountInfo` from `CpiContext`. Every CPI site uses:
   - `CpiContext::new(ctx.accounts.token_program.key(), TransferChecked{ from, mint, to, authority })` — program arg is a `Pubkey`; the field accounts still use `.to_account_info()`.
   - PDA-signed (sell/redeem/close vault payouts): `CpiContext::new_with_signer(ctx.accounts.token_program.key(), TransferChecked{..}, &[&[MARKET_SEED, &match_id_le, &[market.bump]]])`.
   - The pre-1.0 `ctx.accounts.token_program.to_account_info()` *program* argument is a **compile break** — never use it. Isolate CPI construction in a small `fn` wrapper per instruction file for readability.
2. **Space always `8 + INIT_SPACE`** — mandatory in 1.0.0; `InitSpace` never adds the 8-byte discriminator.
3. **Explicit `address =` over `has_one`** — `has_one` is deprecated in 1.0.0. For every stored-Pubkey reference, pin with `address`: `market_config: address = market.config`, `usdc_mint: address = global.usdc_mint`, `txline_program: address = global.txline_program`. Keep `has_one` only for the ergonomic `authority`/`owner` gates and back them with an `address` check where the referenced key is stored (§6 lists each site).
4. **No `AccountInfo` in `Accounts` structs** — deprecated (compile warning) in 1.0.0. Use `UncheckedAccount` with a `/// CHECK:` doc comment + an `address`/`owner`/`constraint` guard (e.g. the `txline_program` in `resolve`).
5. **Single `#[error_code]` block** — hard compile-time error in 1.0.0 if more than one. One `AmmError` enum in `error.rs`.
6. **Duplicate mutable accounts rejected by default** — free defense-in-depth (no `dup` opt-in anywhere in our design).
7. **Avoid `init_if_needed`** — omit the feature (D-3 → explicit `open_position`). If used, note it's now folded into the dup-mutable check.
8. **`#[interface]` / `interface-instructions` removed** — if O-3 forces a Token-2022 transfer-hook path, use `#[instruction(discriminator = <EXPR>)]` instead.
9. **`Anchor.toml`:** no `[registry]` section; optionally add `[hooks]` for `post-build` Codama codegen.
10. **TS client:** generate via **Codama** (`@solana/kit`-compatible); any raw Anchor-TS imports use **`@anchor-lang/core`** (`^1.0.0`), not `@coral-xyz/anchor`. `libs/idl` consumes `target/idl/amm.json`.

**Toolchain (pin in CI + README):** Rust 1.89+, Solana CLI 3.1.10+, Anchor CLI 1.0.0 (`cargo install avm --git https://github.com/solana-foundation/anchor --locked && avm install 1.0.0 && avm use 1.0.0`), Surfpool 1.1.2+.

---

## 9. IDL / client generation (contract boundary out)

Flow (PLAN §3.2):
```
anchor build  →  target/idl/amm.json  →  codama generate  →  libs/idl/src (Kit client)
```
- Enable in `Anchor.toml`:
  ```toml
  [clients]
  auto = true
  js = { enable = true, path = "libs/idl/src/generated" }
  ```
  OR run explicitly in the turbo task: `anchor codama generate -l js -p libs/idl/src/generated target/idl/amm.json`.
- The generated client is `@solana/kit`-compatible (renderer `@codama/renderers-js`). Keeper uses it directly.
- **What downstream teammates consume (freeze early):** program id, the 5 PDA seed schemes (§2.6), and the instruction set (§4). Publish the seed constants to `libs/shared` so PDA derivation is shared, not re-implemented.
- **Events for indexer:** emit `MarketCreated`, `MarketActivated`, `MarketFrozen`, `Trade{side,usdc,tokens,price_bps,fee_bps}`, `MarketResolved{outcome}`, `Redeemed`, `MarketClosed`. Put them in `state.rs`/each ix via `emit!`. These are the indexer's price/volume feed — coordinate the exact fields with the indexer owner.

---

## 10. Testing plan

### 10.1 LiteSVM unit tests (Rust, in `programs/amm/tests/`) — Phase 1 & 2
Setup: `svm.add_program(amm::id(), include_bytes!("../../../target/deploy/amm.so"))`, `svm.set_account` to fabricate a USDC mint + funded ATAs (the "infinite USDC" pattern — no need for the real mint keypair), `svm.set_sysvar::<Clock>` for time control.

Concrete cases:
1. `initialize_config` sets fields; re-init fails (singleton).
2. `create_market_config` — admin only (non-admin signer → custom error); param validation rejects `base>max`, `filter>decay`, `max_v_acc==0`.
3. `init_market` — creates Market+vault, reserves seeded, price≈5000 bps; vault authority == market PDA; seed USDC transferred; wrong `usdc_mint`/`token_program` rejected.
4. Lifecycle guards: `buy` before `activate` fails; `activate` before `kickoff_ts` fails (advance clock, then succeeds); `freeze` before `freeze_ts` fails; `buy`/`sell` after `freeze` fail.
5. **CPMM invariant:** after `buy`, `k' >= k` (never decreases net of rounding); price moves correct direction; `min_out` slippage rejection (`out < min_out` → `SlippageExceeded`).
6. **Buy→sell round-trip:** buy then immediately sell same tokens returns ≤ input minus 2× fee (never a profit → no free money bug).
7. **Dynamic-fee math (pure `fee.rs` unit tests, no SVM):**
   - v_acc grows by `price_delta_bps * SCALE`, capped at `max_v_acc`.
   - three-zone: elapsed < filter → no decay; filter ≤ elapsed < decay → ×R; ≥ decay → reset to 0.
   - quadratic: fee increases ~quadratically with v_acc; capped at `max_fee_bps`.
   - ceiling division: small nonzero v_acc yields `variable ≥ 1`, never rounds to 0.
   - monotonic clock: `now < last_ts` → error.
   - u128 square: max `v_acc` doesn't overflow.
8. **CPMM math (pure) property tests:** random `x,y,Δ` → `k` preserved, no overflow, output < reserve.
9. `resolve` (LiteSVM with a **mock TxLINE program** loaded via `add_program`): double-resolve rejected (`state != Locked`); resolve with wrong `txline_program` account → address constraint fails; success sets outcome + Resolved; emits event.
10. `redeem`: winner gets `tokens * 1 USDC`; double-redeem rejected (flag + zeroed balance); loser gets 0; `Void` refund path.
11. `close_market`: before grace → fail; after grace, vault swept + closed, rent → admin; revival (re-init closed market) fails.
12. Overflow/edge: `usdc_in = u64::MAX` → `MathOverflow`; zero-amount trades rejected.

### 10.2 Surfpool integration (Phase 2)
- **Real CPI into forked TxLINE oracle** on surfnet (lazy fork of devnet); USDC from faucet; Token-2022 forked automatically for any TxL account.
- **Time-travel** across kickoff→freeze→resolution window.
- `surfnet_setAccount` to force edge-case reserves / `v_acc` states and confirm on-chain behavior matches the pure math.
- Full happy path: init → activate → several trades (price shifts, fee spikes then decays) → freeze → resolve (real proof) → redeem → close.

### 10.3 Devnet smoke (Phase 6, not program-owner's core job)
Final keeper+kitguard reliability check only.

### 10.4 `program_autofixer` (MCP) — mandatory gate
Run **every** program file through `program_autofixer` (framework=anchor) before considering it done; loop applying fixes until `require_another_tool_call_after_fixing == false`. Priority targets: `resolve.rs` (arbitrary CPI), `buy.rs`/`sell.rs` (checked math, reserve re-validation, dup-account), `fee.rs`/`math.rs` (overflow), `redeem.rs`/`close_market.rs` (accounting, secure close). Surface medium/low findings to the team but they don't block the build. Build/test with `NO_DNA=1 anchor build` / `NO_DNA=1 anchor test`.

---

## 11. Open questions / blockers (resolve BEFORE coding `resolve`)

**TxLINE — RESOLVED from official docs (2026-07-02):** `txline.txodds.com/documentation` (quickstart, worldcup, `programs/addresses`, `programs/devnet` IDL, `examples/onchain-validation`, `scores/*`). Full reference in **§11.1**.
- **O-1 — RESOLVED.** Program id devnet `6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J` / mainnet `9ExbZjAapQww1vfcisDmrngPinHTEfpjYRWMunJgcKaA`. Instruction `validate_stat(ts: i64, fixture_summary: ScoresBatchSummary, fixture_proof: Vec<ProofNode>, main_tree_proof: Vec<ProofNode>, predicate: TraderPredicate, stat_a: StatTerm, stat_b: Option<StatTerm>, op: Option<BinaryExpression>) -> bool`, account `daily_scores_merkle_roots` (read-only PDA, seeds `["daily_scores_roots", epoch_day u16 LE]`). Devnet IDL published → use `declare_program!(txline)` with `idls/txline.json`.
- **O-2 — RESOLVED.** Verification is a **`bool` CPI return** (read via `Return<bool>::get()` / `get_return_data`), NOT `Ok/Err` and NOT a written result account. View-simulation is only the *off-chain* client path; on-chain we CPI + read return data. `resolve` logic branch = §4.7.
- **O-3 — RESOLVED.** `resolve` touches **no** TxL token accounts (only the read-only roots PDA) → no Token-2022 exposure there. Separately: the TxLINE **ecosystem is Token-2022** (TxL mint devnet `4Zao8ocPhmMgq7PdsYWyxvqySMGx7xb9cMftPMkEokRG`, their USDT devnet `ELWTKspHKCnCfCiCiqYw1EDH77k8VCP74dK9qytG2Ujh`; treasury/ATAs use `TOKEN_2022_PROGRAM_ID`). This bears on the **collateral-mint choice** (D-6 below), not on `resolve`.
- **O-4 — RESOLVED.** Devnet World-Cup feed exists: 57 group-stage + 16 Round-of-32 fixtures (Jun 14–Jul 4 2026), all with Scores + StablePrice odds. Free/devnet tier = **Service Level 1 (60s delay)**; SL12 realtime is mainnet-only. The **60s delay is exactly the adverse-selection window** the dynamic fee (§5.2) defends. Historical replay available via `/api/scores/historical/{fixtureId}` (within 2wk 6h) → feeds §5.2 fee calibration.

**Internal decisions to lock at scaffold time:**
- **D-1: RESOLVED — explicit `keeper: Pubkey` on `GlobalConfig`.** `activate_market`/`freeze_market`/`resolve` are gated on `global.keeper` via `address = global.keeper` on a `keeper: Signer`. Space of `GlobalConfig` +32 (now 5×32 Pubkeys). Both clock-gated too (belt-and-suspenders).
- **D-2: RESOLVED — virtual reserves.** `yes_reserve`/`no_reserve` set ODDS ONLY via `x·y=k`. A buy mints a complete set (1 YES + 1 NO per 1 USDC) and routes the unwanted leg through the curve; the vault holds ALL USDC. **Hard solvency invariant, re-checked after every buy/sell/redeem: `vault_usdc >= max(yes_supply, no_supply)`** so every winning token redeems for exactly 1 USDC. Documented in `math.rs` header + enforced by `math::assert_solvent`.
- **D-3: RESOLVED — explicit `open_position` instruction, NO `init_if_needed`.** `open_position` does the one-time `init` of the `Position` PDA (owner+market seeds); `buy`/`sell` take an already-created `mut` `Position`. The `init-if-needed` feature is NOT enabled in `Cargo.toml`.
- **D-4: RESOLVED — `Outcome::Void` refunds stake pro-rata.** On `Void`, `redeem` refunds the trader's USDC basis pro-rata (v0: refund `position.collateral` = net USDC deposited, i.e. the sum of buy inputs minus sell proceeds tracked on the position). Losing/winning distinction is void; everyone gets their remaining collateral back.
- **D-5: RESOLVED — Anchor 1.0.2 (team decision, MCP-verified).** See §8. No longer open. (Toolchain pins 1.0.2 stable, classic Borsh model.)
- **D-6: RESOLVED — TxLINE devnet USDT as collateral.** Mint `ELWTKspHKCnCfCiCiqYw1EDH77k8VCP74dK9qytG2Ujh` VERIFIED on-chain as **classic SPL Token** (owner Tokenkeg…), **6 decimals**, `freezeAuthority=null`, mintAuthority `DR6Q3pvCy991wMkGXNwdwAZ1jKtiHvVaWxG8mzxNNVW`. Use `anchor_spl::token_interface` types + `transfer_checked` (works with classic SPL); no Token-2022 extension handling needed for this mint, but keep balance-delta accounting as cheap insurance on deposits/payouts.
- **D-7 (NEW — `fixture_id` type):** TxLINE `fixture_id` is **`i64`** (e.g. `17588316`). Change `Market.match_id: u64` → `fixture_id: i64` and the `MARKET_SEED` to `fixture_id.to_le_bytes()` for a clean 1:1 mapping to TxLINE. Update §2.3 and §2.6. *(Implemented v0: `Market.fixture_id: i64`, `MARKET_SEED = b"market" + fixture_id LE`.)*
- **D-8: RESOLVED — resolution predicate stored on `MarketConfig`.** `resolution_threshold: i32`, `resolution_comparison: u8` (TxLINE `Comparison`), `stat_key_a: u32`, `stat_key_b: u32` (0 = unused), `stat_op: u8` (TxLINE `BinaryExpression`; 0 = none) are carved from `MarketConfig._reserved` so `resolve` (Phase 2) proves a pre-committed question the keeper can't alter.
- **D-9 (NEW — LOCKED direction, STAGED after v0): leverage-as-option + pm-AMM stretch.** The v1/v2 on-chain direction is **locked** (decided in a prior Claude conversation; ref `PLAN §10` and auto-memory): **(v1)** no-liquidation "pay-for-time" leverage modeled as a **binary option** — `LeveragePool` = options writer, funded by **per-epoch ROLLING funding** (Messari/Forecast correction, replacing the earlier snapshot-at-open time-fee: full-life pricing exactly offsets the levered upside when a market can jump straight to 0; instead the theta rate `p(1−p)/(T−t)` — `fee.rs` pure fn — is re-quoted each `funding_epoch_secs` epoch at that epoch's mark, like perps funding), **deterministic time-based expiry** (cumulative `funding_accrued == collateral`) replacing all price-based liquidation (no liquidation ix, no TWAP oracle, no cascades), adverse-selection guards + `p`-dependent leverage cap; **mark price = TxLINE StablePrice** posted on-chain (keeper-signed v1 → `validate_odds` CPI v2) with a `max_mark_age_secs` staleness guard — never our own manipulable FPMM spot; **SSE risk valve** — keeper-gated, bounded `set_risk_valve(paused, funding_multiplier_bps, until_ts)` on `LeveragePool` to pause opens / widen funding around goal/red-card jumps (§4.10). **Risk controls (Delphi/Gensyn, §4.10):** the bounded-loss options vault is underwritten by the pool and governed by a **coverage ratio** — `coverage = pool_balance / Σ(max_payout)`, tracked via `total_max_payout` on `LeveragePool` + a `min_coverage_bps` guard in `open_leverage` (generalizes `max_open_interest`); plus **LP lock/withdraw windows** (`request_withdraw`/`withdraw` with an `unlock_ts` delay + `pending_withdraw` accounting) so an LP can't pull writer capital right before a KNOWN sports resolution and dump the shortfall on remaining LPs. **(v2)** the **`PricingCurve` trait** with a **static pm-AMM** second impl (Gaussian `Φ`, `erf` via Abramowitz–Stegun in Q64.64; **`Φ⁻¹` not needed on-chain** — Newton-solve the invariant; **oracle-free** — score implied by price + time-to-maturity; **dynamic pm-AMM skipped**, both for on-chain clock-state hazard and because it surrenders ~half LP capital and empties at resolution — counterproductive when ~80% of live-sports volume is the final minutes) behind the same trait as FPMM (§5.3). **pm-AMM football caveat (verified):** its uniform-LVR optimality assumes **Gaussian score dynamics** — basketball fits, but **football win-prob is a jump process** (goal-jumps, not diffusion), so pm-AMM here is **a better-shaped bounded-[0,1] prior with a jump caveat, NOT theoretically optimal**. Both v1 and v2 are **STAGED strictly after the v0 critical path** (pure FPMM, `leverage = 1`); reserved fields (§2.2 `max_open_interest`/theta params/`funding_epoch_secs`/`max_mark_age_secs`/`min_coverage_bps`, §2.4 `last_funding_epoch`/`funding_accrued` — re-documented from the old `entry_slot`/`fee_rate_snapshot`, same 16 bytes, no space change) are pre-carved so v1/v2 need **no account migration** (the new `LeveragePool` fields `total_max_payout`/`pending_withdraw` live on the new v1 PDA, so no migration of existing accounts). A README LVR benchmark (FPMM vs static pm-AMM, replayed on real TxLINE odds, O-4) counts as delivery even if pm-AMM doesn't ship on-chain. **pm-AMM math's role in v1 is the derivation of the funding (theta) formula, NOT the pool curve** — the curve swap is strictly the v2 `PricingCurve` item. A **jump-arbitrage auction** for the moments around goals (Messari) is a v2/pitch item, not v1. Multi-outcome win/draw/lose (LMSR/multi-outcome pm-AMM) is a roadmap note, not a v0/v1 requirement (§4.10).

---

### 11.1 TxLINE on-chain reference (verified from official docs, 2026-07-02)

**Addresses** (`programs/addresses`):
| | Devnet | Mainnet |
|---|---|---|
| TxLINE program | `6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J` | `9ExbZjAapQww1vfcisDmrngPinHTEfpjYRWMunJgcKaA` |
| TxL token mint (Token-2022) | `4Zao8ocPhmMgq7PdsYWyxvqySMGx7xb9cMftPMkEokRG` | `Zhw9TVKp68a1QrftncMSd6ELXKDtpVMNuMGr1jNwdeL` |
| USDT mint | `ELWTKspHKCnCfCiCiqYw1EDH77k8VCP74dK9qytG2Ujh` | `Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB` |

**TxLINE PDA seeds** (their program; we only read `daily_scores_merkle_roots`): `daily_scores_roots` + epoch_day(u16 LE); `daily_batch_roots` + epoch_day(u16 LE); `ten_daily_fixtures_roots` + aligned_epoch_day(u16 LE, `day/10*10`); `token_treasury_v2`; `pricing_matrix`; `usdt_treasury`. All token ops use `TOKEN_2022_PROGRAM_ID`.

**Verification instructions (all read-only, return `bool`):** `validate_stat`, `validate_fixture`, `validate_fixture_batch`, `validate_odds`. TxLINE also ships `settle_trade` / `settle_matched_trade` (their own escrow-settlement primitive combining proof-check + payout via a `TraderPredicate`) — informative for how they model prediction settlement, but **we run our own AMM/escrow**, so we use `validate_stat` for verification only.

**Types (from devnet IDL) — mirror in `idls/txline.json` for `declare_program!`:**
```
ProofNode         { hash: [u8;32], is_right_sibling: bool }
ScoreStat         { key: u32, value: i32, period: i32 }
StatTerm          { stat_to_prove: ScoreStat, event_stat_root: [u8;32], stat_proof: Vec<ProofNode> }
ScoresBatchSummary{ fixture_id: i64, update_stats: ScoresUpdateStats, events_sub_tree_root: [u8;32] }
TraderPredicate   { threshold: i32, comparison: Comparison(GreaterThan|LessThan|EqualTo) }
BinaryExpression  enum { Add, Subtract }
```
**Relevant TxLINE errors:** 6003 InvalidSubTreeProof · 6004 InvalidMainTreeProof · 6005 TimeSlotMismatch · 6007 RootNotAvailable (retry after oracle posts) · 6021 PredicateFailed · 6022 InvalidFixtureSubTreeProof · 6023 InvalidStatProof · 6024 InvalidStatCombination · 6053 StatKeyMismatch · 6062 ProofTooLarge.

**Score/stat encoding** (`scores/soccer-feed`): stat key = `(period*1000)+base`; base keys — 1=P1 goals, 2=P2 goals, 3–6=yellow/red cards, 7–8=corners. Period multipliers: H1 +1000, H2 +2000, ET1 +3000, ET2 +4000, Pens +5000. **Match-end phases** (Game Phase ID): 5 `F`, 10 `FET`, 13 `FPE` (final). Others: 1 NS, 2 H1, 3 HT, 4 H2, 7 ET1, 9 ET2, 12 PE.

**Off-chain (keeper — see backend plan):** proof fetch `GET /api/scores/stat-validation?fixtureId=&seq=&statKey=&statKey2=` (returns args ready for `validate_stat`); SSE `GET /api/scores/stream` (auth `Authorization: Bearer <guest-jwt from /auth/guest/start>` + `X-Api-Token` from `/api/token/activate`, `Accept: text/event-stream`); historical `GET /api/scores/historical/{fixtureId}` (within 2wk 6h). Devnet feed = Service Level 1 (60s delay).

---

## 12. Sequenced task breakdown (→ Milestone Phases 1–2)

**Phase 0 pre-req (from scaffold owner — see `monorepo-setup.md`):** install Anchor **1.0.x** toolchain (`avm install 1.0.2 && avm use 1.0.2`, Rust 1.89+, Solana CLI 3.1.10+), `anchor init amm --test-template rust` (default is the modular single-program layout matching §1; `--test-template rust` gives the LiteSVM Rust harness of §10 instead of the default ts-mocha TS test), `Anchor.toml` (no `[registry]`; set `[provider] cluster="Devnet"`), CI `NO_DNA=1 anchor build`, turbo `codegen` task (or `[hooks] post-build`) for the Codama client.

**Phase 1 — Core program (PLAN days 3–4):**
1. Lock remaining decisions D-1, D-2, D-3 (**D-5 = Anchor 1.0.0, already locked — §8**). [ ]
2. `constants.rs` (seeds + fixed-point denoms), `error.rs` (single `AmmError` enum). [ ]
3. `state.rs`: `GlobalConfig`, `MarketConfig`, `Market`, `Position` + enums + `InitSpace`; verify hand-computed space vs `INIT_SPACE`. [ ]
4. `math.rs`: pure CPMM (`compute_out`, `price_yes_bps`, k-invariant helpers) + unit tests. [ ]
5. `fee.rs`: pure dynamic-fee (Steps A–C) + exhaustive unit tests (three-zone, quadratic, caps, ceil-div, u128 square, monotonic). [ ]
6. `initialize_config`, `create_market_config`, `init_market` (+vault init, seed transfer). [ ]
7. `activate_market`, `freeze_market` (clock-gated, keeper-gated per D-1). [ ]
8. `buy`, `sell` (dynamic fee → CPMM → position/supply update → transfer_checked; slippage; reserve re-validate). [ ]
9. Emit events (`MarketCreated`, `Trade`, etc.). [ ]
10. LiteSVM tests §10.1 cases 1–8, 12 green. [ ]
11. `program_autofixer` loop on every file until clean. [ ]
12. `anchor build` → confirm IDL + Codama client generate; publish seeds to `libs/shared`. [ ]

**Phase 2 — Resolution (PLAN days 2–3):** *(O-1..O-4 resolved — §11/§11.1; lock D-6/D-7/D-8 first)*
13. Drop the TxLINE **devnet IDL** into `programs/amm/idls/txline.json`; `declare_program!(txline)`; mirror `ProofNode`/`StatTerm`/`ScoresBatchSummary`/`TraderPredicate` types (§11.1). Store `resolution_predicate` + stat keys on `MarketConfig`/`Market` (D-8). [x]
14. `resolve` (arbitrary-CPI guard on `txline_program` + `daily_scores_merkle_roots` owner/PDA check; CPI `validate_stat`, read `Return<bool>::get()`, `require!(is_valid)`, derive outcome, state gate, `MarketResolved` event; map `RootNotAvailable`/proof errors to `ProofRejected` for keeper retry). [x]
15. `redeem` (zero-before-transfer, flag, PDA-signed payout, Void policy D-4). [x]
16. `close_market` (grace gate, sweep → close token acct → `close = authority`). [x]
17. LiteSVM tests cases 9–11 with a **mock TxLINE program**. [x]
18. Surfpool integration §10.2: real forked-TxLINE CPI + time-travel + full happy path. [x] *(done 2026-07-04, Surfpool 1.4.0: `tests/surfpool/run.ts` (`pnpm test:surfpool`, self-managing — spawns/kills `surfpool start --network devnet --ci --no-deploy`, 17/17 steps). **Proven:** full lifecycle through the real RPC with the generated `@fpm/idl` Kit client — deploy → initialize_config → create_market_config → init_market → open_position → buy-before-activate guard (6012) → timeTravel → activate → buy (position credited, price 5000→5243 bps, vault delta exact) → timeTravel → freeze → resolve probes → forced-Resolved (`surfnet_setAccount`) → redeem (1 USDT/token, balance-delta exact) → timeTravel past grace → close (vault + market reclaimed). **CPI interface vs REAL forked txoracle binary:** missing roots PDA → our 6021 `InvalidMerkleRootsAccount` pre-CPI guard (shields TxLINE 6007); existing devnet roots PDA + garbage proofs → real binary EXECUTES `ValidateStat` (discriminator + Borsh arg layout accepted) and rejects **2006 ConstraintSeeds**; direct `validate_stat` with ms `ts` → **6007 RootNotAvailable** on empty 5-min slots and **6004 InvalidMainTreeProof** (`validate_stat.rs:73`) on a posted slot — full verification path executed. **NOT proven:** proof-VALID resolve (needs real Merkle proofs from the TxLINE keeper API). **BUG FOUND & FIXED (same day):** TxLINE timestamps are **MILLISECONDS** — the real binary derives the roots PDA as `ts/86_400_000` (one root per 5-min batch slot), while `resolve.rs` originally derived `epoch_day = ts/86_400` (seconds) → the two could never agree; only this real-binary probe could catch it (the LiteSVM mock shared our wrong assumption). **Fix applied:** `constants.rs` `SECONDS_PER_DAY` → `MILLIS_PER_DAY = 86_400_000`; `resolve.rs`, `tests/common.rs` `epoch_day()`, and keeper `proof.ts` fallback all on the ms convention. **Re-verified 17/17:** probe 5b now drives the CPI **through our `resolve`** with a ms `ts` and the real binary executes **FULL Merkle verification**, rejecting garbage proofs with **6004 InvalidMainTreeProof** against a genuinely posted devnet root — discriminator, Borsh layout, and PDA derivation all accepted by the production program via our own instruction.)*
19. `program_autofixer` loop on `resolve.rs`/`redeem.rs`/`close_market.rs`. [x]
20. Fee calibration harness (offline replay via `fee.rs` pure fns) — hand tuned params to `create_market_config` defaults. [ ]

**Definition of done (program layer):** all LiteSVM cases green, Surfpool happy path green, `program_autofixer` reports no critical/high on any file, IDL + Kit client generated and imported by `libs/idl`, seeds mirrored in `libs/shared`.

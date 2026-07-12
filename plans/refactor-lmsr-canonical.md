# Refactor: LMSR 1X2 as the sole market (delete binary CPMM), canonical rename

**Decision (session):** Variant 2 (Scope A2). The program supports ONE market type:
a 3-way (1X2) LMSR market. Delete the binary CPMM path entirely. Rename the
surviving 1X2 code to canonical names (drop the `_1x2` / `1x2` / `3` suffixes).

This is a **fresh devnet redeploy** — no binary markets exist with value, so wire
discriminators and PDA seeds may change freely. `N_MAX = 3` (Team1/Draw/Team2),
regular `Account<T>` (not zero-copy), loops bound by the real outcome count.

Every agent MUST read this file and use these exact names byte-for-byte.

## Outcomes (final, product-locked)

```
0 = Team1  (Виграш Команди1)   predicate (s1−s2) >  t   GreaterThan
1 = Draw   (Нічия)             predicate (s1−s2) == t   EqualTo
2 = Team2  (Виграш Команди2)   predicate (s1−s2) <  t   LessThan
```
Integer trichotomy over `(stat_a − stat_b)` — all three proven POSITIVELY via one
`validate_stat` CPI. No negation, no `negate_predicate`, no `market_shape` enum,
no binary complement case. `Void` still exists (pro-rata refund, D-4).

## DELETE (binary CPMM — remove files + all references)

Instruction files: `buy.rs`, `sell.rs`, `init_market.rs`, `create_market_config.rs`,
`open_position.rs`, `activate_market.rs`, `freeze_market.rs`, `resolve.rs`,
`redeem.rs`, `close_market.rs`.
Modules: `math.rs` (whole file) — BUT first RELOCATE `assert_solvent_multi` into
`lmsr.rs` (it is used by the 1X2 path; nothing else in math.rs survives).
State: struct `Market`, struct `Position` (the binary ones), enum `Side`, enum
`Outcome { Unset, Yes, No, Void }`, field `MarketConfig.market_kind`.
Events: `MarketCreated`, `MarketActivated`, `MarketFrozen`, `MarketResolved`,
`Redeemed`, `MarketClosed`, `Trade` (the binary ones — they get REPLACED by the
renamed 1X2 events, see below).
`lib.rs`: drop the 11 binary instruction fns; keep `initialize_config`.

## RENAME (1X2 → canonical). Left = current, right = new.

### Instructions (fn + file + `Context<...>` struct)
```
create_market_config_1x2  -> create_market_config     (CreateMarketConfig1x2 -> CreateMarketConfig)
init_market_1x2           -> init_market              (InitMarket1x2         -> InitMarket)
open_position_1x2         -> open_position            (OpenPosition1x2       -> OpenPosition)
buy_1x2                   -> buy                       (Buy1x2                -> Buy)
sell_1x2                  -> sell                      (Sell1x2               -> Sell)
activate_market_1x2       -> activate_market          (ActivateMarket1x2     -> ActivateMarket)
freeze_market_1x2         -> freeze_market            (FreezeMarket1x2       -> FreezeMarket)
resolve_1x2               -> resolve                   (Resolve1x2            -> Resolve)
redeem_1x2                -> redeem                    (Redeem1x2             -> Redeem)
mint_set_1x2              -> mint_set                  (MintSet1x2            -> MintSet)
redeem_set_1x2            -> redeem_set                (RedeemSet1x2          -> RedeemSet)
close_market_1x2          -> close_market              (CloseMarket1x2        -> CloseMarket)
initialize_config         -> initialize_config         (unchanged)
```
Instruction file renames follow the fn: `buy_1x2.rs -> buy.rs`, etc. (the deleted
binary file of the same target name is removed first, so no collision).
`resolve/predicate_1x2.rs -> resolve/predicate.rs`.

### Accounts / enums (state.rs)
```
Market1x2    -> Market
Position1x2  -> Position
Outcome1x2   -> Outcome        // { Unset, Team1, Draw, Team2, Void }
MarketConfig -> MarketConfig   (unchanged; DROP the market_kind field)
GlobalConfig -> GlobalConfig   (unchanged)
```

### Events
```
Market1x2Created   -> MarketCreated     (fields: fixture_id, config, b, q:[u64;3], prices_bps:[u16;3])
Market1x2Activated -> MarketActivated
Market1x2Frozen    -> MarketFrozen
Market1x2Resolved  -> MarketResolved    (outcome: Outcome)
Redeemed1x2        -> Redeemed
Market1x2Closed    -> MarketClosed
Trade1x2           -> Trade
SetMinted1x2       -> SetMinted
SetRedeemed1x2     -> SetRedeemed
```

### PDA seeds (constants.rs — MUST match libs/shared/src/pda.ts byte-for-byte)
```
b"market3"    -> b"market"
b"position3"  -> b"position"
b"mkt_config" -> b"mkt_config"   (unchanged)
b"config"     -> b"config"       (unchanged)
b"vault"      -> b"vault"        (unchanged, verify)
```

## JS side (canonical, after `anchor build` + `pnpm codegen`)

- `libs/shared/src/pda.ts`: `findMarket1x2Pda -> findMarketPda` (seed `b"market"`),
  `findPosition1x2Pda -> findPositionPda` (seed `b"position"`). Delete the old
  binary `findMarketPda`/`findPositionPda` (they used the same names — collapse:
  the 1X2 derivation becomes the canonical one). Seed consts `MARKET_1X2_SEED ->
  MARKET_SEED`, `POSITION_1X2_SEED -> POSITION_SEED`.
- `libs/shared/src/dto`: collapse — `Market1x2Dto -> MarketDto` (3 prices, 3
  supplies), `Position1x2Dto -> PositionDto`. Delete the old binary `MarketDto`
  (YES/NO). Drop `MarketKind`, `AnyMarketDto` union, `Outcome1x2 -> Outcome`.
- `libs/shared/src/errors.ts`: drop binary-only error entries if any; keep AMM +
  TXLINE maps.
- keeper: `resolve1x2.ts -> resolve.ts`, drop the binary resolve action; keeper
  hints `0=Team1 / 1=Draw / 2=Team2`. Seed script `seed-markets-1x2.ts ->
  seed-markets.ts`.
- indexer: `events-1x2` decoders become THE decoders; drop binary event decoders;
  Prisma `market_kind` column dropped, `onex_*` columns become the canonical
  columns. New migration.
- web: `resolution-panel-1x2.tsx -> resolution-panel.tsx` (replace the binary
  one), `Trade1x2Ticket` becomes the ticket, drop `binaryThreeWayCents`, the
  `isMarket1x2` branch collapses to always-3-way.

## Sequencing (waves)

1. **Program** (one agent): delete binary, relocate `assert_solvent_multi`, rename
   to canonical, `program_autofixer` loop on every touched `.rs`, `NO_DNA=1 anchor
   build`, `cargo test --workspace` green. Deliverable: green program + new IDL.
2. **Codegen + shared** (run codegen, then one agent): `pnpm codegen`, then update
   `libs/shared` per above; `pnpm -r typecheck` for shared consumers.
3. **Apps** (3 parallel agents): keeper, indexer, web — canonical names + updated
   shared DTO; each verifies its own typecheck/build.

Do NOT push or deploy. Deploy strategy decided separately after all waves green.

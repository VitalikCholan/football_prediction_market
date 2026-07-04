# TxLINE IDL — needed for `declare_program!(txline)` in `resolve` (anchor plan Phase 2)

Drop the TxLINE **devnet** Anchor IDL here as **`txline.json`** so the AMM program can
generate a typed CPI client via `declare_program!(txline)` (see `anchor-programs-plan.md` §4.7, §11.1).

**Not yet added** — the IDL is only required when we build `resolve` (Phase 2). Staged as a
pointer because TxLINE serves the IDL embedded in a rendered docs page with **no raw JSON
download URL** (auto-fetch not possible); grab it manually via one of the routes below.

## Source of truth
- Page: https://txline.txodds.com/documentation/programs/devnet  (tab: "IDL")
- Program name: `txoracle`
- IDL version: `1.5.2`
- Devnet program address: `6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J`
- Mainnet program address: `9ExbZjAapQww1vfcisDmrngPinHTEfpjYRWMunJgcKaA`

## How to obtain `txline.json`
1. Open the devnet page above → "IDL" tab → copy the full JSON into `programs/amm/idls/txline.json`, **or**
2. `anchor idl fetch 6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J --provider.cluster devnet -o programs/amm/idls/txline.json`
   (works if TxLINE published the on-chain IDL account), **or**
3. Ask TxLINE for the raw `txoracle` IDL file.

## What we actually use from it
Only `validate_stat(ts, fixture_summary, fixture_proof, main_tree_proof, predicate, stat_a, stat_b, op) -> bool`
and its types (`ProofNode`, `StatTerm`, `ScoreStat`, `ScoresBatchSummary`, `TraderPredicate`,
`BinaryExpression`) + the `daily_scores_merkle_roots` account. `declare_program!` will generate the
full client, but `resolve` only calls `validate_stat`. See `anchor-programs-plan.md` §11.1 for the
verified signatures, error codes, and PDA seeds.

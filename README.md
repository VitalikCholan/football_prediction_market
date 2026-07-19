# TXL·Markets — World Cup Prediction Market AMM on Solana

**A 3-way (1X2) LMSR prediction market with a no-liquidation leverage layer, where every
settlement is cryptographically proven on-chain against TxLINE's Merkle-rooted sports data.**

- **Live app (devnet):** https://d3t5m460iwplkc.cloudfront.net
- **REST API:** https://d3oqvu2dk2gvv9.cloudfront.net/markets
- **Program (devnet):** [`H59qQz8DXzUWWc3L528iTCFL36ozwBhJc4tHzuwL2JuY`](https://explorer.solana.com/address/H59qQz8DXzUWWc3L528iTCFL36ozwBhJc4tHzuwL2JuY?cluster=devnet)
- **Demo video:** _link here_

---

## The idea

Football is a 3-way result (win / draw / win), yet most on-chain prediction markets are
binary — "NO on Spain" silently includes a draw, which is misleading ~25% of the time.
And the market's weakest link is always settlement: who decides the result, and why
should traders trust them?

TXL·Markets fixes both:

1. **Honest 1X2 markets.** One market per match with three outcomes (Team1 / Draw /
   Team2) priced jointly by Hanson's **LMSR** — softmax prices always sum to $1, a
   complete set always redeems for exactly 1 USDT, bounded LP loss = `b·ln(3)`.
2. **Trustless settlement.** A keeper *hints* the outcome; the **program derives the
   predicate on-chain and one CPI into the TxLINE oracle must prove it** against
   Merkle roots posted on-chain (`validate_stat` → `bool`). A wrong hint simply fails —
   the keeper physically cannot settle a false result.
3. **No-liquidation leverage (v1).** 2–5× exposure as a cash-settled binary option
   written by an LP-funded `LeveragePool`, marked to keeper-posted prices via a
   Drift-style cumulative funding index. Time is the liquidator: a position dies only
   when accrued funding reaches collateral (`fee-death`) — no TWAP oracle, no
   liquidation bots, no cascades. Max trader loss = collateral, always.

## How TxLINE powers it (primary data source)

| TxLINE endpoint / feature | Used for |
|---|---|
| `POST /auth/guest/start` + `X-Api-Token` | auth for every data request |
| `GET /api/scores/stream` (SSE) | live scores; match-end detection (`StatusId 100` / `game_finalised`) triggers resolution |
| `GET /api/scores/stat-validation?fixtureId=&seq=&statKey=&statKey2=` | the **Merkle proof** passed into on-chain `resolve` |
| `GET /api/fixtures/snapshot` | market seeding (fixture ids, kickoff times) + team-name enrichment in the indexer |
| `GET /api/scores/snapshot/{id}` | score enrichment for market cards |
| `GET /api/odds/snapshot/{id}` | 1X2 implied-probability marks for the leverage layer (LMSR-spot fallback on devnet) |
| `GET /api/scores/historical/{id}` | team names for finished fixtures (lineups frame) |
| On-chain `txoracle.validate_stat` (CPI) | **the trust anchor**: proof-verified `bool` for the hinted outcome's predicate, checked against the `daily_scores_merkle_roots` PDA |
| TxLINE devnet USDT faucet (`request_devnet_faucet`) | collateral for seeding/testing |

The 60-second devnet feed delay is itself a design input: a **dynamic volatility fee**
(Meteora/Raydium-style three-zone decay + quadratic) defends LPs against stale-price
sniping around goals, and the leverage layer adds a keeper **risk valve** (bounded
funding multiplier + open-pause) for the same window.

## Deterministic resolution (judging: code quality & logic)

`resolve` is the heart of the trust model — designed to be boring and provable:

- The resolution predicate is **pre-committed on-chain** at config creation
  (`stat_key_a=1, stat_key_b=2, op=Subtract` — home goals minus away goals) and is
  **immutable** (the admin instruction that tunes leverage params cannot touch it;
  proven byte-identical in tests).
- **Hint-and-prove-positively:** for hint Team1/Draw/Team2 the program derives
  `(s1−s2) > 0` / `== 0` / `< 0` — integer trichotomy, exactly one is true. All three
  are positive TxLINE predicates (`GreaterThan/EqualTo/LessThan`), so no negation
  logic exists. One `validate_stat` CPI must return `true`; only then
  `market.outcome = hint`. Wrong hint → `ProofRejected`, no state change.
- Pure math lives in dependency-free modules (`lmsr.rs`, `fee.rs`, `funding.rs`) with
  exhaustive unit tests (fixed-point LMSR error ≈ 1e-16 vs f64 reference; funding
  theta peaks at p=0.5 and grows toward expiry; pool-favorable rounding at every
  boundary). **119 tests** across unit + LiteSVM integration (incl. a real forked
  txoracle via Surfpool).

## Architecture

```
programs/amm     Anchor 1.0 program: LMSR 1X2 market + v1 leverage layer (24 ix)
apps/keeper      TS service: SSE match-end detection -> proof fetch -> resolve;
                 on-chain fixture source (markets self-appear in its schedule);
                 leverage mark poster; simulate-before-send + RPC failover
apps/indexer     NestJS + Postgres: event ingestion, REST for the web app
apps/web         Next.js 16: market cards, 3-outcome trade panel, leverage panel
libs/shared      buildless TS: PDA seeds, zod DTOs (single API contract)
libs/idl         Codama-generated @solana/kit client from the Anchor IDL
infra/           AWS CDK: ECS Fargate x3, RDS, 2x ALB + CloudFront (HTTPS), ECR,
                 GitHub OIDC CI/CD (no static cloud keys)
```

The full off-chain stack runs on AWS (eu-central-1) behind a GitHub-Actions OIDC
pipeline; the keeper is fully autonomous — it discovered, activated, marked and will
resolve the live World Cup fixture in this demo without any manual scheduling.

## Try it (judges)

- Open https://d3t5m460iwplkc.cloudfront.net — markets list (state chips: LIVE /
  UPCOMING / AWAITING PROOF / RESOLVED). Resolved cards show the proven score.
- Any market page: 3-outcome LMSR prices + price history; markets with a funded
  `LeveragePool` show the **Leverage** panel (2–5×, live funding burn estimate,
  guard-aware disabled states that mirror the on-chain checks).
- API: `GET /markets`, `GET /markets/:id`, `GET /markets/:id/history` on the REST URL.
- Wallet: any devnet wallet; test USDT via the in-app TxLINE faucet button.
- Rebuild everything: `NO_DNA=1 anchor build && pnpm codegen && cargo test --workspace`.

## TxLINE API feedback

**Liked most**
- The hint-and-prove `validate_stat` design maps beautifully onto on-chain
  settlement: one read-only CPI returning `bool` means `resolve` has zero token
  exposure and the whole trust argument fits in one instruction.
- `EqualTo` being a first-class comparator dissolved the classic "draw market"
  problem — all three 1X2 outcomes are provable positively.
- Guest-JWT + API-token auth is simple to automate; the devnet faucet made
  end-to-end rehearsals cheap.

**Friction we hit**
- **Timestamps are milliseconds** but this isn't stated anywhere — we derived
  `epoch_day` as `ts/86_400` first and the roots PDA never matched (found by diffing
  against the deployed oracle binary in a Surfpool fork).
- **Docs vs reality drift:** documented "Game Phase" ids don't exist in the live SSE
  feed; real frames are PascalCase with a `Stats` map and match end is
  `StatusId 100`/`game_finalised`. `stat-validation` silently requires `seq`.
- Responses are gzip'd but undici doesn't auto-decode — easy to miss.
- Devnet **World Cup odds snapshots return `[]`** (club-league guest odds work), so
  our leverage marks fall back to LMSR spot on devnet; `validate_odds`-proven marks
  are ready for when the feed fills in.
- The faucet's per-wallet cooldown is fair but undocumented; multi-market seeding
  needed a small multi-wallet funding script.

---

_TxLINE hackathon submission (Track 1 — DeFi). Devnet only._

# Backend / Off-chain Services — Implementation Plan

**Scope:** `apps/keeper`, `apps/indexer`, and the shared libs they depend on (`libs/shared`, `libs/idl`). Maps to master-plan milestone **Phase 3 (Keeper)** and **Phase 4 (Indexer)**. Grounded in PLAN.md §3, §6, §7, §8, §9.

**Out of scope (teammates):** Anchor program internals (`programs/amm`), frontend UI (`apps/web`). We *consume* the on-chain contract (IDL, instruction signatures, PDA seeds, program logs) but do not design it.

> **Verification notes (Solana MCP + TxLINE docs, 2026-07-02):**
> - `@solana/kit` pipe-based transaction construction, `sendAndConfirmTransactionFactory`, `simulateTransaction`, `signTransactionMessageWithSigners`, `setTransactionMessageComputeUnitPrice` (dynamic priority fee setter) — **confirmed** against Kit docs and SPL/Metaplex `_setup.ts` test harnesses.
> - **Anchor version = 1.0.0 — LOCKED** (resolves O6). Codama client generation targets the 1.0 IDL; TS client base is `@anchor-lang/core`; the keeper uses the generated `@solana/kit`-compatible client from `libs/idl`. Use **Option A** (Anchor-1.0 built-in codama) below.
> - **TxLINE integration facts — CONFIRMED** against the official docs (txline.txodds.com) and the Solana MCP. Program ids, token mints, the `validate_stat` verification instruction + its types, the REST/SSE API surface, match-end phase detection, and score-stat key encoding are all treated as ground truth (see §2.4/§2.5/§2.8). This resolves O3 (SSE schema), O4 (proof format / resolve model), and the TxLINE half of P0.
> - Codama flow — **confirmed** two supported paths: (a) `anchor codama generate -l js -p clients target/idl/amm.json` (Anchor 1.0 built-in), and (b) a standalone script using `createFromRoot` + `rootNodeFromAnchor` (`@codama/nodes-from-anchor`) + `renderVisitor` (`@codama/renderers-js`). Both emit a `@solana/kit`-compatible client (`accounts/ instructions/ programs/ types/ errors/`).
> - Dynamic priority-fee estimation via `getRecentPrioritizationFees` RPC — **confirmed** (Solana docs, Helius docs).
> - **`kitguard` was NOT found** in any indexed Solana doc source. It is treated here as a project-specific reliability layer over `@solana/kit`. This plan defines a `TxSender` interface so the keeper is agnostic: if `kitguard` exists as a package we adapt it behind that interface; if not, we implement the same behavior (RPC failover + rebroadcast loop + dynamic fee) directly on Kit. **See Open Question O1.**

---

## 0. Architecture at a glance

```
                TxLINE SSE score stream
                          │
                          ▼
   ┌──────────────────────────────────────┐
   │  apps/keeper (Node, @solana/kit)      │
   │  score-stream → lifecycle FSM →       │   build tx      ┌───────────────┐
   │  activate / freeze / resolve builders │ ─────────────▶  │  Solana RPC   │
   │  → TxSender (kitguard: failover /     │                 │  (devnet)     │
   │  rebroadcast / dynamic fee / simulate)│                 └───────────────┘
   └──────────────────────────────────────┘                        │ program logs / account changes
                          │ imports                                 ▼
                          │                          ┌──────────────────────────────┐
   ┌──────────────────────┴─────────┐                │  apps/indexer (NestJS)         │
   │  libs/idl (Codama-generated     │◀───imports─────│  IndexerModule (log/acct sub)  │
   │  Kit client: ix builders,       │                │  MarketsModule (REST + zod)    │
   │  account decoders, PDA helpers) │                │  DbModule (Postgres)           │
   └────────────────┬────────────────┘               └───────────────┬────────────────┘
                    │ imports                                          │ REST (zod DTOs)
   ┌────────────────┴────────────────┐                                ▼
   │  libs/shared (zod DTOs,          │◀──────imports──────────  apps/web (frontend)
   │  PDA seeds/derivations, consts)  │
   └──────────────────────────────────┘
```

Both services share **one source of truth for on-chain types** (`libs/idl`, build-fed) and **one source of truth for API/PDA/domain types** (`libs/shared`, buildless TS source).

---

## 1. Shared libs

### 1.1 `libs/idl` — generated Kit client (the one build-fed package, §3.2)

**Generation flow (verified):**
```
anchor build                    # emits target/idl/amm.json (+ target/types/amm.ts)
   ↓
codama generate  →  libs/idl/src/generated/    # Kit-compatible client
```

Anchor 1.0.0 is locked, so use **Option A** (built-in). Option B is retained only as a fallback:

- **Option A (Anchor 1.0 built-in):** `anchor codama generate -l js -p libs/idl/src generated target/idl/amm.json`, or set `[clients] auto = true` + `js = { enable = true, path = "libs/idl/src/generated" }` in `Anchor.toml` so it runs after every `anchor build`.
- **Option B (standalone script, works on 0.31 too):** `libs/idl/scripts/generate.ts`:
  ```ts
  import { createFromRoot } from "codama";
  import { rootNodeFromAnchor, type AnchorIdl } from "@codama/nodes-from-anchor";
  import { renderVisitor } from "@codama/renderers-js";
  import anchorIdl from "../../../target/idl/amm.json";

  const codama = createFromRoot(rootNodeFromAnchor(anchorIdl as AnchorIdl));
  codama.accept(renderVisitor("libs/idl/src/generated"));
  ```
  Run via `node libs/idl/scripts/generate.ts` (buildless). Devdeps: `codama`, `@codama/nodes-from-anchor`, `@codama/renderers-js`.

**Turbo wiring (§3.2/§3.4):** a `turbo` task `idl#generate` with **input** `target/idl/amm.json` and **output** `libs/idl/src/generated/**`. Downstream tasks (`keeper`, `indexer`, `shared`, `web`) declare `dependsOn: ["idl#generate"]`. This is the *only* package that is not pure-source-pointing — everything else imports it like a normal workspace package.

**What the generated client gives both services:**
- Instruction builders — e.g. `getResolveInstruction(...)`, `getActivateMarketInstruction(...)`, `getFreezeMarketInstruction(...)` (async variants may auto-derive PDAs/bumps).
- Account decoders/fetchers — e.g. `getMarketDecoder()`, `fetchMarket(rpc, addr)`, `decodeMarket(accountInfo)`.
- Program address constant + discriminator constants (used by the indexer for account-change filters and log parsing).
- Codama-generated `find…Pda` helpers where seeds are declared in the IDL.

**`libs/idl/package.json`** (build-fed but still points at generated TS source — no compile step):
```jsonc
{ "name": "@fpm/idl", "private": true, "type": "module", "main": "src/index.ts" }
```
`src/index.ts` re-exports `./generated`. **Commit the generated output** so services can run before anyone rebuilds the program (critical for CI and Railway Docker slices that don't have the Rust toolchain).

### 1.2 `libs/shared` — zod DTOs, PDA seeds, constants (§3.1, §3.3)

Buildless, source-pointing (per PLAN.md §3.1):
```jsonc
{ "name": "@fpm/shared", "private": true, "type": "module",
  "main": "src/index.ts", "imports": { "#src/*.ts": "./src/*.ts" } }
```

Contents:
- `src/constants.ts` — PDA seed byte-strings (`b"config"`, `b"market"`, `b"position"`, `b"vault"`, `b"mkt_config"`), collateral mint (see D-6), `AMM_PROGRAM_ID`, and the confirmed TxLINE addresses (per-cluster), collateral decimals, cluster URLs:
  - `TXLINE_PROGRAM_ID`: devnet `6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J`, mainnet `9ExbZjAapQww1vfcisDmrngPinHTEfpjYRWMunJgcKaA`.
  - `TXL_MINT` (TxL token, **Token-2022**): devnet `4Zao8ocPhmMgq7PdsYWyxvqySMGx7xb9cMftPMkEokRG`, mainnet `Zhw9TVKp68a1QrftncMSd6ELXKDtpVMNuMGr1jNwdeL`.
  - `USDT_MINT` (TxLINE collateral candidate): devnet `ELWTKspHKCnCfCiCiqYw1EDH77k8VCP74dK9qytG2Ujh`, mainnet `Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB`.
  - `TXLINE_DAILY_SCORES_ROOTS_SEED` = `b"daily_scores_roots"` (PDA seeds `["daily_scores_roots", epoch_day as u16 LE]` — the read-only root account `resolve` needs).
  - **Token program:** TxLINE uses `TOKEN_2022_PROGRAM_ID` for all its token ops. **D-6 is OPEN:** collateral mint is either classic-SPL USDC or TxLINE's Token-2022 devnet USDT. If Token-2022 is chosen, downstream ATA/transfer helpers must use the Token-2022 program (`transfer_checked` with decimals) — see keeper note §2.7.
- `src/pda.ts` — thin re-export/wrappers over the Codama `find…Pda` helpers for seeds the IDL may not encode (keeps derivations in one place; validated by the on-chain team's PDA layout in §4.1).
- `src/dto/` — the zod schemas (see §4). These are the **API↔web contract** (PLAN.md §3.3 option a) — imported by NestJS via `nestjs-zod` and by the web app.
- `src/domain.ts` — shared enums/types: `MarketState` (`Uninitialized|Open|Trading|Locked|Resolved|Closed`), `Side` (`Yes|No`), `Outcome`.

### 1.3 Buildless TS conventions affecting these services (§3.1)

- Services run TS **directly**: `node src/index.ts`, `node --watch src/index.ts` (dev). No bundler/tsc build step for keeper.
- Root/base tsconfig (packages/tsconfig): `module: "NodeNext"`, `moduleResolution: "NodeNext"`, `verbatimModuleSyntax: true`, `erasableSyntaxOnly: true`, `allowImportingTsExtensions: true`, `noEmit: true`, `target: "ES2022"`, `strict: true`.
- **Import specifiers use explicit `.ts`** across `libs/shared` (required by `allowImportingTsExtensions`). No TS path aliases (they need a build) — use workspace package names + subpath `imports`.
- **Indexer caveat:** NestJS relies on **decorator metadata + reflection** (`emitDecoratorMetadata`, `experimentalDecorators`), which `erasableSyntaxOnly` forbids and `node`'s native TS type-stripping does not emit. So the **indexer needs a real TS runtime**: use `emitDecoratorMetadata: true` + run under **`tsx`** (or `swc`/`ts-node`) — it cannot use raw `node src/index.ts`. Keep a per-app `apps/indexer/tsconfig.json` that overrides the erasable-only settings. **The keeper (no decorators) can use plain `node --watch src/index.ts`.** This split is called out because it's an easy footgun (Open Question O2).

---

## 2. Keeper service (`apps/keeper`) — the differentiator (§6.1)

### 2.1 Responsibilities

1. **Subscribe** to TxLINE **SSE score stream** (`GET /api/scores/stream`); maintain live match state.
2. **Lifecycle keeper (§4.1/§4.2):** at **kickoff** send `activate_market()` (Open→Trading); at **final whistle** send `freeze_market()` (Trading→Locked).
3. **Resolution:** on match-end (Game Phase ∈ {5,10,13}), fetch the TxLINE stat-validation proof (`GET /api/scores/stat-validation`), build our program's `resolve(...)` passing the proof/stat args, **simulate**, then send via the reliability layer so it lands. Our program does the actual verification by **CPI'ing into TxLINE `validate_stat` (read-only, returns bool)** — the keeper only supplies the proof args; the predicate lives on-chain in `MarketConfig`. Resolve fails with TxLINE `RootNotAvailable (6007)` until the oracle posts the epoch-day Merkle root; the keeper **retries** on this error (see §2.8).
4. **Reliability:** RPC failover, rebroadcast, dynamic priority fees (kitguard / TxSender).
5. **Safety:** simulate-before-send; devnet default; keeper holds *only its own* signer (authorized on-chain for activate/freeze/resolve), **never user keys**.
6. **v1 (STAGED) — Mark-price ingestion:** subscribe to the TxLINE **StablePrice odds** SSE stream (`GET /api/odds/stream`, same auth as scores; a snapshots endpoint also exists) and post a mark price on-chain for the `LeveragePool` (`mark_price_bps` + timestamp; **keeper-signed in v1**, proof-verified via TxLINE `validate_odds` CPI as v2). The funding rate is re-quoted **per epoch** off this mark. Must be **staleness-aware**: never post a stale mark; on-chain rejects `now - mark_ts > max_mark_age_secs`. Reuses the existing `TxSender`/simulate-before-send path (§2.6). On-chain/economic detail: anchor-programs-plan.md §4.10, PLAN §10. *Not in v0 scope — the v0 keeper (activate/freeze/resolve, already implemented) stays as-is.*
7. **v1 (STAGED) — SSE risk valve:** on discrete jump events in the scores SSE the keeper already consumes (goal, red card — reuses the existing match-event detection, §2.4), call the keeper-gated `set_risk_valve(paused/funding_multiplier, until_ts)` instruction to briefly pause new leverage opens / widen funding around the jump, then clear it. See anchor-programs-plan.md §4.10 and PLAN §10.
8. **Auto-seed (SHIPPED, opt-in):** `MarketSeeder` (`src/lifecycle/seeder.ts`) — a scheduled loop that polls `GET /api/fixtures/snapshot`, and for each strictly-future fixture with no on-chain Market PDA sends `init_market` (reserves from StablePrice odds `Pct` with 50/50 fallback), so upcoming markets self-appear while the keeper runs. Reuses the keeper's signer / `TxSender` / TxLINE auth (ports `scripts/seed-markets.ts`, no shelling out). Opt-in via `ENABLE_AUTO_SEED` (default off), bounded by `MAX_SEED_PER_RUN` (SOL-drain guard), hourly `AUTO_SEED_INTERVAL_MS`; idempotent (pre-reads each Market PDA), never-throws, and pre-checks `GlobalConfig.authority == signer` before sending (refuses otherwise). Dry-run: `--smoke-seed` / `AUTO_SEED_DRY_RUN`.

### 2.2 Module / file layout

```
apps/keeper/
├─ package.json          # "start": "node src/index.ts", "dev": "node --watch src/index.ts"
├─ tsconfig.json
├─ .env.example
└─ src/
   ├─ index.ts           # bootstrap: load config, signer, rpc; start schedulers + SSE
   ├─ config.ts          # env parse+validate (zod): RPC_URL(S), KEEPER_KEYPAIR,
   │                     #   TXLINE_BASE_URL (default https://txline.txodds.com), TXLINE_API_TOKEN
   │                     #   (X-Api-Token from /api/token/activate; guest JWT fetched at runtime via
   │                     #   POST /auth/guest/start), CLUSTER=devnet, PRIORITY_FEE_MODE, REDIS_URL?
   ├─ solana/
   │  ├─ rpc.ts          # createSolanaRpc + createSolanaRpcSubscriptions (primary + fallbacks)
   │  ├─ signer.ts       # load keypair signer from env/file → TransactionSigner
   │  └─ txSender.ts     # TxSender interface + kitguard adapter (§2.6)
   ├─ txline/
   │  ├─ auth.ts         # guest JWT (POST /auth/guest/start) + X-Api-Token; refresh/caching
   │  ├─ scoreStream.ts  # SSE client (GET /api/scores/stream, undici) → typed MatchEvent; reconnect+backoff
   │  ├─ oddsStream.ts   # v1 (STAGED): SSE GET /api/odds/stream (StablePrice odds, same auth) → mark price for LeveragePool
   │  ├─ proof.ts        # GET /api/scores/stat-validation → args for our resolve() (validate_stat proof)
   │  ├─ history.ts      # GET /api/scores/historical/{fixtureId} — replay/backtest + fee calibration
   │  └─ fixtures.ts     # kickoff/final-whistle schedule (drives activation FSM)
   ├─ lifecycle/
   │  ├─ stateMachine.ts # per-match FSM: Scheduled→Live(activated)→Ended(frozen)→Resolved
   │  └─ scheduler.ts    # setInterval tick: poll fixtures, fire activate/freeze at boundaries
   ├─ actions/
   │  ├─ activate.ts     # build activate_market ix (from @fpm/idl) → simulate → send
   │  ├─ freeze.ts       # build freeze_market ix → simulate → send
   │  ├─ resolve.ts      # fetch proof → build resolve ix → simulate → send
   │  ├─ postMark.ts     # v1 (STAGED): post mark_price_bps+ts to LeveragePool (staleness-aware; §2.1 item 6)
   │  └─ riskValve.ts    # v1 (STAGED): set_risk_valve on goal/red-card jumps, then clear (§2.1 item 7)
   ├─ queue/
   │  └─ jobs.ts         # OPTIONAL BullMQ/Redis retry queue (behind a flag)
   └─ log.ts             # pino logger
```

### 2.3 Run model

- **Default (hackathon):** single Node process, event-loop driven.
  - `scoreStream.ts` — long-lived SSE connection, emits `MatchEvent`s.
  - `scheduler.ts` — `setInterval` (e.g. 5 s) reconciling `fixtures` against `Clock`/wall-time to fire activate/freeze; idempotent (each action re-reads on-chain `Market.state` before acting, so a missed tick or restart self-heals).
  - Match-end from the SSE stream (or fixture end time) enqueues a **resolve job**.
- **Optional hardening (if time, §6.1):** **BullMQ + Redis** retry queue for `resolve`/`activate`/`freeze` jobs — durable retries with backoff survive process restarts, and dedupe by `match_id`. Gate behind `REDIS_URL` presence; without it, fall back to an in-memory retry with capped exponential backoff. This is a *nice-to-have*, not on the critical path.
- **Idempotency is the key design rule:** every action first fetches the on-chain `Market` and no-ops if the state transition already happened (e.g. already `Resolved`). This makes restarts, duplicate SSE events, and rebroadcasts safe.

### 2.4 TxLINE SSE score-stream + match-end detection (CONFIRMED)

> **REAL API shapes — correction (verified LIVE 2026-07-04; the docs/OpenAPI below were wrong; keeper parsers now implement this):**
> - Score events (SSE stream AND `/api/scores/historical/{id}` — historical is **SSE-framed text** too, `data:`/`id:` lines, not JSON) use **PascalCase** fields: `FixtureId, Seq, Ts, Action, StatusId, GameState, Stats, Clock, Score`. `Ts` is milliseconds.
> - `Stats` is a **map** `{"<key>": value}` with key = period*1000+base (e.g. `"1":1,"2":0` = home 1, away 0) — NOT an array of `{key,value,period}`.
> - **There is NO Game Phase / phase_id.** Lifecycle = `StatusId` 1..5 in-play stages, **100 = finalised**; `Action` strings (`kickoff`, `goal`, `halftime_finalised`, `game_finalised`, ...). `GameState` stays `"scheduled"` even in play — never trust it.
> - **Match-end rule (replaces Game Phase {5,10,13}): `StatusId === 100` OR `Action === "game_finalised"`.**
> - Heartbeats: SSE `event: heartbeat` + `data: {"Ts":...}` (~every 15s). `historical` returns a literal `null`/empty body for fixtures with no data or still in play.
> - Two origins: devnet `https://txline-dev.txodds.com` (default), mainnet `https://txline.txodds.com`.
> - undici `request()` does **not** auto-decompress — don't send `Accept-Encoding: gzip` on the SSE stream (a gunzip pipe swallows disconnect errors).

- **Endpoint:** `GET https://txline.txodds.com/api/scores/stream`. Auth headers (both required): `Authorization: Bearer <guest-jwt>` (guest JWT from `POST /auth/guest/start`) **and** `X-Api-Token: <apiToken>` (from `/api/token/activate`). Plus `Accept: text/event-stream`, `Cache-Control: no-cache`. Send `Accept-Encoding: gzip` (cuts bandwidth 70–80%). (Odds stream is the sibling `GET /api/odds/stream` with the same auth — not needed for resolution. **v1 (STAGED):** it feeds the LeveragePool **mark-price ingestion** job, §2.1 item 6; an odds **snapshots** endpoint also exists.)
- Use `undici`'s fetch with a streaming body or a small `EventSource` client. **SSE events are generic/unnamed** — parse each `message.data` as JSON into a discriminated union `MatchEvent` (`Score`, `StatusChange`, `Ended`, `Heartbeat`). The parser carries a `retry` field. **Exact inner JSON field names are still generic in the docs** — normalize defensively in `scoreStream.ts` (see remaining note in §8).
- **fixture_id is `i64`** (e.g. `17588316`) — the match id used across the whole system (on-chain `match_id`, DB `match_id`, REST `:id`).
- **Match-end detection (CONFIRMED, resolves O3):** track **Game Phase ID**: 1 NS, 2 H1, 3 HT, 4 H2, 7 ET1, 9 ET2, 12 PE. **Ended = phase ∈ {5 "F", 10 "FET", 13 "FPE"}.** Detect end when phase enters that set. Cross-check with `fixtures` end time as a fallback so a missed SSE frame still triggers resolution.
- **Score-stat key encoding (CONFIRMED):** `key = period*1000 + base`. Base keys: 1 = P1 total goals, 2 = P2 total goals, 3–6 = yellow/red cards, 7–8 = corners. Period multipliers: H1 +1000, H2 +2000, ET1 +3000, ET2 +4000, Pens +5000. Example: a "home win" market → `stat_a = key 1`, `stat_b = key 2`, `op = Subtract`, predicate `threshold 0 GreaterThan`.
- **Service level / delay (devnet):** devnet/free = Service Level 1 = **60-second DELAYED** data. Realtime (SL 12) is mainnet-only. This 60s delay is exactly the adverse-selection window our dynamic fee defends against — the keeper's live path runs on delayed data on devnet by design.
- **Resilience:** auto-reconnect with exponential backoff + jitter; on reconnect, re-sync current match statuses (the stream is a hint, on-chain state + fixture schedule are the source of truth).

### 2.5 Building the txs via @solana/kit (verified pattern)

Standard Kit pipe (confirmed against Kit docs / SPL test harness). Every action follows: **build → simulate → send**.

```ts
// actions/resolve.ts (illustrative — not final)
import {
  pipe, createTransactionMessage, setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash, appendTransactionMessageInstructions,
  setTransactionMessageComputeUnitPrice,        // dynamic priority fee (verified)
} from "@solana/kit";
import { getSetComputeUnitLimitInstruction } from "@solana-program/compute-budget";
import { getResolveInstruction } from "@fpm/idl";   // Codama-generated

// Our program CPIs into TxLINE validate_stat (read-only → bool) and resolves on the result.
// The keeper only supplies the proof/stat args from /api/scores/stat-validation;
// the predicate is stored on-chain in MarketConfig, NOT passed here (§2.8).
const resolveIx = getResolveInstruction({
  // accounts
  market, marketConfig, escrowVault, globalConfig,
  txlineProgram: TXLINE_PROGRAM_ID,                 // CPI target
  dailyScoresMerkleRoots,                           // TxLINE read-only PDA ["daily_scores_roots", epoch_day u16 LE]
  keeper: signer,
  // args forwarded to validate_stat via CPI (from the stat-validation response)
  ts, fixtureSummary, fixtureProof, mainTreeProof,
  statA, statB /* Option */, op /* Option: Add|Subtract */,
});

const { value: latestBlockhash } = await rpc.getLatestBlockhash().send();
const message = pipe(
  createTransactionMessage({ version: 0 }),
  (tx) => setTransactionMessageFeePayerSigner(signer, tx),
  (tx) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, tx),
  (tx) => setTransactionMessageComputeUnitPrice(priorityFeeMicroLamports, tx),
  (tx) => appendTransactionMessageInstructions(
            [getSetComputeUnitLimitInstruction({ units: cuLimit }), resolveIx], tx),
);
```

- **Compute-unit limit:** derive from the simulation's `unitsConsumed` × 1.1 margin (fall back to a safe constant if simulation omits it).
- **Priority fee:** see §2.6.

### 2.6 Reliability layer — `TxSender` (kitguard adapter) + simulate-before-send

Define an interface the keeper depends on, so kitguard is swappable:
```ts
interface TxSender {
  simulate(message): Promise<SimResult>;                 // must succeed before send
  sendAndConfirm(message, opts): Promise<Signature>;     // failover + rebroadcast internally
}
```

**Behavior required (from §6.1 "RPC failover / rebroadcast / dynamic priority fees"):**
1. **Simulate first (safety).** Use Kit `rpc.simulateTransaction(...)` (or `simulateTransactionFactory`). Abort on error; log program logs + return the decoded custom error (map via the IDL's error enum). Never send a tx that fails simulation.
2. **Dynamic priority fees.** Before build, query `getRecentPrioritizationFees` (verified RPC) over the writable accounts the tx locks (the `Market`/`EscrowVault` PDAs), take a percentile (e.g. p75), clamp to `[floor, ceiling]`, set via `setTransactionMessageComputeUnitPrice`. On rebroadcast escalate the fee.
3. **RPC failover.** Configure a primary + ordered fallback list (`RPC_URLS`). On transport error / timeout, rotate to the next endpoint. Devnet primary = `https://api.devnet.solana.com`; recommend adding one paid endpoint (Helius/Triton) for the live demo since public devnet is flaky.
4. **Rebroadcast until confirmed or blockhash expires.** Re-send the *same signed tx* on an interval; poll `getSignatureStatuses` for `confirmed`. Only re-sign if the blockhash expired (per Solana "Retrying Transactions" guidance — do **not** re-sign a still-valid tx or you risk duplicates). Use `sendAndConfirmTransactionFactory` as the confirmation primitive.

**kitguard integration:** if `kitguard` is a real package, wrap its sender in this `TxSender` adapter (map its failover/rebroadcast/fee-strategy config to the interface). If it isn't available, implement the above directly on `@solana/kit` primitives — the interface is identical either way, so the keeper code doesn't change. **Confirm which before Phase 3 (O1).**

> **Devnet is where failover actually gets exercised (§7 smoke tier):** LiteSVM/Surfpool don't have multiple RPCs, so the kitguard value-add is only truly testable on devnet. Budget a devnet smoke pass.

### 2.7 Signer / key handling & safety (§6.1)

- Keeper keypair loaded from `KEEPER_KEYPAIR` env (base58 or JSON array) or a file path; convert to a Kit `TransactionSigner`. `@solana/kit` has no built-in file loader, so either implement a small loader or pull in `gill/node`'s `loadKeypairSignerFromFile` / `loadKeypairSignerFromEnvironmentBase58` (verified helpers).
- On Railway, store as a **secret env var** (not a file in the image).
- The keeper's key is **authorized on-chain only for activate/freeze/resolve** — it never touches user funds or positions. Document this in the README security notes.
- **Default cluster = devnet**; refuse to start against mainnet unless an explicit `ALLOW_MAINNET=1` flag is set (guard against fat-finger).
- **Token-2022 (D-6, OPEN):** if the collateral mint is TxLINE's devnet USDT (Token-2022) rather than classic-SPL USDC, any keeper token handling must use `TOKEN_2022_PROGRAM_ID` — derive ATAs against the Token-2022 program and use `transfer_checked` (decimals-aware). TxLINE itself uses `TOKEN_2022_PROGRAM_ID` for all its token ops. For the hackathon the keeper does not move collateral, but if a helper ever does (e.g. seeding demo liquidity) it must branch on the mint's owning program.

### 2.8 Resolution flow — proof fetch + CPI-return-bool model (CONFIRMED, resolves O4)

> **REAL API shapes — correction (verified LIVE 2026-07-04; keeper `proof.ts` implements this):**
> - `GET /api/scores/stat-validation` — **`seq` is REQUIRED** (404 without it); take it from the `Seq` of the score event that finalised the match (`game_finalised`), or recover it from the historical replay.
> - The response is **FLAT** camelCase JSON (hashes as `number[32]`): `{ ts, statToProve, eventStatRoot, summary{ fixtureId, updateStats{updateCount,minTimestamp,maxTimestamp}, eventStatsSubTreeRoot }, statProof, subTreeProof, mainTreeProof, statToProve2?, statProof2? }`. Final stats carry `period: 100`.
> - Mapping to our resolve args: `statA = {statToProve, eventStatRoot, statProof}`; `statB = {statToProve2, eventStatRoot (SHARED root), statProof2}`; `fixtureSummary = {summary.fixtureId, summary.updateStats, eventsSubTreeRoot: summary.eventStatsSubTreeRoot}`; `fixtureProof = subTreeProof`; `mainTreeProof = mainTreeProof`; `ts = ts` (ms; `epochDay = ts / 86_400_000`).

Our AMM `resolve` **CPIs into TxLINE `validate_stat` and reads the returned bool** — TxLINE does the Merkle verification, our program acts on the result. `validate_stat` is **read-only**:

```
validate_stat(ts: i64, fixture_summary: ScoresBatchSummary, fixture_proof: Vec<ProofNode>,
              main_tree_proof: Vec<ProofNode>, predicate: TraderPredicate,
              stat_a: StatTerm, stat_b: Option<StatTerm>,
              op: Option<BinaryExpression>) -> bool
```
It verifies a Merkle proof against on-chain daily score roots posted by the TxLINE oracle. Required account: `daily_scores_merkle_roots` (read-only PDA, seeds `["daily_scores_roots", epoch_day as u16 LE]`).

**Keeper's job for resolve:**
1. **Detect match end** (Game Phase ∈ {5,10,13}, §2.4).
2. **Fetch proof + stat values** from TxLINE: `GET /api/scores/stat-validation?fixtureId=X&seq=Y&statKey=Z&statKey2=W` — the response is directly usable as `validate_stat` args.
3. **Build our `resolve` tx** passing `ts / fixture_summary / fixture_proof / main_tree_proof / stat_a / stat_b / op` as args. The **predicate is stored on-chain in `MarketConfig`** (comparison + threshold) — the keeper does **not** pass it.
4. **Simulate then send** via `TxSender` (simulate-before-send, §2.6).

**Gating / retry loop (important):** `resolve` fails with TxLINE `RootNotAvailable (6007)` until the oracle posts that epoch-day's Merkle root. This is **transient, not a permanent failure** — the keeper must **retry after the root is posted** (backoff loop; idempotent so re-runs are safe). Other TxLINE proof errors to surface/log distinctly: `PredicateFailed (6021)`, `InvalidStatProof (6023)`, `InvalidMainTreeProof (6004)`, `ProofTooLarge (6062)`.

**TxLINE types (for `proof.ts` decoding / the generated client):**
- `ProofNode { hash: [u8;32], is_right_sibling: bool }`
- `ScoreStat { key: u32, value: i32, period: i32 }`
- `StatTerm { stat_to_prove: ScoreStat, event_stat_root: [u8;32], stat_proof: Vec<ProofNode> }`
- `ScoresBatchSummary { fixture_id: i64, update_stats: ScoresUpdateStats, events_sub_tree_root: [u8;32] }`
- `TraderPredicate { threshold: i32, comparison: GreaterThan|LessThan|EqualTo }` (stored on-chain)
- `BinaryExpression` enum `{ Add, Subtract }`

**IDL surface:** the TxLINE devnet IDL is published at `txline.txodds.com/documentation/programs/devnet`. The keeper's generated client should include TxLINE's IDL too (or hand-build the `validate_stat` instruction + the above types).

---

## 3. Indexer / API service (`apps/indexer`) — §6.2

### 3.1 NestJS module structure

```
apps/indexer/
├─ package.json          # "start": "tsx src/main.ts", "dev": "tsx watch src/main.ts"
├─ tsconfig.json         # emitDecoratorMetadata + experimentalDecorators (see §1.3)
├─ .env.example
└─ src/
   ├─ main.ts            # bootstrap Nest app; global ZodValidationPipe (nestjs-zod)
   ├─ app.module.ts      # imports DbModule, IndexerModule, MarketsModule
   ├─ db/
   │  ├─ db.module.ts    # TypeORM (or Prisma) connection; entities
   │  ├─ entities/       # Market, PricePoint, Trade (see §3.3)
   │  └─ migrations/
   ├─ indexer/
   │  ├─ indexer.module.ts
   │  ├─ subscriber.service.ts   # program-log + account-change subscriptions (§3.4)
   │  ├─ log-parser.ts           # decode Anchor program logs → domain events
   │  └─ backfill.service.ts     # getSignaturesForAddress replay on startup (catch-up)
   └─ markets/
      ├─ markets.module.ts
      ├─ markets.controller.ts   # GET /markets, /markets/:id, /markets/:id/history
      └─ markets.service.ts      # queries + shaping into DTOs
```

- **DbModule** — TypeORM recommended for hackathon (decorator entities align with Nest; Prisma also fine but adds a codegen step — TypeORM keeps it buildless-ish). Provides the repository/connection.
- **IndexerModule** — background worker: subscribes to the chain, parses events, writes rows. Runs inside the same Nest process (implements `OnModuleInit`) — no separate deployable for the hackathon.
- **MarketsModule** — the REST surface; depends on DbModule only (reads).

> **SHIPPED — deltas from this draft:** persistence is **Prisma/Postgres** (not TypeORM — the codegen step was accepted); the background worker lives in an **`ingest/`** module (`backfill.service` = boot replay + authoritative account refresh, `tail.service` = poll loop, `persister.service` = event → row writes, `fixtures.service` = TxLINE enrichment), event decoding in **`chain/`** (`events.decoder` / `log-parser`). **Market enrichment (SHIPPED):** each Market row is enriched from the TxLINE feed — `home_team`/`away_team` (from `/api/scores/historical/{id}` lineups, snapshot fallback), **`competition`/`competition_id`** (from `/api/fixtures/snapshot`, cached once per process), live **score + match clock + game state** (refreshed per poll for `Trading`, one-shot for `Locked`/`Resolved`, 30 s throttle), and **reference odds** (`odds_*_bps` from StablePrice, assembled into `marketOdds` only when the full home/draw/away triple is present — null on devnet WC where the feed is empty). All enrichment is cached + never-throws so a flaky feed can't break the poll. These columns flow through `MarketDto` (§4) to the web app's filters and the market-vs-pool spread.

### 3.2 Chain subscription strategy (§6.2)

Two complementary sources, both via `@solana/kit` subscriptions (`createSolanaRpcSubscriptions`):

1. **Program logs** (`logsSubscribe` filtered by `AMM_PROGRAM_ID`) — primary event feed. The Anchor program should emit `emit!` events (Anchor CPI event logs) for `Buy`, `Sell`, `Resolve`, `Activate`, `Freeze`. Parse via `log-parser.ts` using the IDL's event discriminators (from `libs/idl`). Each `Buy`/`Sell` → a `Trade` row + a derived `PricePoint`.
2. **Account changes** (`accountSubscribe` per active `Market` PDA, or `programSubscribe` on the program with a Market-discriminator memcmp filter) — authoritative state: decode with the Codama `Market` decoder to capture `yes_reserve`/`no_reserve`, `state`, `outcome`, `last_price_bps`, `v_acc`, volumes. Write a `PricePoint` snapshot on each change so the chart reflects true reserves even for events we didn't parse from logs.

- **Startup backfill:** on boot, `getSignaturesForAddress(AMM_PROGRAM_ID)` back to the last-indexed signature (persisted cursor) and replay via `getTransaction` to fill gaps from downtime. Idempotent upserts keyed by `(signature, event_index)`.
- **Resilience:** subscriptions auto-reconnect; on reconnect, run a bounded backfill to close the gap. Persist a `last_indexed_signature` / `last_indexed_slot` cursor.
- **Price derivation:** `price(YES) = no_reserve / (yes_reserve + no_reserve)` (matches on-chain math §4.3) — compute in the parser so `PricePoint` stores the same value the contract uses (`last_price_bps` from the decoded account is the cross-check).

- **Team-name enrichment** (`ingest/fixtures.service.ts`): the on-chain `Market` carries only `fixture_id`, so `markets.home_team`/`away_team` are populated from TxLINE. Source (authed, reuses the keeper's guest-JWT + `X-Api-Token` pattern; env `TXLINE_BASE_URL` / `TXLINE_API_TOKEN`, token only in the gitignored `.env`): (1) `GET /api/fixtures/snapshot` for currently-featured fixtures (direct `Participant1`/`Participant2` names), else (2) `GET /api/scores/historical/{id}` — the SSE `Action:"lineups"` frame carries `Lineups[0/1].preferredName` (`Lineups[0]` = `Participant1`; `Participant1IsHome` picks home). The public `/api/schedule` is not a usable no-auth fallback (401 without a token). Resilience: `getTeams` **never throws**, memoizes positive *and* negative results per fixture (the 15s poll never refetches), and is only called when `home_team` is null — enrichment is one-shot per market. Called from the persister on `MarketCreated` and via a boot backfill (`enrichMissingTeams`) for pre-existing rows. A fixture with no feed data (empty historical body) stays null and the web falls back to `"Fixture <id>"`.

### 3.3 Postgres schema

```sql
-- markets: one row per on-chain Market PDA (denormalized snapshot for fast list/detail)
CREATE TABLE markets (
  id                TEXT PRIMARY KEY,        -- market PDA (base58)
  match_id          TEXT NOT NULL UNIQUE,
  config_id         TEXT NOT NULL,           -- MarketConfig PDA
  state             TEXT NOT NULL,           -- Open|Trading|Locked|Resolved|Closed
  outcome           SMALLINT,                -- null until resolved (0=NO,1=YES)
  yes_reserve       NUMERIC(40,0) NOT NULL,
  no_reserve        NUMERIC(40,0) NOT NULL,
  yes_price_bps     INTEGER NOT NULL,        -- 0..10000, mirrors last_price_bps
  base_fee_bps      INTEGER,
  current_fee_bps   INTEGER,                 -- derived from v_acc if we compute it
  total_volume      NUMERIC(40,0) NOT NULL DEFAULT 0,   -- cumulative USDC (base units)
  kickoff_ts        TIMESTAMPTZ,
  freeze_ts         TIMESTAMPTZ,
  home_team         TEXT,                    -- enrichment from TxLINE fixtures (optional)
  away_team         TEXT,
  updated_slot      BIGINT NOT NULL,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- price_points: time-series for charts (append-only)
CREATE TABLE price_points (
  id            BIGSERIAL PRIMARY KEY,
  market_id     TEXT NOT NULL REFERENCES markets(id),
  ts            TIMESTAMPTZ NOT NULL,
  slot          BIGINT NOT NULL,
  yes_price_bps INTEGER NOT NULL,
  yes_reserve   NUMERIC(40,0) NOT NULL,
  no_reserve    NUMERIC(40,0) NOT NULL,
  fee_bps       INTEGER
);
CREATE INDEX idx_price_points_market_ts ON price_points (market_id, ts);

-- trades: individual buy/sell events (append-only)
CREATE TABLE trades (
  id              BIGSERIAL PRIMARY KEY,
  market_id       TEXT NOT NULL REFERENCES markets(id),
  signature       TEXT NOT NULL,
  event_index     INTEGER NOT NULL,          -- position within tx
  trader          TEXT NOT NULL,
  side            SMALLINT NOT NULL,          -- 0=NO,1=YES
  action          TEXT NOT NULL,              -- buy|sell
  usdc_amount     NUMERIC(40,0) NOT NULL,
  tokens_amount   NUMERIC(40,0) NOT NULL,
  fee_bps         INTEGER NOT NULL,
  yes_price_bps   INTEGER NOT NULL,           -- price after trade
  ts              TIMESTAMPTZ NOT NULL,
  slot            BIGINT NOT NULL,
  UNIQUE (signature, event_index)             -- idempotent replay
);
CREATE INDEX idx_trades_market_ts ON trades (market_id, ts);

-- indexer_cursor: single-row replay checkpoint
CREATE TABLE indexer_cursor (
  id                     BOOLEAN PRIMARY KEY DEFAULT true,
  last_indexed_signature TEXT,
  last_indexed_slot      BIGINT
);
```

Notes: use `NUMERIC(40,0)` for u64/u128 token amounts (JS `number` can't hold them; DTOs serialize as strings — §4). Consider a `time_bucket`/rollup later for chart downsampling; not needed for the hackathon volume.

### 3.4 REST endpoints (§6.2)

All responses validated/serialized through the `libs/shared` zod DTOs (§4).

| Method | Path | Query | Returns |
|---|---|---|---|
| GET | `/markets` | `?state=&limit=&offset=` | `MarketSummary[]` (list) |
| GET | `/markets/:id` | — | `MarketDetail` |
| GET | `/markets/:id/history` | `?from=&to=&resolution=` | `HistoryResponse` (price/volume series for lightweight-charts) |

- `:id` accepts the market PDA (and optionally `match_id` for convenience).
- `/history` `resolution` = candle interval (`1m|5m|1h|raw`); `from`/`to` = unix seconds. Shape targets TradingView `lightweight-charts` (array of `{ time, value }` or OHLC).
- Add `GET /health` for Railway health checks.
- Enable CORS for the web origin.

**TxLINE enrichment on `MarketDto` (Phase 4, DONE 2026-07-07):** the indexer decorates each Market row with off-chain TxLINE data beside the on-chain state.
- *Team names* — one-shot, static (`FixturesService.getTeams`, `/api/fixtures/snapshot` → `/api/scores/historical/{id}` lineups).
- *Live score* — `getScore` reads `/api/scores/snapshot/{id}` (array of per-action rows; prefers the last `StatusId==100` finalised row). Goals from the `Stats` map (`"1"`=home, `"2"`=away goals) with `Score.*.Total.Goals` fallback → `home_score/away_score/status_id/match_clock/game_state`.
- *Reference odds* — `getOdds` reads `/api/odds/snapshot/{id}` (demargined StablePrice); the freshest 1X2 row's aligned `PriceNames`/`Prices` → implied probabilities in bps → `odds_home_bps/odds_draw_bps/odds_away_bps/odds_ts`. Surfaced on the DTO as `marketOdds` (null unless a full 1X2 triple exists).
- *Refresh cadence* — score/odds CHANGE for live markets, so they refetch every poll for `Trading` markets (throttled ≥30s/fixture inside the persister) and are captured once for `Locked`/`Resolved`; teams stay one-shot. Driven from the tail poll (`refreshMarkets` on new txs, `refreshLiveData` otherwise). All TxLINE calls never throw — a dead feed leaves columns untouched and never stalls indexing. Devnet note: the demo fixtures' odds feed returns `[]`, so `marketOdds` is null there; `18179549` resolves score 1–0, `statusId` 100.

---

## 4. API↔web type contract — zod DTOs in `libs/shared` (§3.3, §6.2 option a)

Single source of truth; imported by NestJS via **`nestjs-zod`** (`createZodDto` + global `ZodValidationPipe`) and by the web app for typed fetches. **All large integers serialize as strings.**

```ts
// libs/shared/src/dto/market.dto.ts (illustrative)
import { z } from "zod";

export const MarketState = z.enum(["Open","Trading","Locked","Resolved","Closed"]);
export const Side = z.enum(["YES","NO"]);

export const MarketSummarySchema = z.object({
  id: z.string(),                 // market PDA
  matchId: z.string(),
  state: MarketState,
  homeTeam: z.string().nullable(),
  awayTeam: z.string().nullable(),
  yesPriceBps: z.number().int().min(0).max(10_000),
  totalVolume: z.string(),        // u64 base units as string
  kickoffTs: z.number().int().nullable(),
  freezeTs: z.number().int().nullable(),
  outcome: z.enum(["YES","NO"]).nullable(),
});

export const MarketDetailSchema = MarketSummarySchema.extend({
  configId: z.string(),
  yesReserve: z.string(),
  noReserve: z.string(),
  baseFeeBps: z.number().int(),
  currentFeeBps: z.number().int().nullable(),
  updatedSlot: z.number().int(),
});

export const HistoryQuerySchema = z.object({
  from: z.coerce.number().int().optional(),
  to: z.coerce.number().int().optional(),
  resolution: z.enum(["1m","5m","1h","raw"]).default("5m"),
});

export const PricePointSchema = z.object({
  time: z.number().int(),         // unix seconds (lightweight-charts UTCTimestamp)
  yesPriceBps: z.number().int(),
  volume: z.string(),
});

export const HistoryResponseSchema = z.object({
  marketId: z.string(),
  resolution: z.string(),
  points: z.array(PricePointSchema),
});

export const MarketListQuerySchema = z.object({
  state: MarketState.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

// inferred TS types for web:
export type MarketSummary = z.infer<typeof MarketSummarySchema>;
export type MarketDetail  = z.infer<typeof MarketDetailSchema>;
export type HistoryResponse = z.infer<typeof HistoryResponseSchema>;
```

NestJS side:
```ts
// markets.controller.ts
import { createZodDto } from "nestjs-zod";
class MarketListQueryDto extends createZodDto(MarketListQuerySchema) {}
class HistoryQueryDto   extends createZodDto(HistoryQuerySchema) {}
// @Query() validated by global ZodValidationPipe; responses shaped to *Schema.parse(...)
```
Keeps the contract buildless and single-sourced; web imports `@fpm/shared` types directly. (Alt: NestJS Swagger→generated client, heavier — skip per §6.2.)

---

## 5. Deployment (§8) — Railway

- **Two Railway services** (keeper, indexer) + one **Railway Postgres** plugin (indexer's DB). Frontend → Vercel; program → devnet (teammates).
- **Lean Docker via turbo prune (§3.4):** per service,
  ```
  turbo prune --scope=@fpm/keeper --docker      # → ./out with only that slice
  turbo prune --scope=@fpm/indexer --docker
  ```
  Multi-stage Dockerfile: stage 1 copies `out/json` + lockfile → `pnpm install`; stage 2 copies `out/full` (source) → run. **Because both services are buildless, the image just runs the TS entrypoint** (`node src/index.ts` for keeper; `tsx src/main.ts` for indexer). `libs/idl` generated output is committed, so no Rust toolchain is needed in the images.
- **Env / secrets (Railway variables):**
  - keeper: `RPC_URLS` (primary,fallbacks), `KEEPER_KEYPAIR` (secret), `TXLINE_BASE_URL` (default `https://txline.txodds.com`), `TXLINE_API_TOKEN` (secret; `X-Api-Token`), `CLUSTER=devnet`, `PRIORITY_FEE_*`, optional `REDIS_URL`. (Guest JWT is fetched at runtime via `POST /auth/guest/start`, not stored.) TxLINE program id / mints come from `@fpm/shared` constants, keyed by `CLUSTER`.
  - indexer: `DATABASE_URL` (Railway Postgres reference var), `RPC_URLS`, `AMM_PROGRAM_ID`, `PORT`, web `CORS_ORIGIN`.
  - Use Railway **reference variables** to inject the Postgres `DATABASE_URL` into the indexer.
- **Health checks:** indexer `GET /health`; keeper can expose a tiny HTTP `/health` (or rely on log liveness).
- **Run migrations** on indexer deploy (TypeORM `migration:run` as a release/pre-start step).
- Devnet public RPC is unreliable under load — provision at least one paid RPC endpoint (Helius/Triton) in `RPC_URLS` for the recorded demo.

---

## 6. Testing / verification approach

**Keeper:**
- **Unit:** FSM transitions (Scheduled→Live→Ended→Resolved), SSE frame parsing, proof-fetch mapping, priority-fee clamp logic, idempotency guards (no-op when on-chain state already advanced). Mock RPC + a fake SSE server.
- **Integration (Surfpool, aligns with §7 tier 2):** point keeper RPC at surfnet; forge a `Market` in `Locked` via `surfnet_setAccount`; feed a canned proof; assert `resolve` lands and `Market` → `Resolved`. Use Surfpool **time-travel** for the kickoff→freeze→resolve window to test activate/freeze timing without waiting on real clocks.
- **Smoke (devnet, §7 tier 3):** real activate→freeze→resolve against a live devnet market; this is the **only** place kitguard failover/rebroadcast is genuinely exercised. Record it for the Historical Replay demo (§8). **Devnet World Cup feed is confirmed available** (57 group-stage + 16 Round-of-32 fixtures, Jun 14–Jul 4 2026, all with Scores + StablePrice odds), so the live path is demoable end-to-end (resolves O7).
- **Historical replay / fee calibration:** `GET /api/scores/historical/{fixtureId}` serves scores for fixtures within the past two weeks and six hours — use it to replay a finished match for the demo and to calibrate the dynamic-fee parameters against the 60s-delay adverse-selection window. **v1 (STAGED):** theta/funding sizing for the LeveragePool should be calibrated off **realized TxLINE odds volatility** (historical odds replay — the odds history endpoints serve this), not a static constant (anchor-programs-plan.md §4.10, PLAN §10).

**Indexer:**
- **Unit:** log-parser decodes known Anchor event log lines → correct `Trade`/`PricePoint` rows; price-derivation math matches `no/(yes+no)`; idempotent upsert on duplicate `(signature, event_index)`.
- **Integration:** run against Surfpool or a local validator with the program deployed; execute buy/sell/resolve txs and assert rows appear and REST endpoints return them. Validate every response against its zod schema (contract test) so the web app can trust shapes.
- **DB:** run migrations against an ephemeral Postgres (docker/Railway) in CI.

**CI (§3.4):** `turbo run lint typecheck test --affected` (set `TURBO_SCM_BASE`). Both services get `typecheck` (tsc `--noEmit`) even though they're buildless — catches drift against `libs/idl` after regeneration.

---

## 7. Sequenced task breakdown (checklist)

**Pre-req (depends on program team having a compilable IDL — coordinate early):**
- [ ] P0. Agree the IDL surface we consume: instruction names/args for `activate_market`, `freeze_market`, `resolve(ts, fixture_summary, fixture_proof, main_tree_proof, stat_a, stat_b, op)` (predicate is on-chain in `MarketConfig`); `Market`/`MarketConfig` account layouts; emitted event names; PDA seeds. (Blocks real codegen.)
- [x] P0. **TxLINE interface — CONFIRMED** (§2.4/§2.8): SSE `GET /api/scores/stream` + guest-JWT/`X-Api-Token` auth, generic-JSON event schema, match-end via Game Phase {5,10,13}, proof via `GET /api/scores/stat-validation`, CPI-return-bool resolve model, program ids + mints. Only genuinely-open item: exact inner JSON field names of SSE score events (docs generic) — handle defensively.
- [ ] P0. Decide kitguard reality (real package vs. implement-on-Kit) — O1.

**libs (do first — everything depends on these):**
- [ ] L1. Scaffold `libs/shared` (buildless package.json, tsconfig) with constants, `domain.ts`, PDA helpers.
- [ ] L2. Author zod DTOs in `libs/shared/src/dto` (§4).
- [ ] L3. Wire `libs/idl` generation (**Option A**, Anchor 1.0 built-in codama), run against a stub/real IDL, **commit generated output**; add `idl#generate` turbo task. Include TxLINE's devnet IDL in codegen too (or hand-build `validate_stat` + types) so `resolve` CPI args are typed.

**Phase 3 — Keeper (2 days, §9):**
- [ ] K1. `apps/keeper` scaffold: config (zod env), pino logger, `node --watch` dev script.
- [ ] K2. `solana/rpc.ts` (primary+fallback), `solana/signer.ts` (keypair→signer), devnet default + mainnet guard.
- [ ] K3. `txSender.ts`: `TxSender` interface + kitguard adapter (or Kit-native impl) — simulate, dynamic fee via `getRecentPrioritizationFees` + `setTransactionMessageComputeUnitPrice`, failover, rebroadcast.
- [ ] K4. `txline/auth.ts` (guest JWT + `X-Api-Token`) + `txline/scoreStream.ts` SSE client (`/api/scores/stream`, reconnect/backoff, gzip) → typed `MatchEvent`; match-end via Game Phase {5,10,13}; stat-key decoding (`period*1000+base`).
- [ ] K5. `txline/proof.ts` (`GET /api/scores/stat-validation` → resolve args), `txline/history.ts` (`/api/scores/historical/{fixtureId}` for replay/fee-calibration), `txline/fixtures.ts`.
- [ ] K6. `lifecycle/stateMachine.ts` + `scheduler.ts` (setInterval, idempotent).
- [x] K7. `actions/activate.ts`, `freeze.ts`, `resolve.ts` (build→simulate→send via TxSender). `resolve.ts` supplies the stat-validation proof args (our program CPIs `validate_stat`); implement the `RootNotAvailable (6007)` retry-until-root-posted loop and distinct logging for `PredicateFailed/InvalidStatProof/InvalidMainTreeProof/ProofTooLarge`. — **DONE 2026-07-04**: wired to the generated `@fpm/idl` builders (`getActivateMarketInstructionAsync` / `getFreezeMarketInstructionAsync` / `getResolveInstructionAsync`; `ts` in MILLISECONDS, `daily_scores_roots` PDA per `epoch_day = ts/86_400_000` under the TxLINE program). Outcome-hint ladder Yes→No→proof-refetch (bounded); `solana/errors.ts` discriminates our codes vs TxLINE CPI codes from program logs (the 6xxx spaces overlap); terminal proof errors get alert-level (`fatal`) logs. Devnet smoke (`pnpm --filter @fpm/keeper smoke`, simulate-only) verified GlobalConfig fetch, market listing by discriminator, and activate simulation + error discrimination against the LIVE program.
- [x] K8. Idempotency: each action re-reads on-chain `Market.state` and no-ops if already advanced. — **DONE 2026-07-04**: `readMarket` decodes the real `Market` via Codama `fetchMaybeMarket`; all actions guard on `MarketState`, and resolve treats a concurrent `InvalidMarketState`→already-Resolved as success.
- [ ] K9. (Optional) BullMQ/Redis retry queue behind `REDIS_URL`.
- [ ] K10. Keeper tests (unit FSM/parse; Surfpool integration for resolve).

**Phase 4 — Indexer (1–2 days, §9):**
- [x] I1. `apps/indexer` NestJS scaffold; `tsx`-based run; global `ZodValidationPipe`; `/health`. — **DONE 2026-07-05** (dev runs `nest start --watch -b swc`; runtime needs `--experimental-transform-types --import ./hooks/register.mjs` — same loader-hook trick as the keeper — because dist CJS requires the ESM/TS `@fpm/idl`).
- [x] I2. `DbModule` + **Prisma** models/migrations for `markets`, `price_points`, `volume_points`, `trades`, `redemptions` (new, for `Redeemed` events), `indexer_cursor` (§3.3). — **DONE 2026-07-05**: local dev DB = dockerized Postgres 16 (`fpm-postgres`, host port **5433** — 5432 was taken by another project's container); `prisma migrate dev` applied `0001_init` + `0002_redemptions`.
- [x] I3. `IndexerModule`: `events.ts` (pure decoders — Codama does NOT generate event decoders, so the 7 discriminators + borsh layouts from `target/idl/amm.json` are built on `@solana/kit` codecs; `Program data:` lines are attributed via invoke-frame stack so only OUR program's events decode), `log-parser.ts` (event→domain mapping), `persister.service.ts` (idempotent sink keyed `(signature,event_index)`; post-trade reserves recovered from constant-product k + event `price_bps`, `reserve-math.ts`). Events are keyed by `fixture_id` — market PDA derived via `findMarketPda` (@fpm/shared). — **DONE 2026-07-05**.
- [x] I4. `backfill.service.ts` full-history catch-up via paginated `getSignaturesForAddress` + cursor, per-tx `getTransaction`, exponential-backoff/endpoint-rotation RPC wrapper (devnet 429s observed and survived), then an **authoritative account refresh**: all known `Market` + `MarketConfig` accounts re-fetched via the Codama `@fpm/idl` decoders (reserves/supplies/state/outcome/kickoff/freeze/baseFee). Live tail = `SubscriberService` polling `tailOnce()` every `INDEXER_POLL_MS` (15s default) on the same cursor/persistence path (idempotent by construction; websocket `logsSubscribe` left as an optional fast-path). Gated by `INDEXER_ENABLED`. — **DONE 2026-07-05**: replayed the full 14-tx devnet history of `H59qQz…`; both real markets indexed — `HNkBat…` (fixture 18179549) **Resolved YES** with trade/freeze/resolve/redeem rows, `HN5imP…` (fixture 17588316) **Trading**; restart replays 0 (cursor) with no duplicate rows.
- [x] I5. `MarketsModule`: `/markets`, `/markets/:id` (PDA or fixture id), `/markets/:id/history` returning `libs/shared` DTOs; history `volume` now sums per-bucket traded collateral from `volume_points` (was reserves-sum). — **DONE 2026-07-05**: verified against live devnet data — `GET /markets` returns both markets (Trading + Resolved/YES), history shows the real 5000→5243 bps move with 5 USDC volume.
- [x] I6. Indexer tests: `events.spec.ts` — decoder units against **verbatim devnet payloads** (all 6 observed event types incl. Trade/Resolved/Redeemed), invoke-frame attribution incl. nested-CPI cases, reserve-math round-trip (14 jest tests green). REST contract stays zod-validated via `nestjs-zod`. — **DONE 2026-07-05**.

**Deployment (§8, Phase 6):**
- [ ] D1. Dockerfiles using `turbo prune --docker` for `@fpm/keeper` and `@fpm/indexer`.
- [ ] D2. Railway: create project, Postgres plugin, two services; set env/secrets; reference-var `DATABASE_URL`; run migrations; health checks.
- [ ] D3. Add a paid RPC endpoint to `RPC_URLS`; devnet smoke pass (kitguard failover) → record for Historical Replay demo.

---

## 8. Critical blockers & open questions

- **O1 — kitguard reality (BLOCKER for K3):** `kitguard` is not in any indexed Solana doc source. Confirm whether it's a real published package (and its API) or a name for "the reliability layer we build on `@solana/kit`". The `TxSender` interface de-risks this, but the choice affects effort in Phase 3.
- **O2 — Indexer runtime vs. buildless (§3.1 conflict):** NestJS needs decorator metadata/reflection, which the plan's `erasableSyntaxOnly` + raw `node` TS-stripping do **not** support. Resolution: run the indexer under `tsx` with `emitDecoratorMetadata` (per-app tsconfig override). Keeper stays on plain `node`. Confirm the team accepts this asymmetry.
- **O3 — TxLINE SSE schema — RESOLVED (§2.4):** endpoint `GET /api/scores/stream`; auth = guest JWT (`POST /auth/guest/start`) + `X-Api-Token` (`/api/token/activate`); events are generic-unnamed JSON; match-end via **Game Phase ∈ {5,10,13}**. *Residual:* exact inner JSON field names of score events are generic in the docs — normalize defensively in `scoreStream.ts`.
- **O4 — TxLINE proof / resolve model — RESOLVED (§2.8):** our `resolve` **CPIs into read-only `validate_stat(...) -> bool`**; keeper fetches args from `GET /api/scores/stat-validation`; `resolve` needs the read-only `daily_scores_merkle_roots` PDA; proof types (`ProofNode`, `StatTerm`, `ScoresBatchSummary`, etc.) confirmed; `RootNotAvailable (6007)` gates until the oracle posts the root → keeper retries.
- **O5 — IDL surface (BLOCKER for real codegen L3 / all actions):** need the program team's finalized instruction signatures, account layouts, and emitted event names. Until then, work against a stub IDL and swap in the real one (mechanical). *(Note: the `resolve` arg list is now known from the TxLINE side — see §2.8.)*
- **O6 — Anchor version — RESOLVED:** **Anchor 1.0.0 locked.** Use Option A (built-in `anchor codama generate`); TS client base `@anchor-lang/core`.
- **O7 — Devnet World Cup feed availability — RESOLVED:** devnet feed confirmed (57 group-stage + 16 Round-of-32 fixtures, Jun 14–Jul 4 2026, Scores + StablePrice odds). Live path is demoable; historical replay via `GET /api/scores/historical/{fixtureId}`. Note the devnet feed is Service Level 1 = **60s delayed**.
- **D-6 — Collateral mint (OPEN):** classic-SPL USDC vs. TxLINE's Token-2022 devnet USDT. Owned by the on-chain team, but it directly affects keeper token handling: if Token-2022, any keeper helper that moves collateral must use `TOKEN_2022_PROGRAM_ID` + `transfer_checked` (decimals) and Token-2022 ATAs (§2.7). No keeper blocker for the core activate/freeze/resolve path (keeper never moves collateral there).

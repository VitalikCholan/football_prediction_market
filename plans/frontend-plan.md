# Frontend Implementation Plan — `apps/web`

**Scope:** ONLY the Next.js web app. Consumes the indexer REST API, the shared zod DTOs in `libs/shared`, and the generated Kit client in `libs/idl`. Builds/signs/sends on-chain instructions. Does NOT cover the Anchor program, keeper, or indexer internals (teammates' jobs).

**Grounded in** master `PLAN.md` §2 (stack), §3 (monorepo + type contract), §6.3 (frontend), §8 (deploy + demo), §9 (milestone phase 5).

**Verified against** the Solana MCP + `solana-dev` skill (Feb 2026):
- The Solana docs now recommend **framework-kit** (`@solana/client` + `@solana/react-hooks`, Wallet-Standard-first) for new Next.js dapps; `@solana/web3.js` is deprecated. `@solana/kit` is the low-level SDK powering it. Both the framework-kit hooks (`useWalletAccountTransactionSendingSigner`, `useSignAndSendTransaction`) and classic `@solana/wallet-adapter` connect the same Wallet-Standard wallet set (Phantom/Solflare/Backpack) and both drive `@solana/kit` transactions.
- Codama renders a **Kit-native** TS client from the Anchor IDL (`@solana/program-client-core`), which is exactly what `libs/idl` is (`PLAN.md` §3.2). Its generated instruction builders return Kit `Instruction`s, composable with `pipe()` / `createTransactionMessage()`.

> **Critical open question (flag to the team):** `PLAN.md` §2 locks the "Solana wallet adapter" but §6.3 says "build/sign/send via **Kit**." The current recommended path is **framework-kit** hooks (`@solana/react-hooks`), which is Wallet-Standard-first, plays natively with the Kit client in `libs/idl`, and avoids pulling in deprecated `@solana/web3.js` (which classic wallet-adapter still drags in). **Recommendation: use framework-kit as the wallet + signer layer**, keep classic wallet-adapter only as the README "hackathon default" wording. This plan is written for framework-kit, with a fallback note where the two differ. **Confirm before scaffolding (blocks task F1).**

---

## 0. Design direction (from `frontend-design` skill)

**Subject:** a real-time, on-chain betting book for World Cup matches where the price of "YES this team wins" moves like an order book and a goal can spike the fee. Audience: crypto-native DeFi users who read charts. Page's job: let them read the current odds, feel the price impact of their trade, and act.

The three AI-default looks (cream+serif, near-black+acid accent, broadsheet hairlines) are off-limits as unearned defaults. The subject's own world is a **stadium scoreboard / matchday broadcast lower-third** — split-flap boards, pitch-green, the two-team head-to-head framing. That's the identity.

**Token system (compact — expand into `globals.css` + Tailwind theme):**

- **Color** (dark, broadcast-booth): `--pitch: #0B1F17` (near-black green base), `--turf: #12352A` (raised surface), `--chalk: #F3F5F0` (text), `--kit-yes: #35E08A` (YES / up / mint), `--kit-no: #FF5C5C` (NO / down / vermilion), `--whistle: #F5C542` (amber = fee/volatility warnings). YES/NO map to the two market outcomes everywhere — never decorative.
- **Type:** display = a **condensed grotesque** for scores and prices (e.g. self-hosted *Archivo Expanded* / *Anton* for the big numbers — the "scoreboard" voice), used with restraint on prices/odds only; body/UI = a neutral grotesque (*Inter* or *Geist*); data/mono = a tabular monospace (*Geist Mono* / *JetBrains Mono*) for reserves, tx sigs, countdowns. **All numeric displays use `font-variant-numeric: tabular-nums`** so odds don't jitter as they tick.
- **Layout:** market detail is a **broadcast split** — YES team left, NO team right, chart spanning full width beneath, trade panel docked right. The head-to-head is the structure, not decoration.
- **Signature element:** the **odds tape** — a live, tabular-nums price for each side that animates on change with a brief flash in `--kit-yes`/`--kit-no` (the scoreboard "flip"), plus a thin **volatility/fee bar** that widens and turns `--whistle` when the dynamic fee spikes. One bold thing; everything else quiet.
- **Motion:** respect `prefers-reduced-motion`. The odds-flip flash and the fee-bar are the only ambient motion; page-load is a single staggered reveal of the market cards. No scattered effects.
- **State badges** carry real meaning: `Open` (grey), `Trading` (mint, pulsing dot), `Locked` (amber, "awaiting proof"), `Resolved` (outcome-colored), `Closed` (muted).

Build the quality floor without announcing it: responsive to mobile (split collapses to stacked), visible keyboard focus, reduced-motion honored.

---

## 1. App structure (Next.js App Router)

Server components by default; `"use client"` only in leaf components that call wallet/hook APIs or lightweight-charts (`PLAN.md` §6.3, framework-kit guidance: "minimal use client footprint"). Data fetching from the indexer happens in **server components / route-level fetch** where possible; live updates via client-side polling/subscription in leaf components.

```
apps/web/
├─ app/
│  ├─ layout.tsx                # root: fonts, <Providers>, nav shell (server)
│  ├─ globals.css               # Tailwind + design tokens (CSS vars)
│  ├─ providers.tsx             # "use client": SolanaProvider + QueryClient
│  ├─ page.tsx                  # market list (server component; fetches /markets)
│  ├─ markets/
│  │  └─ [id]/
│  │     └─ page.tsx            # market detail (server shell + client islands)
│  ├─ positions/
│  │  └─ page.tsx               # "use client": user positions (wallet-gated)
│  └─ api/                      # (optional) route handlers to proxy/cache indexer
├─ components/
│  ├─ market/
│  │  ├─ MarketCard.tsx         # list item: teams, odds tape, state badge
│  │  ├─ MarketHeader.tsx       # detail: head-to-head, kickoff, state badge
│  │  ├─ OddsTape.tsx           # SIGNATURE: live YES/NO price, flip flash
│  │  ├─ PriceChart.tsx         # "use client": lightweight-charts
│  │  ├─ StateBadge.tsx         # Open/Trading/Locked/Resolved/Closed
│  │  ├─ ResolutionPanel.tsx    # outcome + TxLINE proof link (Resolved)
│  │  └─ FeeBar.tsx             # dynamic-fee / volatility indicator
│  ├─ trade/
│  │  ├─ TradePanel.tsx         # buy/sell tabs, side toggle, amount
│  │  ├─ SlippageControl.tsx    # tolerance %, drives min_out
│  │  ├─ PriceImpact.tsx        # quote + impact + effective fee
│  │  └─ TxReviewDialog.tsx     # simulation result BEFORE signing (§6.3)
│  ├─ position/
│  │  ├─ PositionRow.tsx        # per-market YES/NO balances, P/L
│  │  └─ RedeemButton.tsx       # redeem winning position → USDC
│  ├─ wallet/
│  │  ├─ ConnectButton.tsx      # wallet connect/disconnect dropdown
│  │  └─ WalletGate.tsx         # "connect to trade" empty state
│  └─ ui/                       # shadcn primitives (button, dialog, tabs, …)
├─ lib/
│  ├─ api.ts                    # typed fetch wrappers (zod DTOs from @fpm/shared)
│  ├─ solana.ts                 # rpc, cluster config, program id
│  ├─ tx/
│  │  ├─ buildBuy.ts            # compose buy ix via libs/idl Kit client
│  │  ├─ buildSell.ts
│  │  ├─ buildRedeem.ts
│  │  └─ send.ts                # simulate → review → sign+send helper
│  ├─ quote.ts                  # client-side CPMM quote + price-impact math
│  ├─ format.ts                 # odds %, USDC (6 dp), tabular formatting
│  └─ pdas.ts                   # re-export PDA derivations from @fpm/shared
├─ hooks/
│  ├─ useMarkets.ts             # list + poll
│  ├─ useMarket.ts              # detail + live price
│  ├─ useMarketHistory.ts       # chart series
│  ├─ usePositions.ts           # on-chain Position reads for connected wallet
│  └─ useDemoReplay.ts          # Historical Replay driver (§8)
├─ public/                      # team crests, favicon, self-hosted fonts
├─ next.config.ts
├─ tailwind.config.ts
└─ package.json
```

**Component tree (market detail):**
```
markets/[id]/page.tsx (server: fetch market + history via zod DTOs)
└─ MarketDetailClient ("use client")
   ├─ MarketHeader → StateBadge
   ├─ OddsTape (live)              ← useMarket()
   ├─ FeeBar (live)               ← useMarket() (v_acc/fee)
   ├─ PriceChart                  ← useMarketHistory()
   ├─ ResolutionPanel (if Resolved)
   └─ TradePanel                  ← WalletGate
      ├─ side toggle (YES/NO) + buy/sell tabs
      ├─ amount input
      ├─ PriceImpact (quote, effective fee, impact)  ← lib/quote.ts
      ├─ SlippageControl (→ min_out)
      └─ TxReviewDialog (simulation) → sign+send
```

---

## 2. Routes / screens

| Route | Type | Shows | Reads |
|---|---|---|---|
| `/` | server + client islands | Market list: grid of `MarketCard` (teams, live odds tape, volume, state badge), filter by state | `GET /markets` |
| `/markets/[id]` | server shell + client | Detail: head-to-head header, odds tape, fee bar, price/odds chart, trade panel, resolution panel | `GET /markets/:id`, `GET /markets/:id/history`, on-chain `Market` for freshest reserves/fee |
| `/positions` | client (wallet-gated) | User's `Position` PDAs across markets, unrealized value, redeem buttons for resolved winners | on-chain `Position` reads + `GET /markets` for metadata |

---

## 3. Screens & components (detail)

### 3.1 Market list (`/`)
- Server component fetches `GET /markets`, validated with the `MarketsListSchema` zod DTO from `@fpm/shared`.
- `MarketCard`: two team names/crests, **odds tape** (YES % / NO %), 24h volume, `StateBadge`. Cards animate in on load (single stagger).
- Client island subscribes to periodic refresh so odds tick live on the list too (lighter cadence than detail).
- Empty/error states: "No markets yet." / "Couldn't load markets — retry." (interface voice, actionable).

### 3.2 Market detail (`/markets/[id]`)
- `MarketHeader`: broadcast split (YES team left, NO team right), kickoff/lock countdown (mono, tabular), `StateBadge`.
- `OddsTape` (signature): YES price and NO price = `no_reserve/(yes+no)` and inverse, shown as % with tabular-nums; flips/flashes on change. This is the memorable element; keep the rest quiet.
- `FeeBar`: current dynamic fee (from `v_acc`) as a thin bar; widens + turns `--whistle` when fee is elevated. Tooltip: "Fee rises after sharp price moves to protect liquidity from stale-price trades."
- `PriceChart`: see §5.
- `ResolutionPanel` (when `Resolved`): winning outcome, "Verified by TxLINE proof" with an explorer link to the `resolve` tx (the trustless-resolution story), redeem CTA if the user holds the winning side.

### 3.3 Buy/sell panel (`TradePanel`)
- Tabs: **Buy** / **Sell**. Toggle: **YES** / **NO**. Amount input in USDC (buy) or position tokens (sell).
- `PriceImpact`: live quote from `lib/quote.ts` (mirrors on-chain CPMM + dynamic fee math): expected out, average price, **price impact %**, **effective dynamic fee** for this trade. This is where the user *understands* price impact (§6.3 + design brief).
- `SlippageControl`: tolerance presets (0.5% / 1% / 2%) + custom; converts quote → **`min_out`** (buy) / **`min_usdc_out`** (sell). Show the resolved min in mono so it's inspectable.
- Disabled when market not `Trading`, wallet not connected (→ `WalletGate`), or amount invalid. Actionable disabled reasons ("Market opens at kickoff", "Connect wallet to trade").
- On submit → build ix → **simulate → `TxReviewDialog`** → sign+send. Never sign before showing the simulation (skill guardrail W009 + §6.3).

### 3.4 Position view + redeem (`/positions`)
- Wallet-gated. Reads the connected wallet's `Position` PDAs (derive with `@fpm/shared` PDA helpers) directly on-chain for authoritative balances (indexer may lag).
- `PositionRow`: market, side, token balance, current mark value (from live odds), status. For `Resolved` markets where the user holds the winning side, show `RedeemButton` → builds `redeem()` ix → simulate → review → send → toast "Redeemed N USDC." Zero out after success.
- Copy uses one consistent verb through the flow: button "Redeem" → toast "Redeemed."

### 3.5 State badges
`StateBadge` maps the on-chain `Market` state enum to design tokens (see §0). `Trading` gets a pulsing dot; `Locked` reads "Awaiting proof" (amber); `Resolved` is outcome-colored. Read from on-chain state (freshest) with the indexer value as SSR fallback.

---

## 4. Wallet integration & transactions

### 4.1 Connection (framework-kit — recommended)
`providers.tsx` creates one client via `@solana/client` (`autoDiscover()` for Wallet-Standard wallets) and wraps the app in `SolanaProvider` from `@solana/react-hooks` (verified pattern, `solana-dev` frontend-framework-kit ref). `ConnectButton` uses the connection hooks (`useConnectWallet`/`useDisconnectWallet` per current Solana docs) — a dropdown of discovered wallets. Cluster + RPC from `NEXT_PUBLIC_SOLANA_RPC_URL` (devnet default per §8).

> **Fallback (if the team insists on classic wallet-adapter per §2):** wrap with `ConnectionProvider`/`WalletProvider`/`WalletModalProvider` from `@solana/wallet-adapter-react(-ui)`, use `useWallet()` for the account, and adapt to a Kit `TransactionSendingSigner` at the send boundary. Downside: pulls in deprecated `@solana/web3.js`; contain it to `lib/tx/` only.

### 4.2 Building instructions (Kit client from `libs/idl`)
The Codama-generated client in `@fpm/idl` exposes typed instruction builders (e.g. `getBuyInstructionAsync`). Compose with Kit:

```ts
// lib/tx/buildBuy.ts (illustrative)
import { pipe, createTransactionMessage, setTransactionMessageFeePayerSigner,
         setTransactionMessageLifetimeUsingBlockhash,
         appendTransactionMessageInstruction } from '@solana/kit';
import { getBuyInstructionAsync } from '@fpm/idl';           // generated
import { deriveMarket, derivePosition, deriveVault } from '@fpm/shared'; // PDAs

export async function buildBuyTx({ rpc, signer, marketId, side, usdcIn, minOut }) {
  const market = deriveMarket(marketId);
  const ix = await getBuyInstructionAsync({
    market, position: derivePosition(market, signer.address),
    vault: deriveVault(market), trader: signer,
    side, usdcIn, minOut,                                     // slippage guard
  });
  const { value: blockhash } = await rpc.getLatestBlockhash().send();
  return pipe(
    createTransactionMessage({ version: 0 }),
    m => setTransactionMessageFeePayerSigner(signer, m),
    m => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
    m => appendTransactionMessageInstruction(ix, m),
  );
}
```

`sell`/`redeem` follow the same shape (`buildSell.ts`, `buildRedeem.ts`).

### 4.3 Simulate → review → sign+send (§6.3, mandatory)
```ts
// lib/tx/send.ts (illustrative)
import { compileTransaction, getBase64EncodedWireTransaction,
         signAndSendTransactionMessageWithSigners } from '@solana/kit';

export async function simulate(rpc, txMessage) {
  const wire = getBase64EncodedWireTransaction(compileTransaction(txMessage));
  return rpc.simulateTransaction(wire, { encoding: 'base64', sigVerify: false }).send();
}
// UI flow: build → simulate → render TxReviewDialog(units consumed, logs, err, expected out)
//          → on user approve → signAndSendTransactionMessageWithSigners(txMessage)
//          → surface signature + track confirmation
```
- `TxReviewDialog` shows: action (Buy YES 100 USDC), expected out, effective fee, **min_out**, compute units, cluster, and any simulation error decoded to a human message. Approve/cancel. **No signing before approval** (W009).
- The signer comes from the connected account: framework-kit's `useWalletAccountTransactionSendingSigner(account, 'solana:devnet')` yields a Kit `TransactionSendingSigner` usable directly with `signAndSendTransactionMessageWithSigners` (verified against kit `packages/react`).
- Error decoding: map custom Anchor error codes (slippage exceeded, market not trading, etc.) via the IDL error table in `@fpm/idl` to friendly messages.

### 4.4 Embedded wallet — README roadmap (§2)
Note in README (not built for hackathon): embedded/social login via **Privy / Dynamic / LazorKit** as the consumer-onboarding direction. Framework-kit keeps this a swap at the connector/signer layer, not a rewrite — call this out as a deliberate seam.

---

## 5. Charts (lightweight-charts)

- `PriceChart` is `"use client"`; dynamically imported (`next/dynamic`, `ssr:false`) so the TradingView lib never runs on the server.
- Data from `GET /markets/:id/history`, validated with `HistoryPointSchema[]` (zod, `@fpm/shared`). Each point: `{ ts, yesPrice, noPrice, volume }` (align field names with the indexer DTO — confirm with the indexer owner).
- Render a line/area series for YES odds (0–100%) with a right price scale as %, plus an optional volume histogram pane. Colors from tokens (`--kit-yes`).
- **Live tail:** append/`update()` the last point as fresh trades arrive (poll or subscription in `useMarketHistory`), so the chart tracks the odds tape.
- Chart y-axis and crosshair labels use tabular formatting; annotate the **lock time** and, when resolved, the **resolution point** with a marker (ties the chart to the lifecycle story for the demo).
- Handle empty history (new market) with a flat 0.50 baseline placeholder, not an error.

---

## 6. Data layer

### 6.1 Type-safe indexer fetch (§3.3 contract)
- `@fpm/shared` is the single source of truth: zod DTOs shared by NestJS (`nestjs-zod`) and web. `lib/api.ts` wraps `fetch` and **parses every response with the corresponding schema** before returning — untrusted-data guardrail (W011): validate shape/length before use.

```ts
// lib/api.ts (illustrative)
import { MarketSchema, MarketsListSchema, HistorySchema } from '@fpm/shared';
const BASE = process.env.NEXT_PUBLIC_INDEXER_URL!;
async function get<T>(path: string, schema: import('zod').ZodType<T>): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { next: { revalidate: 5 } });
  if (!res.ok) throw new Error(`Indexer ${res.status}`);
  return schema.parse(await res.json());
}
export const getMarkets  = () => get('/markets', MarketsListSchema);
export const getMarket   = (id: string) => get(`/markets/${id}`, MarketSchema);
export const getHistory  = (id: string) => get(`/markets/${id}/history`, HistorySchema);
```

### 6.2 Live updates
- **Odds/price:** short-interval polling (2–5s) of `GET /markets/:id` for the demo (simple, reliable). If the indexer exposes SSE/WS later, swap `useMarket` to subscribe. Consider TanStack Query for cache + refetch + dedupe.
- **On-chain reads where authority matters:** `Position` balances and the freshest `Market` reserves/`v_acc`/state come from RPC via the Kit client (`fetchMarket`/`fetchPosition` decoders from `@fpm/idl`), because the indexer can lag a block. The indexer is the source for **history/aggregates**; on-chain is the source for **user funds + current state**.
- Reconcile: SSR from indexer for fast first paint → client hydrates + overrides with on-chain reads for balances/state.

---

## 7. Dynamic fee / slippage UX (§4.4 story, §6.3)

The dynamic volatility fee is the project's judge thesis — the UI must make it legible:
- `FeeBar` on detail: current effective fee, widening/amber when elevated, tooltip explaining stale-price protection.
- `PriceImpact` in the trade panel: for the entered amount, show **effective fee bps** (recomputed client-side from `v_acc`, `base/max/vfc/reduction/filter/decay` read from `MarketConfig` + `Market` — mirror the exact `math.rs`/`fee.rs` formulas so the quote matches on-chain), **price impact %**, and expected out. Warn (amber) when fee or impact is high.
- `SlippageControl` → `min_out`: the user sets tolerance; UI computes and displays the concrete `min_out`, so a fee spike between quote and execution simply reverts (safe) rather than filling at a bad price. Explain: "If the price moves past your tolerance, the trade won't go through."
- `lib/quote.ts` is the client mirror of on-chain math; keep it in sync with the program (single test comparing quote vs on-chain simulate result).

---

## 8. Historical Replay demo flow (§8)

Matches finish after the deadline, so the demo replays a historical match end-to-end and the UI must showcase: **market open → trades (price shifts) → match end → proof → resolve → payout.**

What the UI needs:
- `useDemoReplay` / a `/demo` affordance (or a "Demo mode" toggle) that walks a scripted timeline against a devnet market seeded by the keeper/replay, so the recording is deterministic.
- Visible lifecycle transitions: `StateBadge` moves `Open → Trading → Locked → Resolved`; the chart shows the odds swing during trades and drops a **lock marker** then a **resolution marker**.
- The trade panel demonstrates a buy with price impact + fee spike (simulate a "goal" moment → fee bar turns amber).
- `ResolutionPanel` surfaces the **TxLINE proof / resolve tx** (explorer link) — the trustless-resolution payoff.
- `/positions` shows the winning position, then **Redeem → "Redeemed N USDC"** — the payout beat.
- Keep it screen-recordable: no wallet popups mid-take where avoidable (pre-connect), tabular numbers so nothing jitters on video.

Coordinate with keeper/indexer owners on: a stable replay dataset on devnet, and whether the keeper drives `activate/freeze/resolve` on a schedule the UI just observes.

---

## 9. Styling / design approach (Tailwind + shadcn)

- Init shadcn/ui; theme via CSS variables in `globals.css` mapped to the §0 tokens; extend `tailwind.config.ts` with the palette + the display/body/mono font families (self-hosted, no external font host — Vercel-friendly, CSP-clean).
- Use shadcn primitives (Button, Dialog, Tabs, Tooltip, Badge, Skeleton, Sonner/toast) but **restyle to the scoreboard identity** — don't ship default shadcn look (avoids the templated feel the design brief warns against). Spend the boldness on `OddsTape` + `FeeBar`; keep everything else quiet.
- Global `tabular-nums` utility applied to all numeric/price/countdown displays.
- Skeletons for market cards/chart while loading; consistent empty/error components.
- Accessibility floor: keyboard-focusable trade controls with visible focus rings, `aria-live` on the odds tape for screen readers, `prefers-reduced-motion` disables the flip flash and pulse.

---

## 10. Deployment (§8)

- Host `apps/web` on **Vercel**. Set root/monorepo settings so Vercel builds the `web` workspace (`pnpm --filter @fpm/web build`; Turborepo-aware). Ensure `@fpm/shared` (buildless TS source) and `@fpm/idl` (generated) resolve in the Vercel build — pnpm workspace + transpile internal packages if needed (`next.config` `transpilePackages`).
- Env vars in Vercel: `NEXT_PUBLIC_SOLANA_RPC_URL` (devnet), `NEXT_PUBLIC_SOLANA_WS_URL`, `NEXT_PUBLIC_INDEXER_URL` (Railway indexer URL, §8), `NEXT_PUBLIC_PROGRAM_ID`, `NEXT_PUBLIC_USDC_MINT`, `NEXT_PUBLIC_CLUSTER`.
- No external network calls from static assets (self-host fonts/crests) to keep CSP simple.
- Preview deploys per PR for demo iteration.

---

## 11. Sequenced task breakdown (maps to milestone phase 5: Frontend, ~3 days)

Ordered checklist. Wallet-stack decision resolved: **framework-kit** (as recommended).

**Day 1 — foundation & data**
- [x] **F0.** Confirm the interface contracts with teammates: exact zod DTO field names in `@fpm/shared`, `@fpm/idl` instruction/account signatures, indexer base URL + history point shape. *(done — DTOs in `libs/shared/src/dto`, indexer on :3900)*
- [x] **F1.** Scaffold `apps/web` (Next.js app-router, TS, Tailwind). Wire `@fpm/shared` + `@fpm/idl` workspace imports. *(done first pass; shadcn skipped — hand-rolled primitives per DESIGN_SPEC)*
- [x] **F2.** Design tokens: `globals.css` CSS vars (DESIGN_SPEC token set, not the §0 draft palette).
- [x] **F3.** `providers.tsx`: framework-kit `SolanaProvider` (devnet); `lib/solana.ts` cluster/program config; `WalletChip`/`ConnectModal`.
- [x] **F4.** Typed fetch with zod DTOs in `lib/data.ts` (demo-fixture ↔ live seam). **2026-07-05:** client polling added in `lib/use-live.ts` — market 5s, balances/positions 10–15s, plus a `notifyTxConfirmed()` bus so every view revalidates after a confirmed tx; timers pause while the tab is hidden.

**Day 2 — screens & trading**
- [x] **F5.** Market list `/` + `MatchCard` + `StateBadge` + `OddsTape`. *(2026-07-05: null-team fallback → "Fixture <id>" for real devnet markets)*
- [x] **F6.** Market detail `/markets/[id]`: header, odds tape, `ResolutionPanel`; server shell + client islands. **2026-07-05:** SSR market/history hydrate, then live-poll; chart series refetches when `updatedSlot` advances.
- [x] **F7.** Price chart (lightweight-charts, dynamic import) fed by `/markets/:id/history`.
- [x] **F8.** `lib/quote.ts` client CPMM quote + slippage → `min_out` (1d summary box).
- [x] **F9.** **2026-07-05 — REAL transactions.** `lib/tx.ts` rewritten on the `@fpm/idl` builders: buy = (openPosition if missing) + buy(side, usdcIn, minOut); sell(side, tokensIn, minUsdcOut); redeem. PDAs from `@fpm/shared`. Flow = build → compile unsigned → `simulateTransaction` (sigVerify:false, post-state account capture → the EXACT simulated shares/USDC out rendered in the 1d box) → user confirms → sign (wallet session or demo keypair) → send → bounded confirm poll → toast with devnet-explorer link. Anchor errors decoded via `getAmmErrorMessage`. Demo data mode keeps the stubbed settle path (CI/Vercel-safe). Note: `@solana/client` is kit v5 while the workspace is kit v2 — all tx code stays on kit v2; the wallet-session `signTransaction` boundary is one structural cast (`WalletTxSession` in lib/tx.ts).

**Day 3 — positions, demo, polish, deploy**
- [x] **F10.** **2026-07-05.** `/positions` live mode decodes on-chain `Position` PDAs (`fetchAllMaybePosition`, one batched RPC): open-positions table (per-side rows, mark value from live odds, P/L vs collateral basis), Claims tab with Redeem (simulate → send), portfolio header from the real USDT balance. Demo mode still renders fixtures. Trade ticket + 1g panel read the same live position (held YES/NO, redeemed flag).
- [x] **F10b.** **2026-07-05 — trader onboarding.** "Get test USDT" (trade ticket when balance 0, wallet modal, portfolio header) → devnet-SOL gas check/airdrop + idempotent ATA create + TxLINE `request_devnet_faucet` (100 USDT; wiring from scripts/full-circle.ts). Demo custodial wallet upgraded from a fake address to a REAL persisted Ed25519 keypair (localStorage seed, devnet-only custody) that signs every flow. Top-nav balance pill shows the real USDT balance in live mode.
- [ ] **F11.** Historical Replay affordance (`useDemoReplay`): observe lifecycle transitions, chart markers, fee-spike moment (§8). *(pending — needs the keeper-driven replay dataset)*
- [x] **F12.** Polish: skeletons, empty/error states, toasts, accessibility (focus, `aria-live`, reduced motion), mobile responsive. *(first pass; live-mode empty/claim states added 2026-07-05)*
- [ ] **F13.** Deploy to Vercel with env vars pointing at devnet + Railway indexer (§10); record the demo. *(pending; gitignored `apps/web/.env.local` documents the exact vars — `NEXT_PUBLIC_USE_LIVE_DATA`, `NEXT_PUBLIC_INDEXER_URL`, `NEXT_PUBLIC_SOLANA_RPC_URL`, `NEXT_PUBLIC_CLUSTER`; no API keys committed — Helius RPC via env only)*

**2026-07-05 gates:** `pnpm --filter @fpm/web typecheck/build/lint` green (with AND without `.env.local` — demo mode intact for CI/Vercel), `pnpm -r typecheck` 7/7. SSR curls against the live indexer rendered both real devnet markets (fixture 18179549 Resolved · Yes won with the 1g claim panel; 17588316 Trading) on `/` and `/markets/[id]`. tsconfig `target` bumped ES2017→ES2020 (bigint literals required by kit).

**Dependencies:** F5–F7 need the indexer live (or a mock server against the DTOs) — build a `msw`/static-fixture mock from `@fpm/shared` so frontend isn't blocked waiting on the indexer. F9–F11 need the program on devnet + `@fpm/idl` generated.

---

## 12. Risks / open questions to flag

1. **Wallet stack (blocking):** framework-kit vs classic wallet-adapter — resolve §2/§6.3 tension before F1. Recommendation: framework-kit.
2. **DTO field names:** exact shapes of `MarketSchema` / `HistorySchema` (esp. history point fields, fixed-point encoding of prices/reserves — bps? u64 strings?) must be pinned with the indexer + shared-lib owners. Client fee/quote math depends on getting `MarketConfig` fee params + `Market.v_acc/last_ts/last_price_bps` exactly.
3. **On-chain vs indexer authority:** confirmed split (funds/state = on-chain, history = indexer); needs the `@fpm/idl` account decoders to exist.
4. **Replay dataset:** need a stable, screen-recordable devnet replay driven by the keeper — coordinate ownership of `activate/freeze/resolve` timing.
5. **Quote/on-chain drift:** `lib/quote.ts` must mirror `math.rs`/`fee.rs` exactly; add one parity test (client quote vs `simulateTransaction` result).
6. **USDC 6-dp formatting** and price bps conventions everywhere — one `lib/format.ts`, tabular-nums, to avoid off-by-decimal bugs in a money UI.

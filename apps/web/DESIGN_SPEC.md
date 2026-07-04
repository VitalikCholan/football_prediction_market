# Frontend Design Spec — from `Prediction Market Wireframes.dc.html`

Source: user's claude.ai/design project (imported via DesignSync). Style: **desktop web, Polymarket/Kalshi share model (outcomes priced 0–100¢), crypto kept light (Solana wallet in the background), live odds-movement charts (TxLINE feed) as the hero.** Lo-fi sketch reference → implement as a clean, polished hi-fi build that keeps the same layout, palette, and information hierarchy.

Brand: **◆ TXL·Markets**.

---

## Design tokens (verbatim from the wireframe `<style>`)

**Fonts:** `Inter` (400/500/600/700) for all UI; `Kalam` (cursive, 400/700) ONLY for sketch hand-notes/annotations — in the hi-fi build, drop the hand-note accents or keep them as subtle helper text.

**Palette**
- Page bg `#eceae4`; surface/card bg `#fff`; text `#1f1d1a`; muted `#8f8b83`.
- Card `.scr`: `background:#fff; border:1.5px solid #d7d3ca; border-radius:12px; box-shadow:0 2px 6px rgba(0,0,0,.05)`.
- `.box`: `border:1.5px solid #dcd8cf; border-radius:9px`. `.dash`: dashed `#c7c1b6` (inputs/placeholders). `.sk`: skeleton `#efece6`.
- **YES / positive:** green `#2f9e5f` (text/line), dark green `#1c7a45`; yes-chip `.yc` `background:#f2faf5; border-color:#bfe3cd`; yes-button `.btn-y` `background:#e9f5ee; border-color:#2f9e5f; color:#1c7a45`.
- **NO / negative:** red `#d1495b`, `#a8303f`; no-chip `.nc` `background:#fdf4f5; border-color:#f0c9ce`; no-button `.btn-n` `background:#fbecee; border-color:#d1495b; color:#a8303f`.
- **Links / info accent:** blue `#2a78d6`; tag `.tag` `background:#eef3fb; color:#2a78d6`.
- **Live tag** `.tag-live`: `background:#fbecee; color:#c53b4a`.
- **Verified badge** `.verified`: `color:#1c7a45; background:#eef7f1; border:1px solid #cfe8d9; border-radius:6px` — text "◆ TxLINE verified feed" / "◆ Settlement verified on-chain".

**Components**
- `.btn` outline `1.5px #2b2926`, radius 8; `.btn-p` primary = `background:#1f1d1a; color:#fff`.
- `.pill` rounded-999 outline; `.pill-on` = filled `#1f1d1a`/white (active filter/toggle).
- `.chip` = outcome price cell (label + big ¢ price), colored `.yc`/`.nc` by side.
- `.tag` = uppercase mini-label; table `.th` uppercase muted, `.td` 13px, `.pos` green `.neg` red for P/L.

---

## Screens (7) → our routes

| id | Screen | Width | Our route |
|----|--------|-------|-----------|
| 1a | Wallet connect / onboarding | 460 | `/` gate or modal |
| 1b | Markets browse | 1080 | `/` (market list) |
| 1c | Match detail (chart + book) | 1080 | `/markets/[id]` |
| 1d | Trade ticket (slide-in panel) | 360 | panel on `/markets/[id]` |
| 1e | Portfolio / positions | 820 | `/positions` |
| 1f | Leaderboard + activity | 480+340 | `/leaderboard` (+ activity sidebar) |
| 1g | Resolution & payout | 480 | resolved state on `/markets/[id]` + claim |

### 1a Wallet connect
Header band "◆ TXL·Markets / Trade the outcome of every World Cup match". Primary CTA **"◎ Continue with Solana wallet"**, then Phantom / Solflare / Backpack buttons, an OR divider, email input + "Continue with email". Footer note: on-chain badge + "Balances & trades settle on Solana. A wallet is created for you — no crypto knowledge needed." → **crypto opt-in; email path auto-provisions a custodial wallet.**

### 1b Markets browse
Top nav: brand · search box ("Search matches, teams, outrights…") · nav links Markets/Leaderboard/Activity · **balance pill `$1,240.00`** · wallet chip `◎ 4xK…9Fa`. Filter row of pills: All markets (on) · Group stage · Knockout · Outrights · **● Live now** · "Sort: Volume ▾". **3-column grid** of match cards: each = live/time tag + group, "Team vs Team", "Match winner · score", **3 outcome chips (Home ¢ / Draw ¢ / Away ¢)** with the leading side tinted, then "Vol $842k" + a **sparkline SVG**. Plus one **Outright card** (World Cup Winner — ranked list of teams w/ ¢, "+13 more →"). Cards are one-tap trade entry.

### 1c Match detail — HERO
Breadcrumb "Markets › Group C › Brazil vs Argentina". Live tag + **"◆ TxLINE verified feed"**. Title + "Who wins the match?" and big score "1 – 1 · Score · updates ~60s delay". **Hero price-history chart** (the centerpiece): multi-line SVG (green/red/dashed-grey per outcome), timeframe pills **1H / Match / All**, legend "Brazil 46¢ / Argentina 33¢ / Draw 24¢". Below: **Outcomes list** — each row = name + "% implied · Vol" + **Buy Yes ¢** and **No ¢** buttons. Right sidebar: **Order book** (price/shares ladder, last marked) + **Market info** (Total volume, Liquidity, Resolves "At full time", Source "TxLINE oracle") + "◆ Settlement verified on-chain". → chart/book/score share one feed.

### 1d Trade ticket (slides in from right on any Buy)
Buy/Sell toggle. Market row ("Brazil vs Argentina / Brazil — Yes" + `46¢`). Yes/No side toggle. **AMOUNT** big input `$50 USDC ▾` + quick chips `$10 / $50 / $100 / Max`. Summary box: Shares `108.7`, Avg price `46¢`, Est. slippage `0.4%`, **Payout if wins `$108.70`** (green). Primary **"Place order"**. Footer: "Signs 1 Solana tx · gas covered by TXL". → payout math is the emphasis; tx/gas is the only visible crypto.

### 1e Portfolio
Header row: **Portfolio value `$3,412.80`** · Cash · In positions · All-time P/L (green) · Deposit / Withdraw. Tabs: Open positions (on) / History / Claims. **Positions table**: Market (+ live/time sub) · Outcome pill · Shares · Avg · Now · Value · **P/L colored** (green/red/grey). Rows update live; colour tracks P/L.

### 1f Leaderboard + activity (side by side)
**Leaderboard card** (480): Today/Week/All toggle; table # · Trader (avatar + name) · Volume · Profit (green); **"You" row pinned/highlighted** at rank 18. **Activity card** (340): "● Live" header; stream of "user bought/sold Outcome ¢ · $amount · Ns ago" (green for buy, red for sell). → social-proof loop.

### 1g Resolution & payout (settled)
Green resolved banner "● Resolved / Brazil won 2–1". "Final result: Brazil". **Your position** box: Held "640 × Brazil Yes", Avg cost, "Resolved at $1.00 / share", **Payout `$640.00`** (green), Profit. Primary **"Claim $640.00"**. Footer: "◆ Resolved via TxLINE oracle" + "View tx ↗". → payout auto-credits; "View tx" is discreet on-chain proof.

---

## Implementation notes for our stack
- 0–100¢ price === `price_yes_bps / 100` from the on-chain `Market` / indexer (`libs/shared` DTOs). YES/NO map to our `Side` enum; multi-outcome (Home/Draw/Away) is 3 markets or a 3-way (roadmap) — for v0 render per-outcome YES/NO.
- The price-history chart (1c hero) is fed by `GET /markets/:id/history` (indexer) → use **lightweight-charts** (TradingView) as planned.
- "TxLINE verified feed" / "Settlement verified on-chain" / "View tx" badges map to our resolve proof + tx signature.
- "Signs 1 Solana tx" / build-sign-send via framework-kit + the `libs/idl` Kit client; show the simulation/summary (shares, payout, slippage) before signing — this is exactly the 1d summary box.
- The raw wireframe lives in the user's claude.ai/design project (`Prediction Market Wireframes.dc.html`); this spec is the implementable distillation (drop the `<x-dc>`/`support.js` canvas runtime).

> **Примітка про переклад.** Це український переклад `plans/SPEC.md`. Канонічним є англомовний `plans/SPEC.md` — у разі розходжень англійська версія має пріоритет.

# SPEC.md — Проєктні рішення + перспективна (ще не реалізована) специфікація

**Призначення:** сталий запис "чому воно побудоване саме так" (ухвалені рішення) плюс конкретна on-chain специфікація того, що **ще не написано в коді** (v1 leverage §2, v2 pm-AMM крива §3, 3-стороння 1X2 LMSR-ринок §3.1), а також технічний борг, який варто відстежувати. Це консолідує колишні `anchor-programs-plan.md` / `backend-plan.md` / `frontend-plan.md` / `monorepo-setup.md`.

- **Стан того, що вже поставлено (джерело істини): `CLAUDE.md`** у корені репозиторію — поточні program/keeper/indexer/web у тому вигляді, як вони реалізовані, команди, архітектурні шви, живі підводні камені. Не дублюйте це тут.
- **Магістральне бачення + дорожня карта: `PLAN.md`** — §9 фази, §10 v0/v1/v2 економіка, §12 відомі баги. Економічне обрамлення leverage/pm-AMM живе там; SPEC.md містить on-chain **механіку**, якої немає в PLAN.md.
- SPEC.md — лише перспективний + рішення. Деталі реалізації по кожному шару навмисно опущені (вони в CLAUDE.md і в коді).

---

## 1. Ухвалені рішення (те саме "чому")

Усе поставлено у v0, якщо не позначено STAGED. По одному рядку на кожне; обговорення опущені.

- **D-1 — keeper gate.** Явний `keeper: Pubkey` на `GlobalConfig`; `activate_market`/`freeze_market`/`resolve` захищені через `address = global.keeper` на `keeper: Signer` (подвійний запобіжник разом із clock gate). Дешево закриває вектор griefing.
- **D-2 — virtual reserves.** `yes_reserve`/`no_reserve` встановлюють **лише odds** через `x·y=k`; vault тримає всі USDC. Жорсткий інваріант платоспроможності перевіряється повторно після кожного buy/sell/redeem: **`vault_usdc >= max(yes_supply, no_supply)`**, тож кожен виграшний токен погашається рівно за 1 USDC (`math::assert_solvent`).
- **D-3 — без `init_if_needed`.** Явна ix `open_position` виконує одноразову ініціалізацію `Position` PDA; `buy`/`sell` беруть уже створену `mut` Position. Фіча `init-if-needed` не увімкнена (небезпека reinit→перезапис балансу).
- **D-4 — `Outcome::Void` повертає pro-rata.** При Void `redeem` повертає трейдеру його чисту USDC-базу (`position.collateral` = Σ buy inputs − sell proceeds); різниця win/lose скасовується.
- **D-5 — Anchor 1.0.x stable (LOCKED).** Класична Borsh-модель акаунтів, **не** v2/`anchor-next` alpha (неаудитована, zero-copy — непридатна для escrow, що тримає реальні кошти, за наявності дедлайну). Toolchain: Rust 1.89+, Solana CLI 3.1.10+, Anchor CLI 1.0.x, Surfpool 1.1.2+. Конвенції 1.0 (Pubkey-first CPI, єдиний `#[error_code]`, `address =` замість `has_one`, `UncheckedAccount` замість `AccountInfo`, `8 + INIT_SPACE`, dup-mutable відхиляється за замовчуванням) вбудовані в поставлену програму — див. CLAUDE.md.
- **D-6 — collateral = TxLINE devnet USDT.** Mint `ELWTKspHKCnCfCiCiqYw1EDH77k8VCP74dK9qytG2Ujh`, перевірено on-chain як **classic SPL Token** (owner Tokenkeg…), 6 decimals, `freezeAuthority=null`. Використовує `anchor_spl::token_interface` + `transfer_checked`; обробка розширень Token-2022 не потрібна, але зберігаємо облік balance-delta на депозитах/виплатах як дешеву страховку. (Сумісність із Token-2022 на рівні типів безкоштовна через `InterfaceAccount`; фактичне приймання *collateral* у Token-2022 потребувало б extension-guard з §4 "deferred".)
- **D-7 — `fixture_id: i64`.** TxLINE fixture id мають тип `i64` (напр. `17588316`). `Market.fixture_id: i64`, `MARKET_SEED = b"market" + fixture_id LE` — чисте 1:1 до TxLINE.
- **D-8 — resolution-предикат зберігається on-chain.** `MarketConfig` несе `resolution_threshold: i32`, `resolution_comparison: u8` (TxLINE `Comparison`), `stat_key_a: u32`, `stat_key_b: u32` (0 = не використовується), `stat_op: u8` (TxLINE `BinaryExpression`; 0 = none), вирізані з `_reserved`. `resolve` доводить **попередньо зафіксоване** питання, яке keeper не може змінити; `outcome` виводиться з того, що доводить proof, і ніколи не є аргументом keeper.
- **D-9 — leverage-as-option + pm-AMM stretch (STAGED, напрям LOCKED).** v1 = leverage "pay-for-time" без ліквідації, змодельоване як binary option; v2 = замінюваний trait `PricingCurve` зі статичною pm-AMM 2-ю реалізацією. Повна on-chain механіка в §2/§3; економіка в `PLAN §10`.

**Розв'язані відкриті питання (O-items), стисло:**

- **O-1/O-2 — TxLINE resolve-модель.** `validate_stat` — це **read-only CPI, що повертає `bool`** (читається через `Return<bool>::get()` / `get_return_data`), НЕ `Ok/Err` і НЕ записаний result-акаунт. `resolve` викликає його через CPI і розблоковує лише на `true`. Факти про інтерфейс — у §5.
- **O-3 — `resolve` має нульову token-експозицію.** Він торкається лише read-only `daily_scores_merkle_roots` PDA — вибір token-program для collateral повністю відв'язаний від верифікації.
- **O-4 — devnet feed.** Free/devnet рівень = **Service Level 1 = затримка 60s** (SL12 realtime лише для mainnet). Ця затримка 60s і є саме тим вікном adverse-selection, яке захищає динамічна volatility fee. Історичний replay через `/api/scores/historical/{fixtureId}` (у межах 2wk 6h) живить калібрування fee.
- **O5/O6 — розділення runtime монорепо та версія Anchor.** Anchor 1.0.x зафіксовано (вбудований Codama codegen, TS-база `@anchor-lang/core`). Keeper = native Node TS-strip (без decorators); indexer = `nest start --watch -b swc` (потрібні decorator metadata). Це розділення per-app-runner поставлене й задокументоване в CLAUDE.md.
- **kitguard** ніколи не був реальним пакетом — поставлений як замінюваний інтерфейс `TxSender` (`KitTxSender`: simulate-before-send + RPC failover + rebroadcast + динамічна priority fee).

---

## 2. v1 leverage — on-chain механіка (UNBUILT)

**Не на шляху v0.** v0 постачає чистий FPMM з `Position.leverage = 1` і всіма leverage-полями рівними нулю. Зарезервовані поля попередньо вирізані, тож v1 не потребує **міграції акаунтів**. Економічне обрамлення: `PLAN §10`; нижче — конкретний on-chain дизайн.

**Переосмислення (options, не perps).** Leverage "pay-for-time" без ліквідації **є binary option**: трейдер платить безперервну **time-fee = theta** (option decay) і ніколи не може бути ліквідований за ціною; **max loss = collateral**. `LeveragePool` PDA — це **options writer**, що належить протоколу. Це усуває весь стек ліквідацій perps (немає liquidation ix, немає TWAP oracle, немає каскадів).

### 2.1 Зарезервовані поля (попередньо вирізані, без міграції)

- **`MarketConfig._reserved` [u8;64]** тримає (30 байт, 34 залишається): `max_open_interest: u64`, `time_fee_num: u32` (theta-нахил per-epoch), `funding_epoch_secs: u32`, `max_mark_age_secs: u32`, `leverage_cutoff_secs: i64`, `max_leverage: u16`. Плюс `min_coverage_bps: u16` (або на `LeveragePool`).
- **`Position._reserved`** (16 байт) тримає `last_funding_epoch: u64` (індекс останньої розрахованої funding-епохи; встановлюється в поточну епоху при відкритті) і `funding_accrued: u64` (кумулятивний per-epoch funding; позиція експірується, коли він досягає `collateral`). Перевикористовує `collateral`/`leverage`/`notional` (уже поля). v0 лишає все нулем. *(Це переописує стару резервацію `entry_slot`/`fee_rate_snapshot` — ті самі 16 байт.)*
- **Новий `LeveragePool` PDA** (seeds `[b"lev_pool", market.key()]`) — новий акаунт, тож його поля не мігрують наявні акаунти. Тримає writer USDC + відстежує `open_interest`, `total_max_payout`, `pending_withdraw`, `mark_price_bps`/`mark_ts`, стан risk-valve.

### 2.2 Funding = per-epoch ROLLING (НЕ snapshot-at-open)

**Критична поправка (Messari/Forecast):** fee, оцінена на *весь час життя* позиції при відкритті, точно компенсує leveraged upside, коли ринок може стрибнути одразу в 0 → leverage не дає користі. Виправлення — переоцінка щоепохи, як funding у perps:

- Funding накопичується в **епохах** по `funding_epoch_secs`; індекс епохи = `unix_timestamp / funding_epoch_secs` (єдине читання годинника).
- **Ставка кожної епохи** = theta, обчислена за **mark price** цієї епохи (TxLINE StablePrice, §2.4) — НЕ за open price.
- **Lazy accrual:** при будь-якій взаємодії пройти епохи, що минули з `Position.last_funding_epoch`, підсумувати funding кожної епохи в `funding_accrued`, просунути `last_funding_epoch`. (Точний per-epoch прохід — O(epochs), але точний; closed-form наближення — O(1), але неточне — оберіть одне, зберігайте математику як pure fn.)

**Per-epoch theta — pure `fee.rs` fn** `compute_epoch_funding_bps(...)` (без `Clock`/`AccountInfo`; checked, ceil-div, тож ніколи не округлюється до 0 біля resolution):
```
// FPMM-cheap form: fee_rate ∝ p(1−p)/(T−t); max near p≈0.5, spikes as t→T.
//   p_bps = the epoch's MARK price; t_remaining = T−t (secs/slots), guard != 0.
numer = (p_bps as u128) * ((BPS_DENOM - p_bps) as u128) * (time_fee_num as u128)
denom = (BPS_DENOM as u128) * (BPS_DENOM as u128) * (t_remaining as u128)
fee_rate_bps = ((numer + denom - 1) / denom) as u64   // ceil-div
```
"Correct" форма (лише якщо приземлиться pm-AMM/erf, §3): `fee_rate ∝ φ(Φ⁻¹(p))/√(T−t)` — Gaussian theta; property-test обидві одна проти одної.

### 2.3 Платоспроможність: coverage ratio (Delphi/Gensyn — основний guard)

Рамка: vault із обмеженими збитками (у кожної позиції `max_payout` скінченний) → підстрахований пулом → компенсований через theta → **керований coverage ratio**. On-chain = одне поле PDA + один guard, що узагальнює `max_open_interest`:

- Відстежувати **`total_max_payout: u64`** на `LeveragePool` — біжуча Σ `max_payout` усіх відкритих позицій (нарощувати при open, зменшувати при close/expire). Точне зобов'язання, яке пул мусить виконати.
- `coverage = pool_balance / total_max_payout`; обчислювати як checked cross-multiply (без ділення, округлення на користь пулу). `min_coverage_bps` = налаштований поріг.
- **Guard у `open_leverage`:** відхилити, якщо відкриття опустило б coverage нижче порога — `pool_balance * COVERAGE_DENOM >= min_coverage_bps * (total_max_payout + new_max_payout)`. `max_open_interest` обмежує *notional* (розмір); coverage обмежує *платоспроможність пулу проти найгіршого payout* (суворіше, основне). Обидва в одному guard-блоці; зберігайте `coverage_ok(...)` як pure checked fn.

### 2.4 Mark price = TxLINE StablePrice (ніколи не наш власний spot)

Funding/PnL/exposure маркуються за **TxLINE StablePrice mark**, ніколи за нашим тонким FPMM spot (spot маніпульований → підштовхнути пул → спотворити funding). Keeper постить `mark_price_bps` + `mark_ts` на `LeveragePool` — **підписано keeper у v1** (keeper уже gated, D-1), **proof-verified через CPI `validate_odds` у v2** (дзеркалить патерн resolve `validate_stat` з §5). **Staleness guard:** `require!(now - mark_ts <= max_mark_age_secs)` — відхиляти funding-оновлення й нові відкриття проти stale mark.

### 2.5 Expiry = детермінований (БЕЗ ліквідації за ціною)

Позиція вмирає в ту саму мить, коли `funding_accrued == collateral` — pure-функція від минулих епох + постнутої mark-історії, без цінового тригера.
- **Lazy settlement (переважно):** при взаємодії підсумувати funding минулих епох; якщо `funding_accrued >= collateral`, зарахувати expired (writer лишає collateral, трейдер лишає будь-який in-the-money залишок).
- **Permissionless crank:** опційна ix `expire_position`, яку будь-хто може викликати, щойно `funding_accrued >= collateral`, щоб повернути rent / звільнити open-interest.
- Повністю замінює ліквідацію — весь сенс переосмислення як options.

### 2.6 Guard-и проти adverse-selection (вікно атаки з затримкою 60s, O-4)

- **Fee spike біля T** — `p(1−p)/(T−t)` уже вибухає при `t→T`, витісняючи пізніх відкривачів.
- **Cutoff-вікно** — відхиляти нові відкриття в межах `leverage_cutoff_secs` перед очікуваним resolution: `require!(now < resolution_estimate - leverage_cutoff_secs)`.
- **Size cap** — обмежити `new_notional` відносно вільного (незакомміченого) пулу USDC і `max_open_interest`.
- **SSE risk valve (jump events)** — навколо голів/червоних карток (keeper детектить зі scores SSE) наївний short-gamma vault виловлюють. Keeper-gated `set_risk_valve(paused: bool, funding_multiplier_bps: u16, until_ts: i64)`, що встановлює поля на `LeveragePool`: поки активний, відхиляти нові відкриття та/або розширювати funding на `funding_multiplier_bps`. Обмежити обидві ручки on-chain (`require!` multiplier ≤ жорсткий cap, `until_ts - now` ≤ max тривалість), тож keeper може демпфувати, а не rug. Розмір `time_fee_num` виводьте з **realized** волатильності TxLINE odds (offline `fee.rs` sim), а не зі статичної константи.
- **Leverage cap як fn від p** — `max_leverage_for_p(p_bps, max_leverage)`: FPMM-евристика = повний `max_leverage` у `p∈[0.2,0.8]`, лінійний спад → 1x до країв. pm-AMM форма `∝ 1/φ(Φ⁻¹(p))`, щойно приземлиться erf.

### 2.7 Вікна LP lock/withdraw (анти-runbank на ВІДОМОМУ resolution)

Writer-капітал фінансується LP; спортивний resolution — заплановна публічна подія, тож LP міг би висмикнути капітал за хвилини до неї й скинути дефіцит на решту LP. Захист — **двокрокове відкладене зняття**:
- `request_withdraw` записує запит; `withdraw` стає claimable лише після затримки — до наступного settlement або з gate lock-вікном перед `freeze_ts` (перевикористати `leverage_cutoff_secs` або окремий `lp_lock_secs`). `require!(now >= request.unlock_ts)` у `withdraw`; відхиляти `request_withdraw` усередині lock-вікна, якщо політика "жодних нових запитів біля resolution".
- `LeveragePool.pending_withdraw: u64` (сукупний зарезервований USDC, віднімається від *вільної* ліквідності, тож не може подвійно слугувати як coverage/OI headroom); per-LP `unlock_ts: i64` + сума на `WithdrawRequest` PDA (`[b"lp_withdraw", lev_pool.key(), lp.key()]`). Вільна ліквідність = `pool_balance - pending_withdraw`.

### 2.8 Набір інструкцій v1 (ескіз)

`init_leverage_pool` (per market; фінансує writer, встановлює `min_coverage_bps`) · `open_leverage` (встановити `collateral`/`leverage`/`notional`, `last_funding_epoch`=current, `funding_accrued`=0; застосувати coverage + `max_open_interest` + mark-staleness + risk-valve + cutoff guard; нарощувати `open_interest`/`total_max_payout`) · `close_leverage`/`expire_position` (зарахувати минулий funding lazily або через crank; зменшити `total_max_payout`) · keeper-пара `post_mark` / `set_risk_valve` · LP-пара `request_withdraw` / `withdraw`. Усі перевикористовують поставлений vault + Anchor-1.0 CPI-конвенції (Pubkey-first, PDA-signed `transfer_checked`, checked math).

### 2.9 LiteSVM-тести v1, які треба додати

(a) багатоепохове accrual зі **змінною ставкою** (warp епохи, постити різний mark на кожній, перевірити `funding_accrued` = Σ per-epoch rates); (b) `p(1−p)/(T−t)` має пік при p≈0.5, spike при t→T; (b2) економічна осудність full-life vs epoch pricing — epoch pricing лишає позитивний edge для правильного call, full-life ні (поправка Messari); (c) детермінований expiry при `funding_accrued==collateral` (lazy + crank); (d) OI cap + відхилення cutoff-вікна; (d2) risk valve (відкриття відхиляються поки активний, funding ×multiplier, out-of-bounds ручки відхиляються); (d3) відхилення mark staleness; (e) спад `max_leverage_for_p`; (f) відхилення coverage-ratio + зменшення `total_max_payout` при close/expire; (g) забезпечення withdraw-вікна + `pending_withdraw` прибирає зарезервований USDC з вільної ліквідності.

---

## 3. v2 — pm-AMM крива (дизайн зафіксовано на перспективу)

Ізолювати pricing-криву за невеликим trait у `math.rs`, щоб її можна було замінити без зачіпання handler-ів чи resolution/redemption:
```rust
pub trait PricingCurve {
    fn compute_out(reserve_in: u64, reserve_out: u64, amount_in_net: u64) -> Result<u64, AmmError>;
    fn price_yes_bps(yes_reserve: u64, no_reserve: u64) -> Result<u16, AmmError>;
}
```
- **v0 impl = FPMM** (constant product) — поставлено. `compute_out = y − k/(x + Δin_net)`.
- **v2 impl = static pm-AMM** (Paradigm 2024): інваріант `price = Φ((y − x)/L)`, `L` константа (статичний варіант). Ті самі два reserve + параметр ліквідності `L`, без нової форми акаунта. Потребує: **`erf` у fixed-point** через Abramowitz–Stegun у Q64.64 (`Φ(z)=½(1+erf(z/√2))`), pure + property-testable; **Newton solve** для інверсії `Φ` на кожному swap. **Oracle-free** — рахунок *імпліцитний* через marginal price + time-to-maturity, не читається з feed; on-chain потрібен лише `Φ` (`Φ⁻¹` НЕ потрібен — Newton-solve інваріант). "Один вечір: модуль математики + property-тести."
- **Пропустити dynamic pm-AMM** — дві причини: on-chain, його per-swap clock-стан `L ∝ √(T−t)` — небезпека округлення/монотонності; економічно він віддає ~половину LP-капіталу до expiry і майже порожній саме на resolution, але ~80% обсягу live-sports — це фінальні хвилини → контрпродуктивно.
- **Football caveat (перевірено):** оптимальність uniform-LVR у pm-AMM припускає **Gaussian** динаміку рахунку (баскетбол пасує). Win-prob футболу — **jump process** (плоско, потім дискретний goal-jump), тож pm-AMM тут — "краще сформований bounded-[0,1] prior із jump-застереженням, НЕ теоретично оптимальний". Подавати як покращення форми, не оптимальність.
- **Постачання навіть без on-chain шипінгу:** README LVR-бенчмарк (FPMM vs static pm-AMM, реплеєний на реальних TxLINE odds, O-4) через offline harness `fee.rs`/`math.rs`. v1 Gaussian theta (`φ(Φ⁻¹(p))/√(T−t)`) перевикористовує той самий erf/Φ код — обидва stretch-треки ділять один модуль математики. Роль pm-AMM у v1 — виведення funding-формули, НЕ крива пулу (заміна кривої строго v2).
- **3-way (win/draw/lose)** — v0 (і v1 leverage) — це **binary FPMM** на предикаті home-win; повноцінний футбольний **1X2** ринок (Team1 / Draw / Team2) потребує multi-outcome нормалізації, щоб `P1+PX+P2=1`. Повна LMSR-специфікація в **§3.1** нижче. Jump-arbitrage-аукціон навколо голів (Messari) — v2/pitch-item.

### 3.1 — 3-way (1X2) LMSR-ринок (v1 — математика + resolve-протокол BUILT, wiring UNBUILT)

> **Статус (2026-07-11):** фаза A (`programs/amm/src/lmsr.rs`, чистий fixed-point LMSR + 21 тест) і фаза B (`instructions/resolve/predicate_1x2.rs` + `plans/resolve-1x2.md`, протокол 1-of-3 + 8 тестів) **змержені**. EqualTo-стіна розчинена (positive-proof протокол). Залишок: фаза C — переформування `Market`/`Position`/`Outcome`, інструкції `buy`/`sell`/`resolve_1x2`, codegen + full-stack.

**Чому це існує.** Поставлений ринок — **binary**: один предикат (`(P1_goals − P2_goals) > 0` = Team1 win, D-8), два токени. `NO` = "Team1 НЕ виграє" = **{draw ∪ Team2 win}** — один токен, що покриває два футбольні результати. Тож YES/NO не можна перейменувати на "Team1 / Team2" без брехні на нічиїх (~25% матчів): нічия settle-иться в `NO`, але мітка "Team2" мала б означати, що Team2 виграв. Правдивий ринок Team1 / Draw / Team2 потребує **трьох outcome**, чого 2-reserve CPMM не може виразити. Це фіча рівня програми, не UI-перейменування.

**Модель — 3 токени, платить рівно один.** Outcome `{Team1, Draw, Team2}` (+ `Void`); на resolution рівно один істинний, і його токен погашається за 1 USDT, інші — 0. Когерентність структурна: **complete set** `{1×P1, 1×PX, 1×P2}` завжди погашається рівно за 1 USDT (один гарантований переможець), що змушує `price(P1)+price(PX)+price(P2)=1`. Binary FPMM отримує це безкоштовно (YES+NO=1 через `x·y=k`); N>2 потребує кривої, що зберігає суму.

**Крива = LMSR (основна).** Logarithmic Market Scoring Rule Хансона — природний multi-outcome maker:
```
cost:   C(q) = b · ln( Σ_i exp(q_i / b) )          // q_i = net tokens of outcome i minted; b = liquidity depth
price:  price_i = exp(q_i/b) / Σ_j exp(q_j/b)      // softmax → in (0,1), Σ price_i = 1 BY CONSTRUCTION
trade:  cost_to_buy(Δ on outcome i) = C(q + Δ·e_i) − C(q)
loss:   bounded = b · ln(3)                        // max subsidy the LP/vault can lose
```
Softmax-нормалізація дає `Σ price = 1` безкоштовно — окремого інваріанта дотримуватися не треба. On-chain cost = fixed-point `exp`/`ln` (Q64.64, pure + property-tested) — єдиний по-справжньому новий математичний тягар.

**Як збудовано (`lmsr.rs`, змержено):** Q64.64 в u128; `exp(−x)` = ln2 range-reduction + sign-free paired Taylor series; `ln` = power-of-2 нормалізація + atanh series; 256-бітні проміжні (limb split, ніщо мовчки не wrap-неться); softmax max-subtraction (усі exp-аргументи ≤ 0, ln-аргумент ∈ [1,3]). Виміряна похибка ~1e-16 проти f64 reference. Підтримувані межі: `b ∈ [10³, 2^60]`, `q_i ≤ 2^60` (нові appended `Lmsr*` error-варіанти; існуючі коди не зсунуті). Округлення pool-favorable: buy = ceil (мін 1 — ніколи не безкоштовно), sell = floor, ціни floor із `Σ prices_bps ∈ [9_997, 10_000]`. Структурна гарантія: `cost(q) ≥ max(q)` тримається ТОЧНО у fixed point, тож bounded loss `b·ln(3)` виживає trunc-ацію. Underflow-семантика: outcome ≳ 44.4·b нижче максимуму цінується в 0 bps з нульовою marginal cost — min-1 floor у `buy_cost` тримає купівлі не-безкоштовними.

**pm-AMM (multi-dim) розглянуто, не обрано.** Multi-outcome pm-AMM — альтернатива, але його оптимальність uniform-LVR припускає **Gaussian** динаміку; футбол — **jump process** (застереження §3), тож перевага pm-AMM формально тут не тримається, а коштує більшої реалізації. **LMSR — вибір для 3-way футболу**; pm-AMM лишається binary-curve експериментом v2 (§3).

**Відхилений сурогат — три незалежні binary-ринки.** Запуск "Team1 win?", "Draw?", "Team2 win?" як трьох окремих binary CPMM перевикористовує весь поставлений код і дешево дає *вигляд* 1X2, АЛЕ (a) ціни трьох незалежних пулів **не сумуються в 1** (некогерентні ймовірності, cross-market arb — саме те, що виправляє крива зі спільним інваріантом), і (b) `resolve` ринку "Draw?" врізається в **EqualTo wall** нижче. Це заглушка, не справжнє.

**On-chain переробка (це "велика" частина):**

| Layer | Binary (shipped) | 1X2 LMSR |
|---|---|---|
| `state.rs` `Market` | `yes_reserve`, `no_reserve` | LMSR state: `q: [u64;3]` (u64 LOCKED — sell обмежений outstanding supply, q ніколи не від'ємний) + `b: u64` |
| `state.rs` `Position` | `yes_tokens`, `no_tokens` | `tokens: [u64;3]` (Team1/Draw/Team2) |
| `Outcome` enum | `{Yes, No, Void}` | `{Team1, Draw, Team2, Void}` (2-bit) |
| `buy`/`sell` | `side: Side` | `outcome: u8 ∈ {0,1,2}`, price via LMSR cost delta |
| new math | `math.rs` CPMM | **new `lmsr.rs`** — pure `exp`/`ln`/cost/price, exhaustive tests |
| solvency (D-2 generalized) | `vault ≥ max(yes_supply, no_supply)` | `vault ≥ max(supply_Team1, supply_Draw, supply_Team2)` — re-checked after every mutate |
| complete set | implicit | optional `mint_set` (deposit 1 USDT → 1 of each) / `redeem_set` (burn 1 of each → 1 USDT) to pin the ≤$1 arb band |
| dynamic fee | `fee.rs` on YES price move | reuse; volatility measured on the traded outcome's price move |

**`resolve` — ВИРІШЕНО (фаза B, `plans/resolve-1x2.md`).** Протокол: **hint-and-prove-positively.** Keeper хінтить `outcome ∈ {Team1, Draw, Team2}`; програма виводить предикат цього outcome on-chain зі збереженого D-8 конфігу (компаратор `GreaterThan`/`EqualTo`/`LessThan` per hint, на тому ж `stat_a − stat_b` Subtract, threshold pass-through) і робить рівно ОДИН `validate_stat` CPI, який мусить повернути `true`; `market.outcome = hint` лише після верифікації proof. **EqualTo-стіна розчиняється**: Draw доводиться ПОЗИТИВНО через `EqualTo` (першокласний TxLINE-компаратор) — негація ніколи не виконується, `PredicateNotNegatable` недосяжний на цьому шляху. Soundness = цілочисельна трихотомія (рівно один з `{d>t, d==t, d<t}`), доведено тестами вичерпно (`predicate_1x2.rs`: взаємовиключність + вичерпність + правдивість). Невірний hint → CPI `false` → `ProofRejected`, без зміни стану (лише liveness). D-8 полів вистачає; `resolution_comparison` на цьому шляху ІГНОРУЄТЬСЯ (виводиться per-hint, не зберігається). Одне доповнення `MarketConfig`: **`market_kind: u8`** з `_reserved` (zero-default = Binary, без міграції), що розводить binary `resolve` і `resolve_1x2`; 1X2-конфіги вимагають `stat_key_b != 0`, різні ключі, `stat_op = Subtract` (`validate_1x2_config`). Рішення по відкритих питаннях доку: пінити `stat_to_prove.period` on-chain (захист від stale-batch replay, стосується і binary) — ТАК, у фазі C; окрема інструкція `resolve_1x2` (тримає v0 binary IDL byte-stable) — ТАК; handicap 1X2 (`t ≠ 0`) — ЛИШИТИ (безкоштовно за побудовою; UI просто не пропонує для WC-демо).

**Full-stack брижі:** зміна IDL → `pnpm codegen` → регенерація `libs/idl` → keeper (resolve обирає 1-of-3, hint), indexer (3 ціни, 3-outcome events, DTO), web (3-chip панель торгівлі Team1/Draw/Team2 — усі buyable; картка показує 3 реальні on-chain ціни, не поточний косметичний 0.42-split Draw). DTO в `libs/shared` отримують форму на 3 ціни + позицію на 3 баланси. Seeder створює **один** 3-way ринок на fixture (не три binary).

**Рішення (напрям LOCKED, UNBUILT):** справжній 1X2 = **єдиний LMSR multi-outcome ринок**, обраний над (a) трьома незалежними binary (некогерентні ціни + Draw-resolve wall) і (b) multi-outcome pm-AMM (Gaussian-припущення провалюється на футбольних jump). Зусилля ≈ новий `lmsr.rs` + переформування `Market`/`Position`/`Outcome` + переробка `buy`/`sell`/`resolve` + codegen + full-stack адаптація. Не на шляху v0/demo — demo використовує **чесні binary-мітки** ("{Team1} win" / "draw or {Team2}", PLAN §12 BUG-4).

**LiteSVM-тести v1, які треба додати:** (a) інваріант `Σ price_i == 1` тримається після довільних buy/sell послідовностей (у межах округлення); (b) LMSR cost монотонний + bounded loss `≤ b·ln(3)`; (c) fixed-point `exp`/`ln` проти reference (property-тест, error bound); (d) solvency `vault ≥ max(supply_i)` після кожного mutate; (e) round-trip `mint_set`/`redeem_set` = 1 USDT; (f) resolve до кожного з трьох outcome (positive-proof шлях) + Void refund; (g) конкретно Draw-resolve шлях (виправлення EqualTo).

### 3.2 — Leverage поверх 3-way LMSR (композиція, UNBUILT)

**Leverage-шар (§2) чисто компонується ПОВЕРХ 3-way LMSR-ринку — бо він ортогональний до spot-кривої.** Рамка PLAN §10: три *окремі* рішення — **mark price**, **spot liquidity**, **leverage instrument**. Leverage маркиться до **зовнішнього TxLINE-індексу, ніколи до spot-кривої**, тож заміна spot (binary FPMM → 3-way LMSR) лишає leverage-дизайн по суті незмінним. Порядок побудови вільний: спершу LMSR-3-way, потім leverage — або binary+leverage (§2 як написано), потім узагальнити spot.

**Що узагальнюється безкоштовно:**
- **Кожен outcome — сам по собі бінарний опціон.** З погляду одного outcome усе бінарно (`i` проти `not-i`, ймовірність `p_i`); ліверед-лонг на outcome `i` = бінарний опціон, max loss = `collateral`, upside `[0,1]`. Та сама структура, що в §2.
- **Theta per-outcome:** `fee_rate ∝ p_i·(1−p_i)/(T−t)`, обчислена на mark `p_i` цього outcome (§2.2 без змін, лише індексовано по outcome). Три `p_i(1−p_i)` незалежні, їхня сума ≠ 1 — це нормально, theta рахується per-position/per-outcome.
- **Mark = TxLINE 1X2 odds per outcome** (home/draw/away) — природніше, ніж у binary-випадку; `validate_odds` CPI на outcome у v2 (§2.4).
- **Coverage (§2.3) узагальнюється і навіть покращується:** виграє рівно один outcome, тож реалізована виплата — лише ліверед-позиції переможного outcome → guard `vault ≥ max_i(leveraged_payout_i)` (та сама форма, що LMSR-spot solvency у §3.1).
- **Детермінований expiry (§2.5), LP-вікна (§2.7) без змін. Risk valve (§2.6) важливіший** — гол різко перекидає 1X2 (особливо вбиває draw), саме тоді ліверед-позицію, відкриту перед голом, вибивають.

**Нова робота (чесна ціна):** `Position` несе ліверед `outcome_idx ∈ {0,1,2}` + leverage-поля з §2; `resolve` платить ліверед-позиціям переможного outcome і гасить решту (компонується з resolve §3.1); `max_leverage_for_p(p_i)` per outcome (draw `p≈0.25` → середній taper).

**Compute:** LMSR `exp`/`ln` (spot buy/sell ix) і funding-epoch walk (open/close/crank leverage ix) живуть у **різних інструкціях** — вони ніколи не стакаються в одному CU-бюджеті. Funding тримати **окремим crank** (не бандлити у трейд) — за патерном Drift нижче.

**Прецедент (Solana MCP, 2026-07):** публічної програми, що поєднує LMSR/multi-outcome AMM з leverage/options-вольтом, немає — ця композиція і є новизна (теза). Найближчий архітектурний прецедент — **Drift Protocol** (perps): підтверджує патерни **funding окремим crank** (`update_funding_rate`), **oracle-marked позиції** (`OracleSource`, не маркитись до власного AMM), **fixed-point грошова математика** (`PRICE_PRECISION`/`FUNDING_RATE_BUFFER`/`MARGIN_PRECISION`, без float) і **multi-position акаунт** (`MAX_PERP_POSITIONS`) — усе прямо застосовне тут.

**Рішення (напрям LOCKED, UNBUILT):** leverage-as-option — **шар, агностичний до spot-кривої**, що маркиться до TxLINE-оракула; лягає на binary FPMM (§2) або 3-way LMSR (§3.1) лише зі змінами per-outcome індексації. Не на шляху v0.

---

## 4. Відкладені / незавершені пункти (відстежуйте їх)

Відомі баги v0 — у **PLAN.md §12** (BUG-1…BUG-5) — тут не дублюються; виправити перед demo. Крім них:

- **Indexer vs реальні devnet events** — Phase 4 перевірено проти живої devnet-історії поставленої програми (див. CLAUDE.md / колишній backend-plan §7 I1–I6, усе зроблено). Залишок: опційний websocket `logsSubscribe` fast-path (наразі лише poll `tailOnce` кожні `INDEXER_POLL_MS`) лишено нереалізованим; poll-шлях авторитетний та ідемпотентний.
- **Overlay графіка руху odds (відкладено)** — крива StablePrice odds, накладена на hero price-графік ринку. Відкладено, бо devnet World Cup odds feed повертає `[]` (club-league guest odds працюють; WC fixtures ні), тож це був би dead code до mainnet WC або club-league ринку. Поле DTO `marketOdds` + spread market-vs-pool уже існують, але інертні на devnet WC.
- **Demo-афорданс Historical Replay (frontend F11)** — `useDemoReplay`, що керує скриптованим життєвим циклом (open→trades→lock→proof→resolve→payout) проти keeper-driven devnet replay dataset. Очікує стабільний replay dataset; потрібне для записаного demo, бо реальні матчі завершуються після дедлайну.
- **Fee calibration harness** — offline replay через pure `fee.rs` fn для ручного тюнінгу дефолтів `create_market_config` проти вікна затримки 60s (дані через `/api/scores/historical/{fixtureId}`). Також вхід для sizing theta/funding у v1 (realized волатильність TxLINE odds).
- **Proof-VALID resolve ще не доведено live** — Surfpool довів повний CPI/Merkle-шлях проти реального forked txoracle (discriminator, Borsh layout, PDA derivation усі прийняті; garbage proofs відхилені з реальним `6004 InvalidMainTreeProof`), і повне devnet-коло пройшло з keeper (fixture 18179549, реальний Merkle proof). Що лишається неперевіреним конкретно в Surfpool — це proof-VALID resolve там (потребує реальних Merkle proofs з keeper API) — покрито на devnet, не в integration-suite.
- **Token-2022 collateral (не потрібне для D-6, але якщо колись прийматиметься)** — vault мусить додати: облік balance-delta на кожному депозиті/виплаті (TransferFee), extra-account resolution (TransferHook, `anchor_spl` не auto-append), відхилення DefaultFrozen/CPIGuard mint при `init_market` і `harvest_withheld_tokens_to_mint` перед `close_account`. `resolve` лишається token-free (O-3). Поставлений USDT — classic SPL, тож нічого з цього не активне.
- **Розгортання (keeper/indexer → Railway, web → Vercel)** — зрізи `turbo prune --docker`, secret env vars, Postgres reference-var, платний RPC endpoint у `RPC_URLS` для записаного demo (публічний devnet нестабільний під навантаженням). Migrations запускаються при deploy indexer.

---

## 5. TxLINE integration reference (факти, яких немає в CLAUDE.md)

CLAUDE.md уже має живі підводні камені (ms timestamps, PascalCase SSE + `Stats` map, match-end = `StatusId 100`/`game_finalised`, `seq` обов'язковий, undici без auto-gunzip, devnet base URL). Стабільні факти про on-chain інтерфейс:

**`validate_stat` (read-only, повертає `bool`):**
```
validate_stat(ts: i64, fixture_summary: ScoresBatchSummary, fixture_proof: Vec<ProofNode>,
              main_tree_proof: Vec<ProofNode>, predicate: TraderPredicate,
              stat_a: StatTerm, stat_b: Option<StatTerm>, op: Option<BinaryExpression>) -> bool
```
Account: `daily_scores_merkle_roots` (read-only PDA, seeds `["daily_scores_roots", epoch_day: u16 LE]`, належить TxLINE-програмі). `epoch_day = ts_ms / 86_400_000` (TxLINE `ts` — це MILLISECONDS — один root на 5-хв batch-slot; конвенція в секундах була багом, виправлено). Наш `resolve` захищає `txline_program` через `address = global.txline_program` (guard проти довільного CPI) + повторно виводить/перевіряє owner roots PDA, потім CPI і читає `Return<bool>::get()` **перед будь-яким іншим CPI** (return data очищається на кожному CPI).

**Addresses / mints:**
| | Devnet | Mainnet |
|---|---|---|
| TxLINE program | `6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J` | `9ExbZjAapQww1vfcisDmrngPinHTEfpjYRWMunJgcKaA` |
| TxL token (Token-2022) | `4Zao8ocPhmMgq7PdsYWyxvqySMGx7xb9cMftPMkEokRG` | `Zhw9TVKp68a1QrftncMSd6ELXKDtpVMNuMGr1jNwdeL` |
| USDT (our collateral, classic SPL) | `ELWTKspHKCnCfCiCiqYw1EDH77k8VCP74dK9qytG2Ujh` | `Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB` |

**Types (mirror in `programs/amm/idls/txline.json`):** `ProofNode { hash: [u8;32], is_right_sibling: bool }` · `ScoreStat { key: u32, value: i32, period: i32 }` · `StatTerm { stat_to_prove: ScoreStat, event_stat_root: [u8;32], stat_proof: Vec<ProofNode> }` · `ScoresBatchSummary { fixture_id: i64, update_stats: ScoresUpdateStats, events_sub_tree_root: [u8;32] }` · `TraderPredicate { threshold: i32, comparison: GreaterThan|LessThan|EqualTo }` · `BinaryExpression { Add, Subtract }`.

**Кодування stat-key:** `key = period*1000 + base`. Base: 1=P1 goals, 2=P2 goals, 3–6=yellow/red cards, 7–8=corners. Множники періоду: H1 +1000, H2 +2000, ET1 +3000, ET2 +4000, Pens +5000. Приклад "home win": `stat_a`=key 1, `stat_b`=key 2, `op=Subtract`, predicate `threshold 0, GreaterThan`.

**Помітні TxLINE-помилки:** `6007 RootNotAvailable` (oracle ще не запостив root цього epoch-day → keeper **ретраїть**, не перманентно) · `6021 PredicateFailed` · `6023 InvalidStatProof` · `6004 InvalidMainTreeProof` · `6062 ProofTooLarge`. Наш `resolve` мапить відхилення в чистий `AmmError::ProofRejected`; keeper refetch-ить/ретраїть.

**Off-chain endpoint-и keeper:** proof `GET /api/scores/stat-validation?fixtureId=&seq=&statKey=&statKey2=` (плаский camelCase JSON, `seq` обов'язковий); SSE `GET /api/scores/stream` (auth = guest JWT з `POST /auth/guest/start` + `X-Api-Token` з `/api/token/activate`); historical `GET /api/scores/historical/{fixtureId}` (SSE-framed, у межах 2wk 6h); snapshots `/api/scores/snapshot/{id}` (score) і `/api/odds/snapshot/{id}` (StablePrice odds); `/api/fixtures/snapshot` (назви команд + competition). Devnet feed = Service Level 1 (затримка 60s).

**PDA seeds (межа контракту, віддзеркалено в `libs/shared`):** `CONFIG=b"config"` · `MKT_CONFIG=b"mkt_config"+config_id:u16 LE` · `MARKET=b"market"+fixture_id:i64 LE` · `POSITION=b"position"+market:Pubkey+owner:Pubkey` · `VAULT=b"vault"+market:Pubkey`. v1 додає `LEV_POOL=b"lev_pool"+market` і `LP_WITHDRAW=b"lp_withdraw"+lev_pool+lp`.

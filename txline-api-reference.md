# TxLINE / TxODDS Oracle — API Reference

> Довідник по всіх endpoints гібридної on-chain/off-chain системи TxLINE (v1.5.2), зібраний під World Cup prediction-market проєкт.
> Технічні поля, шляхи й типи — англійською (як у самій документації); анотації — українською.

---

## 0. Загальна модель

TxLINE — **гібрид**: on-chain програма `txoracle` (Solana, Rust) + off-chain TxODDS HTTP/SSE API.

- **On-chain** відповідає за: підписки (`subscribe` / `subscribe_with_token`), published Merkle-корені батчів даних, і повний prediction-trading (`create_trade` / `settle_trade` + escrow).
- **Off-chain** віддає самі дані (fixtures / scores / odds) у request-response або SSE, і Merkle-proofs для on-chain валідації.
- Дані **канонізовані**: кожен запис можна криптографічно довести on-chain як частину батчу, чий корінь опубліковано в блокчейні.
- Батчі: **odds і scores — кожні 5 хв**; **fixtures — щогодини**. Корінь (Merkle root) публікується on-chain наприкінці інтервалу.

### Servers

| Середовище | Off-chain API base | Призначення |
|---|---|---|
| Production (MainNet) | `https://txline.txodds.com` / `https://oracle.txodds.com` | Живі матчі, low-latency |
| Test (DevNet) | `http://txline-dev.txodds.com` / `https://oracle-dev.txodds.com` | Re-runs матчів для інтеграції |

### On-chain конфігурація (`txoracle`, v1.5.2)

Значення взяті зі сторінки **Program Addresses** + IDL (свіжіші за README).

| Тип | MainNet | DevNet |
|---|---|---|
| Program ID | `9ExbZjAapQww1vfcisDmrngPinHTEfpjYRWMunJgcKaA` | `6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J` |
| TxL Token Mint | `Zhw9TVKp68a1QrftncMSd6ELXKDtpVMNuMGr1jNwdeL` | `4Zao8ocPhmMgq7PdsYWyxvqySMGx7xb9cMftPMkEokRG` |
| USDT Mint | `Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB` | `ELWTKspHKCnCfCiCiqYw1EDH77k8VCP74dK9qytG2Ujh` |
| API base | `https://txline.txodds.com/api/` | `https://txline-dev.txodds.com/api/` |

> ⚠️ **Не змішуй мережі.** DevNet subscribe-tx активується тільки на `txline-dev`, MainNet — тільки на `txline`. Усі treasury-ATA на **`TOKEN_2022_PROGRAM_ID`**.

### Автентифікація (спільна для всіх data-endpoints)

Кожен data-запит вимагає **два токени**:

| Заголовок | Джерело | Опис |
|---|---|---|
| `Authorization: Bearer <JWT>` | `POST /auth/guest/start` | Гостьова сесія, TTL **30 днів** (на 401 → перевипуск) |
| `X-Api-Token: <token>` | `POST /api/token/activate` | Довгоживучий API-токен, прив'язаний до on-chain підписки |

---

## 1. Authentication

### `POST /auth/guest/start`
Ініціює анонімну гостьову сесію, повертає JWT.
- **Auth:** немає.
- **Response `TokenResponse`:** `{ token: string }`
- **Нотатка:** JWT живе 30 днів. Keeper має обробляти 401 повторним викликом.

### `POST /api/token/activate`
Обмінює доказ on-chain підписки на довгоживучий API-токен.
- **Auth:** `Authorization: Bearer <JWT>`
- **Body `ActivationPayload`:**
  - `txSig: string` — підпис підтвердженої `subscribe`-транзакції
  - `walletSignature: string` — Base64 detached-підпис повідомлення (txSig + ліги + JWT)
  - `leagues: int32[]` — обрані ліги (порожній масив для legacy / standard matrix)
- **Response:** `text/plain` — API-токен (напр. `txoracle_api_123abc456def`)
- **Errors:** 400 (bad payload), 401 (invalid JWT), 403, 500

---

## 2. Purchase (лише платні tier'и — для free World Cup ПРОПУСКАЄТЬСЯ)

### `POST /api/guest/purchase/quote`
Генерує частково підписану Solana-tx для купівлі TxLINE utility-токенів за USDT.
- **Auth:** `Authorization: Bearer <JWT>`
- **Курс:** 1000 TxLINE = 1 USDT, наразі 0% markup.
- **Body `PurchaseQuoteRequest`:** `{ buyerPubkey: string, txlineAmount: int64 (1..100_000_000) }`
- **Response `PurchaseQuoteResponse`:** `{ transactionBase64, baseUsdtCost, feeUsdtAmount, totalUsdtCharged }`
- **Передумови:** гаманець має активний USDT ATA + достатній баланс.

---

## 3. Fixtures (розклад матчів; батчі — щогодини)

### Модель `Fixture`
```
Ts:int64  StartTime:int64  Competition:string  CompetitionId:int32
FixtureGroupId:int32  FixtureId:int64  Participant1IsHome:bool
Participant1Id:int32  Participant1:string  Participant2Id:int32  Participant2:string
```
> Увага: `Fixture` НЕ містить рахунку — це метадані матчу. Результат — у каналі `scores`.

### `GET /api/fixtures/snapshot`
Останній знімок матчів.
- **Query:** `startEpochDay?:int` (у межах 30 днів, default = сьогодні UTC), `competitionId?:int32`
- **Response:** `Fixture[]`
- **Застосування:** авто-створення ринків — джерело списку матчів турніру.

### `GET /api/fixtures/updates/{epochDay}/{hourOfDay}`
Усі оновлення матчів за конкретну годину.
- **Path:** `epochDay:int`, `hourOfDay:int (0-23)`
- **Response:** `Fixture[]` (порожній, якщо нема оновлень)

### `GET /api/fixtures/validation`
Merkle proof одного fixture-оновлення (дерево 2 рівні).
- **Query:** `fixtureId:int64` (required), `timestamp?:int64` (ms, default = now)
- **Response `FixtureValidation`:**
  - `snapshot: Fixture`
  - `summary: FixtureBatchSummary` (`fixtureId, competitionId, competition, updateStats, updateSubTreeRoot`)
  - `subTreeProof: ProofNode[]` — всередині піддерева матчу
  - `mainTreeProof: ProofNode[]` — піддерево → корінь батчу

### `GET /api/fixtures/batch-validation`
Merkle proof цілого погодинного батчу (bulk-верифікація).
- **Query:** `epochDay:int` (required), `hourOfDay:int` (required)
- **Response `FixtureBatchValidation`:** `{ metadata: BatchMetadata, proof: ProofNode[] }`
  - `BatchMetadata`: `totalUpdateCount, numUniqueFixtures, overallBatchStartTs, overallBatchEndTs`

---

## 4. Scores (події матчу; батчі — кожні 5 хв)

> ⚠️ **Покриття `scores`:** лише **US College Football & Basketball** (NCAA). Для футболу (World Cup / клубного) scores НЕ надаються — тільки odds.

### Модель `Scores` (мультиспортивна — ключові поля)
```
fixtureId:int32  seq:int32  ts:int64  id:int32  connectionId:int64
gameState:string  action:string  confirmed:bool  participant:int32
statusSoccerId / statusId / statusBasketballId   — статус матчу (enum)
scoreSoccer / score / scoreBasketball            — рахунок по періодах
dataSoccer / data / dataBasketball               — деталі події (Goal, RedCard, Corner...)
stats: Map<statKey:int -> value:int>             — плоска мапа статистик
```
Для soccer: `SoccerScore = { Goals, YellowCards, RedCards, Corners }`; періоди `H1/HT/H2/ET1/ET2/PE/Total`.
Статуси кінця матчу: `END`, `FET` (після ET), `FPE` (після пенальті).

### `GET /api/scores/snapshot/{fixtureId}`
Знімки по кожній дії останніх score-подій матчу.
- **Path:** `fixtureId:int64` · **Query:** `asOf?:int64` (ms; без нього — live)
- **Response:** `Scores[]`

### `GET /api/scores/updates/{epochDay}/{hourOfDay}/{interval}`
Історичний 5-хв зріз (без live).
- **Path:** `epochDay:int`, `hourOfDay:int (0-23)`, `interval:int (0-11)` · **Query:** `fixtureId?:int32`
- **Response:** `Scores[]`

### `GET /api/scores/updates/{fixtureId}`
Апдейти матчу в поточному 5-хв інтервалі (з live, якщо є).
- **Path:** `fixtureId:int64` · **Response:** `Scores[]`

### `GET /api/scores/historical/{fixtureId}`
Повна історія матчу. **Вікно: старт між 6 год і 2 тижні тому.**
- **Path:** `fixtureId:int64` · **Response:** `Scores[]`
- **Застосування:** відтворення завершеного матчу для демо.

### `GET /api/scores/stream`  ⭐ SSE
Live-потік score-апдейтів.
- **Query:** `fixtureId?:int64` · **Header:** `Last-Event-ID?` (відновлення)
- **Events:** data (`id="timestamp:index"`, `data: Scores`) + `heartbeat` (`{"Ts":...}`)

### `GET /api/scores/stat-validation`  ⭐⭐ (ядро резолюції)
Глибокий Merkle proof статистики. **Трирівнева ієрархія:** batch → fixture summary → event → stat.
- **Query:** `fixtureId:int32` (req), `seq:int32` (req), і один режим:
  - Legacy: `statKey:int32`, `statKey2?:int32`
  - V2: `statKeys:string` (через кому, N статистик)
- **Response `ScoresStatValidation`:**
  - `ts:int64`
  - `statToProve: ScoreStat` (`key:int32, value:int32, period:int32`)
  - `eventStatRoot: binary`
  - `summary: ScoresBatchSummary` (`fixtureId, updateStats, eventStatsSubTreeRoot`)
  - `statProof: ProofNode[]` — stat → event root
  - `subTreeProof: ProofNode[]` — event → fixture summary
  - `mainTreeProof: ProofNode[]` — summary → published batch root
  - `statToProve2? / statProof2?` — для двостатистичних умов
- **V2 `ScoresStatValidationV2`:** `statsToProve[]`, `statProofs[][]`
- **Застосування:** on-chain доказ «стат виконує бінарну умову» (score > threshold, різниця двох scores тощо).

---

## 5. Odds (де-марживані Stable Price; батчі — кожні 5 хв)

> Футбольний free tier (з 07.11.2025) — **лише odds**, затримка 60 сек. Guest-endpoints нижче.

### Модель `OddsPayload`
```
FixtureId:int64  MessageId:string  Ts:int64  Bookmaker:string  BookmakerId:int32
SuperOddsType:string  GameState:string  InRunning:bool
MarketParameters:string  MarketPeriod:string
PriceNames:string[]  Prices:int32[]   — паралельні масиви назва↔ціна
Pct:string[]                          — де-маржинована ймовірність, 3 знаки (напр. "52.632") або "NA"
```
> `Pct` = готова implied probability без vig. Використовуй для ініціалізації ціни AMM і довідкового відображення (НЕ для постійного pricing).

### `GET /api/odds/updates/{fixtureId}`
Live-котирування з поточного 5-хв кешу.
- **Path:** `fixtureId:int64` · **Response:** `OddsPayload[]`

### `GET /api/odds/updates/{epochDay}/{hourOfDay}/{interval}`
Історичний 5-хв зріз odds.
- **Path:** `epochDay:int`, `hourOfDay:int`, `interval:int (0-11)` · **Query:** `fixtureId?:int64`
- **Response:** `OddsPayload[]`

### `GET /api/odds/snapshot/{fixtureId}`
Знімок усіх odds-offers по матчу (per-fixture). Guest-варіант — `/api/guest/odds/snapshot`.
- **Path:** `fixtureId:int64` · **Response:** `OddsPayload[]`

### `GET /api/odds/stream`  ⭐ SSE
Live-потік odds. Живить Sharp Movement Detector + dynamic-fee сигнал.
- **Query:** `fixtureId?:int64` · **Header:** `Last-Event-ID?`
- **Events:** data (`data: OddsPayload`) + `heartbeat`

### `GET /api/odds/validation`
Merkle proof одного котирування (дерево 2 рівні).
- **Query:** `messageId:string` (req), `ts:int64` (req)
- **Response `OddsValidation`:** `{ odds: Odds, summary: OddsBatchSummary (oddsSubTreeRoot), subTreeProof, mainTreeProof }`

### Guest football odds (free tier, без активації, лише JWT)
- `GET /api/guest/odds/snapshot`
- `GET /api/guest/odds/stream`
- **Ліги:** La Liga(7), Premier League(8), Bundesliga(9), UCL(10), Serie A(13), Ligue 1(16), Europa League(18), Serie A Brazil(26), Argentina(87). Затримка 60 сек.

---

## 6. Спільні типи proof

```
ProofNode {
  hash: binary
  isRightSibling: bool   // з якого боку сусід при перерахунку гілки
}
List_ProofNode = ProofNode[] | Nil
```

---

## 7. On-chain програма `txoracle` (повний IDL v1.5.2)

> IDL name: `txoracle`, spec `0.1.0`. Усі snake_case (Rust IDL) / camelCase (TS types).

### 7.1 Інструкції — повний список

**Підписка й доступ**
| Інструкція | Args | Призначення |
|---|---|---|
| `subscribe` | `service_level_id:u16, weeks:u8` | Оформити підписку (weeks кратне 4). Accounts: `user(signer)`, `pricing_matrix`, `token_mint`, `user_token_account`, `token_treasury_vault`, `token_treasury_pda`, token/system/ATA programs |
| `purchase_subscription_token_usdt` | `txline_amount:u64` | Купити TxL за USDT. **Вимагає `backend_admin` co-sign.** Token-2022. |
| `request_devnet_faucet` | — | ⭐ DevNet USDT-фаусет (тест escrow без пошуку токенів) |

**Верифікація (view, повертають `bool` — CPI-придатні)** ⭐
| Інструкція | Args | Account |
|---|---|---|
| `validate_stat` → `bool` | `ts:i64, fixture_summary:ScoresBatchSummary, fixture_proof:Vec<ProofNode>, main_tree_proof:Vec<ProofNode>, predicate:TraderPredicate, stat_a:StatTerm, stat_b:Option<StatTerm>, op:Option<BinaryExpression>` | `daily_scores_merkle_roots` |
| `validate_odds` → `bool` | `ts, odds_snapshot:Odds, summary:OddsBatchSummary, sub_tree_proof, main_tree_proof` | `daily_odds_merkle_roots` |
| `validate_fixture` → `bool` | `snapshot:Fixture, summary:FixtureBatchSummary, sub_tree_proof, main_tree_proof` | `ten_daily_fixtures_roots` |
| `validate_fixture_batch` → `bool` | `index:u8, metadata:BatchMetadata, proof` | `ten_daily_fixtures_roots` |

> **Ключове:** `validate_stat` — публічна, повертає `bool`, тож твій AMM-контракт може **CPI'ити її** й на основі результату розблокувати власний escrow. Merkle-перевірку реалізовувати не треба.

**Prediction trading — P2P escrow model**
| Інструкція | Args (корот.) | Призначення |
|---|---|---|
| `create_trade` | `trade_id:u64, stake_a:u64, stake_b:u64, trade_terms_hash:[u8;32]` | **3 підписи:** `authority`(backend) + `trader_a` + `trader_b`. Створює escrow. |
| `settle_trade` | `trade_id, ts, fixture_summary, fixture_proof, main_tree_proof, predicate, stat_a, stat_b?, op?` | Резолюція за proof → виплата winner. |
| `settle_matched_trade` | `... terms:MarketIntentParams` | Резолюція matched-trade (orderbook-гілка) |
| `audit_trade_result` | `terms, fixture_summary, main_tree_proof, fixture_proof, stat_a, stat_b?, ts` | Аудит результату (emit `AuditVerifiedEvent`) |

**Prediction trading — order-book / intents model** (non-custodial)
| Інструкція | Args (корот.) | Призначення |
|---|---|---|
| `create_intent` | `intent_id:u64, terms_hash, deposit_amount:u64, expiration_ts:i64, claim_period:u16, fixture_id:i64` | Створити ордер-намір (maker) |
| `execute_match` | `trade_id:u64, maker_stake:u64, taker_stake:u64` | Solver матчить maker+taker → `MatchedTrade` |
| `close_intent` | — | Закрити/повернути прострочений intent |
| `claim_via_resolution` | `epoch_day:u16, interval_index:u16, merkle_proof` | Виплата через resolution-root |
| `claim_batch_legacy` | `epoch_day, interval_index, terms_hash, winner_is_maker:bool, seq:u32, merkle_proof` | Legacy batch-claim |
| `refund_batch` | — | Повернення по завершених/нічийних |

**Адмін / інфраструктура (не для тебе):** `initialize_pricing_matrix`, `update_pricing_matrix`, `close_pricing_matrix`, `initialize_treasury_v2`, `initialize_usdt_treasury`, `insert_batch_root`, `insert_scores_root`, `insert_fixtures_root`, `publish_resolution_root`, `withdraw_usdt`, `expose_structs`.

### 7.2 Ключові типи

```rust
TraderPredicate { threshold: i32, comparison: Comparison }
Comparison = GreaterThan | LessThan | EqualTo
BinaryExpression = Add | Subtract

ScoreStat { key: u32, value: i32, period: i32 }   // лист внутрішнього дерева
StatTerm {
  stat_to_prove: ScoreStat,
  event_stat_root: [u8;32],
  stat_proof: Vec<ProofNode>,
}
ProofNode { hash: [u8;32], is_right_sibling: bool }

ScoresBatchSummary {
  fixture_id: i64,
  update_stats: ScoresUpdateStats,   // { update_count:i32, min_timestamp:i64, max_timestamp:i64 }
  events_sub_tree_root: [u8;32],
}

MarketIntentParams {
  fixture_id: i64, period: u16,
  stat_a_key: u32, stat_b_key: Option<u32>,
  predicate: TraderPredicate, op: Option<BinaryExpression>, negation: bool,
}

// Кодування бінарної умови "хто виграв" (A голів − B голів > 0):
//   stat_a = {goals_p1}, stat_b = {goals_p2}, op = Subtract,
//   predicate = { threshold: 0, comparison: GreaterThan }
```

**On-chain акаунти:** `TradeEscrow`, `MatchedTrade`, `OrderIntent`, `PricingMatrix`, `FaucetTracker`.
`TradeEscrow { trade_id, trader_a, trader_b, stake_a, stake_b, trade_terms_hash, state, bump, created_at, expires_at, fee_amount, padding[64] }`.
`TradeState = Active | Resolved | Disputed`; `IntentState = Active | Locked | Closed | Expired`.

**Events:** `TradeSettled`, `MatchExecuted`, `IntentCreated`, `IntentClosed`, `BatchClaimExecuted`, `BatchRefundExecuted`, `AuditVerifiedEvent`.

### 7.3 PDA seeds (точні, з деривацій)

| PDA | Seeds | Для |
|---|---|---|
| `token_treasury_pda` | `["token_treasury_v2"]` | Vault підписок (TxL) |
| `pricing_matrix` | `["pricing_matrix"]` | Тарифи service-level |
| `usdt_treasury_pda` | `["usdt_treasury"]` | USDT vault |
| `daily_scores_roots` | `["daily_scores_roots", epochDay:u16 LE]` | ⭐ `validate_stat` |
| `daily_batch_roots` | `["daily_batch_roots", epochDay:u16 LE]` | `validate_odds` |
| `ten_daily_fixtures_roots` | `["ten_daily_fixtures_roots", floor(epochDay/10)*10 :u16 LE]` | `validate_fixture` |

Treasury-vault = ATA(mint, treasury_pda, **TOKEN_2022_PROGRAM_ID**). `epochDay = floor(Date.now()/86400000)`.

### 7.4 Константи

| Назва | Значення |
|---|---|
| `TOKEN_DECIMALS` | 6 |
| `MIN_DEPOSIT_TOKENS` / `MIN_USER_BALANCE` | 1_000_000 (= 1 токен) |
| `TOKEN_PRICE_IN_USDT` | 1000 (1000 TxL = 1 USDT) |
| `SUBSCRIPTION_DURATION` | 3600 |
| `BACKEND_ADMIN_PUBKEY` | `Ah5xwzHxRYBBV3BWHDCHdfzQJfBehzGQcc7A9QX1DLUB` (co-signer для purchase/create_trade) |

### 7.5 Коди помилок програми (вибірка)

`6003 InvalidSubTreeProof`, `6004 InvalidMainTreeProof`, `6007 RootNotAvailable` (корінь ще не запощено оракулом), `6013 InvalidTimeSlot` (не вирівняно на 5 хв), `6021 PredicateFailed` (умова не виконалась), `6022 InvalidFixtureSubTreeProof`, `6023 InvalidStatProof`, `6030 WinnerMismatch`, `6041 InvalidWeeks` (не кратно 4), `6045 InsufficientLiquidity`, `6062 ProofTooLarge`. Повний діапазон: 6000–6065.

### 7.6 Довідник кодувань (US-спорт; soccer stat keys перевірити на devnet)

**Game phases (US Football):** `NS=1, Q1=2, Q1B=3, Q2=4, HT=5, Q3=6, Q3B=7, Q4=8, F=9, WO=10, OT=11, OB=12, FO=13, I=14, A=15, C=16, TXCC=17, TXCS=18`. Overtime: `OT1=1011, OB1=1012, OT2=2011...`
**Stat keys (US Football):** `1=P1 Total Score, 2=P2 Total Score, 3/4=Touchdowns, 5/6=Field Goals...` Період: full (1..16), 1st half (+1000), 2nd half (+2000), Q1 (+10000), Q2 (+20000), Q3 (+30000), Q4 (+40000).
**Soccer:** статуси `END/FET/FPE` (кінець/після ET/після пенальті); score-поля `Goals, YellowCards, RedCards, Corners`; періоди `H1/HT/H2/ET1/ET2/PE/Total`. ⚠️ Точні числові soccer stat keys для on-chain `validate_stat` варто підтвердити емпірично на devnet.

> **Покриття даних:** Schedule-сторінка підтверджує, що World Cup матчі мають **і Scores, і StablePrice Odds coverage** — тобто `validate_stat` доступний для футболу (README був застарілий, US-only). Soccer stat-key encoding в IDL явно не наведено — перевірити на devnet re-runs.

---

---

## 8. Практика валідації `validate_stat` (робочий приклад)

Це ядро резолюції для Шляху 2 (свій AMM + CPI у `validate_stat`).

### 8.1 Два режими виклику

- **`.view()`** — off-chain read-only симуляція, **безкоштовна**. Keeper так перевіряє результат ДО реальної tx.
- **CPI on-chain** — твій AMM викликає `validate_stat` як CPI, отримує `bool`, розблоковує escrow. Merkle-перевірку сам НЕ реалізовуєш.

### 8.2 ⚠️ CU-ліміт = 1_400_000 (не 600k!)

Merkle-верифікація дорога. У прикладі `setComputeUnitLimit(1_400_000)` — це майже весь бюджет Solana-tx. **Наслідок:** тримай `resolve()` окремою транзакцією; buy/sell/redeem — окремими інструкціями, інакше не влізеш у CU.

### 8.3 Хелпери маппінгу API → Anchor

```typescript
// binary (base64/hex/array) → number[32]
toBytes32(value)                        // кидає помилку, якщо не 32 байти
toProofNodes(nodes)                     // [{hash, isRightSibling}] → Anchor ProofNode[]
```

### 8.4 Single-stat («гол > 0»)

```typescript
// 1) fetch proof
GET /api/scores/stat-validation?fixtureId=..&seq=..&statKey=1002
// 2) зібрати структури
fixtureSummary = { fixtureId, updateStats{updateCount,minTimestamp,maxTimestamp},
                   eventsSubTreeRoot: toBytes32(summary.eventStatsSubTreeRoot) }
fixtureProof   = toProofNodes(validation.subTreeProof)
mainTreeProof  = toProofNodes(validation.mainTreeProof)
stat1          = { statToProve, eventStatRoot: toBytes32(eventStatRoot),
                   statProof: toProofNodes(statProof) }
predicate      = { threshold: 0, comparison: { greaterThan: {} } }
// 3) PDA (див. пастку нижче)
// 4) validateStat(ts, fixtureSummary, fixtureProof, mainTreeProof,
//                 predicate, stat1, null, null).view()
```

### 8.5 Two-stat («хто виграв» = різниця) — точний кейс резолюції

```typescript
GET /api/scores/stat-validation?fixtureId=..&seq=..&statKey=1002&statKey2=1003
stat2      = { statToProve: v2.statToProve2, eventStatRoot: toBytes32(v2.eventStatRoot),
               statProof: toProofNodes(v2.statProof2) }
op         = { subtract: {} }
// "A переміг" → різниця голів A−B > 0:
predicate  = { threshold: 0, comparison: { greaterThan: {} } }
// validateStat(ts, fixtureSummary, fixtureProof, mainTreeProof,
//              predicate, stat1, stat2, op).view()
```

### 8.6 ⚠️ Пастка epochDay для PDA

`epochDay` рахується з **`minTimestamp` стату в мілісекундах**, не з «сьогодні», і кодується u16 LE (2 байти):

```typescript
const targetTs  = validation.summary.updateStats.minTimestamp;   // ms
const epochDay  = Math.floor(targetTs / 86400000);
const [dailyScoresPda] = PublicKey.findProgramAddressSync(
  [ Buffer.from("daily_scores_roots"), new BN(epochDay).toArrayLike(Buffer, "le", 2) ],
  program.programId
);
// у виклик передається new BN(targetTs) як ts
```

### 8.7 ⚠️ Пастка `Participant1IsHome` на World Cup

На нейтральних турнірах (ЧС) `Participant1IsHome` — **лише мітка фіду** для мапінгу P1/P2, НЕ гарантія майданчика. `true` означає, що P1 просто позначений як «home» у фіді, навіть якщо матч не в його країні.
**Наслідок для ринку:** прив'язуй YES/NO до конкретного `Participant1Id`/`Participant2Id`, ніколи до «home/away» — інакше семантика ринку попливе.

### 8.8 Приклади statKey (з робочого коду)

`statKey=1002`, `statKey2=1003` у прикладі — це half-scores (кодування 1st-half, +1000). Для фінального результату всього матчу бери full-game keys. ⚠️ Точні soccer stat keys не задокументовані в IDL — підтвердити на devnet re-runs.

### 8.9 Офіційні use-cases валідації

Trading settlement · conditional smart-contract logic · dispute resolution · **automated prediction markets** · score differentials. Останні два — прямо твій кейс.

---

## 9. Коди помилок (HTTP, спільні)

| Код | Значення |
|---|---|
| 400 | Invalid header/query/path |
| 401 | Invalid/expired guest JWT → перевипустити |
| 403 | Invalid API token / insufficient permissions |
| 500 | Internal server error |

---

## 10. Приклад повного access-флоу

1. `POST /auth/guest/start` → JWT
2. *(платний tier)* `POST /api/guest/purchase/quote` → підписати → відправити *(free WC пропускає)*
3. On-chain `subscribe(serviceLevel, weeks)` → `txSig`
4. Підписати повідомлення `txSig + leagues + JWT` гаманцем (Base64)
5. `POST /api/token/activate` → API-токен
6. Далі всі виклики з `Authorization: Bearer <JWT>` + `X-Api-Token: <token>`
7. На 401 → крок 1 наново.

---

## Джерела
- Off-chain OpenAPI: `oracle.txodds.com/docs` (MainNet), `oracle-dev.txodds.com/docs` (DevNet)
- Doc index: `https://txline-docs.txodds.com/llms.txt`
- On-chain приклади: `https://github.com/txodds/tx-on-chain`
- GitHub Pages: `https://txodds.github.io/tx-on-chain/`

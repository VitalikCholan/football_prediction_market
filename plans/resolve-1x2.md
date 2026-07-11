# resolve-1x2.md — 1-of-3 resolve protocol for the 3-way (1X2) market

**Status:** DESIGNED + prototyped (pure fns + unit tests in
`programs/amm/src/instructions/resolve/predicate_1x2.rs`). Kills the hard
sub-problem of SPEC §3.1 ("resolve is the hard sub-problem", EqualTo wall).
The LMSR curve / account reshape of §3.1 is out of scope here.

## 1. Protocol (chosen)

**Keeper hints; program derives; proof decides.** One `resolve_1x2` tx:

1. Keeper picks `hint ∈ {Team1, Draw, Team2}` (it knows the final score from
   the SSE stream — the hint is informed, not a guess).
2. Program derives THAT outcome's predicate **on-chain** from the stored D-8
   config (`derive_predicate_for_outcome`), on the same
   `stat_a − stat_b` subtraction, same threshold `t`:

   | hint  | derived predicate         | TxLINE comparator |
   |-------|---------------------------|-------------------|
   | Team1 | `(s1 − s2) >  t`          | `GreaterThan`     |
   | Draw  | `(s1 − s2) == t`          | `EqualTo`         |
   | Team2 | `(s1 − s2) <  t`          | `LessThan`        |

   `t = MarketConfig.resolution_threshold` (canonical 1X2: `t = 0`; `t ≠ 0`
   is a handicap 1X2 — still a valid trichotomy).
3. **Exactly ONE CPI** into `validate_stat` with the derived predicate; stat
   keys/op pinned to `stat_key_a`/`stat_key_b`/`stat_op` exactly as the
   binary `resolve` already does; stat *values* pinned by the Merkle proof.
4. CPI must return `true` (else `AmmError::ProofRejected`, tx aborts, no
   state change). On `true`: `market.outcome = hint`, `state = Resolved`.
   `outcome` remains "what was proven", never a free keeper arg — D-8 holds.

## 2. Why the EqualTo wall dissolves (verified)

The binary path needs `negate_predicate` because proving NO = proving the
*complement* of the stored predicate; `¬(x == t)` is a disjunction
(`x < t ∨ x > t`) TxLINE cannot express in one `Comparison` →
`PredicateNotNegatable (6023)`.

The 1-of-3 protocol never negates anything: **each of the three outcomes is a
positive proof**, and Draw is proven positively via `EqualTo` — a first-class
TxLINE comparator (`idls/txline.json` `Comparison::{GreaterThan,LessThan,EqualTo}`).
So on the 1X2 path `negate_predicate` is simply never called and the wall is
**fully dissolved** — no oracle change, no `NotEqual` comparator, no
two-CPI elimination chain. Residual: `EqualTo` stays non-negatable for
*binary* markets (unchanged, pre-existing); don't author binary configs with
`EqualTo` — the 3-way market IS the correct home for equality questions.

## 3. Soundness (unit-proven, `predicate_1x2.rs`)

Integer trichotomy: for any goal diff `d` and threshold `t`, exactly one of
`{d > t, d == t, d < t}` holds (`derived_predicates_partition_integer_goal_diffs`).

- **Mutual exclusivity → safety.** The proof pins the stat values; at most one
  hint's predicate can verify against the true final score. The keeper cannot
  select an outcome the proof doesn't prove.
- **Exhaustiveness → liveness.** For every final score some hint verifies, so
  a correct keeper always has a working resolve path (worst case 3 attempts).
- **Derivation is pure** in `(stored config, hint)`; the fn signature admits
  no comparator/threshold/key input from the keeper. No threshold arithmetic
  → no overflow path (unlike `negate_predicate`'s `t ± 1`).

**Wrong hint:** CPI returns `false` → `ProofRejected` → tx aborts, market
stays `Locked`, keeper retries with another hint. Liveness-only cost (one
wasted tx fee), zero safety loss.

## 4. Griefing analysis

- **Non-keeper caller:** rejected — D-1 signer gate (`global.keeper`), same
  accounts struct as binary `resolve`.
- **Malicious keeper, wrong outcome:** impossible — values Merkle-pinned,
  keys/op/threshold config-pinned, comparator hint-derived on-chain; the CPI
  bool is the only judge.
- **Hint spam:** keeper burns its own fees; each false hint is a no-op.
- **Equivocation / double resolve:** `require!(state == Locked)` +
  one-way `Locked → Resolved` transition — first winning proof locks the
  outcome; exclusivity means no second hint could verify anyway.
- **Withholding (keeper never resolves):** unchanged Void path — after
  `resolution_grace_secs`, `close_market` voids and D-4 refunds pro-rata.
- **Stale-batch replay (INHERITED, not new):** a proof from an earlier 5-min
  batch (mid-match score) also verifies against a real daily root. Same
  exposure as the shipped binary resolve. Mitigations today: keeper resolves
  only on `game_finalised` (`StatusId 100`), and final stats carry
  `period: 100`. **Open question O-1x2-1 below** proposes pinning
  `stat_to_prove.period` on-chain for both paths.
- **Token exposure:** none — `resolve_1x2` touches only the read-only roots
  PDA (O-3 preserved).

## 5. MarketConfig: do the D-8 fields suffice?

**For the derivation math — yes.** Needed inputs: `resolution_threshold`,
`stat_key_a`, `stat_key_b`, `stat_op` — all already stored. The stored
`resolution_comparison` is **ignored** by the 1X2 path (the comparator is
derived per-hint, not stored — that is the exact rule of §1).

**One addition needed: a market-kind discriminant.** Without it a config is
ambiguous (is this binary-on-GreaterThan or 3-way?) and a keeper could resolve
a 3-way market through the binary handler (2 outcomes on a 3-outcome book).
Carve **`market_kind: u8`** from `MarketConfig._reserved` (44 → 43 bytes;
0 = Binary as today, 1 = ThreeWay1x2 — zero-default keeps every existing
config Binary, no migration):
- `create_market_config`: if ThreeWay, require `stat_key_b != 0`,
  `stat_op == Subtract`, keys distinct (`validate_1x2_config`).
- binary `resolve`: `require!(kind == Binary)`; `resolve_1x2`:
  `require!(kind == ThreeWay1x2)` + defensive `validate_1x2_config` re-check.

`Outcome` enum gains `Team1/Draw/Team2` (or the §3.1 reshape supersedes
Yes/No); `Void` unchanged. Everything else (LMSR reserves, 3-token Position,
redeem) is SPEC §3.1 territory.

## 6. LiteSVM test sketch (needs the 3-way market accounts — until then, spec)

Mock oracle (`tests/mock-txoracle`) already evaluates the passed predicate
against passed stat values incl. `EqualTo` — no mock change needed.
Per scenario: bootstrap a ThreeWay config/market to `Locked`, then:

1. **Team1:** prove stats `s1=2, s2=0`; hint Team1 → resolved `Team1`; hints
   Draw/Team2 first → `ProofRejected`, state still `Locked`, then Team1 wins.
2. **Draw:** stats `s1=1, s2=1`; hint Draw → CPI proves `EqualTo 0` → resolved
   `Draw` (the wall-dissolver case); hints Team1/Team2 → `ProofRejected`.
3. **Team2:** stats `s1=0, s2=3`; hint Team2 → resolved `Team2`.
4. **Double-resolve:** after (1), any second resolve (any hint) →
   `InvalidMarketState`.
5. **Void:** never resolve; warp past `freeze + resolution_grace_secs`;
   `close_market` → `Outcome::Void`; 3-token redeem refunds collateral (D-4).
6. **Kind gates:** binary `resolve` on a ThreeWay market and `resolve_1x2` on
   a Binary market both rejected.
7. **Error mode:** `0xFF` sentinel roots account → oracle 6007 propagates
   verbatim (keeper-retryable), state unchanged.

Keeper change: `resolveMarket` computes the hint from the final SSE score
(`s1−s2` sign), calls `resolve_1x2` once; on `ProofRejected` (shouldn't
happen with a correct feed) falls back to trying the remaining hints.

## 7. Open questions (for the human)

- **O-1x2-1 — pin `period` on-chain?** Store an expected `period` (e.g. 100 =
  final) in `MarketConfig` and require `stat_to_prove.period == expected` in
  both resolve paths, closing the stale-batch replay window at the program
  level instead of trusting keeper timing. Cheap (2×4 bytes of _reserved).
- **O-1x2-2 —** should `resolve_1x2` be a separate instruction (clean IDL,
  chosen here) or fold into `resolve` with `hint: u8` once §3.1 reshapes
  `Outcome`? Separate keeps v0 binary byte-stable.
- **O-1x2-3 —** handicap 1X2 (`t ≠ 0`): keep supported (free by construction)
  or `require!(t == 0)` for the World Cup demo to avoid mislabeled UIs?
